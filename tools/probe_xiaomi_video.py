"""实测：小米 MiMo 的 OpenAI 兼容接口是否接受视频输入。

背景：DSH 管线里没有任何视频通路（pi-ai 无 video 模态、附件服务只收图片、
read_image 只认 PNG/JPEG/WebP/GIF）。但模型本身可能支持视频——那就得绕开 DSH 工具层，
由编排器直接调提供商 API。这个脚本判定"直调能不能成"。

密钥从 DSH 凭据库读取，**不打印**。
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path(os.environ["DSH_HOME"])
CRED = HOME / ".credentials.yaml"
BASE = "https://api.xiaomimimo.com/v1/chat/completions"
VIDEO = Path(r"C:\Projects\byk\tests\_fixtures\clip.mp4")
MODEL = "mimo-v2.6"


def read_key() -> str | None:
    if not CRED.exists():
        return None
    text = CRED.read_text(encoding="utf-8", errors="replace")
    # 只在 refs: 段里找 XIAOMI_API_KEY
    m = re.search(r"^\s*XIAOMI_API_KEY\s*:\s*(\S+)\s*$", text, re.MULTILINE)
    if not m:
        return None
    v = m.group(1).strip().strip("'\"")
    return v or None


def post(payload: dict, key: str) -> tuple[int, str]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BASE,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return -1, f"{type(e).__name__}: {e}"


def main() -> int:
    key = read_key()
    print(f"凭据文件: {CRED}")
    print(f"读到密钥: {'是（长度 %d，不回显）' % len(key) if key else '否'}")
    if not key:
        print("无法读取 XIAOMI_API_KEY，测试中止。")
        return 2

    if not VIDEO.exists():
        print(f"测试视频不存在: {VIDEO}")
        return 2
    b64 = base64.b64encode(VIDEO.read_bytes()).decode("ascii")
    print(f"测试视频: {VIDEO.name}  {VIDEO.stat().st_size} 字节 -> base64 {len(b64)} 字符")

    question = (
        "请描述这段视频：画面里出现的文字是什么？说了什么话？"
        "如果这段内容你根本收不到，请直接回答「未收到视频」。"
    )

    # 依次尝试几种常见的视频内容块写法
    variants: list[tuple[str, dict]] = [
        (
            "video_url + data URL",
            {
                "type": "video_url",
                "video_url": {"url": f"data:video/mp4;base64,{b64}"},
            },
        ),
        (
            "video + base64 字段",
            {"type": "video", "video": f"data:video/mp4;base64,{b64}"},
        ),
        (
            "input_video",
            {"type": "input_video", "input_video": {"data": b64, "format": "mp4"}},
        ),
    ]

    for name, block in variants:
        payload = {
            "model": MODEL,
            "max_tokens": 600,
            "messages": [{"role": "user", "content": [block, {"type": "text", "text": question}]}],
        }
        print(f"\n===== 尝试：{name} =====")
        status, body = post(payload, key)
        print(f"HTTP {status}")
        snippet = body[:700].replace("\n", " ")
        print(f"响应: {snippet}")
        if status == 200:
            try:
                obj = json.loads(body)
                content = obj["choices"][0]["message"]["content"]
                print("\n--- 模型回答 ---")
                print(content[:1500])
                print("--- 回答结束 ---")
                low = content or ""
                hit_text = "BYKVIDEO" in low.upper().replace(" ", "") or "2024" in low
                hit_speech = "quick brown fox" in low.lower() or "test of the local" in low.lower()
                print(f"\n画面文字是否读对: {hit_text}")
                print(f"语音内容是否读对: {hit_speech}")
                print(
                    "\n结论："
                    + ("接口接受视频且模型真的读到了内容 ✅"
                       if (hit_text or hit_speech)
                       else "接口接受了请求，但模型未读出内容（可能只是接受了格式）")
                )
                return 0
            except Exception as e:
                print(f"解析响应失败: {e}")
        # 该变体不被接受，继续试下一个
    print("\n结论：三种写法都被拒绝 —— 该接口当前不接受视频输入。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
