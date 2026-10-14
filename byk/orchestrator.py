"""编排核心：接收输入 -> 本地提取 -> 任务助手规划 -> 用户确认 -> 并发派发助手 -> 提权处理 -> 汇总。

一次 turn 的完整生命周期跑在独立工作线程里；与界面的交互通过 EventBus（SSE）与
threading.Event（等待用户确认）完成。
"""
from __future__ import annotations

import concurrent.futures as cf
import shutil
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path

from .bus import EventBus
from .config import AppConfig, DATA, JOBS, MAX_EXTRACT_BYTES, UPLOADS, ensure_dirs
from .dsh_runner import (
    AgentResult,
    read_plan,
    read_privilege_request,
    run_agent,
)
from .models import (
    Confirmation,
    SubTask,
    SubTaskState,
    TaskPlan,
    Turn,
    new_id,
    now_iso,
)
from .precedents import SECRET_PLACEHOLDER, PrecedentStore, SecretStore, run_privileged
from .roles import ROLES

PLAN_WAIT_S = 1800          # 等待用户确认计划的最长时间
CONFIRM_WAIT_S = 1800       # 等待用户确认提权的最长时间
MAX_PRIVILEGE_ATTEMPTS = 3  # 同一子任务最多因提权往返的次数

#: 提权处理结果的如实措辞。区分"用户拒绝"与"用户批准但没能执行"很重要 ——
#: 后者若被说成前者，助手会误判自己的处境并给出错误结论。
DECISION_LABEL = {
    "executed": "批准，已执行成功",
    "exec_failed": "批准，已执行但失败",
    "denied": "拒绝",
    "timeout": "超时未应答",
    "not_allowed": "被编排器策略禁止",
    "no_secret": "批准，但因缺少可用密钥引用而未能执行",
}

VERDICT = {
    "executed": "已批准，并已由编排器以特权身份执行成功",
    "exec_failed": "已批准并执行，但命令执行失败",
    "denied": "被用户拒绝，未执行",
    "timeout": "等待用户确认超时，未执行",
    "not_allowed": "被编排器的策略禁止执行",
    "no_secret": "用户已批准，但因缺少可用的密钥引用而根本无法执行",
}

GUIDANCE = {
    "executed": "- 请继续完成剩余的步骤，并做最终的验证。",
    "exec_failed": "- 请分析失败原因，给出可行的替代方案或需要用户介入的具体事项。不要谎报成功。",
    "denied": "- 请说明哪些部分因缺少权限而未能完成，把已完成的部分整理清楚。",
    "timeout": "- 请说明该步骤因未获确认而搁置，并写明重新发起时需要用户做什么。",
    "not_allowed": "- 请说明该操作被策略禁止，并给出不需要特权的替代路径（如果有）。",
    "no_secret": "- 请说明该步骤卡在「缺少密钥引用」上，**不是**被用户拒绝；并写明需要用户先在密钥库录入哪个引用。",
}

EXTRACT_WARN = (
    "提取层不可用（byk.extract 未就绪）。请安装提取依赖后重试；"
    "本次仅使用用户直接输入的文本。"
)


def _try_extract(path: Path):
    """惰性调用提取层，缺失时降级而不是崩溃。"""
    try:
        from .extract import extract_file  # type: ignore
    except Exception as exc:  # 提取层尚未就绪
        class _R:
            def __init__(self, p: Path, e: str):
                self.path = str(p)
                self.name = p.name
                self.kind = "unknown"
                self.ok = False
                self.text = ""
                self.meta = {}
                self.error = e
                self.method = "unavailable"

            def to_dict(self) -> dict:
                return {
                    "path": self.path, "name": self.name, "kind": self.kind,
                    "ok": self.ok, "text": self.text, "meta": self.meta,
                    "error": self.error, "method": self.method,
                }

        return _R(path, f"{EXTRACT_WARN} ({exc})")
    try:
        return extract_file(str(path))
    except Exception as exc:
        from .models import to_dict  # noqa: F401

        class _R2:
            def __init__(self, p: Path, e: str):
                self.path = str(p)
                self.name = p.name
                self.kind = "unknown"
                self.ok = False
                self.text = ""
                self.meta = {}
                self.error = f"提取失败：{e}"
                self.method = "error"

            def to_dict(self) -> dict:
                return {
                    "path": self.path, "name": self.name, "kind": self.kind,
                    "ok": self.ok, "text": self.text, "meta": self.meta,
                    "error": self.error, "method": self.method,
                }

        return _R2(path, str(exc))


