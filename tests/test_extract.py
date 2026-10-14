"""``byk.extract`` 提取层测试。

测试素材**全部由脚本现场生成**（不依赖任何外部样例文件）：

* PNG  —— Pillow 绘制带文字的图片
* DOCX —— python-docx 生成（含标题/段落/表格）
* PPTX —— python-pptx 生成（含正文/表格/备注）
* XLSX —— openpyxl 生成
* PDF  —— 手写最小 PDF 文本流（pypdf 只能读写已有 PDF，**无法用 pypdf 生成带文字的 PDF**，
          因此这里手写内容流，再用 pypdf 读回验证）
* ZIP  —— zipfile 生成
* 音频  —— ffmpeg ``flite`` 滤镜合成**真实英文语音**（不是正弦音，保证 whisper 有内容可转写）
* 视频  —— ffmpeg ``testsrc`` + ``drawtext`` 烧录文字 + ``flite`` 语音合成为 mp4
* 大文本 / 空文件 / 随机二进制 —— 用于边界与失败用例

运行（必须用 .venv 里的解释器）::

    C:\\Projects\\byk\\.venv\\Scripts\\python.exe -m pytest tests/test_extract.py -v

也可以直接当脚本跑，打印每个素材的提取摘要::

    C:\\Projects\\byk\\.venv\\Scripts\\python.exe tests/test_extract.py
"""

from __future__ import annotations

import dataclasses
import os
import random
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from byk.extract import (  # noqa: E402
    MAX_TEXT_BYTES,
    ExtractionResult,
    detect_kind,
    extract_file,
    extract_many,
)

FIXTURE_DIR = REPO_ROOT / "tests" / "_fixtures"

FFMPEG = os.environ.get("BYK_FFMPEG", r"C:\utils\ffmpeg\bin\ffmpeg.exe")

#: 测试用 whisper 模型（下载快）；生产默认仍是 "small"
TEST_WHISPER_MODEL = "tiny"

#: flite 合成的英文语音内容（不含单引号，避免 ffmpeg 滤镜转义问题）
SPEECH_TEXT = "Hello. This is a test of the local extraction layer. The quick brown fox jumps over the lazy dog."


# --------------------------------------------------------------------------- #
# 素材生成
# --------------------------------------------------------------------------- #
def _run(exe: str, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [exe, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _find_font() -> str | None:
    for name in ("arial.ttf", "segoeui.ttf", "calibri.ttf", "verdana.ttf"):
        candidate = Path(r"C:\Windows\Fonts") / name
        if candidate.is_file():
            return str(candidate)
    return None


def make_png(path: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (760, 240), "white")
    draw = ImageDraw.Draw(image)
    font_path = _find_font()
    font = ImageFont.truetype(font_path, 56) if font_path else ImageFont.load_default()
    draw.text((30, 40), "BYK OCR TEST", fill="black", font=font)
    draw.text((30, 130), "Extract 2024", fill="black", font=font)
    image.save(path, format="PNG")


def make_docx(path: Path) -> None:
    import docx

    document = docx.Document()
    document.add_heading("BYK Extraction Report", level=1)
    document.add_paragraph("This paragraph comes from a generated DOCX fixture.")
    document.add_paragraph("第二段：中文内容也要能正确提取。")
    table = document.add_table(rows=2, cols=3)
    for col, value in enumerate(("Name", "Kind", "Size")):
        table.cell(0, col).text = value
    for col, value in enumerate(("alpha.pdf", "document", "12KB")):
        table.cell(1, col).text = value
    document.save(path)


def make_pptx(path: Path) -> None:
    from pptx import Presentation
    from pptx.util import Inches

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[1])
    slide.shapes.title.text = "BYK Slide One"
    slide.placeholders[1].text = "Slide body text from python-pptx fixture"

    table_slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    table_slide.shapes.title.text = "BYK Slide Two"
    table = table_slide.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(6), Inches(1.5)).table
    table.cell(0, 0).text = "Header A"
    table.cell(0, 1).text = "Header B"
    table.cell(1, 0).text = "value 1"
    table.cell(1, 1).text = "value 2"
    table_slide.notes_slide.notes_text_frame.text = "Speaker notes for slide two"

    presentation.save(path)


