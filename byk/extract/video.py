"""视频提取器：ffmpeg 抽帧 → 逐帧本地 OCR（带时间戳）+ 抽取音轨 → whisper 转写。"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
from pathlib import Path

from . import audio as audio_mod
from . import ocr as ocr_mod
from ._common import ExtractError, find_ffprobe, require_ffmpeg, run_exe, tail_text

#: 默认每 5 秒 1 帧，最多 24 帧（契约 §4）
DEFAULT_FRAME_INTERVAL = 5.0
DEFAULT_MAX_FRAMES = 24

#: 从 ffmpeg showinfo 日志里抓每帧的真实 pts_time
_SHOWINFO_RE = re.compile(r"n:\s*\d+\s+pts:.*?pts_time:(-?[0-9.]+)")


def probe_media(path: str) -> dict:
    """用 ffprobe 读取容器/流信息，返回归一化字典。"""
    ffprobe = find_ffprobe()
    if not ffprobe:
        raise ExtractError(
            "缺少 ffprobe（读取视频时长/分辨率必需）。请把 ffprobe.exe 放到 "
            r"C:\utils\ffmpeg\bin\ 下，或设置环境变量 BYK_FFPROBE。"
        )
    proc = run_exe(
        ffprobe,
        [
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        timeout=120,
        what="ffprobe",
    )
    if proc.returncode != 0:
        raise ExtractError(f"ffprobe 无法解析该视频：{tail_text(proc.stderr.strip(), 500)}")
    try:
        data = json.loads(proc.stdout or "{}")
    except Exception as exc:
        raise ExtractError(f"ffprobe 输出解析失败：{exc}") from exc

    streams = data.get("streams") or []
    fmt = data.get("format") or {}

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]

    duration = _to_float(fmt.get("duration"))
    if duration is None and video_stream is not None:
        duration = _to_float(video_stream.get("duration"))
    if duration is None:
        duration = 0.0

    fps = None
    if video_stream is not None:
        fps = _parse_fraction(video_stream.get("avg_frame_rate")) or _parse_fraction(
            video_stream.get("r_frame_rate")
        )

    has_audio = bool(audio_streams)
    if has_audio and duration > 0:
        # 只含极小音轨（无实际声音）仍视为有音轨，由 whisper 结果决定是否有文本
        pass

    return {
        "duration_s": round(duration, 3),
        "width": int(video_stream.get("width") or 0) if video_stream else 0,
        "height": int(video_stream.get("height") or 0) if video_stream else 0,
        "fps": round(fps, 3) if fps else None,
        "video_codec": (video_stream or {}).get("codec_name"),
        "has_audio": has_audio,
        "audio_codec": (audio_streams[0].get("codec_name") if audio_streams else None),
        "format_name": fmt.get("format_name"),
        "size_bytes": int(_to_float(fmt.get("size")) or 0) or Path(path).stat().st_size,
    }


def _to_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_fraction(value) -> float | None:
    if not value:
        return None
    try:
        if "/" in str(value):
            num, den = str(value).split("/", 1)
            den_f = float(den)
            if den_f == 0:
                return None
            return float(num) / den_f
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def extract_frames(
    path: str,
    out_dir: str,
    *,
    frame_interval: float = DEFAULT_FRAME_INTERVAL,
    max_frames: int = DEFAULT_MAX_FRAMES,
) -> list[Path]:
    """按固定间隔抽帧为 PNG。

    返回 ``[(帧文件, 该帧真实时间戳秒), ...]``，时间戳取自 ffmpeg ``showinfo`` 输出的
    ``pts_time``（fps 滤镜输出的帧不一定落在 0/interval 的整数格点上）；解析失败时
    退化为 ``index * interval``。
    """
    ffmpeg = require_ffmpeg()
    interval = max(0.1, float(frame_interval))
    pattern = str(Path(out_dir) / "frame_%04d.png")
    proc = run_exe(
        ffmpeg,
        [
            "-hide_banner",
            "-loglevel",
            "info",
            "-y",
            "-i",
            str(path),
            "-an",
            "-vf",
            f"fps=1/{interval},showinfo",
            "-frames:v",
            str(int(max_frames)),
            pattern,
        ],
        timeout=900,
        what="ffmpeg 抽帧",
    )
    if proc.returncode != 0:
        raise ExtractError(f"ffmpeg 抽帧失败：{tail_text(proc.stderr.strip(), 500)}")

    files = sorted(Path(out_dir).glob("frame_*.png"))
    times = [float(m) for m in _SHOWINFO_RE.findall(proc.stderr or "")]
    frames: list[tuple[Path, float]] = []
    for index, file in enumerate(files):
        timestamp = times[index] if index < len(times) else index * interval
        frames.append((file, round(max(0.0, timestamp), 2)))
    return frames


def extract_audio_track(path: str, out_wav: str) -> bool:
    """把音轨转为 16 kHz 单声道 wav（whisper 最佳输入）。失败返回 False。"""
    ffmpeg = require_ffmpeg()
    proc = run_exe(
        ffmpeg,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            out_wav,
        ],
        timeout=900,
        what="ffmpeg 抽音轨",
    )
    target = Path(out_wav)
    return proc.returncode == 0 and target.is_file() and target.stat().st_size > 44


def extract_video(
    path: str,
    *,
    ocr_lang: str = "ch",
    whisper_model: str = audio_mod.DEFAULT_WHISPER_MODEL,
    frame_interval: float = DEFAULT_FRAME_INTERVAL,
    max_frames: int = DEFAULT_MAX_FRAMES,
    **kw,
) -> tuple[str, dict, str]:
    """视频提取：逐帧 OCR（``[t=12.5s] 文字``）+ 音轨转写。"""
    require_ffmpeg()
    info = probe_media(path)

    tmp_dir = tempfile.mkdtemp(prefix="byk_video_")
    frame_results: list[dict] = []
    ocr_backend: str | None = None
    ocr_error: str | None = None

    try:
        try:
            frames = extract_frames(
                path, tmp_dir, frame_interval=frame_interval, max_frames=max_frames
            )
        except ExtractError:
            raise
        except Exception as exc:
            raise ExtractError(f"视频抽帧失败：{type(exc).__name__}: {exc}") from exc

        for index, (frame, timestamp) in enumerate(frames):
            try:
                lines, backend = ocr_mod.run_ocr(str(frame), lang=ocr_lang)
                ocr_backend = backend
                text = ocr_mod.lines_to_text(lines)
                frame_results.append(
                    {
                        "index": index,
                        "t": timestamp,
                        "text": text,
                        "line_count": len(lines),
                        "ok": True,
                    }
                )
            except ExtractError as exc:
                ocr_error = ocr_error or str(exc)
                frame_results.append(
                    {"index": index, "t": timestamp, "text": "", "line_count": 0, "ok": False, "error": str(exc)}
                )
            except Exception as exc:  # 单帧失败不影响其他帧
                ocr_error = ocr_error or f"{type(exc).__name__}: {exc}"
                frame_results.append(
                    {
                        "index": index,
                        "t": timestamp,
                        "text": "",
                        "line_count": 0,
                        "ok": False,
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )

        # ---- 音轨 ----
        transcript = ""
        transcript_meta: dict = {}
        audio_error: str | None = None
        has_audio = bool(info.get("has_audio"))
        if has_audio:
            wav_path = str(Path(tmp_dir) / "audio.wav")
            try:
                got_audio = extract_audio_track(path, wav_path)
                if not got_audio:
                    has_audio = False
                    audio_error = "ffmpeg 未能从视频中抽出可用音轨。"
                else:
                    transcript, transcript_meta, _ = audio_mod.transcribe_file(
                        wav_path, whisper_model=whisper_model
                    )
            except ExtractError as exc:
                audio_error = str(exc)
                has_audio = False
            except Exception as exc:
                audio_error = f"{type(exc).__name__}: {exc}"
                has_audio = False
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    # ---- 拼装文本 ----
    frame_lines = [f"[t={f['t']}s] {f['text']}" for f in frame_results if f["text"].strip()]
    transcript_segments = transcript_meta.get("segments", []) if transcript_meta else []
    transcript_lines = [
        f"[t={s['start']}s-{s['end']}s] {s['text']}" for s in transcript_segments if s.get("text")
    ]

    blocks: list[str] = []
    if frame_lines:
        blocks.append("[画面 OCR]\n" + "\n".join(frame_lines))
    if transcript_lines:
        blocks.append("[语音转写]\n" + "\n".join(transcript_lines))
    text = "\n\n".join(blocks)

    meta: dict = {
        "duration_s": info.get("duration_s"),
        "width": info.get("width"),
        "height": info.get("height"),
        "fps": info.get("fps"),
        "video_codec": info.get("video_codec"),
        "sampled_frames": len(frame_results),
        "has_audio": has_audio,
        "audio_codec": info.get("audio_codec"),
        "transcript_segments": transcript_segments,
        "transcript_language": transcript_meta.get("language") if transcript_meta else None,
        "transcript": transcript,
        "frame_interval_s": float(frame_interval),
        "max_frames": int(max_frames),
        "ocr_backend": ocr_backend,
        "ocr_lang": ocr_lang,
        "frames": [
            {"index": f["index"], "t": f["t"], "line_count": f["line_count"], "ok": f["ok"], "text": f["text"]}
            for f in frame_results
        ],
        "whisper_model": whisper_model,
        "size_bytes": info.get("size_bytes"),
    }
    # 契约规定「每 5 秒 1 帧、上限 24 帧」，因此 >120 秒的视频只会覆盖前 120 秒
    if info.get("duration_s") and info["duration_s"] > float(frame_interval) * int(max_frames):
        meta["frames_truncated"] = True
        meta["frames_truncated_note"] = (
            f"视频时长 {info['duration_s']}s 超过 {frame_interval}s×{max_frames}帧 的覆盖范围，"
            f"画面 OCR 只覆盖前 {float(frame_interval) * int(max_frames)}s；"
            "如需覆盖全片，请调大 max_frames 或调大 frame_interval。"
        )
    if ocr_error:
        meta["ocr_error"] = ocr_error
    if audio_error:
        meta["audio_error"] = audio_error
    if not text:
        meta["note"] = "视频未提取到任何文字（画面无文字且音轨无语音）。"
        if ocr_error:
            raise ExtractError(f"视频既无可用转写，画面 OCR 也全部失败：{ocr_error}", meta=meta)

    methods = [f"ffmpeg-frames:{len(frame_results)}"]
    if ocr_backend:
        methods.append(f"ocr:{ocr_backend}")
    if transcript_meta:
        methods.append(f"whisper:{whisper_model}")
    return text, meta, "+".join(methods)
