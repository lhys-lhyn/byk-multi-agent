"""用小米 MiMo 直接理解视频 —— 画面与音轨一起读。

## 为什么需要这个模块（绕开 DSH）

DSH 这条管线里**没有任何视频通路**，实测确认：

| 检查项 | 结果 |
|---|---|
| pi-ai 包里 `'video'` 模态 | 0 处（整个包） |
| `dsh-tool-fs` / `dsh-attachment` / `dsh-llm` 里 `video` | 各 0 处 |
| 附件服务准入 | 只接受 images |
| `read_image` 支持的扩展名 | 仅 PNG/JPEG/WebP/GIF |

也就是说 `mimo-v2.6` 明明能看视频，但 DSH 没有工具能把视频送进去。

**但模型能力是真的**：实测小米 OpenAI 兼容接口接受

    {"type": "video_url", "video_url": {"url": "data:video/mp4;base64,..."}}

并且模型同时读出了画面文字与音频内容。所以这里由**编排器直接调提供商接口**，
把视频理解成文字后再交给视觉助手 —— 视觉助手仍然是那个"负责理解视频内容"的角色，
只是喂给它的材料从"抽帧 OCR 文本"升级成了"模型直接看视频得到的描述"。

## 注意：目录声明 ≠ 模型能力

pi-ai 的模型目录把 `mimo-v2.6` 标为 `input: ['text','image']`，没有 video。
这个结论**只说明适配器不支持**，不代表模型不支持。判据只能是实测接口。
"""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

#: 实测可直读视频（画面 + 音轨）的模型
DEFAULT_MODEL = "mimo-v2.6"
BASE_URL = "https://api.xiaomimimo.com/v1/chat/completions"

#: 源文件上限。base64 会膨胀约 4/3，太大既慢又可能被服务端拒绝。
MAX_SOURCE_BYTES = 96 * 1024 * 1024

DEFAULT_PROMPT = (
    "请详细描述这段视频的全部内容，分四部分输出：\n"
    "1. **画面文字**：逐条列出画面中出现的所有文字，保留原文（包括大小写、空格、数字）。\n"
    "2. **画面内容**：场景、物体、人物、动作、界面元素，按时间顺序描述关键变化。\n"
    "3. **音频内容**：说了什么（尽量逐字转写）、有无音乐或环境音；没有音轨就明确说「无音轨」。\n"
    "4. **时间轴**：用 `[起始秒-结束秒]` 标注每个关键事件。\n"
    "只描述你确实看到/听到的。看不清或听不清的部分明确标注为不确定，不要猜测填充。"
)


@dataclass
class VideoUnderstanding:
    ok: bool
    text: str = ""
    model: str = ""
    source_bytes: int = 0
    method: str = ""
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "ok": self.ok, "text": self.text, "model": self.model,
            "source_bytes": self.source_bytes, "method": self.method, "error": self.error,
        }


def xiaomi_api_key() -> str | None:
    """按 DSH 的凭据优先级取密钥：进程环境 -> DSH 凭据库。绝不回显密钥。"""
    env = os.environ.get("XIAOMI_API_KEY")
    if env and env.strip():
        return env.strip()
    home = os.environ.get("DSH_HOME")
    bases = []
    if home:
        bases.append(Path(home))
    appdata = os.environ.get("APPDATA")
    if appdata:
        bases.append(Path(appdata) / "com.yeagoo.dsh-desktop" / "harness")
    for base in bases:
        cred = base / ".credentials.yaml"
        if not cred.exists():
            continue
        try:
            text = cred.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        m = re.search(r"^\s*XIAOMI_API_KEY\s*:\s*(\S+)\s*$", text, re.MULTILINE)
        if m:
            v = m.group(1).strip().strip("'\"")
            if v:
                return v
    return None


def _extract_text(body: str) -> str:
    """从响应里取正文。注意：模型思考时正文可能为空，内容全在 reasoning_content。"""
    try:
        obj = json.loads(body)
    except Exception:
        return ""
    choices = obj.get("choices") or []
    if not choices:
        return ""
    msg = choices[0].get("message") or {}
    content = (msg.get("content") or "").strip()
    if content:
        return content
    # finish_reason=length 时经常出现：正文空，内容都在推理字段里
    return (msg.get("reasoning_content") or "").strip()


def describe_video(
    path: str | Path,
    prompt: str | None = None,
    *,
    model: str = DEFAULT_MODEL,
    max_tokens: int = 8000,
    timeout_s: int = 900,
) -> VideoUnderstanding:
    """把一个视频交给 MiMo 直接理解，返回文字描述。

    任何失败都返回 ok=False 且带明确 error，绝不抛异常（编排器要能继续跑）。
    """
    p = Path(path)
    if not p.exists():
        return VideoUnderstanding(False, error=f"视频不存在：{p}", method="mimo-video")
    try:
        size = p.stat().st_size
    except OSError as exc:
        return VideoUnderstanding(False, error=f"无法读取视频信息：{exc}", method="mimo-video")
    if size == 0:
        return VideoUnderstanding(False, error="视频为空文件（0 字节）", method="mimo-video")
    if size > MAX_SOURCE_BYTES:
        return VideoUnderstanding(
            False,
            error=f"视频过大（{size} 字节 > {MAX_SOURCE_BYTES} 字节上限）；"
                  "base64 后体积会再涨约 1/3，请先压缩或裁剪后重试",
            source_bytes=size, method="mimo-video",
        )

    key = xiaomi_api_key()
    if not key:
        return VideoUnderstanding(
            False, error="找不到 XIAOMI_API_KEY（进程环境与 DSH 凭据库都没有）",
            source_bytes=size, method="mimo-video",
        )

    try:
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    except Exception as exc:
        return VideoUnderstanding(False, error=f"读取视频失败：{exc}", source_bytes=size, method="mimo-video")

    suffix = p.suffix.lower().lstrip(".") or "mp4"
    mime = {"mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
            "mkv": "video/x-matroska", "avi": "video/x-msvideo"}.get(suffix, f"video/{suffix}")

    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "video_url", "video_url": {"url": f"data:{mime};base64,{b64}"}},
                {"type": "text", "text": prompt or DEFAULT_PROMPT},
            ],
        }],
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BASE_URL, data=data,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            body = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        return VideoUnderstanding(
            False, error=f"接口返回 HTTP {e.code}：{detail}",
            source_bytes=size, model=model, method="mimo-video",
        )
    except Exception as exc:
        return VideoUnderstanding(
            False, error=f"请求失败：{type(exc).__name__}: {exc}",
            source_bytes=size, model=model, method="mimo-video",
        )

    text = _extract_text(body)
    if not text:
        return VideoUnderstanding(
            False, error=f"接口返回 200 但取不到任何正文：{body[:300]}",
            source_bytes=size, model=model, method="mimo-video",
        )
    return VideoUnderstanding(
        True, text=text, model=model, source_bytes=size, method="mimo-video",
    )