def make_pdf(path: Path) -> None:
    """手写最小 PDF（Helvetica 文本流）。

    说明：pypdf 是**读写库**，不能在页面上绘制新文字，所以这里直接构造 PDF 字节；
    生成后用 pypdf 读回，验证 pypdf 提取链路。
    """
    lines = [
        "BYK PDF extraction test 2024",
        "Second line extracted by pypdf",
        "Third line: hello world",
    ]
    content = ["BT", "/F1 18 Tf", "72 720 Td", "22 TL"]
    for index, line in enumerate(lines):
        escaped = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        if index:
            content.append("T*")
        content.append(f"({escaped}) Tj")
    content.append("ET")
    stream = "\n".join(content).encode("latin-1")

    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
    xref_offset = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode("ascii")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode("ascii")
    path.write_bytes(bytes(out))


def make_xlsx(path: Path) -> None:
    from openpyxl import Workbook

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "BYK"
    sheet.append(["Name", "Role", "Note"])
    sheet.append(["doc.pdf", "file", "extract layer"])
    sheet.append(["audio.wav", "audio", "whisper"])
    workbook.create_sheet("Empty")
    workbook.save(path)


def make_zip(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("readme.txt", "hello from the zip fixture")
        archive.writestr("nested/data.csv", "a,b,c\n1,2,3\n")
        archive.writestr("empty_dir/", "")


RTF_SOURCE = (
    r"{\rtf1\ansi\deff0 {\fonttbl{\f0 Times;}{\f1 Arial;}}"
    r"{\*\generator Riched20 10.0;}"
    r"\f0\fs24 BYK RTF test line one.\par Second line.\par \u20013\u25991\u27979\u35797\par}"
)


def make_rtf(path: Path) -> None:
    """手写 RTF（含 fonttbl/pict 目标组 + ``\\uN`` 中文转义）验证剥壳逻辑。"""
    path.write_bytes(RTF_SOURCE.encode("latin-1"))


def make_cn_png(path: Path) -> None:
    """用微软雅黑绘制中文，验证 rapidocr 的中文识别能力。"""
    from PIL import Image, ImageDraw, ImageFont

    font_path = Path(r"C:\Windows\Fonts\msyh.ttc")
    if not font_path.is_file():
        raise RuntimeError("缺少 msyh.ttc，跳过中文 OCR 素材")
    image = Image.new("RGB", (760, 160), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(font_path), 52)
    draw.text((25, 30), "多智能体系统 提取层测试", fill="black", font=font)
    image.save(path)


def make_audio(path: Path) -> None:
    """ffmpeg flite 合成真实英文语音 → 16kHz 单声道 WAV。"""
    filter_spec = f"flite=text='{SPEECH_TEXT}':voice=slt"
    proc = _run(
        FFMPEG,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            filter_spec,
            "-ar",
            "16000",
            "-ac",
            "1",
            str(path),
        ],
    )
    if proc.returncode != 0 or not path.is_file():
        raise RuntimeError(f"ffmpeg flite 合成音频失败：{proc.stderr}")


def make_video(path: Path) -> None:
    """testsrc 画面 + drawtext 烧录文字 + flite 语音 → H.264/AAC mp4。"""
    font = _find_font()
    chains = []
    if font:
        font_escaped = font.replace("\\", "/").replace(":", r"\:")
        chains.append(
            "drawtext=fontfile='{}':text='BYK VIDEO OCR 2024':fontsize=34:fontcolor=white:"
            "box=1:boxcolor=black@0.6:x=24:y=24".format(font_escaped)
        )
    video_filter = ",".join(chains) if chains else "null"

    proc = _run(
        FFMPEG,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=640x360:rate=10:duration=8",
            "-f",
            "lavfi",
            "-i",
            f"flite=text='{SPEECH_TEXT}':voice=slt",
            "-vf",
            video_filter,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ],
    )
    if proc.returncode != 0 or not path.is_file():
        raise RuntimeError(f"ffmpeg 合成视频失败：{proc.stderr}")


