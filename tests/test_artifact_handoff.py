"""子任务间产物交接测试。

背景：每个子任务有独立的 job 目录。若不显式交接，下游子任务拿不到上游产生的文件
（构建产物、生成的脚本、打包好的文件），在"构建 -> 部署"这类链路上会真出问题。

本测试用桩验证：上游子任务的产出会出现在下游的 `from_<上游id>/` 下，
且 TASK.md 里会明确告知下游去哪里找。

    python tests/test_artifact_handoff.py
"""
from __future__ import annotations

import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import byk.orchestrator as O  # noqa: E402
from byk.bus import EventBus  # noqa: E402
from byk.models import SubTask, SubTaskState, TaskPlan, Turn  # noqa: E402
from byk.precedents import PrecedentStore, SecretStore  # noqa: E402

PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}  {detail}")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="byk-handoff-"))
    workdir = tmp / "t_ho"
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "EXTRACT.md").write_text("# 附件提取结果\n\n（本次没有附件）", encoding="utf-8")

    orch = O.Orchestrator.__new__(O.Orchestrator)
    orch.bus = EventBus()
    orch.cfg = O.AppConfig.load()
    orch.secrets = SecretStore(tmp / "s.json")
    orch.precedents = PrecedentStore(tmp / "p.json", orch.secrets)
    orch.turns, orch.runtimes = {}, {}
    orch._lock = threading.Lock()

    subs = [
        SubTask(id="st_1", title="构建产物", detail="生成构建产物", role="code"),
        SubTask(id="st_2", title="部署产物", detail="部署上游构建出来的产物",
                role="code", depends_on=["st_1"]),
    ]
    turn = Turn(turn_id="t_ho", session_id="s", user_text="构建并部署", workdir=str(workdir))
    turn.plan = TaskPlan(goal="构建并部署", subtasks=subs)
    turn.subtasks = [
        SubTaskState(id="st_1", title="构建产物", role="code", detail="生成构建产物"),
        SubTaskState(id="st_2", title="部署产物", role="code", detail="部署上游产物"),
    ]
    rt = O.TurnRuntime()

    seen: dict[str, object] = {}
    original = O.run_agent

    def stub_agent(role, task_md, job_dir, *, on_delta=None, timeout_s=None, cfg=None):
        job_dir = Path(job_dir)
        sid = job_dir.name
        seen[f"{sid}_task_md"] = task_md
        if sid == "st_1":
            # 上游产出：一个产物文件 + 一个嵌套目录里的文件 + 一份结果
            (job_dir / "dist").mkdir(exist_ok=True)
            (job_dir / "dist" / "app.bin").write_text("BINARY-PAYLOAD-42", encoding="utf-8")
            (job_dir / "dist" / "sub").mkdir(exist_ok=True)
            (job_dir / "dist" / "sub" / "deep.txt").write_text("deep", encoding="utf-8")
            (job_dir / "RESULT.md").write_text("# 构建完成\n\n产物在 dist/app.bin", encoding="utf-8")
            return O.AgentResult(role=role, ok=True, output="# 构建完成\n\n产物在 dist/app.bin",
                                 exit_code=0, duration_s=0.1, job_dir=str(job_dir))
        # 下游：检查上游产物是否交接过来
        staged = job_dir / "from_st_1"
        seen["from_exists"] = staged.is_dir()
        seen["from_app"] = (staged / "dist" / "app.bin").exists()
        seen["from_app_text"] = (
            (staged / "dist" / "app.bin").read_text(encoding="utf-8")
            if (staged / "dist" / "app.bin").exists() else ""
        )
        seen["from_deep"] = (staged / "dist" / "sub" / "deep.txt").exists()
        seen["from_task_md_copied"] = (staged / "TASK.md").exists()
        (job_dir / "RESULT.md").write_text("# 部署完成", encoding="utf-8")
        return O.AgentResult(role=role, ok=True, output="# 部署完成",
                             exit_code=0, duration_s=0.1, job_dir=str(job_dir))

    O.run_agent = stub_agent
    try:
        for s in subs:
            orch._run_subtask(turn, rt, s)
    finally:
        O.run_agent = original

    print("\n[1] 上游产物确实交接给了下游")
    check("下游 job 目录下存在 from_st_1/", seen.get("from_exists") is True)
    check("上游产物 dist/app.bin 已交接", seen.get("from_app") is True)
    check("交接内容与上游一致", seen.get("from_app_text") == "BINARY-PAYLOAD-42",
          repr(seen.get("from_app_text")))
    check("嵌套目录结构被保留", seen.get("from_deep") is True)
    check("上游的 TASK.md 不被复制（避免混淆）", seen.get("from_task_md_copied") is False)

    print("\n[2] 下游被告知去哪里找上游产物")
    md2 = str(seen.get("st_2_task_md") or "")
    check("TASK.md 里列出了 from_st_1/", "from_st_1" in md2)
    check("TASK.md 说明了那是上游产出", "上游" in md2)
    check("TASK.md 提醒不要去翻别的目录", "不要去翻别的目录" in md2)
    check("依赖产出摘要仍被内嵌", "构建完成" in md2, md2[:200])

    print("\n[3] 两个子任务都成功")
    check("st_1 成功", turn.subtasks[0].status == "succeeded", turn.subtasks[0].status)
    check("st_2 成功", turn.subtasks[1].status == "succeeded", turn.subtasks[1].status)

    print(f"\n{'=' * 50}\n通过 {PASS} 项，失败 {FAIL} 项")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