def _as_dict(obj) -> dict:
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    if hasattr(obj, "__dict__"):
        return dict(obj.__dict__)
    return {"value": str(obj)}


@dataclass
class TurnRuntime:
    plan_event: threading.Event = field(default_factory=threading.Event)
    plan_approved: bool = False
    plan_override: TaskPlan | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    pending: dict[str, threading.Event] = field(default_factory=dict)
    answers: dict[str, dict] = field(default_factory=dict)


class Orchestrator:
    def __init__(self, cfg: AppConfig | None = None) -> None:
        ensure_dirs()
        self.cfg = cfg or AppConfig.load()
        self.bus = EventBus()
        self.precedents = PrecedentStore()
        self.secrets = SecretStore()
        self.turns: dict[str, Turn] = {}
        self.runtimes: dict[str, TurnRuntime] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ 对外接口

    def start_turn(
        self, text: str, files: list[tuple[str, bytes]] | None = None, session_id: str | None = None
    ) -> Turn:
        turn_id = new_id("t")
        session_id = session_id or new_id("s")
        workdir = JOBS / turn_id
        workdir.mkdir(parents=True, exist_ok=True)

        attachments: list[dict] = []
        up_dir = UPLOADS / turn_id
        up_dir.mkdir(parents=True, exist_ok=True)
        for i, (name, blob) in enumerate(files or []):
            safe = Path(name).name or f"upload_{i}"
            dest = up_dir / safe
            n = 1
            while dest.exists():
                dest = up_dir / f"{dest.stem}_{n}{dest.suffix}"
                n += 1
            dest.write_bytes(blob)
            attachments.append(
                {
                    "id": f"a{i + 1}",
                    "name": dest.name,
                    "kind": "unknown",
                    "size": len(blob),
                    "path": str(dest),
                }
            )

        turn = Turn(
            turn_id=turn_id,
            session_id=session_id,
            user_text=text,
            attachments=attachments,
            workdir=str(workdir),
        )
        rt = TurnRuntime()
        with self._lock:
            self.turns[turn_id] = turn
            self.runtimes[turn_id] = rt

        threading.Thread(target=self._run_turn, args=(turn, rt), daemon=True).start()
        return turn

    def get_turn(self, turn_id: str) -> Turn | None:
        with self._lock:
            return self.turns.get(turn_id)

    def confirm_plan(self, turn_id: str, approved: bool, plan_raw: dict | None = None) -> bool:
        with self._lock:
            rt = self.runtimes.get(turn_id)
        if rt is None:
            return False
        if plan_raw:
            rt.plan_override = TaskPlan.from_raw(plan_raw)
        rt.plan_approved = approved
        rt.plan_event.set()
        return True

    def answer_confirmation(
        self, cid: str, approved: bool, remember: bool = False, secret_ref: str | None = None
    ) -> bool:
        with self._lock:
            for tid, rt in self.runtimes.items():
                if cid in rt.pending:
                    rt.answers[cid] = {
                        "approved": approved,
                        "remember": remember,
                        "secret_ref": secret_ref,
                    }
                    rt.pending[cid].set()
                    turn = self.turns.get(tid)
                    if turn and turn.pending_confirmation and turn.pending_confirmation.id == cid:
                        turn.pending_confirmation = None
                    return True
        return False

    def cancel(self, turn_id: str) -> bool:
        with self._lock:
            rt = self.runtimes.get(turn_id)
        if rt is None:
            return False
        rt.cancel.set()
        rt.plan_event.set()
        for ev in rt.pending.values():
            ev.set()
        return True

    # ------------------------------------------------------------------ 内部工具

    def _publish(self, turn: Turn, event: str, data: dict) -> None:
        self.bus.publish(turn.turn_id, event, data)

    def _set_stage(self, turn: Turn, stage: str) -> None:
        turn.stage = stage  # type: ignore[assignment]
        self._publish(turn, "stage", {"turn_id": turn.turn_id, "stage": stage})

    def _sub_state(self, turn: Turn, sid: str) -> SubTaskState | None:
        for s in turn.subtasks:
            if s.id == sid:
                return s
        return None

    def _emit_sub(self, turn: Turn, st: SubTaskState) -> None:
        self._publish(turn, "subtask", {"turn_id": turn.turn_id, "subtask": st.to_dict()})

    def _wait(self, ev: threading.Event, timeout: int, cancel: threading.Event) -> bool:
        """等待用户响应，可被取消打断。返回是否在超时前被设置。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if cancel.is_set():
                return False
            if ev.wait(timeout=1.0):
                return True
        return False

    # ------------------------------------------------------------------ 主流程

    def _run_turn(self, turn: Turn, rt: TurnRuntime) -> None:
        try:
            self._do_extract(turn)
            if rt.cancel.is_set():
                return self._finish_cancelled(turn)
            self._do_plan(turn, rt)
            # 规划阶段自己失败时已经把 stage 置为 failed，不能被下面的取消逻辑覆盖
            if turn.stage == "failed":
                return
            if rt.cancel.is_set() or not rt.plan_approved:
                return self._finish_cancelled(turn)
            self._do_execute(turn, rt)
            if rt.cancel.is_set():
                return self._finish_cancelled(turn)
            self._do_summary(turn)
            self._set_stage(turn, "completed")
            self._publish(turn, "done", {"turn_id": turn.turn_id, "stage": "completed"})
        except Exception as exc:  # 任何未预料的异常都要让界面看到，而不是静默卡住
            turn.error = f"编排过程出错：{exc}"
            self._publish(turn, "error", {"turn_id": turn.turn_id, "message": turn.error})
            self._set_stage(turn, "failed")
            self._publish(turn, "done", {"turn_id": turn.turn_id, "stage": "failed"})
            traceback.print_exc()

    def _finish_cancelled(self, turn: Turn) -> None:
        self._set_stage(turn, "cancelled")
        self._publish(turn, "done", {"turn_id": turn.turn_id, "stage": "cancelled"})

    # ---- 阶段 1：本地提取 ----

    def _do_extract(self, turn: Turn) -> None:
        self._set_stage(turn, "extracting")
        workdir = Path(turn.workdir)
        chunks: list[str] = []

        for att in turn.attachments:
            res = _try_extract(Path(att["path"]))
            d = _as_dict(res)
            att["kind"] = d.get("kind", "unknown")
            turn.extractions.append(d)
            self._publish(turn, "extraction", {"turn_id": turn.turn_id, "extraction": d})

            header = f"## {d.get('name')}（{d.get('kind')} / {d.get('method')}）"
            if d.get("ok"):
                body = (d.get("text") or "").strip()
                meta = d.get("meta") or {}
                extra = ""
                if meta:
                    extra = "\n\n元数据：`" + str(meta)[:2000] + "`"
                chunks.append(f"{header}\n\n{body or '（该文件没有可提取的文本内容）'}{extra}")
            else:
                chunks.append(f"{header}\n\n**提取失败**：{d.get('error')}")

            # 视频：让模型**直接观看**（画面 + 音轨一起读），比逐帧 OCR 完整得多
            if d.get("kind") == "video":
                chunks.append(self._watch_video(Path(att["path"]), d))

        # 无附件时也写一个占位文件，保证各角色读 EXTRACT.md 时不落空
        content = "# 附件提取结果\n\n" + ("\n\n---\n\n".join(chunks) if chunks else "（本次没有附件）")
        if len(content.encode("utf-8")) > MAX_EXTRACT_BYTES * 3:
            content = content[: MAX_EXTRACT_BYTES * 3] + "\n\n…（内容过长已截断）"
        (workdir / "EXTRACT.md").write_text(content, encoding="utf-8")

    def _watch_video(self, path: Path, d: dict) -> str:
        """让模型直接观看视频。失败就如实说明并保留抽帧结果，绝不阻塞流程。"""
        if not self.cfg.direct_video:
            return (
                "### 模型直接观看视频\n\n"
                "> 已关闭（`direct_video=false`）。当前内容来自本地抽帧 OCR 与音轨转写。\n"
            )
        try:
            from .video_ai import describe_video

            vu = describe_video(str(path), model=self.cfg.video_model)
        except Exception as exc:
            return f"### 模型直接观看视频\n\n**失败**：{exc}\n\n> 已回退为抽帧 OCR + 音轨转写结果（见上）。\n"

        if vu.ok:
            d.setdefault("meta", {})["direct_video_understanding"] = True
            return (
                f"### 模型直接观看视频（{vu.model}，画面与音轨一起读）\n\n"
                f"{vu.text}\n\n"
                "> 以上是模型**直接观看整段视频**得到的描述，包含画面内容与音轨信息，"
                "比逐帧 OCR 完整。上方「抽帧 OCR + 音轨转写」作为交叉校验保留。\n"
            )
        return (
            f"### 模型直接观看视频\n\n**失败**：{vu.error}\n\n"
            "> 已回退为抽帧 OCR + 音轨转写结果（见上）。\n"
        )

    # ---- 阶段 2：任务助手规划 ----

    def _do_plan(self, turn: Turn, rt: TurnRuntime) -> None:
        self._set_stage(turn, "planning")
        job_dir = Path(turn.workdir) / "plan"
        job_dir.mkdir(parents=True, exist_ok=True)

        extract_text = (Path(turn.workdir) / "EXTRACT.md").read_text(encoding="utf-8", errors="replace")
        att_lines = "\n".join(
            f"- {a['name']}（{a['kind']}，{a['size']} 字节）" for a in turn.attachments
        ) or "（无）"

        task_md = f"""# 任务：拆解用户诉求为可执行的子任务计划

