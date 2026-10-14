"""本地 OCR 后端（惰性导入，可用后端自动降级）。

后端优先级：``rapidocr-onnxruntime`` → ``easyocr`` → ``paddleocr``。
其中 ``rapidocr-onnxruntime`` 是首选：纯 CPU、ONNX Runtime、无 torch/paddle 依赖，
模型随 wheel 一起分发，首次调用**不需要联网下载**。

对外只暴露 :func:`run_ocr`，返回 ``(lines, backend)``，其中 ``lines`` 为
``[{"text": str, "score": float, "box": [[x, y], ...]}]``。
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from ._common import ExtractError, require

#: (backend 名, python 模块名, 安装指引, 用途说明)
BACKEND_SPECS: tuple[tuple[str, str, str], ...] = (
    ("rapidocr", "rapidocr_onnxruntime", "pip install rapidocr-onnxruntime"),
    ("easyocr", "easyocr", "pip install easyocr"),
    ("paddleocr", "paddleocr", "pip install paddleocr paddlepaddle"),
)

#: 后端 → 中文/英文语言参数映射
_LANG_MAP: dict[str, dict[str, Any]] = {
    "rapidocr": {"ch": None, "en": None},
    "easyocr": {"ch": ["ch_sim", "en"], "en": ["en"]},
    "paddleocr": {"ch": "ch", "en": "en"},
}

_ENGINE_LOCK = threading.Lock()
_ENGINES: dict[tuple[str, str], Any] = {}
_ACTIVE: dict[str, str] = {}  # lang -> backend 名


def _import_backend(module_name: str) -> Any:
    return require(
        module_name,
        module_name,
        next(spec[2] for spec in BACKEND_SPECS if spec[1] == module_name),
        "图片 OCR",
    )


def available_backends() -> list[str]:
    """返回当前环境下**可导入**的 OCR 后端名列表（不加载模型）。"""
    import importlib.util

    found: list[str] = []
    for name, module_name, _install in BACKEND_SPECS:
        try:
            if importlib.util.find_spec(module_name) is not None:
                found.append(name)
        except Exception:
            continue
    return found


def pick_backend() -> str | None:
    """选择第一个可用的 OCR 后端名；全都没有时返回 ``None``。"""
    names = available_backends()
    return names[0] if names else None


def _build_engine(backend: str, lang: str) -> Any:
    if backend == "rapidocr":
        mod = _import_backend("rapidocr_onnxruntime")
        RapidOCR = getattr(mod, "RapidOCR", None)
        if RapidOCR is None:
            raise ExtractError(
                "rapidocr-onnxruntime 已安装但缺少 RapidOCR 类，请重装：pip install -U rapidocr-onnxruntime"
            )
        return RapidOCR()

    if backend == "easyocr":
        mod = _import_backend("easyocr")
        langs = _LANG_MAP["easyocr"].get(lang) or _LANG_MAP["easyocr"]["ch"]
        return mod.Reader(langs, gpu=False)

    if backend == "paddleocr":
        mod = _import_backend("paddleocr")
        PaddleOCR = getattr(mod, "PaddleOCR", None)
        if PaddleOCR is None:
            raise ExtractError("paddleocr 已安装但缺少 PaddleOCR 类，请重装：pip install -U paddleocr")
        lang_code = _LANG_MAP["paddleocr"].get(lang, "ch")
        try:
            return PaddleOCR(use_angle_cls=True, lang=lang_code, show_log=False)
        except TypeError:
            return PaddleOCR(lang=lang_code)

    raise ExtractError(f"未知 OCR 后端：{backend}")


def get_engine(lang: str = "ch"):
    """取（并缓存）指定语言的 OCR 引擎，返回 ``(backend, engine)``。"""
    lang = (lang or "ch").strip().lower() or "ch"
    backend = pick_backend()
    if backend is None:
        specs = "、".join(f"`{name}`（{install}）" for name, _m, install in BACKEND_SPECS)
        raise ExtractError(
            f"本地 OCR 不可用：未安装任何 OCR 后端。请任选其一安装：{specs}。"
            "推荐 `pip install rapidocr-onnxruntime`（纯 CPU，无需 torch）。"
        )
    key = (backend, lang)
    with _ENGINE_LOCK:
        engine = _ENGINES.get(key)
        if engine is None:
            try:
                engine = _build_engine(backend, lang)
            except ExtractError:
                raise
            except Exception as exc:
                raise ExtractError(
                    f"OCR 后端 `{backend}` 初始化失败：{type(exc).__name__}: {exc}。"
                    f"请检查安装：{next(s[2] for s in BACKEND_SPECS if s[0] == backend)}"
                ) from exc
            _ENGINES[key] = engine
    return backend, engine


# --------------------------------------------------------------------------- #
# 各后端的结果归一化
# --------------------------------------------------------------------------- #
def _normalize_rapidocr(raw: Any) -> list[dict]:
    if raw is None:
        return []
    # rapidocr 1.2/1.3: (result, elapse)；1.4+: RapidOCROutput 对象
    if isinstance(raw, tuple) and len(raw) == 2:
        raw = raw[0]
    if raw is None:
        return []
    if hasattr(raw, "txts"):  # RapidOCROutput
        txts = list(getattr(raw, "txts", None) or [])
        scores = list(getattr(raw, "scores", None) or [])
        boxes = list(getattr(raw, "boxes", None) or [])
        lines = []
        for i, text in enumerate(txts):
            if text is None:
                continue
            lines.append(
                {
                    "text": str(text),
                    "score": float(scores[i]) if i < len(scores) else 0.0,
                    "box": _boxes_to_list(boxes[i]) if i < len(boxes) else None,
                }
            )
        return lines
    lines = []
    for item in raw:
        try:
            box, text, score = item[0], item[1], item[2]
        except Exception:
            continue
        if text is None:
            continue
        lines.append({"text": str(text), "score": float(score), "box": _boxes_to_list(box)})
    return lines


def _boxes_to_list(box: Any) -> list | None:
    try:
        return [[float(p[0]), float(p[1])] for p in box]
    except Exception:
        return None


def _normalize_easyocr(raw: Any) -> list[dict]:
    lines = []
    for item in raw or []:
        try:
            box, text, score = item[0], item[1], item[2]
        except Exception:
            continue
        lines.append({"text": str(text), "score": float(score), "box": _boxes_to_list(box)})
    return lines


def _normalize_paddleocr(raw: Any) -> list[dict]:
    lines: list[dict] = []
    if not raw:
        return lines
    page = raw[0] if isinstance(raw, list) and raw and isinstance(raw[0], list) else raw
    for item in page or []:
        try:
            box, (text, score) = item[0], item[1]
        except Exception:
            continue
        lines.append({"text": str(text), "score": float(score), "box": _boxes_to_list(box)})
    return lines


# --------------------------------------------------------------------------- #
# 对外接口
# --------------------------------------------------------------------------- #
def run_ocr(image_path: str | Path, lang: str = "ch") -> tuple[list[dict], str]:
    """对图片文件做 OCR。

    返回 ``(lines, backend)``；``lines`` 按后端返回顺序（大致为从上到下、从左到右）。
    无法识别出任何文字时返回空列表 —— 这**不是**错误。
    """
    path = str(image_path)
    if not Path(path).is_file():
        raise ExtractError(f"OCR 输入文件不存在：{path}")

    backend, engine = get_engine(lang)
    try:
        if backend == "rapidocr":
            raw = engine(path)
            lines = _normalize_rapidocr(raw)
        elif backend == "easyocr":
            raw = engine.readtext(path)
            lines = _normalize_easyocr(raw)
        else:
            raw = engine.ocr(path, cls=True)
            lines = _normalize_paddleocr(raw)
    except ExtractError:
        raise
    except Exception as exc:
        raise ExtractError(
            f"OCR（{backend}）处理 `{Path(path).name}` 失败：{type(exc).__name__}: {exc}"
        ) from exc
    return lines, backend


def lines_to_text(lines: list[dict]) -> str:
    """把 OCR 行拼成文本（按行，去掉纯空白行）。"""
    out = [str(item.get("text", "")).strip() for item in lines]
    return "\n".join(t for t in out if t)
