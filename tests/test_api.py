"""HTTP 契约测试：参数校验、错误码、密钥不回显、SSE 收尾行为。

用 httpx 的 ASGI 传输直接打 app，不起端口、不拉助手进程，所以很快。

    python tests/test_api.py
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from byk.models import Turn  # noqa: E402
from byk.server import app, orch  # noqa: E402

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


def parse_sse(text: str) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    event = None
    for line in text.splitlines():
        line = line.rstrip("\r")
        if line.startswith("event:"):
            event = line.split(":", 1)[1].strip()
        elif line.startswith("data:") and event:
            out.append((event, json.loads(line.split(":", 1)[1].strip())))
    return out


async def main() -> int:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=30) as c:
        print("\n[1] 基础端点")
        r = await c.get("/api/health")
        check("health 返回 200", r.status_code == 200, str(r.status_code))
        check("health 含 ok", r.json().get("ok") is True)

        r = await c.get("/api/roles")
        check("roles 返回 200", r.status_code == 200)
        ids = [x["id"] for x in r.json()]
        check("恰好 7 个角色且 id 正确",
              ids == ["task", "code", "vision", "file", "audio", "research", "search"], str(ids))
        check("每个角色都带 model 与 description",
              all(x.get("model") and x.get("description") for x in r.json()))
        note = next(x["note"] for x in r.json() if x["id"] == "vision")
        check("视觉助手如实说明了当前图像能力",
              ("read_image" in note) or ("无可用图像模型路由" in note), note[:70])
        if "read_image" in note:
            print("        （当前图像路由可用，视觉助手为直读原图模式）")
        else:
            print("        （当前无可用图像路由，视觉助手为 OCR 兜底模式）")

        print("\n[2] 参数校验")
        r = await c.post("/api/turns", data={"text": "   "})
        check("空文本且无文件时返回 400", r.status_code == 400, str(r.status_code))

        print("\n[3] 不存在资源的错误码")
        r = await c.get("/api/turns/t_nonexistent")
        check("未知回合返回 404", r.status_code == 404, str(r.status_code))
        r = await c.post("/api/turns/t_nonexistent/confirm", json={"approved": True})
        check("确认未知回合返回 404", r.status_code == 404, str(r.status_code))
        r = await c.post("/api/turns/t_nonexistent/cancel")
        check("取消未知回合返回 404", r.status_code == 404, str(r.status_code))
        r = await c.post("/api/confirmations/c_nope", json={"approved": True})
        check("应答未知确认返回 404", r.status_code == 404, str(r.status_code))
        r = await c.get("/api/events", params={"turn_id": "t_nonexistent"})
        check("订阅未知回合的事件返回 404", r.status_code == 404, str(r.status_code))

        print("\n[4] 密钥接口永不回显值")
        secret_value = "top-secret-value-9c1f"
        r = await c.post("/api/secrets", json={"ref": "TEST_REF_A", "value": secret_value})
        check("写入密钥返回 200", r.status_code == 200, str(r.status_code))
        r = await c.get("/api/secrets")
        body = r.text
        check("列表里有该引用", "TEST_REF_A" in body)
        check("响应体中不含密钥明文", secret_value not in body, body[:200])
        check("响应体里没有 value 字段", '"value"' not in body, body[:200])
        r = await c.post("/api/secrets", json={"ref": "", "value": "x"})
        check("空 ref 返回 400", r.status_code == 400, str(r.status_code))
        r = await c.post("/api/secrets", json={"ref": "X", "value": ""})
        check("空 value 返回 400", r.status_code == 400, str(r.status_code))

        print("\n[5] 先例接口不回显值")
        r = await c.get("/api/precedents")
        check("先例列表返回 200", r.status_code == 200)
        check("先例列表是数组", isinstance(r.json(), list))
        check("先例列表不含密钥明文", secret_value not in r.text)

        print("\n[6] 已结束回合的 SSE 应立即收尾（不能永久挂着）")
        tid = "t_finished_test"
        t = Turn(turn_id=tid, session_id="s_x", user_text="测试", workdir=str(Path(".").resolve()))
        t.stage = "completed"
        t.summary = "已完成"
        with orch._lock:
            orch.turns[tid] = t
        r = await c.get("/api/events", params={"turn_id": tid})
        check("SSE 返回 200", r.status_code == 200, str(r.status_code))
        events = parse_sse(r.text)
        names = [e for e, _ in events]
        check("先发 snapshot", bool(names) and names[0] == "snapshot", str(names))
        check("随后立即发 done", "done" in names, str(names))
        snap = next(d for e, d in events if e == "snapshot")
        check("快照含最终阶段", snap.get("stage") == "completed", str(snap.get("stage")))
        check("快照含汇总", snap.get("summary") == "已完成")

        print("\n[7] 配置端点")
        r = await c.get("/api/config")
        check("config 返回 200", r.status_code == 200)
        cfg = r.json()
        check("config 含 roles", "roles" in cfg)
        check("code 角色沙箱为 danger-full-access",
              cfg["roles"]["code"]["sandbox"] == "danger-full-access",
              str(cfg["roles"]["code"]))
        check("config 不含任何密钥", secret_value not in r.text)

    print(f"\n{'=' * 50}\n通过 {PASS} 项，失败 {FAIL} 项")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