def make_big_text(path: Path) -> None:
    """生成 > 200KB 的文本，用于验证截断。"""
    unit = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ 这是一行中文测试文本。\n"
    lines = []
    total = 0
    while total < MAX_TEXT_BYTES * 2:
        lines.append(unit)
        total += len(unit.encode("utf-8"))
    path.write_text("".join(lines), encoding="utf-8")


def make_random_binary(path: Path, size: int = 4096) -> None:
    rng = random.Random(20240921)
    path.write_bytes(bytes(rng.randrange(256) for _ in range(size)))


def make_fixtures(force: bool = False) -> dict[str, Path]:
    """生成全部测试素材，返回 ``{名称: 路径}``。"""
    if force and FIXTURE_DIR.exists():
        shutil.rmtree(FIXTURE_DIR, ignore_errors=True)
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)

    files: dict[str, Path] = {
        "png": FIXTURE_DIR / "sample.png",
        "docx": FIXTURE_DIR / "sample.docx",
        "pptx": FIXTURE_DIR / "sample.pptx",
        "pdf": FIXTURE_DIR / "sample.pdf",
        "xlsx": FIXTURE_DIR / "sample.xlsx",
        "zip": FIXTURE_DIR / "sample.zip",
        "rtf": FIXTURE_DIR / "sample.rtf",
        "cn_png": FIXTURE_DIR / "chinese.png",
        "audio": FIXTURE_DIR / "speech.wav",
        "video": FIXTURE_DIR / "clip.mp4",
        "text": FIXTURE_DIR / "notes.txt",
        "big_text": FIXTURE_DIR / "big.txt",
        "empty": FIXTURE_DIR / "empty.txt",
        "binary": FIXTURE_DIR / "random.bin",
        "binary_txt": FIXTURE_DIR / "disguised.txt",
        "corrupt_png": FIXTURE_DIR / "corrupt.png",
        "unsupported": FIXTURE_DIR / "strange.qqq",
        "missing": FIXTURE_DIR / "definitely_missing.pdf",
    }

    builders = {
        "png": make_png,
        "cn_png": make_cn_png,
        "docx": make_docx,
        "pptx": make_pptx,
        "pdf": make_pdf,
        "xlsx": make_xlsx,
        "zip": make_zip,
        "rtf": make_rtf,
        "audio": make_audio,
        "video": make_video,
        "big_text": make_big_text,
    }
    for key, builder in builders.items():
        target = files[key]
        if not target.is_file():
            try:
                builder(target)
            except RuntimeError as exc:
                print(f"[fixture skip] {key}: {exc}", file=sys.stderr)

    files["text"].write_text(
        "BYK 提取层测试文本。\nLine two of the passthrough fixture.\n", encoding="utf-8"
    )
    files["gbk"] = FIXTURE_DIR / "gbk.txt"
    files["gbk"].write_bytes("中文GBK编码测试\n第二行\n".encode("gbk"))
    files["empty"].write_bytes(b"")
    make_random_binary(files["binary"])
    make_random_binary(files["binary_txt"])
    make_random_binary(files["corrupt_png"])
    files["unsupported"].write_text("unsupported extension fixture", encoding="utf-8")
    if files["missing"].exists():
        files["missing"].unlink()
    return files


_FIXTURES: dict[str, Path] | None = None


def fixtures() -> dict[str, Path]:
    global _FIXTURES
    if _FIXTURES is None:
        _FIXTURES = make_fixtures()
    return _FIXTURES


