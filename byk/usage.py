"""读取助手会话的真实 token 用量。

为什么走 Node：DSH 的会话日志是「每行一个 zstd 帧」的拼接容器，
Python 的标准库没有 zstd（3.14 才有），而 Node 本来就运行时内置了。
Node 是本系统的硬依赖（每个助手都是被 Node 拉起来的），所以直接复用
`tools/usage_report.js`，不额外引入 Python 依赖。
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from .config import NODE, ROOT

TOOL = ROOT / "tools" / "usage_report.js"


def sessions_dir() -> Path:
    """定位 DSH 的会话日志目录。"""
    home = os.environ.get("DSH_HOME")
    if home:
        return Path(home) / "sessions"
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "com.yeagoo.dsh-desktop" / "harness" / "sessions"
    return Path.home() / ".dsh" / "sessions"


def run_report(mode: str = "jobs", turn: str | None = None, timeout_s: int = 180) -> dict | None:
    """调用计量工具，返回解析后的 JSON；失败返回 None（绝不抛异常）。"""
    if not TOOL.exists():
        return None
    cmd = [NODE, str(TOOL), str(sessions_dir()), mode, "--json"]
    if turn:
        cmd.append(f"--turn={turn}")
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout_s
        )
    except Exception:
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    try:
        return json.loads(proc.stdout)
    except Exception:
        return None


def turn_usage(turn_id: str) -> dict | None:
    """某个回合的真实用量汇总。"""
    data = run_report("jobs", turn_id)
    if not data:
        return None
    t = data.get("totals") or {}
    return {
        "turn_id": turn_id,
        "sessions": data.get("sessions", 0),
        "model_requests": t.get("steps", 0),
        "input_tokens": t.get("input", 0),
        "output_tokens": t.get("output", 0),
        "cache_read_tokens": t.get("cache", 0),
        "reasoning_tokens": t.get("reasoning", 0),
        "web_search_requests": t.get("search", 0),
        "by_model": data.get("byModel") or {},
    }


def format_usage(u: dict) -> str:
    """把用量渲染成汇总里的一段 Markdown。"""
    bm = u.get("by_model") or {}
    lines = [
        "## 本次真实用量",
        "",
        f"- 助手会话：{u['sessions']} 个；模型请求：{u['model_requests']} 次",
        f"- 输入 token：{u['input_tokens']:,}；缓存命中：{u['cache_read_tokens']:,}",
        f"- 输出 token：{u['output_tokens']:,}（其中推理 {u['reasoning_tokens']:,}）",
        f"- `web_search` 独立请求：{u['web_search_requests']} 次（单独计费）",
    ]
    if bm:
        lines.append("")
        lines.append("| 模型 | 请求 | 输入 | 缓存命中 | 输出 |")
        lines.append("| --- | --- | --- | --- | --- |")
        for name, v in sorted(bm.items(), key=lambda kv: -kv[1].get("output", 0)):
            lines.append(
                f"| {name} | {v.get('steps', 0)} | {v.get('input', 0):,} | "
                f"{v.get('cache', 0):,} | {v.get('output', 0):,} |"
            )
    lines.append("")
    lines.append(
        "> 用量直接读自 DSH 会话日志，是实际发生值而非估算。"
        "想降低开销：改 `config.json` 里的角色模型，或给检索类任务设定更小的检索轮次。"
    )
    return "\n".join(lines)
