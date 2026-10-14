"""提取层调度：类型判定、单文件调度、批量调度。

契约 §4：

    def detect_kind(path) -> ExtractKind
    def extract_file(path, *, ocr_lang="ch", whisper_model="small") -> ExtractionResult
    def extract_many(paths, **kw) -> list[ExtractionResult]

**保证**：``extract_file`` 永不抛异常；单文件失败不影响其他文件；缺库返回
``ok=False`` 且 ``error`` 写明「缺哪个库、装什么」。
"""

from __future__ import annotations

import os
from pathlib import Path

from . import archives, audio, documents, images, video
from ._common import ExtractError, truncate_text
from .models import MAX_TEXT_BYTES, ExtractionResult, ExtractKind

# --------------------------------------------------------------------------- #
# 扩展名 → 类型（契约 §4；未列出的扩展名一律 unknown）
# --------------------------------------------------------------------------- #
_DOCUMENT_EXTS: dict[str, object] = {
    ".pdf": documents.extract_pdf,
    ".docx": documents.extract_docx,
    ".pptx": documents.extract_pptx,
    ".xlsx": documents.extract_xlsx,
    ".xlsm": documents.extract_xlsx,
    ".rtf": documents.extract_rtf,
}

_IMAGE_EXTS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".gif",
    ".webp",
    ".tif",
    ".tiff",
    ".ico",
    ".jfif",
    ".heic",
}

_AUDIO_EXTS = {
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
    ".flac",
    ".ogg",
    ".oga",
    ".opus",
    ".wma",
    ".amr",
    ".aiff",
    ".aif",
    ".ape",
    ".mka",
}

_VIDEO_EXTS = {
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".webm",
    ".flv",
    ".wmv",
    ".m4v",
    ".mpg",
    ".mpeg",
    ".ts",
    ".m2ts",
    ".3gp",
    ".rmvb",
    ".vob",
}

_ARCHIVE_EXTS = {".zip"}

_TEXT_EXTS = {
    ".txt",
    ".md",
    ".markdown",
    ".rst",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".ndjson",
    ".log",
    ".yaml",
    ".yml",
    ".xml",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".srt",
    ".vtt",
}

#: 所有可处理的扩展名（用于错误提示）
SUPPORTED_EXTENSIONS: tuple[str, ...] = tuple(
    sorted(
        set(_DOCUMENT_EXTS)
        | _IMAGE_EXTS
        | _AUDIO_EXTS
        | _VIDEO_EXTS
        | _ARCHIVE_EXTS
        | _TEXT_EXTS
    )
)


def detect_kind(path: str) -> ExtractKind:
    """按扩展名判定类型；``.zip`` 归 ``archive``，未知归 ``unknown``。"""
    try:
        suffix = Path(os.fspath(path)).suffix.lower()
    except TypeError:
        return "unknown"
    if not suffix:
        return "unknown"
    if suffix in _DOCUMENT_EXTS:
        return "document"
    if suffix in _IMAGE_EXTS:
        return "image"
    if suffix in _AUDIO_EXTS:
        return "audio"
    if suffix in _VIDEO_EXTS:
        return "video"
    if suffix in _ARCHIVE_EXTS:
        return "archive"
    if suffix in _TEXT_EXTS:
        return "text"
    return "unknown"


def _resolve_handler(ext: str, kind: ExtractKind):
    """按扩展名取提取器；返回 ``(handler, 不可处理提示)``。"""
    if kind == "document":
        handler = _DOCUMENT_EXTS.get(ext)
        if handler is None:
            return None, f"暂不支持该文档格式 `{ext}`。"
        return handler, None
    if kind == "text":
        return documents.extract_text, None
    if kind == "image":
        return images.extract_image, None
    if kind == "audio":
        return audio.extract_audio, None
    if kind == "video":
        return video.extract_video, None
    if kind == "archive":
        return archives.extract_archive, None
    return None, (
        f"不支持的文件类型 `{ext or '(无扩展名)'}`，无法判定提取方式。"
        f"当前支持的扩展名：{'、'.join(SUPPORTED_EXTENSIONS)}。"
    )


def _short_error(exc: BaseException) -> str:
    message = str(exc) or exc.__class__.__name__
    if len(message) > 2000:
        message = message[:2000] + " ...(已截断)"
    return message


