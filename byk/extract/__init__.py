"""BYK 本地内容提取层（``byk.extract``）。

把任意文件变成「文本 + 元数据」，**不调用任何 LLM**、不需要网络（首次下载
whisper 权重除外）。

对外接口（严格对齐 ``docs/api-contract.md`` 第 3、4 节）::

    from byk.extract import ExtractionResult, detect_kind, extract_file, extract_many

    res = extract_file(r"C:\\path\\to\\file.pdf")          # 永不抛异常
    results = extract_many([...], whisper_model="small")   # 单文件失败互不影响

设计要点
--------
* 所有第三方依赖（pypdf / python-docx / python-pptx / openpyxl / Pillow /
  rapidocr-onnxruntime / faster-whisper）**一律惰性导入**，缺库时返回
  ``ok=False`` 且 ``error`` 说明缺什么、装什么。
* 单文件提取文本上限 200 KB，超出截断并置 ``meta["truncated"] = True``。
* 图片/视频抽帧走**本地 OCR**，音频/视频音轨走 **faster-whisper**，全程本地推理。
"""

from __future__ import annotations

from .dispatch import SUPPORTED_EXTENSIONS, detect_kind, extract_file, extract_many
from .models import ALL_KINDS, MAX_TEXT_BYTES, ExtractionResult, ExtractKind

__all__ = [
    "ExtractionResult",
    "ExtractKind",
    "ALL_KINDS",
    "MAX_TEXT_BYTES",
    "SUPPORTED_EXTENSIONS",
    "detect_kind",
    "extract_file",
    "extract_many",
]

__version__ = "1.0.0"