## 用户的原始输入
{turn.user_text.strip() or '（用户没有输入文字，请根据附件内容推断其诉求）'}

## 用户随附的文件
{att_lines}

## 附件提取结果
以下是系统用本地解析器提取出的文件内容，请据此理解用户的真实诉求：

{extract_text}

## 你的产出要求
1. 把结构化计划写入同目录下的 `PLAN.json`（严格按你人格中给出的 schema）。
2. 把人类可读的计划摘要写入同目录下的 `RESULT.md`。
"""
        res = run_agent("task", task_md, job_dir, cfg=self.cfg)
        if not res.ok and not res.output:
            turn.error = f"任务助手执行失败：{res.error}"
            self._publish(turn, "error", {"turn_id": turn.turn_id, "message": turn.error})
            self._set_stage(turn, "failed")
            self._publish(turn, "done", {"turn_id": turn.turn_id, "stage": "failed"})
            rt.plan_event.set()
            return

        raw = read_plan(job_dir)
        if not raw:
            turn.error = "任务助手没有产出可解析的 PLAN.json，无法进入确认环节。"
            self._publish(turn, "error", {"turn_id": turn.turn_id, "message": turn.error})
            self._set_stage(turn, "failed")
            self._publish(turn, "done", {"turn_id": turn.turn_id, "stage": "failed"})
            rt.plan_event.set()
            return

        plan = TaskPlan.from_raw(raw)
        # 角色名兜底：非法角色一律退回 code，并在假设里说明
        for st in plan.subtasks:
            if st.role not in ROLES:
                plan.assumptions.append(f"子任务「{st.title}」的角色 `{st.role}` 不合法，已改为 code")
                st.role = "code"
        turn.plan = plan
        turn.subtasks = [
            SubTaskState(id=s.id, title=s.title, role=s.role, detail=s.detail) for s in plan.subtasks
        ]

        self._publish(turn, "plan", {"turn_id": turn.turn_id, "plan": plan.to_dict()})
        for st in turn.subtasks:
            self._emit_sub(turn, st)

        self._set_stage(turn, "awaiting_confirmation")
        self._wait(rt.plan_event, PLAN_WAIT_S, rt.cancel)

        if rt.cancel.is_set():
            return
        if rt.plan_override is not None:
            plan = rt.plan_override
            for st in plan.subtasks:
                if st.role not in ROLES:
                    st.role = "code"
            turn.plan = plan
            turn.subtasks = [
                SubTaskState(id=s.id, title=s.title, role=s.role, detail=s.detail)
                for s in plan.subtasks
            ]
            self._publish(turn, "plan", {"turn_id": turn.turn_id, "plan": plan.to_dict()})

    # ---- 阶段 3：并发派发 ----

    def _topo_waves(self, subs: list[SubTask]) -> list[list[SubTask]]:
        """按依赖分层，同层可并发。存在环时把剩余任务并入最后一层，避免死锁。"""
        remaining = {s.id: s for s in subs}
        done: set[str] = set()
        waves: list[list[SubTask]] = []
        while remaining:
            ready = [
                s for s in remaining.values()
                if all(d in done or d not in {x.id for x in subs} for d in s.depends_on)
            ]
            if not ready:
                waves.append(list(remaining.values()))
                break
            waves.append(ready)
            for s in ready:
                done.add(s.id)
                remaining.pop(s.id, None)
        return waves

    def _do_execute(self, turn: Turn, rt: TurnRuntime) -> None:
        self._set_stage(turn, "executing")
        plan = turn.plan
        assert plan is not None

        waves = self._topo_waves(plan.subtasks)
        for wave in waves:
            if rt.cancel.is_set():
                return
            # 依赖失败则直接标记 blocked
            runnable: list[SubTask] = []
            for s in wave:
                st = self._sub_state(turn, s.id)
                failed_deps = [
                    d for d in s.depends_on
                    if (ds := self._sub_state(turn, d)) is not None
                    and ds.status in ("failed", "blocked", "skipped")
                ]
                if failed_deps and st is not None:
                    st.status = "blocked"
                    st.error = f"前置子任务未成功完成：{', '.join(failed_deps)}"
                    st.finished_at = now_iso()
                    self._emit_sub(turn, st)
                else:
                    runnable.append(s)

            if not runnable:
                continue

            with cf.ThreadPoolExecutor(max_workers=max(1, self.cfg.max_parallel)) as pool:
                futures = {pool.submit(self._run_subtask, turn, rt, s): s for s in runnable}
                for fut in cf.as_completed(futures):
                    s = futures[fut]
                    try:
                        fut.result()
                    except Exception as exc:
                        st = self._sub_state(turn, s.id)
                        if st:
                            st.status = "failed"
                            st.error = f"派发异常：{exc}"
                            st.finished_at = now_iso()
                            self._emit_sub(turn, st)

    def _stage_dependency_artifacts(self, turn: Turn, sub: SubTask, job_dir: Path) -> list[str]:
        """把前置子任务的产出文件复制进本子任务的 from_<id>/ 目录。

        每个子任务有独立的 job 目录，若不交接，下游就只能去翻上游目录才能拿到产物
        （构建产物、生成的脚本、打包好的文件等）。显式交接让"上游产出 -> 下游使用"成立。
        """
        notes: list[str] = []
        budget = 200 * 1024 * 1024  # 单次交接的总字节预算，防止超大产物拖垮流程
        for dep_id in sub.depends_on:
            dep_state = self._sub_state(turn, dep_id)
            src = Path(turn.workdir) / dep_id
            if not src.is_dir():
                continue
            dst = job_dir / f"from_{dep_id}"
            copied = 0
            skipped = False
            for p in sorted(src.rglob("*")):
                if not p.is_file() or p.name == "TASK.md":
                    continue
                try:
                    size = p.stat().st_size
                except OSError:
                    continue
                if copied + size > budget:
                    skipped = True
                    break
                target = dst / p.relative_to(src)
                try:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(p, target)
                    copied += size
                except Exception:
                    continue
            label = dep_state.title if dep_state else dep_id
            note = f"`from_{dep_id}/` —— 前置子任务「{label}」的产出文件（{copied} 字节）"
            if skipped:
                note += "，**已超出 200MB 交接预算，其余文件未复制**"
            notes.append(note)
        return notes

    def _run_subtask(self, turn: Turn, rt: TurnRuntime, sub: SubTask) -> None:
        st = self._sub_state(turn, sub.id)
        if st is None:
            return
        st.status = "running"
        st.started_at = now_iso()
        self._emit_sub(turn, st)

        job_dir = Path(turn.workdir) / sub.id
        job_dir.mkdir(parents=True, exist_ok=True)

        # 材料就位：提取结果 + 附件实体副本 + 前置子任务产出
        shutil.copyfile(Path(turn.workdir) / "EXTRACT.md", job_dir / "EXTRACT.md")
        if turn.attachments:
            files_dir = job_dir / "files"
            files_dir.mkdir(exist_ok=True)
            for a in turn.attachments:
                try:
                    shutil.copyfile(a["path"], files_dir / a["name"])
                except Exception:
                    pass

        dep_notes = self._stage_dependency_artifacts(turn, sub, job_dir)
        task_md = self._build_subtask_md(turn, sub, dep_notes)
        started = time.time()

        def on_delta(stream: str, text: str) -> None:
            st.log_tail = (st.log_tail + text)[-8000:]
            self._publish(
                turn,
                "agent_delta",
                {
                    "turn_id": turn.turn_id,
                    "subtask_id": sub.id,
                    "stream": stream,
                    "text": text,
                },
            )

        res: AgentResult = run_agent(sub.role, task_md, job_dir, on_delta=on_delta, cfg=self.cfg)
        attempts = 0

        # 提权往返：代码助手上交 PRIVILEGE_REQUEST.json -> 用户确认 -> 编排器执行 -> 助手继续
        while res.ok and attempts < MAX_PRIVILEGE_ATTEMPTS and not rt.cancel.is_set():
            req = read_privilege_request(job_dir)
            if not req:
                break
            attempts += 1
            status, output, note = self._handle_privilege(turn, rt, sub, req)
            label = DECISION_LABEL.get(status, status)
            with (job_dir / "PRIVILEGE_RESULTS.md").open("a", encoding="utf-8") as fh:
                fh.write(f"\n\n## 第 {attempts} 次特权请求\n\n")
                fh.write(f"- 理由：{req.get('reason', '')}\n")
                fh.write(f"- 命令：`{req.get('command', '')}`\n")
                fh.write(f"- 用户决定与执行结果：{label}\n")
                fh.write(f"- 结果：\n\n```\n{output}\n```\n")
                if note:
                    fh.write(f"\n{note}\n")
            try:
                (job_dir / "PRIVILEGE_REQUEST.json").unlink()
            except Exception:
                pass
            st.log_tail += f"\n[编排器] 提权处理结果：{label}\n"
            self._emit_sub(turn, st)
            task_md = self._build_continuation_md(turn, sub, status)
            res = run_agent(sub.role, task_md, job_dir, on_delta=on_delta, cfg=self.cfg)

        st.duration_s = round(time.time() - started, 2)
        st.finished_at = now_iso()
        st.output = res.output
        st.artifacts = res.artifacts

        # 路由回退必须被看见，绝不能静默降级
        if res.fallback_from:
            notice = (
                f"⚠ 路由回退：本子任务原定使用 `{res.fallback_from}`，"
                f"但该路由整体不可用，已改用兜底路由执行。原因：{res.fallback_reason}"
            )
            st.log_tail = f"[编排器] {notice}\n{st.log_tail}"
            st.output = f"> {notice}\n\n{st.output}" if st.output else f"> {notice}"

        # 达到提权往返上限后仍留着未处理的请求：这是"卡在等权限"，不是成功
        leftover = job_dir / "PRIVILEGE_REQUEST.json"
        if leftover.exists():
            st.status = "blocked"
            st.error = (
                f"达到提权往返上限（{MAX_PRIVILEGE_ATTEMPTS} 次）后仍存在未处理的提权请求，"
                "该子任务卡在等待权限上。请在界面或先例库中处理好密钥后重新发起。"
            )
        elif res.ok:
            st.status = "succeeded"
            st.error = None
        else:
            st.status = "failed"
            st.error = res.error or "助手执行失败"
        self._emit_sub(turn, st)

    def _build_subtask_md(self, turn: Turn, sub: SubTask, dep_notes: list[str] | None = None) -> str:
        plan = turn.plan
        goal = plan.goal if plan else ""
        deps_txt = ""
        for d in sub.depends_on:
            ds = self._sub_state(turn, d)
            if ds and ds.output:
                deps_txt += f"\n### 前置子任务 {ds.id}「{ds.title}」（{ds.role}）的产出\n\n{ds.output[:20000]}\n"

        att_files = "\n".join(f"- `files/{a['name']}`" for a in turn.attachments) or "（无）"
        staged = ""
        if dep_notes:
            staged = "\n### 上游交接过来的文件（可直接读写）\n" + "\n".join(
                f"- {n}" for n in dep_notes
            ) + "\n"
        priv = (
            "本子任务被判定为**可能需要特权操作**。如需提权，严格按你人格中的 PRIVILEGE_REQUEST.json 协议上交，不要自行提权。"
            if sub.needs_privilege
            else "如执行中意外发现需要提权，同样按 PRIVILEGE_REQUEST.json 协议上交，不要自行提权。"
        )

        return f"""# 子任务：{sub.title}