def extract_file(
    path: str,
    *,
    ocr_lang: str = "ch",
    whisper_model: str = "small",
    frame_interval: float = video.DEFAULT_FRAME_INTERVAL,
    max_frames: int = video.DEFAULT_MAX_FRAMES,
    **_extra,
) -> ExtractionResult:
    """提取单个文件；**任何情况下都不抛异常**。"""
    # ---- 路径规范化（连路径都不是合法字符串时也要安全返回）----
    try:
        raw_path = os.fspath(path)
        abs_path = os.path.abspath(raw_path)
        name = os.path.basename(abs_path) or str(raw_path)
    except Exception as exc:
        return ExtractionResult(
            path=str(path),
            name=str(path),
            kind="unknown",
            ok=False,
            error=f"路径无效（{type(exc).__name__}: {exc}）。",
            method="",
        )

    kind = detect_kind(abs_path)
    result = ExtractionResult(path=abs_path, name=name, kind=kind, ok=False)

    # ---- 存在性 / 类型 / 非空 检查 ----
    try:
        target = Path(abs_path)
        if not target.exists():
            result.error = f"文件不存在：{abs_path}"
            return result
        if target.is_dir():
            result.error = f"路径是目录，不是文件：{abs_path}"
            return result
        size = target.stat().st_size
        result.meta["size_bytes"] = size
        if size == 0:
            result.error = f"文件为空（0 字节），没有可提取的内容：{abs_path}"
            return result
    except ExtractError as exc:
        result.error = _short_error(exc)
        return result
    except Exception as exc:
        result.error = f"无法读取文件属性：{type(exc).__name__}: {exc}"
        return result

    # ---- 选择提取器 ----
    ext = Path(abs_path).suffix.lower()
    handler, unsupported = _resolve_handler(ext, kind)
    if handler is None:
        result.error = unsupported
        return result

    # ---- 执行（任何异常都转成 ok=False）----
    try:
        text, meta, method = handler(
            abs_path,
            ocr_lang=ocr_lang,
            whisper_model=whisper_model,
            frame_interval=frame_interval,
            max_frames=max_frames,
        )
        text = text or ""
        final_text, truncated = truncate_text(text, MAX_TEXT_BYTES)
        merged_meta = dict(meta or {})
        merged_meta.setdefault("size_bytes", result.meta.get("size_bytes"))
        merged_meta["text_chars"] = len(final_text)
        merged_meta["text_bytes"] = len(final_text.encode("utf-8"))
        merged_meta["truncated"] = bool(truncated)
        if truncated:
            merged_meta["max_text_bytes"] = MAX_TEXT_BYTES
            merged_meta["text_bytes_before_truncate"] = len(text.encode("utf-8"))
        result.text = final_text
        result.meta = merged_meta
        result.method = method
        result.ok = True
        return result
    except ExtractError as exc:
        result.meta.update(exc.meta or {})
        result.error = _short_error(exc)
        result.method = ""
        result.ok = False
        return result
    except KeyboardInterrupt:  # pragma: no cover - 用户中断照常抛出
        raise
    except Exception as exc:
        result.error = (
            f"提取内部错误（{type(exc).__name__}）：{_short_error(exc)}。"
            "该文件已跳过，不影响其他文件。"
        )
        result.ok = False
        return result


#: extract_file 接受的关键字参数（extract_many 会过滤掉多余的键）
_SUPPORTED_KW = ("ocr_lang", "whisper_model", "frame_interval", "max_frames")


def extract_many(paths: list[str], **kw) -> list[ExtractionResult]:
    """批量提取；**单个文件失败绝不影响其他文件**，返回顺序与输入一致。"""
    filtered = {k: v for k, v in kw.items() if k in _SUPPORTED_KW}
    results: list[ExtractionResult] = []
    try:
        items = list(paths)
    except TypeError:
        return [
            ExtractionResult(
                path=str(paths),
                name=str(paths),
                kind="unknown",
                ok=False,
                error="extract_many 需要可迭代的路径列表。",
            )
        ]
    for item in items:
        try:
            results.append(extract_file(item, **filtered))
        except KeyboardInterrupt:  # pragma: no cover
            raise
        except Exception as exc:  # 理论上 extract_file 不会抛，这里是最终兜底
            results.append(
                ExtractionResult(
                    path=str(item),
                    name=os.path.basename(str(item)),
                    kind=detect_kind(str(item)),
                    ok=False,
                    error=f"提取内部错误（{type(exc).__name__}）：{_short_error(exc)}",
                )
            )
    return results


__all__ = ["detect_kind", "extract_file", "extract_many", "ExtractionResult"]
