# 本地内容提取层（`byk/extract`）实现报告

> 范围：`docs/api-contract.md` 第 3、4 节的**本地内容提取层**——把任意文件变成「文本 + 元数据」。
> 全程本地推理，**不调用任何 LLM、不需要任何 API key**。
> 编写时间：2026-09-20。

---

## 1. 目录结构与文件清单

```
C:\Projects\byk\
├─ requirements-extract.txt          提取层依赖清单（新增）
├─ pytest.ini                        测试配置（新增，rootdir = 项目根）
├─ .venv\                            虚拟环境（Python 3.11.9，新增）
├─ byk\
│  ├─ __init__.py                    包根（此文件由另一位协作者维护，本层未改动）
│  └─ extract\                       ★ 本次交付的包
│     ├─ __init__.py                 导出 detect_kind / extract_file / extract_many / ExtractionResult
│     ├─ models.py                   ExtractionResult 数据模型 + ExtractKind + 200KB 上限常量
│     ├─ _common.py                  异常、惰性导入(require)、ffmpeg/ffprobe 探测、文本截断、二进制嗅探
│     ├─ dispatch.py                 detect_kind / extract_file / extract_many（调度与兜底）
│     ├─ documents.py                pypdf / python-docx / python-pptx / openpyxl / rtf / 纯文本
│     ├─ images.py                   Pillow 元数据 + 本地 OCR
│     ├─ ocr.py                      本地 OCR 后端（rapidocr → easyocr → paddleocr 降级链）
│     ├─ audio.py                    faster-whisper 本地转写
│     ├─ video.py                    ffmpeg 抽帧 + 逐帧 OCR + 音轨转写
│     └─ archives.py                 .zip 成员清单（不递归解包）
├─ tests\
│  ├─ conftest.py                    把项目根加入 sys.path（新增）
│  ├─ test_extract.py                ★ 36 个测试，素材全部现场生成（新增）
│  └─ _fixtures\                     测试素材输出目录（自动重建，已加 .gitignore 忽略）
├─ data\models\whisper\              whisper 权重本地缓存（约 538 MB，data/ 已在 .gitignore 中）
└─ docs\extract-report.md            ★ 本报告
```

契约要求的最少文件集合（`__init__.py`、`dispatch.py`、`documents.py`、`images.py`、`audio.py`、`video.py`、`ocr.py`）
全部具备；`models.py` / `_common.py` / `archives.py` 是为了避免循环导入与把兜底逻辑集中管理而拆出的辅助模块。

---

## 2. 依赖环境（实测安装成功的版本）

虚拟环境：`C:\Projects\byk\.venv`（`python -m venv .venv`，Python 3.11.9，pip 26.2.1）。
安装命令：`.venv\Scripts\python.exe -m pip install -r requirements-extract.txt`（另加 `pytest`）。

| 用途 | 包 | 实际版本 | 备注 |
|---|---|---|---|
| PDF | `pypdf` | **6.19.0** | 按契约指定 |
| Word | `python-docx` | **1.2.0** | 按契约指定 |
| PPT | `python-pptx` | **1.0.2** | 按契约指定 |
| Excel | `openpyxl` | **3.1.5** | 按契约指定 |
| 图片 | `Pillow` | **12.3.0** | 按契约指定 |
| OCR | `rapidocr-onnxruntime` | **1.4.4** | ✅ 安装并初始化成功，**未替换** |
| OCR 运行时 | `onnxruntime` | 1.30.0 | rapidocr 传递依赖 |
| OCR 运行时 | `opencv-python` | 5.0.0.93 | rapidocr 传递依赖 |
| OCR 运行时 | `numpy` | 2.4.6 | rapidocr 传递依赖 |
| 语音 | `faster-whisper` | **1.2.1** | ✅ 安装成功，权重下载成功 |
| 语音运行时 | `ctranslate2` | 4.8.2 | faster-whisper 传递依赖 |
| 语音运行时 | `av` / `tokenizers` / `huggingface_hub` | 18.1.0 / 0.23.2 / 1.32.0 | 传递依赖 |
| 测试 | `pytest` | 9.1.1 | 仅测试用 |

### 替换情况

