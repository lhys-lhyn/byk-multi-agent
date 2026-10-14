"""在程序里拉起一个无头 DSH 智能体，并回收它的结果。

调用形如：
    node <dsh>/lib/bin.js --profile headless --patch <role-patch.yml> "<引导语>"

关键设计：
- 任务说明写入 job 目录的 TASK.md，命令行只传短引导语，规避 Windows 32KB 命令行上限。
- 每个角色一份 --patch 覆盖层，注入人格（system-prompt.persona）与模型（agent-default-model）。
- 子进程的沙箱/审批策略由 DSH_PERMISSION_MODE 控制（dsh-base 第 191 行读取）。
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .config import AppConfig, BOOTSTRAP, DSH_BIN, NODE, PATCHES
from .roles import persona_json

DeltaFn = Callable[[str, str], None]  # (stream, text)


@dataclass
class AgentResult:
    role: str
    ok: bool
    output: str
    exit_code: int
    duration_s: float
    stdout: str = ""
    stderr: str = ""
    error: str | None = None
    job_dir: str = ""
    artifacts: list[dict] = field(default_factory=list)
    #: 发生回退时，记录原本想用的路由，例如 "xiaomi/mimo-v2.6"。
    #: 绝不静默：回退一定要能被用户看见。
    fallback_from: str | None = None
    fallback_reason: str | None = None


def write_patch(role_id: str, model: str = "", provider: str = "") -> Path:
    """为角色生成 --patch 覆盖层。persona 用 JSON 字符串表达，天然是合法 YAML 标量。"""
    lines = [
        "- id: system-prompt",
        "  config:",
        f"    persona: {persona_json(role_id)}",
    ]
    if model:
        lines += [
            "- id: agent-default-model",
            "  config:",
            f"    provider: {provider or 'deepseek-official'}",
            f"    model: {model}",
        ]
    path = PATCHES / f"{role_id}-{uuid.uuid4().hex[:8]}.yml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _collect_artifacts(job_dir: Path) -> list[dict]:
    skip = {"TASK.md", "RESULT.md", "PLAN.json", "PRIVILEGE_REQUEST.json", "PRIVILEGE_RESULTS.md"}
    out = []
    try:
        for p in sorted(job_dir.rglob("*")):
            if p.is_file() and p.name not in skip and not p.name.endswith(".png.tmp"):
                out.append({"name": p.name, "path": str(p), "size": p.stat().st_size})
    except Exception:
        pass
    return out[:50]


def _spawn_agent(
    role_id: str,
    task_md: str,
    job_dir: Path,
    *,
    model: str,
    provider: str,
    sandbox: str,
    default_timeout: int,
    on_delta: DeltaFn | None = None,
    timeout_s: int | None = None,
) -> AgentResult:
    """单次尝试：按指定模型拉起一个无头助手，阻塞直到结束或超时。"""
    job_dir = Path(job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "TASK.md").write_text(task_md, encoding="utf-8")

    patch = write_patch(role_id, model, provider)
    env = os.environ.copy()
    env["DSH_PERMISSION_MODE"] = sandbox

    cmd = [NODE, str(DSH_BIN), "--profile", "headless", "--patch", str(patch), BOOTSTRAP]
    started = time.time()
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(job_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except Exception as exc:
        return AgentResult(
            role=role_id, ok=False, output="", exit_code=-1,
            duration_s=time.time() - started, error=f"无法启动助手进程：{exc}",
            job_dir=str(job_dir),
        )

    def pump(stream, sink: list[str], name: str) -> None:
        try:
            for line in iter(stream.readline, ""):
                sink.append(line)
                if on_delta and line.strip():
                    on_delta(name, line)
        except Exception:
            pass
        finally:
            try:
                stream.close()
            except Exception:
                pass

    t_out = threading.Thread(target=pump, args=(proc.stdout, stdout_parts, "stdout"), daemon=True)
    t_err = threading.Thread(target=pump, args=(proc.stderr, stderr_parts, "stderr"), daemon=True)
    t_out.start()
    t_err.start()

    limit = timeout_s or default_timeout
    timed_out = False
    try:
        proc.wait(timeout=limit)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            proc.kill()
        except Exception:
            pass
        try:
            proc.wait(timeout=15)
        except Exception:
            pass

    t_out.join(timeout=10)
    t_err.join(timeout=10)

    duration = time.time() - started
    stdout = "".join(stdout_parts).strip()
    stderr = "".join(stderr_parts).strip()
    exit_code = proc.returncode if proc.returncode is not None else -1

    # 优先采用助手自己写下的 RESULT.md —— 那才是它的完整交付物
    result_file = job_dir / "RESULT.md"
    output = ""
    if result_file.exists():
        try:
            output = result_file.read_text(encoding="utf-8").strip()
        except Exception:
            output = ""
    if not output:
        output = stdout

    error: str | None = None
    ok = exit_code == 0 and not timed_out
    if timed_out:
        error = f"助手执行超时（超过 {limit} 秒），已强制结束"
    elif exit_code != 0:
        error = stderr or stdout or f"助手进程以退出码 {exit_code} 结束"
        # stderr 里常见的是 DSH 的结构化错误，例如 AUTH/QUOTA
        for token in ("AUTH:", "QUOTA:", "RATE:", "TIMEOUT:"):
            if token in stderr:
                error = stderr.strip()
                break
    if ok and not output:
        ok = False
        error = error or "助手没有产出任何结果（RESULT.md 与 stdout 均为空）"

    return AgentResult(
        role=role_id,
        ok=ok,
        output=output,
        exit_code=exit_code,
        duration_s=round(duration, 2),
        stdout=stdout,
        stderr=stderr,
        error=error,
        job_dir=str(job_dir),
        artifacts=_collect_artifacts(job_dir),
    )


#: 表示"整条路由不可用"的错误标记。这类失败与任务本身无关，
#: 换一条可用路由重试是有意义的；其它失败（任务做不出来）重试只会白花钱。
ROUTE_FAILURE_TOKENS = ("AUTH:", "QUOTA:", "RATE:")


def _is_route_failure(res: AgentResult) -> bool:
    blob = f"{res.stderr}\n{res.output}\n{res.error or ''}"
    return any(tok in blob for tok in ROUTE_FAILURE_TOKENS)


def run_agent(
    role_id: str,
    task_md: str,
    job_dir: Path,
    *,
    on_delta: DeltaFn | None = None,
    timeout_s: int | None = None,
    cfg: AppConfig | None = None,
) -> AgentResult:
    """跑一个助手。若该角色配置的模型路由整体不可用，回退到兜底路由并**明确标注**。

    为什么需要回退：模型路由可能因为密钥失效或余额耗尽而整体不可用（实测
    xiaomi 返回 401、zai 返回 429、minimax 返回 402）。若某个角色恰好是流程入口
    （例如任务助手），整条链会直接瘫痪在原地。回退保证系统仍然可用，
    而 `fallback_from` / `fallback_reason` 保证这件事不会被悄悄掩盖。
    """
    cfg = cfg or AppConfig.load()
    setting = cfg.roles.get(role_id)
    if setting is None or not setting.enabled:
        return AgentResult(
            role=role_id, ok=False, output="", exit_code=-1, duration_s=0.0,
            error=f"角色 {role_id} 未启用或不存在", job_dir=str(job_dir),
        )

    # 禁用名单的最后一关：真正拉起进程之前再查一次。
    # AppConfig.load() 已经清洗过，这里防的是有人绕过它直接塞一个 cfg 进来。
    banned = {m.strip().lower() for m in (getattr(cfg, "forbidden_models", None) or [])}
    if (setting.model or "").strip().lower() in banned:
        return AgentResult(
            role=role_id, ok=False, output="", exit_code=-1, duration_s=0.0,
            error=(
                f"模型 {setting.model} 在禁用名单里（forbidden_models），拒绝执行。请改用其它模型。"
            ),
            job_dir=str(job_dir),
        )

    res = _spawn_agent(
        role_id, task_md, Path(job_dir),
        model=setting.model, provider=setting.provider, sandbox=setting.sandbox,
        default_timeout=setting.timeout_s, on_delta=on_delta, timeout_s=timeout_s,
    )

    want_fallback = (
        not res.ok
        and _is_route_failure(res)
        and bool(setting.model)
        and setting.model != cfg.fallback_model
    )
    if not want_fallback:
        return res

    alt = _spawn_agent(
        role_id, task_md, Path(job_dir),
        model=cfg.fallback_model, provider=cfg.fallback_provider, sandbox=setting.sandbox,
        default_timeout=setting.timeout_s, on_delta=on_delta, timeout_s=timeout_s,
    )
    if alt.ok:
        alt.fallback_from = f"{setting.provider}/{setting.model}"
        alt.fallback_reason = (res.error or res.stderr or "").strip()[:300]
        return alt
    # 兜底也失败：返回兜底的结果，但把原本的路由问题一并带上，便于定位
    alt.fallback_from = f"{setting.provider}/{setting.model}"
    alt.fallback_reason = (res.error or res.stderr or "").strip()[:300]
    return alt


def load_json_lenient(path: Path) -> dict | None:
    """读一个 JSON 文件，容忍被 Markdown 代码块包裹、或前后夹带说明文字的情况。"""
    path = Path(path)
    if not path.exists():
        return None
    raw = path.read_text(encoding="utf-8", errors="replace").strip()
    if raw.startswith("```"):
        lines = raw.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        raw = "\n".join(lines).strip()
    try:
        data = json.loads(raw)
    except Exception:
        # 退一步：截取第一个 { 到最后一个 }
        i, j = raw.find("{"), raw.rfind("}")
        if i == -1 or j <= i:
            return None
        try:
            data = json.loads(raw[i : j + 1])
        except Exception:
            return None
    return data if isinstance(data, dict) else None


def read_plan(job_dir: Path) -> dict | None:
    """读取任务助手产出的 PLAN.json。"""
    return load_json_lenient(Path(job_dir) / "PLAN.json")


def read_privilege_request(job_dir: Path) -> dict | None:
    """读取代码助手上交的提权请求。"""
    return load_json_lenient(Path(job_dir) / "PRIVILEGE_REQUEST.json")
