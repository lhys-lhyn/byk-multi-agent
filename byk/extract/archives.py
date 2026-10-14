"""压缩包：只列成员清单，**不递归解包**（契约 §4）。"""

from __future__ import annotations

import zipfile
from pathlib import Path

from ._common import ExtractError


def extract_archive(path: str, **_kw) -> tuple[str, dict, str]:
    """``.zip`` → ``meta["members"]`` = ``[{name, size, is_dir, compress_size, modified}]``。"""
    if not zipfile.is_zipfile(path):
        raise ExtractError(
            f"`{Path(path).name}` 不是有效的 ZIP（可能损坏，或需要密码/被分卷）。"
            "本层不做解包，请提供未加密的 zip 文件。"
        )

    members: list[dict] = []
    directories = 0
    uncompressed = 0
    try:
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                is_dir = info.is_dir()
                if is_dir:
                    directories += 1
                else:
                    uncompressed += info.file_size
                members.append(
                    {
                        "name": info.filename,
                        "size": info.file_size,
                        "is_dir": is_dir,
                        "compress_size": info.compress_size,
                        "modified": "%04d-%02d-%02d %02d:%02d:%02d" % info.date_time,
                    }
                )
    except ExtractError:
        raise
    except Exception as exc:
        raise ExtractError(f"ZIP 读取失败：{type(exc).__name__}: {exc}") from exc

    files = len(members) - directories
    listing = "\n".join(
        f"{'[目录] ' if m['is_dir'] else '       '}{m['name']}  ({m['size']} B)" for m in members
    )
    text = f"[压缩包 {Path(path).name}] 共 {files} 个文件 / {directories} 个目录\n{listing}".strip()

    meta = {
        "members": members,
        "member_count": len(members),
        "file_count": files,
        "dir_count": directories,
        "uncompressed_bytes": uncompressed,
        "note": "按契约只列出成员清单，不递归解包、不提取成员内容。",
    }
    return text, meta, "zipfile-list"