## 总目标
{goal}

## 用户的原始诉求
{turn.user_text.strip() or '（见附件）'}

## 你要做的事
{sub.detail}

## 验收标准
{sub.acceptance or '产出可验证的结果，并在 RESULT.md 中给出证据'}

## 可用材料
- 同目录 `EXTRACT.md`：附件的本地提取结果（OCR / 转写 / 文档正文）
- 同目录 `files/`：用户上传的原始文件副本
{att_files}
{staged}{deps_txt}
## 纪律
{priv}
- 你的工作目录是本子任务专属的，**上游子任务的文件不会自动出现在这里**，只会通过上面的
  `from_<子任务 id>/` 目录交接过来。需要上游产物时先看那里，不要去翻别的目录。
- 完成后把完整结果写入同目录 `RESULT.md`，回复里只给不超过 10 行的摘要。
"""

    def _build_continuation_md(self, turn: Turn, sub: SubTask, status: str) -> str:
        verdict = VERDICT.get(status, status)
        guidance = GUIDANCE.get(status, "- 请根据 PRIVILEGE_RESULTS.md 中的实际情况继续。")
        return f"""# 子任务（续）：{sub.title}

你上一次执行时上交了提权请求。编排器处理后的**真实结果**是：**{verdict}**。

同目录下的 `PRIVILEGE_RESULTS.md` 记录了该请求的理由、确切命令与执行输出，请先用 read 工具完整读取它。

