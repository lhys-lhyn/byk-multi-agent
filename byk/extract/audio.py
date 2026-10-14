"""音频提取器：faster-whisper 本地转写（纯 CPU，不调用任何 LLM）。"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from ._common import ExtractError, require

_MODEL_LOCK = threading.Lock()
_MODELS: dict[str, object] = {}

DEFAULT_WHISPER_MODEL = "small"


def model_cache_dir() -> str:
    """whisper 权重缓存目录。

    默认放在项目内 ``<repo>/data/models/whisper``（避免写到用户目录），
    可用环境变量 ``BYK_WHISPER_CACHE`` 覆盖。
    """
    env = os.environ.get("BYK_WHISPER_CACHE")
    if env:
        return env
    repo_root = Path(__file__).resolve().parents[2]
    return str(repo_root / "data" / "models" / "whisper")


def get_whisper_model(model_size: str = DEFAULT_WHISPER_MODEL):
    """加载并缓存 faster-whisper 模型（首次调用会下载权重）。"""
    key = str(model_size)
    with _MODEL_LOCK:
        cached = _MODELS.get(key)
        if cached is not None:
            return cached

        faster_whisper = require(
            "faster_whisper", "faster-whisper", "pip install faster-whisper", "本地语音转写"
        )
        compute_type = os.environ.get("BYK_WHISPER_COMPUTE_TYPE", "int8")
        local_path = Path(key)
        kwargs: dict = {"device": "cpu", "compute_type": compute_type, "cpu_threads": 0}
        if local_path.is_dir():
            kwargs["download_root"] = model_cache_dir()
        else:
            cache = model_cache_dir()
            try:
                Path(cache).mkdir(parents=True, exist_ok=True)
            except Exception:
                pass
            kwargs["download_root"] = cache
        try:
            model = faster_whisper.WhisperModel(key, **kwargs)
        except Exception as exc:
            raise ExtractError(
                f"faster-whisper 模型 `{key}` 加载失败：{type(exc).__name__}: {exc}。"
                f"若为下载失败，请检查网络后重试，或手动下载模型到 `{model_cache_dir()}`，"
                f"或把 `whisper_model` 设为本地模型目录路径。"
            ) from exc
        _MODELS[key] = model
        return model


def unload_models() -> None:
    """释放已缓存的模型（测试/长期运行时用）。"""
    with _MODEL_LOCK:
        _MODELS.clear()


def transcribe_file(
    path: str,
    *,
    whisper_model: str = DEFAULT_WHISPER_MODEL,
    language: str | None = None,
    beam_size: int = 1,
) -> tuple[str, dict, str]:
    """转写音频文件，返回 ``(text, meta, method)``。

    ``meta`` 含 ``duration_s`` / ``language`` / ``segments``（``[{start,end,text}]``）。
    """
    model = get_whisper_model(whisper_model)

    def _run(vad: bool):
        return model.transcribe(
            path,
            language=language,
            beam_size=beam_size,
            vad_filter=vad,
            condition_on_previous_text=False,
        )

    try:
        try:
            segment_iter, info = _run(True)
        except Exception:
            # 部分环境缺少 silero VAD 资源，退化为不启用 VAD
            segment_iter, info = _run(False)
        segments = [
            {
                "start": round(float(s.start), 2),
                "end": round(float(s.end), 2),
                "text": (s.text or "").strip(),
            }
            for s in segment_iter
        ]
        segments = [s for s in segments if s["text"]]
    except ExtractError:
        raise
    except Exception as exc:
        raise ExtractError(f"语音转写失败：{type(exc).__name__}: {exc}") from exc

    text = "\n".join(s["text"] for s in segments).strip()
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    meta: dict = {
        "duration_s": round(duration, 3),
        "language": getattr(info, "language", None),
        "language_probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
        "segments": segments,
        "segment_count": len(segments),
        "model": str(whisper_model),
        "compute_type": os.environ.get("BYK_WHISPER_COMPUTE_TYPE", "int8"),
    }
    if not text:
        meta["note"] = "转写结果为空（音频可能是纯音乐/噪音/静音，或语音过短）。"
    return text, meta, f"whisper:{whisper_model}"


def extract_audio(path: str, *, whisper_model: str = DEFAULT_WHISPER_MODEL, **kw) -> tuple[str, dict, str]:
    """音频文件提取器入口（契约 §4「音频」）。"""
    if not Path(path).is_file():
        raise ExtractError(f"音频文件不存在：{path}")
    size = Path(path).stat().st_size
    if size == 0:
        raise ExtractError("音频文件为空（0 字节）。")
    text, meta, method = transcribe_file(
        path,
        whisper_model=whisper_model,
        language=kw.get("language"),
        beam_size=int(kw.get("beam_size", 1)),
    )
    meta["size_bytes"] = size
    return text, meta, method
