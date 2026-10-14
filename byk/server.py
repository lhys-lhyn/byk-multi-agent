"""FastAPI 服务：REST + SSE + 静态前端。路径与事件名严格遵循 docs/api-contract.md。"""
from __future__ import annotations

import json
import queue
from pathlib import Path
from typing import Any, Iterator

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import WEB, ensure_dirs
from .models import TaskPlan
from .orchestrator import Orchestrator
from .precedents import PrecedentStore, SecretStore
from .roles import role_list

ensure_dirs()

app = FastAPI(title="BYK 多智能体系统", version="1.0.0")
orch = Orchestrator()
precedents = PrecedentStore()
secrets = SecretStore()


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "version": "1"}


@app.get("/api/roles")
def roles() -> list[dict]:
    return role_list()


@app.get("/api/config")
def get_config() -> dict:
    cfg = orch.cfg
    return {
        "file_agent_threshold": cfg.file_agent_threshold,
        "max_parallel": cfg.max_parallel,
        "allow_privileged": cfg.allow_privileged,
        "roles": {
            rid: {
                "model": s.model,
                "provider": s.provider,
                "sandbox": s.sandbox,
                "timeout_s": s.timeout_s,
                "enabled": s.enabled,
            }
            for rid, s in cfg.roles.items()
        },
    }


@app.post("/api/turns")
async def create_turn(
    text: str = Form(""),
    session_id: str | None = Form(None),
    files: list[UploadFile] = File(default=[]),
) -> dict:
    payload: list[tuple[str, bytes]] = []
    for f in files or []:
        blob = await f.read()
        if blob:
            payload.append((f.filename or "upload", blob))
    if not text.strip() and not payload:
        raise HTTPException(status_code=400, detail="必须提供文字或至少一个文件")
    turn = orch.start_turn(text, payload, session_id)
    return {"session_id": turn.session_id, "turn_id": turn.turn_id}


@app.get("/api/turns/{turn_id}")
def get_turn(turn_id: str) -> dict:
    turn = orch.get_turn(turn_id)
    if turn is None:
        raise HTTPException(status_code=404, detail="回合不存在")
    return turn.to_dict()


@app.post("/api/turns/{turn_id}/confirm")
async def confirm_turn(turn_id: str, body: dict) -> dict:
    plan_raw = body.get("plan")
    if plan_raw is not None and not isinstance(plan_raw, dict):
        raise HTTPException(status_code=400, detail="plan 必须是对象或 null")
    ok = orch.confirm_plan(turn_id, bool(body.get("approved")), plan_raw)
    if not ok:
        raise HTTPException(status_code=404, detail="回合不存在")
    return {"ok": True}


@app.post("/api/turns/{turn_id}/cancel")
def cancel_turn(turn_id: str) -> dict:
    if not orch.cancel(turn_id):
        raise HTTPException(status_code=404, detail="回合不存在")
    return {"ok": True}


@app.post("/api/confirmations/{cid}")
async def answer_confirmation(cid: str, body: dict) -> dict:
    ok = orch.answer_confirmation(
        cid,
        bool(body.get("approved")),
        bool(body.get("remember", False)),
        body.get("secret_ref") or None,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="该确认请求不存在或已处理")
    return {"ok": True}


@app.get("/api/usage")
def usage(turn_id: str | None = None) -> dict:
    """真实 token 用量。带 turn_id 查单个回合，不带则汇总全部助手会话。"""
    from .usage import run_report, turn_usage

    if turn_id:
        u = turn_usage(turn_id)
        if u is None:
            raise HTTPException(status_code=404, detail="读不到该回合的用量（会话日志不存在或工具不可用）")
        return u
    data = run_report("jobs")
    if data is None:
        raise HTTPException(status_code=503, detail="计量工具不可用（需要 Node 与 tools/usage_report.js）")
    return data


@app.get("/api/precedents")
def list_precedents() -> list[dict]:
    return [
        {
            "id": p.id,
            "title": p.title,
            "match_keywords": p.match_keywords,
            "command_template": p.command_template,
            "secret_ref": p.secret_ref,
            "success_count": p.success_count,
            "last_used_at": p.last_used_at,
            "created_at": p.created_at,
        }
        for p in precedents.load()
    ]


@app.get("/api/secrets")
def list_secrets() -> dict:
    """只列出密钥引用名，永不返回值。"""
    return {"refs": secrets.list_refs()}


@app.post("/api/secrets")
async def set_secret(body: dict) -> dict:
    ref = str(body.get("ref") or "").strip()
    value = str(body.get("value") or "")
    if not ref or not value:
        raise HTTPException(status_code=400, detail="ref 与 value 都不能为空")
    secrets.set(ref, value)
    return {"ok": True, "refs": secrets.list_refs()}


@app.get("/api/events")
def events(turn_id: str) -> StreamingResponse:
    turn = orch.get_turn(turn_id)
    if turn is None:
        raise HTTPException(status_code=404, detail="回合不存在")
    q = orch.bus.subscribe(turn_id)
    terminal = turn.stage in ("completed", "failed", "cancelled")

    def stream() -> Iterator[str]:
        try:
            yield _sse("snapshot", turn.to_dict())
            # 回合已经结束了：快照里就是最终状态，没必要再挂着连接等永远不会来的事件
            if terminal:
                yield _sse("done", {"turn_id": turn_id, "stage": turn.stage})
                return
            while True:
                try:
                    event, data = q.get(timeout=20)
                except queue.Empty:
                    # 心跳，防止中间层断开空闲连接
                    yield ": keep-alive\n\n"
                    continue
                yield _sse(event, data)
                if event == "done":
                    break
        except GeneratorExit:
            return
        finally:
            orch.bus.unsubscribe(turn_id, q)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# 静态前端挂在最后，这样 /api/* 优先匹配。前端缺失时给一个最小提示页。
if WEB.exists() and (WEB / "index.html").exists():
    app.mount("/", StaticFiles(directory=str(WEB), html=True), name="web")
else:

    @app.get("/")
    def placeholder() -> JSONResponse:
        return JSONResponse(
            {
                "ok": False,
                "message": "前端尚未构建：web/index.html 不存在。API 仍可用。",
                "api": ["/api/health", "/api/roles", "/api/turns", "/api/events?turn_id=..."],
            }
        )


def main(host: str = "127.0.0.1", port: int = 8760) -> None:
    import uvicorn

    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
