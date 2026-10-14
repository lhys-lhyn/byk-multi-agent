"""提权往返流程的隔离测试。

真实的提权路径不可能在测试里真跑（那会真的动系统），所以这里把
`run_agent` 与 `run_privileged` 换成桩，专门验证编排器的**编排逻辑**：

    代码助手上交请求 -> 弹确认给用户 -> 用户批准 -> 编排器执行 -> 结果写回 -> 重新唤起助手继续

覆盖三个场景：
  A 批准且已绑定密钥 -> 真的执行，明文口令只出现在真正执行的命令里，先例计数累加
  B 用户拒绝          -> 一次都不执行
  C 批准但命令含占位符却未绑定密钥 -> 不执行，且确认弹层必须提前警告

    python tests/test_privilege_flow.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import byk.orchestrator as O  # noqa: E402
from byk.bus import EventBus  # noqa: E402
from byk.models import SubTask, SubTaskState, TaskPlan, Turn  # noqa: E402
from byk.precedents import MASK, SECRET_PLACEHOLDER, PrecedentStore, SecretStore  # noqa: E402

# 缩短等待，避免测试卡死半小时
O.CONFIRM_WAIT_S = 15

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


SECRET = "s3cr3t-root-pw"
SECRET_REF = "PRECEDENT_ROOT_PW_SRV1"
REQ = {
    "reason": "部署需要先结束占用 8080 端口的旧进程，该操作需要 root 权限",
    "command": f"ssh root@srv1 'echo {SECRET_PLACEHOLDER} | sudo -S systemctl stop byk-old'",
    "expected_effect": "旧进程被结束，端口 8080 释放",
    "precedent_hint": "杀进程,重启,端口占用",
    "risk": "medium",
}


def build_orch(tmp: Path, seed_precedent: bool):
    orch = O.Orchestrator.__new__(O.Orchestrator)
    orch.bus = EventBus()
    orch.cfg = O.AppConfig.load()
    orch.secrets = SecretStore(tmp / "secrets.json")
    orch.precedents = PrecedentStore(tmp / "precedents.json", orch.secrets)
    orch.turns = {}
    orch.runtimes = {}
    orch._lock = threading.Lock()
    orch.secrets.set(SECRET_REF, SECRET)
    if seed_precedent:
        orch.precedents.add(
            title="结束占用 8080 的旧进程",
            command_template=REQ["command"],
            keywords=["杀进程", "重启", "端口占用", "8080"],
            secret_ref=SECRET_REF,
        )
    return orch


def build_turn(tmp: Path) -> Turn:
    workdir = tmp / "t_priv"
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "EXTRACT.md").write_text("# 附件提取结果\n\n（本次没有附件）", encoding="utf-8")
    sub = SubTask(
        id="st_1", title="部署到 srv1", detail="把项目部署到 srv1 的 8080 端口",
        role="code", needs_privilege=True, acceptance="服务在 8080 端口可用",
    )
    turn = Turn(turn_id="t_priv", session_id="s_test", user_text="部署项目", workdir=str(workdir))
    turn.plan = TaskPlan(goal="把项目部署到 srv1", subtasks=[sub])
    turn.subtasks = [SubTaskState(id="st_1", title=sub.title, role="code", detail=sub.detail)]
    return turn


def run_scenario(*, approve: bool, seed_precedent: bool) -> dict:
    tmp = Path(tempfile.mkdtemp(prefix="byk-priv-"))
    orch = build_orch(tmp, seed_precedent)
    turn = build_turn(tmp)
    rt = O.TurnRuntime()
    # 关键：必须注册进编排器，否则 answer_confirmation 找不到等待中的事件
    orch.turns[turn.turn_id] = turn
    orch.runtimes[turn.turn_id] = rt

    calls: list[str] = []
    executed: list[str] = []
    original_agent, original_priv = O.run_agent, O.run_privileged

    def stub_agent(role, task_md, job_dir, *, on_delta=None, timeout_s=None, cfg=None):
        job_dir = Path(job_dir)
        calls.append(task_md)
        if len(calls) == 1:
            (job_dir / "PRIVILEGE_REQUEST.json").write_text(
                json.dumps(REQ, ensure_ascii=False), encoding="utf-8"
            )
            return O.AgentResult(role=role, ok=True, output="已完成代码审查，等待提权后继续部署",
                                 exit_code=0, duration_s=0.1, job_dir=str(job_dir))
        (job_dir / "RESULT.md").write_text("# 最终结果\n\n部署完成并验证通过。", encoding="utf-8")
        return O.AgentResult(role=role, ok=True, output="# 最终结果\n\n部署完成并验证通过。",
                             exit_code=0, duration_s=0.1, job_dir=str(job_dir))

    def stub_priv(command, timeout_s=300):
        executed.append(command)
        return True, "Stopped byk-old.service\n"

    O.run_agent, O.run_privileged = stub_agent, stub_priv
    try:
        q = orch.bus.subscribe(turn.turn_id)
        th = threading.Thread(target=orch._run_subtask, args=(turn, rt, turn.plan.subtasks[0]))
        th.start()

        conf = None
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                event, data = q.get(timeout=1)
            except Exception:
                continue
            if event == "confirmation":
                conf = data["confirmation"]
                break

        if conf:
            orch.answer_confirmation(conf["id"], approve, True)
        th.join(timeout=25)
        still_running = th.is_alive()
    finally:
        O.run_agent, O.run_privileged = original_agent, original_priv

    st = turn.subtasks[0]
    rf = Path(turn.workdir) / "st_1" / "PRIVILEGE_RESULTS.md"
    return {
        "conf": conf,
        "still_running": still_running,
        "executed": executed,
        "agent_calls": len(calls),
        "second_task_md": calls[1] if len(calls) > 1 else "",
        "results_text": rf.read_text(encoding="utf-8") if rf.exists() else "",
        "results_exists": rf.exists(),
        "status": st.status,
        "output": st.output,
        "precedents": orch.precedents.load(),
    }


def main() -> int:
    print("\n[场景 A] 批准提权，且已绑定密钥")
    a = run_scenario(approve=True, seed_precedent=True)
    conf = a["conf"]
    check("弹出了提权确认", conf is not None)
    check("确认弹层不含明文口令", conf is not None and SECRET not in conf["command_preview"])
    check("确认弹层展示了掩码", conf is not None and MASK in conf["command_preview"])
    check("确认弹层标注了密钥来源", conf is not None and "密钥引用" in conf["secret_source"])
    check("未标记为'需要密钥'", conf is not None and conf["requires_secret"] is False)
    check("匹配到了先例", conf is not None and conf["precedent_id"] is not None)
    check("特权命令执行了一次", len(a["executed"]) == 1, str(a["executed"]))
    check("真正执行的命令含明文口令（占位符确实被替换）",
          bool(a["executed"]) and SECRET in a["executed"][0], str(a["executed"])[:200])
    check("结果写回了 PRIVILEGE_RESULTS.md", a["results_exists"])
    check("回写内容含执行输出", "Stopped byk-old.service" in a["results_text"])
    check("回写内容已擦除口令", SECRET not in a["results_text"])
    check("助手被重新唤起（共 2 次调用）", a["agent_calls"] == 2, str(a["agent_calls"]))
    check("续跑说明告知'已批准'", "已批准" in a["second_task_md"], a["second_task_md"][:200])
    check("续跑说明引用 PRIVILEGE_RESULTS.md", "PRIVILEGE_RESULTS.md" in a["second_task_md"])
    check("子任务最终成功", a["status"] == "succeeded", a["status"])
    check("输出为第二轮最终产出", "部署完成" in a["output"], a["output"][:120])
    check("线程正常结束（无死锁）", not a["still_running"])
    check("先例库仍为 1 条（复用而非新建）", len(a["precedents"]) == 1, str(len(a["precedents"])))
    check("先例成功次数累加到 1", bool(a["precedents"]) and a["precedents"][0].success_count == 1)
    check("先例绑定密钥引用",
          bool(a["precedents"]) and a["precedents"][0].secret_ref == SECRET_REF)
    check("先例库中无明文口令",
          SECRET not in json.dumps([p.__dict__ for p in a["precedents"]],
                                   ensure_ascii=False, default=str))

    print("\n[场景 B] 用户拒绝提权")
    b = run_scenario(approve=False, seed_precedent=True)
    check("弹出了提权确认", b["conf"] is not None)
    check("特权命令一次都没执行", b["executed"] == [], str(b["executed"]))
    check("回写记录了用户拒绝", "拒绝" in b["results_text"], b["results_text"][:200])
    check("助手仍被重新唤起以交代未完成部分", b["agent_calls"] == 2, str(b["agent_calls"]))
    check("续跑说明告知'拒绝'", "拒绝" in b["second_task_md"], b["second_task_md"][:200])
    check("未执行则不写入先例库（成功次数仍为 0）",
          bool(b["precedents"]) and b["precedents"][0].success_count == 0)
    check("线程正常结束（无死锁）", not b["still_running"])

    print("\n[场景 C] 批准了，但命令含占位符却未绑定任何密钥")
    c = run_scenario(approve=True, seed_precedent=False)
    confc = c["conf"]
    check("弹出了提权确认", confc is not None)
    check("确认弹层警告了未绑定密钥", confc is not None and confc["requires_secret"] is True)
    check("警告文案说明了后果", confc is not None and "无法执行" in confc["secret_source"],
          confc["secret_source"] if confc else "")
    check("风险等级被提升为 high", confc is not None and confc["risk"] == "high")
    check("未绑定密钥时绝不执行命令", c["executed"] == [], str(c["executed"]))
    check("未执行则不写入先例库", len(c["precedents"]) == 0, str(len(c["precedents"])))
    check("线程正常结束（无死锁）", not c["still_running"])
    check("回写如实记录为「批准但未能执行」而非「拒绝」",
          "未能执行" in c["results_text"], c["results_text"][:300])
    check("续跑说明明确指出不是被用户拒绝",
          "不是" in c["second_task_md"] and "拒绝" in c["second_task_md"],
          c["second_task_md"][:300])
    check("续跑说明指出卡在缺少密钥引用", "密钥引用" in c["second_task_md"],
          c["second_task_md"][:300])
    check("助手仍被重新唤起（共 2 次调用）", c["agent_calls"] == 2, str(c["agent_calls"]))

    print(f"\n{'=' * 50}\n通过 {PASS} 项，失败 {FAIL} 项")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