**没有任何包被替换。** 契约推荐的 `rapidocr-onnxruntime` 安装、初始化、识别全部一次通过，
因此**没有启用** `paddleocr` / `easyocr` 备用方案（二者也未安装）。
不过 `byk/extract/ocr.py` 内建了降级链 `rapidocr → easyocr → paddleocr`：
当 rapidocr 不可用时会自动尝试后两者，若三者都不可用则返回
`ok=False` 并给出三者的 `pip install` 命令。

`ffmpeg` 使用绝对路径 `C:\utils\ffmpeg\bin\ffmpeg.exe`（本机不在 PATH）。
探测顺序：`BYK_FFMPEG` → `FFMPEG_BINARY` → `FFMPEG` 环境变量 → `C:\utils\ffmpeg\bin\ffmpeg.exe`
→ `C:\ffmpeg\bin\ffmpeg.exe` → `PATH`。`ffprobe` 同理（识别到 `C:\utils\ffmpeg\bin\ffprobe.exe`）。
本机 ffmpeg 编译包含 `libx264`、`aac`、`flite`（TTS）、`drawtext`、`testsrc` —— 测试素材依赖后两者。

---

## 3. OCR 最终选型

**选用 `rapidocr-onnxruntime` 1.4.4，一次成功，未更换。**

理由与验证：

* 纯 CPU、ONNX Runtime 后端，**不依赖 torch / paddle**，安装体积与启动开销都远小于 easyocr / paddleocr。
* **模型随 wheel 分发，首次调用不需要联网下载**（easyocr 需要联网拉 ~100 MB 权重；paddleocr 还要装 paddlepaddle，体积大得多）。
* 识别质量实测良好（见下方证据），中英文混合模型开箱可用。

真实识别结果（不是模拟）：

```
backends: ['rapidocr']
elapsed 5.0s (首次，含引擎加载)
lines: [('BYK OCR TEST', 0.996), ('Extract 2024', 0.999)]
backend: rapidocr

中文素材 -> '多智能体系统提取层测试'      （微软雅黑 52px 渲染）
预热后单张 760×240 图片耗时 0.75s
```

---

## 4. whisper 模型验证情况

**tiny 与 small 两个模型都真实下载成功并跑通了完整转写链路。**

* 权重缓存目录：`C:\Projects\byk\data\models\whisper`（**刻意放在项目内**，可用 `BYK_WHISPER_CACHE` 覆盖）。
  代码中的**默认模型仍是 `"small"`**，测试为提速使用 `"tiny"` 并通过参数覆盖。
* 计算后端：`device="cpu"`, `compute_type="int8"`（可用 `BYK_WHISPER_COMPUTE_TYPE` 覆盖），启用 silero VAD，
  VAD 资源缺失时自动退化为 `vad_filter=False`。
* 音频素材不是正弦音，而是用 ffmpeg 的 **`flite` 滤镜合成的真实英文语音**，因此转写断言是有效验证。

实测证据：

```
# tiny
model loaded in 6.8s（含下载）
method: whisper:tiny
duration: 6.455  lang: en  (p=0.9887)
text: 'Hello, this is a test of the local extraction layer,
       the quick brown fox jump over the lazy dog.'

# small（默认值，也真实跑通）
small model loaded OK in 41.1s（含 461 MB 下载）
method: whisper:small
text: 'Hello, this is a test of the local extraction layer,
       the quick brown fox jumps over the lazy dog.'   ← 比 tiny 更准确（jumps）
whisper small 单次转写 6.5s 音频：2.83s（已预热）
```

缓存实际占用：`tiny` 约 77 MB + `small` 约 461 MB = **538 MB**。

---

## 5. 测试运行结果

### 命令

```powershell
cd C:\Projects\byk
C:\Projects\byk\.venv\Scripts\python.exe -m pytest tests/test_extract.py -v
```

### 结果（清理 `tests\_fixtures` 后从零重建素材的完整跑）