# --------------------------------------------------------------------------- #
# 契约 / 类型判定
# --------------------------------------------------------------------------- #
def test_result_dataclass_matches_contract():
    names = [f.name for f in dataclasses.fields(ExtractionResult)]
    assert names == ["path", "name", "kind", "ok", "text", "meta", "error", "method"]


def test_detect_kind():
    assert detect_kind("a.pdf") == "document"
    assert detect_kind("a.PDF") == "document"
    assert detect_kind("a.docx") == "document"
    assert detect_kind("a.pptx") == "document"
    assert detect_kind("a.xlsx") == "document"
    assert detect_kind(r"C:\tmp\a.xlsm") == "document"
    assert detect_kind("a.rtf") == "document"
    assert detect_kind("a.txt") == "text"
    assert detect_kind("a.md") == "text"
    assert detect_kind("a.yaml") == "text"
    assert detect_kind("a.png") == "image"
    assert detect_kind("a.jpeg") == "image"
    assert detect_kind("a.mp3") == "audio"
    assert detect_kind("a.wav") == "audio"
    assert detect_kind("a.mp4") == "video"
    assert detect_kind("a.mkv") == "video"
    assert detect_kind("a.zip") == "archive"
    assert detect_kind("a.zzz") == "unknown"
    assert detect_kind("noextension") == "unknown"


def test_default_whisper_model_is_small():
    import inspect

    params = inspect.signature(extract_file).parameters
    assert params["whisper_model"].default == "small"
    assert params["ocr_lang"].default == "ch"
    assert params["ocr_lang"].kind is inspect.Parameter.KEYWORD_ONLY


# --------------------------------------------------------------------------- #
# 文档
# --------------------------------------------------------------------------- #
def test_pdf():
    result = extract_file(str(fixtures()["pdf"]))
    assert result.ok, result.error
    assert result.kind == "document"
    assert "BYK PDF extraction test 2024" in result.text
    assert result.method == "pypdf"
    assert result.meta["pages"] == 1


def test_docx():
    result = extract_file(str(fixtures()["docx"]))
    assert result.ok, result.error
    assert "BYK Extraction Report" in result.text
    assert "中文内容也要能正确提取" in result.text
    assert "alpha.pdf" in result.text  # 表格内容
    assert result.meta["tables"] == 1
    assert result.method == "python-docx"


def test_pptx():
    result = extract_file(str(fixtures()["pptx"]))
    assert result.ok, result.error
    assert "[slide 1]" in result.text and "[slide 2]" in result.text
    assert "BYK Slide One" in result.text
    assert "value 2" in result.text  # 表格
    assert "Speaker notes for slide two" in result.text  # 备注
    assert "Speaker notes" in result.text
    assert result.meta["slides"] == 2
    assert result.meta["notes_slides"] == 1
    assert result.method == "python-pptx"


def test_xlsx():
    result = extract_file(str(fixtures()["xlsx"]))
    assert result.ok, result.error
    assert "[sheet BYK]" in result.text
    assert "extract layer" in result.text
    assert result.meta["sheet_count"] == 2


def test_text_passthrough():
    result = extract_file(str(fixtures()["text"]))
    assert result.ok, result.error
    assert result.kind == "text"
    assert "BYK 提取层测试文本" in result.text
    assert result.method == "passthrough"
    assert result.meta["encoding"].lower().startswith("utf-8")


def test_text_truncation_200kb():
    result = extract_file(str(fixtures()["big_text"]))
    assert result.ok, result.error
    assert result.meta["truncated"] is True
    assert len(result.text.encode("utf-8")) <= MAX_TEXT_BYTES
    assert result.meta["text_bytes_before_truncate"] > MAX_TEXT_BYTES


def test_text_gbk_encoding_detected():
    result = extract_file(str(fixtures()["gbk"]))
    assert result.ok, result.error
    assert "中文GBK编码测试" in result.text
    assert result.meta["encoding"] in ("gb18030", "gbk")


