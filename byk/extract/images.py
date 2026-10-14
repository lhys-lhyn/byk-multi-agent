"""图片提取器：Pillow 取元数据 + 本地 OCR 取文字。**不调用任何 LLM。**"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from . import ocr
from ._common import ExtractError, require

#: 能被 OpenCV/Pillow 直接交给 OCR 的格式；其余先转 PNG
_OCR_FRIENDLY = {"PNG", "JPEG", "JPG", "BMP", "WEBP", "TIFF", "JP2", "PPM"}


def extract_image(path: str, *, ocr_lang: str = "ch", **kw) -> tuple[str, dict, str]:
    """返回 ``(text, meta, method)``；``meta`` 含宽高、格式、字节数、OCR 明细。"""
    Image = require("PIL.Image", "Pillow", "pip install Pillow", "图片读取与转码")

    try:
        with Image.open(path) as img:
            width, height = img.size
            fmt = (img.format or "").upper()
            mode = img.mode
            info = {k: str(v) for k, v in dict(img.info).items() if k in ("dpi", "gamma")}
    except ExtractError:
        raise
    except Exception as exc:
        raise ExtractError(f"图片无法打开（格式不支持或文件损坏）：{type(exc).__name__}: {exc}") from exc

    tmp_dir: str | None = None
    ocr_input = path
    try:
        if fmt not in _OCR_FRIENDLY:
            tmp_dir = tempfile.mkdtemp(prefix="byk_ocr_")
            converted = Path(tmp_dir) / "input.png"
            try:
                with Image.open(path) as img:
                    img.convert("RGB").save(converted, format="PNG")
            except Exception as exc:
                raise ExtractError(f"图片转码为 PNG 失败：{type(exc).__name__}: {exc}") from exc
            ocr_input = str(converted)

        lines, backend = ocr.run_ocr(ocr_input, lang=ocr_lang)
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    text = ocr.lines_to_text(lines)
    scores = [float(item.get("score") or 0.0) for item in lines]
    meta: dict = {
        "width": width,
        "height": height,
        "format": fmt or Path(path).suffix.lstrip(".").upper(),
        "mode": mode,
        "size_bytes": Path(path).stat().st_size,
        "ocr_backend": backend,
        "ocr_lang": ocr_lang,
        "line_count": len(lines),
        "lines": [{"text": str(i.get("text", "")), "score": round(float(i.get("score") or 0.0), 4)} for i in lines],
    }
    if info:
        meta["image_info"] = info
    if scores:
        meta["avg_score"] = round(sum(scores) / len(scores), 4)
        meta["min_score"] = round(min(scores), 4)
    else:
        meta["note"] = "OCR 未识别出任何文字（图片可能不含文字，或文字过小/过于模糊）。"

    if ocr_lang not in ("ch",):
        meta["ocr_lang_note"] = "rapidocr-onnxruntime 使用内置中英文模型，lang 参数仅作记录，不切换模型。"
    return text, meta, f"ocr:{backend}"