```
platform win32 -- Python 3.11.9, pytest-9.1.1
rootdir: C:\Projects\byk
collected 36 items

test_result_dataclass_matches_contract PASSED
test_detect_kind PASSED
test_default_whisper_model_is_small PASSED
test_pdf PASSED / test_docx PASSED / test_pptx PASSED / test_xlsx PASSED
test_text_passthrough PASSED / test_text_truncation_200kb PASSED
test_text_gbk_encoding_detected PASSED / test_rtf PASSED / test_zip_listing_only PASSED
test_image_ocr PASSED / test_chinese_image_ocr PASSED / test_gif_via_temp_png_conversion PASSED
test_audio_transcription PASSED
test_video_frames_and_transcript PASSED
test_missing_file_returns_error PASSED / test_empty_file_returns_error PASSED
test_random_binary_returns_error PASSED / test_unsupported_extension_returns_error PASSED
test_directory_returns_error PASSED / test_garbage_inputs_never_raise PASSED
test_extract_file_never_raises_on_unknown_kwargs PASSED / test_corrupt_image_returns_error PASSED
test_missing_library_is_reported_not_raised[pdf-pypdf-pypdf] PASSED
test_missing_library_is_reported_not_raised[docx-docx-python-docx] PASSED
test_missing_library_is_reported_not_raised[pptx-pptx-python-pptx] PASSED
test_missing_library_is_reported_not_raised[xlsx-openpyxl-openpyxl] PASSED
test_missing_library_is_reported_not_raised[png-rapidocr_onnxruntime-rapidocr-onnxruntime] PASSED
test_missing_library_is_reported_not_raised[audio-faster_whisper-faster-whisper] PASSED
test_missing_pillow_is_reported PASSED / test_missing_ocr_backend_is_reported PASSED
test_missing_ffmpeg_is_reported PASSED
test_extract_many_isolates_failures PASSED / test_extract_many_ignores_unknown_kwargs PASSED

============================= 36 passed in 17.37s ==============================
```

**36 项全部通过，0 skip、0 xfail —— 音频与视频两项转写断言是真实跑通的，没有被跳过。**

### 测试素材（全部由脚本现场生成，无外部样例文件）

| 素材 | 生成方式 |
|---|---|
| `sample.png` | Pillow + arial.ttf 绘制 "BYK OCR TEST / Extract 2024" |
| `chinese.png` | Pillow + msyh.ttc 绘制 "多智能体系统 提取层测试" |
| `anim.gif` | Pillow 存 GIF（验证「非 OCR 友好格式→临时转 PNG」分支） |
| `sample.docx` | python-docx：标题 + 段落（含中文）+ 2×3 表格 |
| `sample.pptx` | python-pptx：2 张幻灯片 + 表格 + 演讲者备注 |
| `sample.pdf` | **手写最小 PDF 内容流**（见下方说明）+ pypdf 读回 |
| `sample.xlsx` | openpyxl：数据表 + 空表 |
| `sample.rtf` | 手写 RTF（含 fonttbl 目标组与 `\uNNNN` 中文转义） |
| `speech.wav` | `ffmpeg -f lavfi -i "flite=text='...':voice=slt"`（**真实语音**） |
| `clip.mp4` | `ffmpeg testsrc` + `drawtext` 烧录文字 + `flite` 语音，H.264/AAC |
| `big.txt` | 415 KB 文本（验证 200 KB 截断） |
| `empty.txt` / `random.bin` / `disguised.txt` / `corrupt.png` / `strange.qqq` | 边界与失败用例 |

> **关于 PDF 素材的说明**：契约任务描述里写「用 pypdf 造一个 pdf」，但 **pypdf 是读写库，
> 没有在页面上绘制文字的 API**，无法凭空生成带文本的 PDF。为不引入额外依赖（如 reportlab），
> 测试改为**手写最小 PDF 字节流**（Catalog/Pages/Page/Helvetica 字体/内容流 + 正确 xref），
> 再用 pypdf 读回验证提取链路。这是刻意的取舍，已在测试文件里注释说明。

### 端到端摘要（`python tests/test_extract.py`）

```
key          ok     kind         bytes  method
pdf          True   document        92  pypdf
docx         True   document       182  python-docx
pptx         True   document       162  python-pptx
xlsx         True   document       104  openpyxl
text         True   text            68  passthrough
big_text     True   text        204800  passthrough          ← 恰好 200 KB，已截断
png          True   image           25  ocr:rapidocr
zip          True   archive        136  zipfile-list
audio        True   audio           96  whisper:tiny
video        True   video          165  ffmpeg-frames:1+ocr:rapidocr+whisper:tiny
missing      False  document         0  文件不存在：...\definitely_missing.pdf
empty        False  text             0  文件为空（0 字节），没有可提取的内容：...
binary       False  unknown          0  不支持的文件类型 `.bin`...
binary_txt   False  text             0  `disguised.txt` 看起来是二进制文件（含 NUL/大量控制字符）...
unsupported  False  unknown          0  不支持的文件类型 `.qqq`...
```

