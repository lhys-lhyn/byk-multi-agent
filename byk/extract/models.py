"""提取层数据模型。

严格对齐 ``docs/api-contract.md`` 第 3 节 —— 字段名不得改动。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

#: 契约中的 ExtractKind 字面量联合
ExtractKind = Literal["document", "image", "audio", "video", "archive", "text", "unknown"]

ALL_KINDS: tuple[str, ...] = (
    "document",
    "image",
    "audio",
    "video",
    "archive",
    "text",
    "unknown",
)

#: 单个文件的提取文本上限：200 KB（UTF-8 字节）
MAX_TEXT_BYTES: int = 200 * 1024


@dataclass
class ExtractionResult:
    """单个文件的提取结果（契约 §3）。"""

    path: str  # 绝对路径
    name: str  # 原始文件名
    kind: ExtractKind
    ok: bool
    text: str = ""
    meta: dict = field(default_factory=dict)
    error: str | None = None
    method: str = ""  # "pypdf" | "python-pptx" | "whisper:small" | "ocr:rapidocr" | "passthrough"

    # ---- 便于 SSE / JSON 序列化 ----
    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "name": self.name,
            "kind": self.kind,
            "ok": self.ok,
            "text": self.text,
            "meta": self.meta,
            "error": self.error,
            "method": self.method,
        }

    @property
    def text_bytes(self) -> int:
        """当前 text 的 UTF-8 字节数。"""
        return len(self.text.encode("utf-8"))

    def __repr__(self) -> str:  # pragma: no cover - 仅调试用
        return (
            f"ExtractionResult(name={self.name!r}, kind={self.kind!r}, ok={self.ok}, "
            f"chars={len(self.text)}, method={self.method!r}, error={self.error!r})"
        )
