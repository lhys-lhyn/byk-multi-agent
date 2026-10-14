"""`byk/video_ai.py` 的离线测试 —— 全部用桩，不发任何真实请求、不产生费用。

重点是两类容易出错的地方：
1. **错误处理**：文件缺失/空文件/超限/无密钥/HTTP 错误/网络异常，都必须返回 ok=False 且带明确原因，
   绝不抛异常（编排器要能继续跑）。
2. **请求格式与响应解析**：必须用 `video_url` + data URL；正文为空但内容落在
   `reasoning_content` 时必须能取到 —— 这正是我第一次探测时被误判为"模型没读到"的原因。

    python tests/test_video_ai.py
"""
from __future__ import annotations

import base64
import json
import sys
import tempfile
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import byk.video_ai as V  # noqa: E402

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


class FakeResp:
    def __init__(self, body: str, status: int = 200):
        self._body = body.encode("utf-8")
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def install(monkeypatch_target, result):
    """把 urlopen 换成桩，并记录下来收到的请求。"""
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.headers)
        captured["payload"] = json.loads(req.data.decode("utf-8"))
        captured["timeout"] = timeout
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch_target(fake_urlopen)
    return captured


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="byk-video-"))
    video = tmp / "clip.mp4"
    video.write_bytes(b"\x00\x00\x00\x20ftypisom" + b"payload" * 100)

    orig_urlopen = V.urllib.request.urlopen
    orig_key = V.xiaomi_api_key

    try:
        print("\n[1] 各种输入失败都必须优雅返回，不抛异常")
        r = V.describe_video(tmp / "nope.mp4")
        check("文件不存在 -> ok=False", not r.ok and "不存在" in (r.error or ""), str(r.error))

        empty = tmp / "empty.mp4"
        empty.write_bytes(b"")
        r = V.describe_video(empty)
        check("空文件 -> ok=False", not r.ok and "空文件" in (r.error or ""), str(r.error))

        orig_max = V.MAX_SOURCE_BYTES
        V.MAX_SOURCE_BYTES = 16
        r = V.describe_video(video)
        V.MAX_SOURCE_BYTES = orig_max
        check("超出体积上限 -> ok=False 且提示压缩", not r.ok and "过大" in (r.error or ""), str(r.error))

        V.xiaomi_api_key = lambda: None
        r = V.describe_video(video)
        check("无密钥 -> ok=False 且点名缺 XIAOMI_API_KEY",
              not r.ok and "XIAOMI_API_KEY" in (r.error or ""), str(r.error))
        V.xiaomi_api_key = lambda: "fake-key-for-test"

        print("\n[2] 请求格式必须正确")
        body = json.dumps({"choices": [{"message": {"content": "画面里有测试卡"}}]})
        cap = install(lambda f: setattr(V.urllib.request, "urlopen", f), FakeResp(body))
        r = V.describe_video(video)
        content = cap["payload"]["messages"][0]["content"]
        check("成功返回 ok=True", r.ok, str(r.error))
        check("正文被取出", r.text == "画面里有测试卡", r.text)
        check("端点是小米 OpenAI 兼容接口",
              cap["url"] == "https://api.xiaomimimo.com/v1/chat/completions", cap["url"])
        check("使用 video_url 内容块", any(b.get("type") == "video_url" for b in content),
              str([b.get("type") for b in content]))
        vurl = next(b["video_url"]["url"] for b in content if b.get("type") == "video_url")
        check("视频以 data URL 内联", vurl.startswith("data:video/mp4;base64,"), vurl[:40])
        check("data URL 内容与文件一致",
              base64.b64decode(vurl.split(",", 1)[1]) == video.read_bytes())
        check("同时带上了文字指令", any(b.get("type") == "text" for b in content))
        check("带了 Authorization 头",
              any("authorization" in k.lower() for k in cap["headers"]), str(list(cap["headers"])))

        print("\n[3] 正文为空、内容全在 reasoning_content 时也要取到（真实踩过的坑）")
        body2 = json.dumps({"choices": [{"finish_reason": "length",
                                        "message": {"content": "", "reasoning_content": "我在思考：画面是测试卡"}}]})
        install(lambda f: setattr(V.urllib.request, "urlopen", f), FakeResp(body2))
        r2 = V.describe_video(video)
        check("从 reasoning_content 兜底取出内容",
              r2.ok and "测试卡" in r2.text, f"ok={r2.ok} text={r2.text!r}")

        print("\n[4] 200 但两边都空 -> 必须判为失败，不能假装成功")
        body3 = json.dumps({"choices": [{"message": {"content": "", "reasoning_content": ""}}]})
        install(lambda f: setattr(V.urllib.request, "urlopen", f), FakeResp(body3))
        r3 = V.describe_video(video)
        check("空响应 -> ok=False", not r3.ok and "取不到任何正文" in (r3.error or ""), str(r3.error))

        print("\n[5] HTTP 与网络错误")
        err = urllib.error.HTTPError(
            V.BASE_URL, 400, "Bad Request", {}, __import__("io").BytesIO(b'{"error":"unsupported content type"}')
        )
        install(lambda f: setattr(V.urllib.request, "urlopen", f), err)
        r4 = V.describe_video(video)
        check("HTTP 400 -> ok=False 且带上服务端说明",
              not r4.ok and "400" in (r4.error or "") and "unsupported" in (r4.error or ""), str(r4.error))

        install(lambda f: setattr(V.urllib.request, "urlopen", f), TimeoutError("timed out"))
        r5 = V.describe_video(video)
        check("网络异常 -> ok=False 且带异常类型",
              not r5.ok and "TimeoutError" in (r5.error or ""), str(r5.error))

        print("\n[6] 密钥只走 Authorization 头，不进请求体")
        secret = "SECRET-MUST-NOT-APPEAR-1234"
        V.xiaomi_api_key = lambda: secret
        cap2 = install(lambda f: setattr(V.urllib.request, "urlopen", f), FakeResp(body))
        V.describe_video(video)
        check("请求体里没有密钥明文",
              secret not in json.dumps(cap2["payload"]), "密钥出现在了请求体里")
        auth = next((v for k, v in cap2["headers"].items() if k.lower() == "authorization"), None)
        check("密钥在 Authorization 头里", bool(auth) and secret in str(auth), str(auth))
    finally:
        V.urllib.request.urlopen = orig_urlopen
        V.xiaomi_api_key = orig_key

    print(f"\n{'=' * 50}\n通过 {PASS} 项，失败 {FAIL} 项")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