def test_rtf():
    result = extract_file(str(fixtures()["rtf"]))
    assert result.ok, result.error
    assert "BYK RTF test line one." in result.text
    assert "Second line." in result.text
    assert "中文测试" in result.text  # \uNNNN 转义还原
    assert "Times" not in result.text  # fonttbl 目标组被整组剥掉


def test_zip_listing_only():
    result = extract_file(str(fixtures()["zip"]))
    assert result.ok, result.error
    assert result.kind == "archive"
    names = [m["name"] for m in result.meta["members"]]
    assert "readme.txt" in names and "nested/data.csv" in names
    assert result.meta["file_count"] == 2
    assert result.meta["dir_count"] == 1
    assert all({"name", "size", "is_dir"} <= set(m) for m in result.meta["members"])


# --------------------------------------------------------------------------- #
# 图片（本地 OCR）
# --------------------------------------------------------------------------- #
def test_image_ocr():
    result = extract_file(str(fixtures()["png"]))
    assert result.ok, result.error
    assert result.kind == "image"
    assert result.text.strip(), "OCR 未识别出任何文字"
    upper = result.text.upper().replace(" ", "")
    assert "BYK" in upper and "2024" in upper, result.text
    assert result.meta["width"] == 760 and result.meta["height"] == 240
    assert result.meta["format"] == "PNG"
    assert result.meta["size_bytes"] > 0
    assert result.method.startswith("ocr:")


def test_chinese_image_ocr():
    path = fixtures()["cn_png"]
    if not path.is_file():
        pytest.skip("缺少 msyh.ttc，未生成中文 OCR 素材")
    result = extract_file(str(path))
    assert result.ok, result.error
    assert result.text.strip(), "中文 OCR 未识别出任何文字"
    assert "多智能体系统" in result.text.replace(" ", ""), result.text


def test_gif_via_temp_png_conversion():
    """GIF 不是 OCR 友好格式，会先经 Pillow 转成临时 PNG 再识别。"""
    from PIL import Image

    path = FIXTURE_DIR / "anim.gif"
    if not path.is_file():
        Image.open(fixtures()["png"]).save(path, format="GIF")
    result = extract_file(str(path))
    assert result.ok, result.error
    assert result.meta["format"] == "GIF"
    assert result.text.strip()


# --------------------------------------------------------------------------- #
# 音频 / 视频（whisper）
# --------------------------------------------------------------------------- #
def _extract_or_skip(path: Path, **kw) -> ExtractionResult:
    """跑 whisper；权重没下载下来时跳过并打印原因（不伪装成功）。"""
    result = extract_file(str(path), **kw)
    if not result.ok and result.method == "" and "faster-whisper" in (result.error or ""):
        pytest.skip(f"whisper 不可用，跳过：{result.error}")
    if not result.ok and "模型" in (result.error or ""):
        pytest.skip(f"whisper 模型不可用，跳过：{result.error}")
    return result


def test_audio_transcription():
    result = _extract_or_skip(fixtures()["audio"], whisper_model=TEST_WHISPER_MODEL)
    assert result.ok, result.error
    assert result.kind == "audio"
    assert result.text.strip(), "whisper 转写结果为空"
    assert result.method == f"whisper:{TEST_WHISPER_MODEL}"
    assert result.meta["duration_s"] > 1.0
    assert isinstance(result.meta["segments"], list) and result.meta["segments"]
    assert {"start", "end", "text"} <= set(result.meta["segments"][0])
    lowered = result.text.lower()
    assert "test" in lowered or "extraction" in lowered, result.text