## 接下来做什么
{guidance}
- 无论哪种情况都不要谎报成功。把真实完成到什么程度、卡在哪里，如实写清楚。

## 你的产出要求
把**完整的最终结果**重新写入同目录 `RESULT.md`（覆盖上一版），包含：已完成的工作、验证证据（命令与输出）、未完成的部分及原因。
"""

    # ---- 提权：匹配先例 -> 用户确认 -> 编排器执行 ----

    def _handle_privilege(
        self, turn: Turn, rt: TurnRuntime, sub: SubTask, req: dict
    ) -> tuple[str, str, str]:
        """返回 (status, output, note)。

        status 用于把真实结果如实转述给助手 —— 尤其是"用户批准了但没能执行"
        必须与"用户拒绝了"区分开，否则助手会误判自己的处境。
        """
        reason = str(req.get("reason") or "")
        command = str(req.get("command") or "")
        hint = str(req.get("precedent_hint") or "")
        risk = str(req.get("risk") or "medium")

        precedent, why = self.precedents.match(reason, command, hint)
        secret_ref = precedent.secret_ref if precedent else None
        needs_secret = SECRET_PLACEHOLDER in command
        # 有占位符却没绑定密钥引用：批准了也执行不了，必须在确认弹层里说清楚
        unbound = needs_secret and not secret_ref
        preview = self.precedents.preview(command, secret_ref)

        if not self.cfg.allow_privileged:
            return "not_allowed", "编排器配置为不允许执行特权命令（allow_privileged=false）", ""

        if unbound:
            secret_source = (
                "⚠ 该命令含 {{secret}} 占位符，但没有匹配到任何已绑定密钥的先例。"
                "即使批准也无法执行 —— 请在批准时指定密钥引用，或先用 "
                "`python -m byk precedent add --secret-ref <引用名>` 录入先例。"
            )
        elif secret_ref:
            secret_source = f"密钥引用 {secret_ref}（来自本地密钥库，不回显明文）"
        else:
            secret_source = "无需密钥"

        cid = new_id("c")
        conf = Confirmation(
            id=cid,
            kind="privilege",
            title=f"子任务「{sub.title}」请求提权",
            reason=f"{reason}\n\n{why}",
            command_preview=preview,
            precedent_id=precedent.id if precedent else None,
            secret_source=secret_source,
            risk="high" if unbound else risk,
            turn_id=turn.turn_id,
            subtask_id=sub.id,
            requires_secret=unbound,
            secret_ref=secret_ref,
        )
        turn.pending_confirmation = conf
        ev = threading.Event()
        rt.pending[cid] = ev
        self._publish(turn, "confirmation", {"turn_id": turn.turn_id, "confirmation": conf.to_dict()})
        if (st_now := self._sub_state(turn, sub.id)) is not None:
            self._emit_sub(turn, st_now)

        got = self._wait(ev, CONFIRM_WAIT_S, rt.cancel)
        answer = rt.answers.pop(cid, None)
        rt.pending.pop(cid, None)
        turn.pending_confirmation = None

        if not got or not answer:
            return "timeout", "等待用户确认超时，特权命令未执行", ""
        if not answer.get("approved"):
            return "denied", "用户拒绝了该特权操作", ""

        # 用户在批准时可以临时指定/覆盖密钥引用
        chosen_ref = answer.get("secret_ref") or secret_ref
        final_cmd, err = self.precedents.build_command(command, chosen_ref)
        if err:
            if SECRET_MISSING_HINT in err:
                return "no_secret", err, "请先录入该密钥引用，然后重新发起该子任务。"
            return "no_secret", err, ""

        ok, output = run_privileged(final_cmd)
        if ok:
            p = self.precedents.record_success(command, reason, hint, chosen_ref)
            note = f"已记入先例库（{p.id}，累计成功 {p.success_count} 次）"
        else:
            note = "本次执行未成功，未记入先例库"
        # 输出里可能含密钥，回写前先掩码
        safe_output = output
        if chosen_ref:
            val = self.secrets.get(chosen_ref)
            if val:
                safe_output = safe_output.replace(val, "••••••••")
        return ("executed" if ok else "exec_failed"), safe_output, note

    # ---- 阶段 4：汇总 ----

    def _do_summary(self, turn: Turn) -> None:
        self._set_stage(turn, "summarizing")
        plan = turn.plan
        lines: list[str] = []
        lines.append("# 任务执行汇总\n")
        if plan:
            lines.append(f"**总目标**：{plan.goal}\n")
        ok_n = sum(1 for s in turn.subtasks if s.status == "succeeded")
        lines.append(
            f"**结果**：{len(turn.subtasks)} 个子任务，成功 {ok_n} 个，"
            f"失败 {sum(1 for s in turn.subtasks if s.status == 'failed')} 个，"
            f"阻塞 {sum(1 for s in turn.subtasks if s.status == 'blocked')} 个。\n"
        )
        lines.append("| 子任务 | 负责角色 | 状态 | 耗时 |")
        lines.append("| --- | --- | --- | --- |")
        for s in turn.subtasks:
            lines.append(
                f"| {s.title} | {ROLES[s.role].name if s.role in ROLES else s.role} | "
                f"{s.status} | {s.duration_s if s.duration_s is not None else '-'}s |"
            )
        lines.append("")
        lines.append("## 各子任务产出\n")
        for s in turn.subtasks:
            lines.append(f"### {s.id} · {s.title}（{ROLES[s.role].name if s.role in ROLES else s.role}）\n")
            if s.status == "succeeded":
                lines.append(s.output or "（助手未给出文本产出）")
            else:
                lines.append(f"**未成功**（{s.status}）：{s.error or '无详细信息'}")
            lines.append("")
        if turn.attachments:
            lines.append("## 附件\n")
            for a in turn.attachments:
                lines.append(f"- {a['name']}（{a['kind']}）")

        # 把真实花费摊在明面上：读自 DSH 会话日志，不是估算
        try:
            from .usage import format_usage, turn_usage

            u = turn_usage(turn.turn_id)
            if u:
                turn.usage = u
                lines.append("")
                lines.append(format_usage(u))
        except Exception:
            pass  # 计量失败绝不能影响汇总本身

        turn.summary = "\n".join(lines)
        self._publish(turn, "summary", {"turn_id": turn.turn_id, "summary": turn.summary})


SECRET_MISSING_HINT = "找不到"
