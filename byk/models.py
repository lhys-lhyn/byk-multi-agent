"""回合、计划、子任务、确认等数据模型。字段与 docs/api-contract.md 严格一致。"""
from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Stage = Literal[
    "intake", "extracting", "planning", "awaiting_confirmation",
    "executing", "summarizing", "completed", "failed", "cancelled",
]
SubStatus = Literal["pending", "running", "succeeded", "failed", "skipped", "blocked"]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


@dataclass
class SubTask:
    id: str
    title: str
    detail: str
    role: str
    depends_on: list[str] = field(default_factory=list)
    inputs: list[str] = field(default_factory=list)
    needs_privilege: bool = False
    acceptance: str = ""

    @classmethod
    def from_raw(cls, raw: dict, index: int) -> "SubTask":
        return cls(
            id=str(raw.get("id") or f"st_{index + 1}"),
            title=str(raw.get("title") or f"子任务 {index + 1}"),
            detail=str(raw.get("detail") or ""),
            role=str(raw.get("role") or "code"),
            depends_on=[str(x) for x in (raw.get("depends_on") or [])],
            inputs=[str(x) for x in (raw.get("inputs") or [])],
            needs_privilege=bool(raw.get("needs_privilege") or False),
            acceptance=str(raw.get("acceptance") or ""),
        )


@dataclass
class TaskPlan:
    goal: str
    subtasks: list[SubTask]
    assumptions: list[str] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)

    @classmethod
    def from_raw(cls, raw: dict) -> "TaskPlan":
        subs = [
            SubTask.from_raw(s, i)
            for i, s in enumerate(raw.get("subtasks") or [])
            if isinstance(s, dict)
        ]
        return cls(
            goal=str(raw.get("goal") or ""),
            subtasks=subs,
            assumptions=[str(x) for x in (raw.get("assumptions") or [])],
            questions=[str(x) for x in (raw.get("questions") or [])],
        )

    def to_dict(self) -> dict:
        return {
            "goal": self.goal,
            "assumptions": self.assumptions,
            "questions": self.questions,
            "subtasks": [asdict(s) for s in self.subtasks],
        }


@dataclass
class SubTaskState:
    id: str
    title: str
    role: str
    detail: str
    status: SubStatus = "pending"
    started_at: str | None = None
    finished_at: str | None = None
    duration_s: float | None = None
    output: str = ""
    log_tail: str = ""
    error: str | None = None
    artifacts: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Confirmation:
    id: str
    kind: str
    title: str
    reason: str
    command_preview: str = ""
    precedent_id: str | None = None
    secret_source: str = ""
    risk: str = "medium"
    turn_id: str = ""
    subtask_id: str = ""
    #: 命令里有 {{secret}} 占位符却没绑定密钥引用时为 True —— 此时即使用户批准也无法执行，
    #: 界面必须显式提示，并允许用户在批准时补上密钥引用。
    requires_secret: bool = False
    secret_ref: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Turn:
    turn_id: str
    session_id: str
    user_text: str
    created_at: str = field(default_factory=now_iso)
    attachments: list[dict] = field(default_factory=list)
    stage: Stage = "intake"
    extractions: list[dict] = field(default_factory=list)
    plan: TaskPlan | None = None
    subtasks: list[SubTaskState] = field(default_factory=list)
    summary: str | None = None
    error: str | None = None
    pending_confirmation: Confirmation | None = None
    workdir: str = ""
    #: 本回合的真实 token 用量（读自 DSH 会话日志，非估算）。见 byk/usage.py。
    usage: dict | None = None

    def to_dict(self) -> dict:
        return {
            "turn_id": self.turn_id,
            "session_id": self.session_id,
            "created_at": self.created_at,
            "user_text": self.user_text,
            "attachments": self.attachments,
            "stage": self.stage,
            "extractions": self.extractions,
            "plan": self.plan.to_dict() if self.plan else None,
            "subtasks": [s.to_dict() for s in self.subtasks],
            "summary": self.summary,
            "error": self.error,
            "usage": self.usage,
            "pending_confirmation": self.pending_confirmation.to_dict()
            if self.pending_confirmation
            else None,
        }


def to_dict(obj: Any) -> dict:
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    return asdict(obj)