def test_video_frames_and_transcript():
    result = _extract_or_skip(fixtures()["video"], whisper_model=TEST_WHISPER_MODEL)
    assert result.ok, result.error
    assert result.kind == "video"
    assert result.text.strip(), "视频未提取到任何文字"
    meta = result.meta
    assert meta["sampled_frames"] >= 1
    assert meta["has_audio"] is True
    assert meta["duration_s"] > 1.0
    assert meta["width"] == 640 and meta["height"] == 360
    assert meta["fps"]
    assert meta["transcript_segments"], "音轨转写为空"
    assert meta["transcript"].strip()
    # 画面 OCR：drawtext 烧录了 "BYK VIDEO OCR 2024"
    frame_text = " ".join(f["text"] for f in meta["frames"]).upper().replace(" ", "")
    assert "BYK" in frame_text, f"视频抽帧 OCR 未命中烧录文字：{meta['frames']}"
    assert result.text.startswith("[画面 OCR]")


# --------------------------------------------------------------------------- #
# 失败路径：必须 ok=False 且不抛异常（最重要的断言）
# --------------------------------------------------------------------------- #
def test_missing_file_returns_error():
    result = extract_file(str(fixtures()["missing"]))
    assert isinstance(result, ExtractionResult)
    assert result.ok is False
    assert result.error and "不存在" in result.error
    assert result.text == ""
    assert result.kind == "document"


def test_empty_file_returns_error():
    result = extract_file(str(fixtures()["empty"]))
    assert result.ok is False
    assert result.error and "空" in result.error


def test_random_binary_returns_error():
    for key in ("binary", "binary_txt"):
        result = extract_file(str(fixtures()[key]))
        assert result.ok is False, f"{key} 应该失败"
        assert result.error
        assert result.text == ""


def test_unsupported_extension_returns_error():
    result = extract_file(str(fixtures()["unsupported"]))
    assert result.ok is False
    assert result.error and "不支持" in result.error


def test_directory_returns_error():
    result = extract_file(str(FIXTURE_DIR))
    assert result.ok is False
    assert result.error and "目录" in result.error


def test_garbage_inputs_never_raise():
    """各种垃圾输入都不得抛异常。"""
    garbage = [
        "",
        "   ",
        "\x00\x01\x02",
        "C:\\\x00bad",
        "Z:\\does\\not\\exist\\a.pdf",
        ".",
        "..",
        "con",
        "a" * 5000,
    ]
    for value in garbage:
        result = extract_file(value)
        assert isinstance(result, ExtractionResult)
        assert result.ok is False
        assert result.error


def test_extract_file_never_raises_on_unknown_kwargs():
    result = extract_file(str(fixtures()["text"]), nonsense_option=True)
    assert result.ok is True


def test_corrupt_image_returns_error():
    result = extract_file(str(fixtures()["corrupt_png"]))
    assert result.ok is False
    assert result.error and result.text == ""


# --------------------------------------------------------------------------- #
# 缺依赖：必须 ok=False + 写明装什么，绝不抛异常
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("fixture_key", "module_name", "package_name"),
    [
        ("pdf", "pypdf", "pypdf"),
        ("docx", "docx", "python-docx"),
        ("pptx", "pptx", "python-pptx"),
        ("xlsx", "openpyxl", "openpyxl"),
        ("png", "rapidocr_onnxruntime", "rapidocr-onnxruntime"),
        ("audio", "faster_whisper", "faster-whisper"),
    ],
)
def test_missing_library_is_reported_not_raised(monkeypatch, fixture_key, module_name, package_name):
    """模拟「库没装」：返回 ok=False，error 里写明缺哪个库、装什么。"""
    for name in list(sys.modules):
        if name == module_name or name.startswith(module_name + "."):
            monkeypatch.setitem(sys.modules, name, None)
    monkeypatch.setitem(sys.modules, module_name, None)
    # 清掉可能已缓存的引擎/模型
    monkeypatch.setattr("byk.extract.ocr._ENGINES", {}, raising=False)
    monkeypatch.setattr("byk.extract.audio._MODELS", {}, raising=False)

    result = extract_file(str(fixtures()[fixture_key]), whisper_model=TEST_WHISPER_MODEL)
    assert isinstance(result, ExtractionResult)
    assert result.ok is False, result.error
    assert result.error
    assert "pip install" in result.error, result.error
    assert package_name in result.error, result.error


