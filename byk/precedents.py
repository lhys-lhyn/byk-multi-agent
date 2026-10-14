"""提权先例库。

设计要点：
1. **先例库永不存明文口令**。记录里只放 `secret_ref`，真值在 data/secrets.json（已加入 .gitignore）。
2. 每次真正执行特权命令前，都必须经过用户在界面上的确认；本模块只负责"匹配 + 准备"，不自行执行。
3. 执行成功后自动累加 `success_count`，下次能被更准确地匹配上 —— 这就是"复刻以前成功的提权"。
"""
from __future__ import annotations

import json
import re
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import PRECEDENTS, SECRETS

SECRET_PLACEHOLDER = "{{secret}}"
MASK = "••••••••"


@dataclass
class Precedent:
    id: str
    title: str
    match_keywords: list[str] = field(default_factory=list)
    command_template: str = ""
    secret_ref: str | None = None
    success_count: int = 0
    last_used_at: str | None = None
    created_at: str = ""
    last_command: str = ""


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


class SecretStore:
    """极简本地密钥库。只存"引用 -> 值"，永远不把值写进先例库或日志。"""

    def __init__(self, path: Path = SECRETS) -> None:
        self.path = Path(path)

    def _read(self) -> dict:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def set(self, ref: str, value: str) -> None:
        data = self._read()
        data[ref] = {"value": value, "updated_at": _now()}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def get(self, ref: str) -> str | None:
        entry = self._read().get(ref)
        if isinstance(entry, dict):
            v = entry.get("value")
            return v if isinstance(v, str) and v else None
        return None

    def has(self, ref: str) -> bool:
        return self.get(ref) is not None

    def list_refs(self) -> list[str]:
        return sorted(self._read().keys())


class PrecedentStore:
    def __init__(self, path: Path = PRECEDENTS, secrets: SecretStore | None = None) -> None:
        self.path = Path(path)
        self.secrets = secrets or SecretStore()

    def load(self) -> list[Precedent]:
        if not self.path.exists():
            return []
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return []
        out: list[Precedent] = []
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict) or "id" not in item:
                continue
            known = {k: v for k, v in item.items() if k in Precedent.__dataclass_fields__}
            known.setdefault("title", "")
            known.setdefault("created_at", _now())
            out.append(Precedent(**known))
        return out

    def save(self, items: list[Precedent]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps([asdict(p) for p in items], ensure_ascii=False, indent=2), encoding="utf-8"
        )

    # ---- 匹配 ----

    @staticmethod
    def _score(p: Precedent, haystack: str) -> int:
        low = haystack.lower()
        score = 0
        for kw in p.match_keywords:
            if kw and kw.lower() in low:
                score += 2
        # 命令结构相似度：取命令里的可执行程序名做弱匹配
        if p.last_command:
            head = p.last_command.strip().split()
            if head:
                prog = head[0].lower()
                if prog and prog in low:
                    score += 1
        return score

    def match(self, reason: str, command: str, hint: str = "") -> tuple[Precedent | None, str]:
        """按关键词与命令结构匹配历史成功先例。返回 (先例, 人类可读的理由)。"""
        haystack = f"{reason} {command} {hint}"
        best: Precedent | None = None
        best_score = 0
        for p in self.load():
            s = self._score(p, haystack)
            if s > best_score or (s == best_score and s > 0 and best and p.success_count > best.success_count):
                best, best_score = p, s
        if best is None or best_score == 0:
            return None, "未匹配到历史先例，将按代码助手上交的命令原样执行"
        return best, f"匹配到历史成功先例「{best.title}」（已成功 {best.success_count} 次）"

    # ---- 记录 ----

    def add(
        self,
        title: str,
        command_template: str,
        keywords: list[str],
        secret_ref: str | None = None,
    ) -> Precedent:
        items = self.load()
        p = Precedent(
            id=f"p_{uuid.uuid4().hex[:10]}",
            title=title,
            match_keywords=[k for k in keywords if k],
            command_template=command_template,
            secret_ref=secret_ref,
            success_count=0,
            created_at=_now(),
        )
        items.append(p)
        self.save(items)
        return p

    def record_success(self, command: str, reason: str, hint: str, secret_ref: str | None) -> Precedent:
        """执行成功后，把这条经验沉淀成可复刻的先例。"""
        matched, _ = self.match(reason, command, hint)
        items = self.load()
        if matched is not None:
            for p in items:
                if p.id == matched.id:
                    p.success_count += 1
                    p.last_used_at = _now()
                    p.last_command = command
                    if secret_ref and not p.secret_ref:
                        p.secret_ref = secret_ref
                    self.save(items)
                    return p
        keywords = _derive_keywords(reason, hint)
        p = Precedent(
            id=f"p_{uuid.uuid4().hex[:10]}",
            title=(reason or "特权操作")[:120],
            match_keywords=keywords,
            command_template=command,
            secret_ref=secret_ref,
            success_count=1,
            last_used_at=_now(),
            created_at=_now(),
            last_command=command,
        )
        items.append(p)
        self.save(items)
        return p

    def update(self, pid: str, **fields) -> Precedent | None:
        items = self.load()
        for p in items:
            if p.id == pid:
                for k, v in fields.items():
                    if hasattr(p, k):
                        setattr(p, k, v)
                self.save(items)
                return p
        return None

    def delete(self, pid: str) -> bool:
        items = self.load()
        keep = [p for p in items if p.id != pid]
        if len(keep) == len(items):
            return False
        self.save(keep)
        return True

    # ---- 预览与执行 ----

    def preview(self, command: str, secret_ref: str | None) -> str:
        """生成给用户看的命令预览：把密钥替换成掩码，绝不回显明文。"""
        if secret_ref and SECRET_PLACEHOLDER in command:
            return command.replace(SECRET_PLACEHOLDER, MASK)
        return command

    def build_command(self, command: str, secret_ref: str | None) -> tuple[str, str | None]:
        """把占位符替换成真实密钥。返回 (可执行命令, 错误)。"""
        if SECRET_PLACEHOLDER not in command:
            return command, None
        if not secret_ref:
            return "", "命令里有 {{secret}} 占位符，但没有指定密钥引用"
        value = self.secrets.get(secret_ref)
        if value is None:
            return "", f"密钥库中找不到 {secret_ref}，请先在设置里录入"
        return command.replace(SECRET_PLACEHOLDER, value), None


def _derive_keywords(reason: str, hint: str) -> list[str]:
    """从理由与提示里抽朴素关键词，供后续匹配。"""
    text = f"{reason} {hint}"
    tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_\-.]{2,}|[\u4e00-\u9fff]{2,6}", text)
    stop = {"需要", "执行", "用户", "操作", "任务", "因为", "所以", "如果", "一个"}
    seen: list[str] = []
    for t in tokens:
        if t in stop or t in seen:
            continue
        seen.append(t)
        if len(seen) >= 8:
            break
    return seen


def run_privileged(command: str, timeout_s: int = 300) -> tuple[bool, str]:
    """在编排器进程里执行特权命令。

    注意：这是**编排器**而非助手在执行，且只会在用户于界面上确认之后被调用。
    """
    try:
        proc = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return False, f"命令执行超时（{timeout_s} 秒）"
    except Exception as exc:
        return False, f"命令无法执行：{exc}"
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    combined = "\n".join(x for x in (out, err) if x)
    return proc.returncode == 0, combined or f"（无输出，退出码 {proc.returncode}）"