视频提取文本实样（画面 OCR 按 ffmpeg 报出的真实 pts 时间戳标注）：

```
[画面 OCR]
[t=0.0s] BYKVIDEO OCR2024

[语音转写]
[t=0.0s-7.0s] Hello, this is a test of the local extraction layer,
              the quick brown fox jump over the lazy dog.
```

---

## 6. 契约逐条符合情况

| 契约要求 | 实现 | 验证 |
|---|---|---|
| 字段名与 §3 完全一致 | `ExtractionResult` 8 个字段按序 | `test_result_dataclass_matches_contract` 断言字段顺序 |
| `detect_kind` 按扩展名；`.zip`→archive，未知→unknown | `dispatch.detect_kind` | `test_detect_kind` |
| `.pdf`→pypdf | `documents.extract_pdf` | `test_pdf` |
| `.docx`→python-docx | `documents.extract_docx` | `test_docx` |
| `.pptx`**逐页**含表格与备注 | `documents.extract_pptx`，输出 `[slide N]` + `[备注]` | `test_pptx`（断言 slide1/slide2/表格值/备注） |
| `.xlsx/.xlsm`→openpyxl | `documents.extract_xlsx` | `test_xlsx` |
| `.txt/.md/.csv/.json/.log/.yaml/.xml`→直读（编码探测） | `documents.extract_text` | `test_text_passthrough`、`test_text_gbk_encoding_detected` |
| `.rtf`→尽力 | `documents.extract_rtf`（花括号配对剥目标组） | `test_rtf` |
| 图片本地 OCR，`text` + 宽高/格式/字节数 | `images.extract_image` → `meta` 含 width/height/format/size_bytes | `test_image_ocr` |
| **图片不得调用任何 LLM** | 全链路只有 onnxruntime 推理，无任何网络/LLM 调用 | 代码审查 |
| 音频 faster-whisper，`meta` 含 duration_s/language/segments | `audio.extract_audio` | `test_audio_transcription` |
| 视频 ffmpeg 抽帧（5s/帧，≤24 帧）逐帧 OCR，`[t=12.5s] 文字` | `video.extract_video` | `test_video_frames_and_transcript` |
| 视频 `meta` 含 duration_s/width/height/fps/sampled_frames/has_audio/transcript_segments | 全部提供 | 同上 |
| `.zip` 只列成员清单（名称/大小/是否目录），不递归解包 | `archives.extract_archive` | `test_zip_listing_only` |
| **可选依赖惰性导入，缺库 ok=False 且写明装什么，绝不抛异常** | `_common.require` + `dispatch.extract_file` 全量 try 包裹 | 8 项「模拟缺库」测试全部通过 |
| 单文件失败不影响其他文件 | `extract_many` 逐个隔离 | `test_extract_many_isolates_failures` |
| 单文件文本上限 200 KB，超出截断并 `meta["truncated"]=True` | `_common.truncate_text`（按 UTF-8 字节、不切多字节字符） | `test_text_truncation_200kb`（415 KB → 恰好 204800 B） |
| `extract_many(paths, **kw)` | 过滤未知 kwarg，保持输入顺序 | 同上两个测试 |

额外验证的健壮性（契约未强制，但属于「绝不炸掉编排器」的关键）：
`""` / `"   "` / 含 NUL 的路径 / `"Z:\不存在"` / `"."` / `".."` / `"con"` / 5000 字符超长路径 ——
全部返回 `ok=False` 且带 `error`，无一抛异常（`test_garbage_inputs_never_raise`）。

---

## 7. 已知限制

**能力边界（明确不支持，均返回 `ok=False` 或空文本，不会静默给错东西）**

1. **老版 Office 格式不支持**：`.doc` / `.ppt` / `.xls`（97-2003 二进制格式）不在契约列表中，
   `detect_kind` 判为 `unknown` → `ok=False`，提示先另存为新格式。
2. **压缩包只支持 `.zip`**：`.7z` / `.rar` / `.tar.gz` 判为 `unknown`。按契约 `.zip` 也**只列清单不解包**，
   因此压缩包内文件的内容永远不会被提取（需要解包时应由编排器决定是否落地解压后再调用本层）。
3. **扫描件 PDF 不做 OCR**：没有文本层时 `ok=True` 但 `text` 为空，`meta["has_text_layer"]=False`
   并附 `note` 说明。原因是渲染 PDF 页面需要额外依赖（pypdfium2/pdftoppm），当前未引入。
   可行替代：编排器先用 ffmpeg/其他工具把页面渲成图片，再交给 `images` 提取器走本地 OCR。
