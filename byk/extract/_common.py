"""提取层内部公共工具：异常、惰性导入、外部可执行文件探测、文本截断。

本模块只依赖标准库；第三方库一律在函数内部按需导入。
"""

from __future__ import annotations

import importlib
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence

from .models import MAX_TEXT_BYTES


class ExtractError(Exception):
    """可预期的提取失败。

    消息面向使用者（中文），必须写明「缺什么 / 该装什么」，由 dispatch 捕获后写入
    ``ExtractionResult.error``，**绝不向上抛出**。
    """

    def __init__(self, message: str, *, meta: dict | None = None) -> None:
        super().__init__(message)
        self.meta: dict = dict(meta or {})


# --------------------------------------------------------------------------- #
# 惰性导入
# --------------------------------------------------------------------------- #
def require(module_name: str, package: str, install: str, purpose: str) -> Any:
    """惰性导入第三方模块；缺库时抛 ``ExtractError``（含安装指引）。"""
    try:
        return importlib.import_module(module_name)
    except ImportError as exc:
        raise ExtractError(
            f"缺少依赖库 `{package}`（{purpose}）。请安装：{install}。原始错误：{exc}"
        ) from exc
    except Exception as exc:  # 例如 DLL 加载失败、onnxruntime 版本冲突
        raise ExtractError(
            f"依赖库 `{package}` 导入失败（{purpose}）：{type(exc).__name__}: {exc}。"
            f"请尝试重装：{install}"
        ) from exc


def module_available(module_name: str) -> bool:
    """判断模块是否可导入（不抛异常）。"""
    try:
        importlib.import_module(module_name)
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# 外部可执行文件
# --------------------------------------------------------------------------- #
_FFMPEG_CANDIDATES: tuple[str, ...] = (
    r"C:\utils\ffmpeg\bin\ffmpeg.exe",
    r"C:\ffmpeg\bin\ffmpeg.exe",
)


def find_ffmpeg() -> str | None:
    """定位 ffmpeg 可执行文件（本机不在 PATH，按绝对路径探测）。"""
    for env_name in ("BYK_FFMPEG", "FFMPEG_BINARY", "FFMPEG"):
        value = os.environ.get(env_name)
        if value and Path(value).is_file():
            return value
    for cand in _FFMPEG_CANDIDATES:
        if Path(cand).is_file():
            return cand
    return shutil.which("ffmpeg")


def find_ffprobe() -> str | None:
    """定位 ffprobe；找不到时退回 ``None``（调用方需降级处理）。"""
    for env_name in ("BYK_FFPROBE", "FFPROBE_BINARY"):
        value = os.environ.get(env_name)
        if value and Path(value).is_file():
            return value
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        for name in ("ffprobe.exe", "ffprobe"):
            cand = Path(ffmpeg).with_name(name)
            if cand.is_file():
                return str(cand)
    return shutil.which("ffprobe")


def require_ffmpeg() -> str:
    """取 ffmpeg 路径，缺失时给出明确修复指引。"""
    path = find_ffmpeg()
    if not path:
        raise ExtractError(
            "缺少 ffmpeg（音频/视频抽帧与解码必需）。请安装 ffmpeg 并把 ffmpeg.exe 放到 "
            r"C:\utils\ffmpeg\bin\ 下，或设置环境变量 BYK_FFMPEG 指向 ffmpeg.exe。"
        )
    return path


def _no_window_flags() -> int:
    if sys.platform == "win32":  # pragma: no cover - 平台相关
        return getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return 0


def run_exe(
    exe: str,
    args: Sequence[str],
    *,
    timeout: float = 900.0,
    what: str = "外部命令",
) -> subprocess.CompletedProcess:
    """执行外部命令并捕获输出；超时/无法启动统一转成 ``ExtractError``。"""
    try:
        return subprocess.run(
            [exe, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=_no_window_flags(),
        )
    except subprocess.TimeoutExpired as exc:
        raise ExtractError(f"{what}超时（>{int(timeout)} 秒），已放弃：{Path(exe).name}") from exc
    except OSError as exc:
        raise ExtractError(f"{what}无法启动（{exe}）：{type(exc).__name__}: {exc}") from exc


# --------------------------------------------------------------------------- #
# 文本截断
# --------------------------------------------------------------------------- #
def truncate_text(text: str, limit: int = MAX_TEXT_BYTES) -> tuple[str, bool]:
    """按 UTF-8 字节截断到 ``limit``，返回 ``(文本, 是否被截断)``。

    不会把一个多字节字符切成两半。
    """
    if not text:
        return text, False
    data = text.encode("utf-8", errors="replace")
    if len(data) <= limit:
        return text, False
    cut = data[:limit]
    while cut:
        try:
            return cut.decode("utf-8"), True
        except UnicodeDecodeError:
            cut = cut[:-1]
    return "", True


def tail_text(text: str, limit: int = 4000) -> str:
    """截取尾部若干字符，用于错误日志。"""
    if len(text) <= limit:
        return text
    return "..." + text[-limit:]


# --------------------------------------------------------------------------- #
# 二进制嗅探
# --------------------------------------------------------------------------- #
def looks_binary(data: bytes) -> bool:
    """粗略判断字节流是否为二进制（用于把「随机二进制文件」判为 ok=False）。"""
    if not data:
        return False
    sample = data[: 64 * 1024]
    if b"\x00" in sample:
        return True
    weird = sum(1 for b in sample if b < 9 or 13 < b < 32)
    return weird / len(sample) > 0.10