def test_missing_pillow_is_reported(monkeypatch):
    monkeypatch.setitem(sys.modules, "PIL", None)
    monkeypatch.setitem(sys.modules, "PIL.Image", None)
    result = extract_file(str(fixtures()["png"]))
    assert result.ok is False
    assert "Pillow" in result.error and "pip install" in result.error


def test_missing_ocr_backend_is_reported(monkeypatch):
    """三个 OCR 后端都不可用时，给出可操作的安装指引。"""
    import byk.extract.ocr as ocr_module

    monkeypatch.setattr(ocr_module, "available_backends", lambda: [])
    result = extract_file(str(fixtures()["png"]))
    assert result.ok is False
    assert "OCR" in result.error
    assert "rapidocr-onnxruntime" in result.error and "pip install" in result.error


def test_missing_ffmpeg_is_reported(monkeypatch):
    """ffmpeg 不存在时，视频提取返回 ok=False 而不是抛异常。"""
    import byk.extract._common as common

    monkeypatch.setattr(common, "_FFMPEG_CANDIDATES", ())
    monkeypatch.setattr(common.shutil, "which", lambda _name: None)
    for var in ("BYK_FFMPEG", "FFMPEG_BINARY", "FFMPEG", "BYK_FFPROBE", "FFPROBE_BINARY"):
        monkeypatch.delenv(var, raising=False)

    result = extract_file(str(fixtures()["video"]), whisper_model=TEST_WHISPER_MODEL)
    assert result.ok is False
    assert result.error and "ffmpeg" in result.error


# --------------------------------------------------------------------------- #
# 批量
# --------------------------------------------------------------------------- #
def test_extract_many_isolates_failures():
    files = fixtures()
    paths = [
        str(files["text"]),
        str(files["missing"]),
        str(files["empty"]),
        str(files["binary"]),
        str(files["pdf"]),
        str(files["unsupported"]),
        str(files["docx"]),
    ]
    results = extract_many(paths)
    assert len(results) == len(paths)
    assert [r.name for r in results] == [Path(p).name for p in paths]
    assert [r.ok for r in results] == [True, False, False, False, True, False, True]
    ok_count = sum(1 for r in results if r.ok)
    assert ok_count == 3
    for bad in (r for r in results if not r.ok):
        assert bad.error
    assert all(isinstance(r, ExtractionResult) for r in results)


def test_extract_many_ignores_unknown_kwargs():
    results = extract_many([str(fixtures()["text"])], not_a_real_option=1, ocr_lang="ch")
    assert len(results) == 1 and results[0].ok


# --------------------------------------------------------------------------- #
# 直接运行时的摘要输出（供人工核对 / 写报告取证）
# --------------------------------------------------------------------------- #
def _summary_rows() -> list[tuple[str, ExtractionResult]]:
    files = make_fixtures()
    keys = [
        "pdf",
        "docx",
        "pptx",
        "xlsx",
        "rtf",
        "text",
        "gbk",
        "big_text",
        "png",
        "cn_png",
        "zip",
        "audio",
        "video",
        "missing",
        "empty",
        "binary",
        "binary_txt",
        "corrupt_png",
        "unsupported",
    ]
    rows = []
    for key in keys:
        path = files.get(key)
        if path is None or not path.is_file():
            continue
        kwargs = {"whisper_model": TEST_WHISPER_MODEL} if key in ("audio", "video") else {}
        rows.append((key, extract_file(str(path), **kwargs)))
    return rows


def main() -> int:
    print(f"fixtures -> {FIXTURE_DIR}")
    print(f"{'key':<12} {'ok':<6} {'kind':<9} {'bytes':>8}  method")
    print("-" * 78)
    for key, result in _summary_rows():
        print(
            f"{key:<12} {str(result.ok):<6} {result.kind:<9} "
            f"{len(result.text.encode('utf-8')):>8}  {result.method or result.error}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