4. **`ocr_lang` 参数在 rapidocr 下不切换模型**：rapidocr-onnxruntime 内置的就是中英文混合模型，
   `ocr_lang` 仅记录在 `meta["ocr_lang"]` 中并附说明。只有降到 easyocr/paddleocr 时才会真正切语言。
5. **视频抽帧覆盖范围**：契约规定「每 5 秒 1 帧、上限 24 帧」，因此 **>120 秒的视频只覆盖前 120 秒**
   的画面。超过时 `meta["frames_truncated"]=True` 并给出说明；需要覆盖全片可传
   `frame_interval=` / `max_frames=`（这两个是契约之外的附加可选参数，默认值严格遵循契约）。
6. **逐帧 OCR 成本线性增长**：默认 24 帧 × 单帧约 0.3–0.8s，长视频的抽帧 OCR 会明显变慢。
   单帧 OCR 失败不会中断整体（写入 `meta["frames"][i]["error"]`），仅当「全部帧 OCR 失败且无语音转写」时才 `ok=False`。
7. **音频/视频没有时长上限保护**：whisper 在 CPU 上转写 1 小时音频需数分钟，本层不设超时。
   长音频建议编排器自行传更小的模型或先切片。
8. **编码探测是启发式**：链为 `utf-8-sig → utf-8 → gb18030 → big5 → cp932 → koi8-r → cp1252 → latin-1`。
   无 BOM 的 UTF-16 文本可能被 gb18030 误判成乱码；实际编码已写入 `meta["encoding"]` 供上层核对。
9. **二进制判定阈值**：含 NUL 字节，或控制字符占比 >10%，即判为二进制并 `ok=False`。
   这会让「伪装成 .txt 的随机二进制」正确失败，但极端情况下也可能误伤含大量控制字符的特殊文本格式。
10. **空文件一律 `ok=False`**：0 字节文件（哪怕是合法的空 .txt / 空 .csv）都会返回错误而不是空文本。
    这是为满足「空文件必须 ok=False」的验收要求所做的明确选择。
11. **rapidocr 对空格的处理**：`"BYK VIDEO OCR 2024"` 被识别为 `"BYKVIDEO OCR2024"`（空格丢失）。
    这是该 ONNX 识别模型的固有行为，`meta["lines"]` 里保留了逐行原始结果与置信度供上层判断。
12. **首次运行需要联网下载 whisper 权重**（tiny≈77 MB / small≈461 MB），下载失败时返回
    `ok=False` 并在 `error` 里说明「检查网络 / 手动放到 `data/models/whisper` / 直接把
    `whisper_model` 设为本地模型目录」。OCR 后端则**不需要**联网。

**性能参考（本机，已预热，CPU）**

| 操作 | 耗时 |
|---|---|
| PDF（1 页小文件）/ 文本 | 0.1s |
| 图片 OCR（760×240） | 0.75s |
| whisper `tiny` 转写 6.5s 音频 | 1.9s（约 0.3× 实时） |
| whisper `small` 转写 6.5s 音频 | 2.8s（约 0.43× 实时） |
| 视频（6.5s，1 帧 OCR + 音轨转写，tiny） | 4.0s |

---

## 8. 复现方式

```powershell
# 1) 依赖
C:\coding\Python\python.exe -m venv C:\Projects\byk\.venv
C:\Projects\byk\.venv\Scripts\python.exe -m pip install -r C:\Projects\byk\requirements-extract.txt
C:\Projects\byk\.venv\Scripts\python.exe -m pip install pytest

# 2) 测试（素材自动生成；首次会下载 whisper tiny 权重，需要联网）
cd C:\Projects\byk
C:\Projects\byk\.venv\Scripts\python.exe -m pytest tests/test_extract.py -v

# 3) 直接看每个素材的提取摘要
C:\Projects\byk\.venv\Scripts\python.exe tests\test_extract.py
```

```python
# 4) 作为库使用
from byk.extract import extract_file, extract_many
res = extract_file(r"C:\path\file.pdf")                       # 永不抛异常
print(res.ok, res.kind, res.method, res.error, len(res.text))
for r in extract_many(paths, whisper_model="small", ocr_lang="ch"):
    ...
```
