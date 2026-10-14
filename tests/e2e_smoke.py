"""端到端冒烟验收：走真实 HTTP + SSE，跑一次完整回合。

用法：
    python tests/e2e_smoke.py ["你的测试任务文本" [附件路径 ...]]

它会：起真实服务 -> 建回合 -> 订阅 SSE -> 自动确认计划与提权 -> 等 done -> 打印结果与断言。
注意：这会真实拉起 DSH 助手进程，消耗模型额度，耗时数分钟。
"""
from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

# 允许直接 `python tests/e2e_smoke.py` 运行：把项目根加入模块搜索路径
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
import uvicorn  # noqa: E402

PORT = 8793
BASE = f"http://127.0.0.1:{PORT}"
WALL_CLOCK_LIMIT = 1500

DEFAULT_TASK = (
    "帮我做一次小规模的技术调研：查一下 Python 3.11 的正式发布日期是哪天，"
    "并给出可核查的来源链接。最后用不超过 5 行总结。"
)


def start_server() -> None:
    from byk.server import app

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


def wait_ready(timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    with httpx.Client(timeout=5) as c:
        while time.time() < deadline:
            try:
                if c.get(f"{BASE}/api/health").status_code == 200:
                    return
            except Exception:
                pass
            time.sleep(0.5)
    raise RuntimeError("服务在 60 秒内没有就绪")


def main() -> int:
    task = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TASK
    file_paths = [Path(p) for p in sys.argv[2:]]
    missing = [p for p in file_paths if not p.is_file()]
    if missing:
        print(f"[e2e] 附件不存在：{missing}")
        return 2

    threading.Thread(target=start_server, daemon=True).start()
    wait_ready()
    print("[e2e] 服务已就绪")

    with httpx.Client(timeout=120) as c:
        roles = c.get(f"{BASE}/api/roles").json()
        print(f"[e2e] 角色数：{len(roles)} -> {[r['id'] for r in roles]}")

        uploads = []
        for p in file_paths:
            uploads.append(("files", (p.name, p.read_bytes(), "application/octet-stream")))
            print(f"[e2e] 附带文件：{p.name}（{p.stat().st_size} 字节）")

        resp = c.post(f"{BASE}/api/turns", data={"text": task}, files=uploads or None)
        if resp.status_code != 200:
            print(f"[e2e] 创建回合失败 {resp.status_code}: {resp.text}")
            return 1
        ids = resp.json()
        turn_id = ids["turn_id"]
        print(f"[e2e] 回合已创建：{turn_id}")

    stages: list[str] = []
    events: list[str] = []
    confirmed_plan = False
    answered_conf: set[str] = set()
    done_stage: str | None = None
    started = time.time()

    # SSE 用独立连接，确认操作用另一个 client，避免同一个 client 上的流把请求堵住
    stream_client = httpx.Client(timeout=httpx.Timeout(30.0, read=None))
    action_client = httpx.Client(timeout=60)

    try:
        with stream_client.stream("GET", f"{BASE}/api/events", params={"turn_id": turn_id}) as s:
            event = None
            for raw in s.iter_lines():
                if time.time() - started > WALL_CLOCK_LIMIT:
                    print("[e2e] 超出墙钟上限，放弃等待")
                    break
                line = raw.rstrip("\r")
                if not line:
                    continue
                if line.startswith(":"):
                    continue
                if line.startswith("event:"):
                    event = line.split(":", 1)[1].strip()
                    events.append(event)
                    continue
                if not line.startswith("data:"):
                    continue
                data = json.loads(line.split(":", 1)[1].strip())

                if event == "stage":
                    stages.append(data["stage"])
                    print(f"[e2e] 阶段 -> {data['stage']}")
                elif event == "plan" and not confirmed_plan:
                    confirmed_plan = True
                    plan = data["plan"]
                    print(f"[e2e] 收到计划：目标={plan['goal'][:60]!r} 子任务={len(plan['subtasks'])}")
                    for st in plan["subtasks"]:
                        print(f"        - {st['id']} [{st['role']}] {st['title']}")
                    r = action_client.post(
                        f"{BASE}/api/turns/{turn_id}/confirm", json={"approved": True}
                    )
                    print(f"[e2e] 已确认计划：{r.status_code}")
                elif event == "confirmation":
                    conf = data["confirmation"]
                    cid = conf["id"]
                    if cid in answered_conf:
                        continue
                    answered_conf.add(cid)
                    print(f"[e2e] 提权确认请求：{conf['title']}")
                    print(f"        命令预览：{conf['command_preview'][:120]}")
                    r = action_client.post(
                        f"{BASE}/api/confirmations/{cid}", json={"approved": True, "remember": True}
                    )
                    print(f"[e2e] 已批准提权：{r.status_code}")
                elif event == "subtask":
                    st = data["subtask"]
                    print(f"[e2e] 子任务 {st['id']} [{st['role']}] -> {st['status']}")
                elif event == "error":
                    print(f"[e2e] !! 错误：{data['message']}")
                elif event == "done":
                    done_stage = data["stage"]
                    print(f"[e2e] done -> {done_stage}")
                    break
                elif event == "snapshot":
                    print(f"[e2e] 收到初始快照，stage={data['stage']}")
    finally:
        stream_client.close()

    with httpx.Client(timeout=60) as c:
        final = c.get(f"{BASE}/api/turns/{turn_id}").json()

    print("\n" + "=" * 70)
    print(f"最终阶段：{final['stage']}")
    print(f"错误：{final['error']}")
    print(f"子任务：")
    for st in final["subtasks"]:
        print(f"  - {st['id']} [{st['role']}] {st['status']} ({st['duration_s']}s) {st['title']}")
        if st["error"]:
            print(f"      错误：{st['error'][:200]}")
    print(f"\n汇总长度：{len(final['summary'] or '')} 字符")
    print("-" * 70)
    print((final["summary"] or "")[:4000])
    print("=" * 70)

    # ---- 断言 ----
    checks: list[tuple[str, bool, str]] = []
    checks.append(("回合到达 completed", final["stage"] == "completed", final["stage"]))
    checks.append(("计划已生成", bool(final["plan"]), str(bool(final["plan"]))))
    checks.append(
        (
            "至少一个子任务成功",
            any(s["status"] == "succeeded" for s in final["subtasks"]),
            str([s["status"] for s in final["subtasks"]]),
        )
    )
    checks.append(("汇总非空", bool(final["summary"]), str(len(final["summary"] or ""))))
    checks.append(("经历了等待确认阶段", "awaiting_confirmation" in stages, str(stages)))
    checks.append(("SSE 收到 done", done_stage is not None, str(done_stage)))

    if file_paths:
        ex = final["extractions"]
        print("\n附件提取结果：")
        for e in ex:
            print(f"  - {e['name']}: kind={e['kind']} ok={e['ok']} "
                  f"method={e.get('method')} 文本={len(e.get('text') or '')} 字符"
                  + (f" 错误={e.get('error')}" if e.get("error") else ""))
        checks.append(("附件数量匹配", len(ex) == len(file_paths), f"{len(ex)} vs {len(file_paths)}"))
        checks.append(("全部附件提取成功", all(e["ok"] for e in ex),
                       str([(e["name"], e["ok"]) for e in ex])))
        checks.append(("至少一个附件有非空文本",
                       any((e.get("text") or "").strip() for e in ex),
                       str([len(e.get("text") or "") for e in ex])))

    print("\n断言结果：")
    failed = 0
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}  ({detail})")
        if not ok:
            failed += 1
    print(f"\n{'全部通过' if failed == 0 else f'{failed} 项未通过'}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
