"""路径、常量与可覆盖的运行配置。"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
JOBS = DATA / "jobs"
UPLOADS = DATA / "uploads"
PATCHES = DATA / "patches"
WEB = ROOT / "web"
SECRETS = DATA / "secrets.json"
PRECEDENTS = DATA / "precedents.json"
CONFIG_FILE = ROOT / "config.json"

#: DSH CLI 入口（进程外回退路径用）。
#: 旧默认值 r"C:\coding\DSH Desktop\runtime\harness\..." 在换到 C:\coding\DSH 之后已不存在，
#: 导致 byk_role 在拿不到进程内 provider 时直接抛 CJS loader 栈。
#: 依次尝试：BYK_DSH_BIN -> %APPDATA%\npm\...\dsh\lib\bin.js -> ~\AppData\Roaming\npm\...
def _default_dsh_bin() -> Path:
    candidates = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "npm" / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js")
    try:
        candidates.append(
            Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
        )
    except RuntimeError:
        pass
    for cand in candidates:
        if cand.exists():
            return cand
    return candidates[0] if candidates else Path("dsh")


DSH_BIN = Path(os.environ.get("BYK_DSH_BIN", str(_default_dsh_bin())))

NODE = os.environ.get("BYK_NODE", "node")

#: 命令行引导语。真正的任务说明一律走 TASK.md，避免 Windows 32KB 命令行上限。
BOOTSTRAP = (
    "你的完整任务说明在同目录下的 TASK.md。"
    "请先用 read 工具完整读取它，然后严格按其中的要求执行。"
    "完成后必须把最终结果写入同目录下的 RESULT.md。"
)

MAX_EXTRACT_BYTES = 200 * 1024


@dataclass
class RoleSetting:
    """单个助手的运行参数。model/provider 为空表示用部署默认。"""

    id: str
    model: str = ""
    provider: str = ""
    sandbox: str = "workspace-write"  # workspace-write | danger-full-access
    timeout_s: int = 1800
    enabled: bool = True
    #: 该角色可以越过 forbidden_models 的模型名（逐个精确匹配）。
    #: 只有显式写进这里才放行——例如科研助手固定用 mimo-v2.6-pro。
    allow_forbidden_models: list[str] = field(default_factory=list)


#: 角色 -> 模型分工。
#:
#: **成本纪律（用户明确要求）：所有用到 deepseek 的地方一律用 flash。**
#: deepseek-v4-pro 已进 `forbidden_models`，代码层面封死，不是靠自觉。
DEFAULT_ROLES: dict[str, RoleSetting] = {
    # —— 用户指定：任务助手与科研助手走小米 mimo-v2.6 ——
    # 注意：xiaomi 路由实测返回 401 Invalid API Key。密钥修好前，
    # run_agent 会自动回退到 fallback 并在结果里标注"发生了回退"，不会让流程瘫痪。
    "task": RoleSetting("task", "mimo-v2.6", "xiaomi", "workspace-write", 1800),
    # 用户指定：科研助手固定用 mimo-v2.6-pro（不跟随峰谷），并按角色开白名单越过全局禁用。
    "research": RoleSetting(
        "research", "mimo-v2.6-pro", "xiaomi", "workspace-write", 2700,
        allow_forbidden_models=["mimo-v2.6-pro"],
    ),

    # —— 用户指定：视觉助手与音频助手走 mimo-v2.6 ——
    # mimo-v2.6 在 pi-ai 模型清单里声明了 [text, image]，因此一旦该路由可用，
    # 视觉助手会自动从"OCR 兜底"升级为**直读原图**（read_image 只在模型声明 image 时可用）。
    "vision": RoleSetting("vision", "mimo-v2.6", "xiaomi", "workspace-write", 1800),
    "audio": RoleSetting("audio", "mimo-v2.6", "xiaomi", "workspace-write", 1200),

    # —— 用到 deepseek 的角色：一律 flash ——
    # 代码助手权限最大（danger-full-access），但模型仍用 flash；
    # 如果将来确实需要更强的模型，请在 config.json 里显式指定**非禁用**的模型。
    "code": RoleSetting("code", "deepseek-v4-flash", "deepseek-official", "danger-full-access", 3600),
    # 用户指定：文件助手也走 mimo-v2.6
    "file": RoleSetting("file", "mimo-v2.6", "xiaomi", "workspace-write", 1800),
    "search": RoleSetting("search", "deepseek-v4-flash", "deepseek-official", "workspace-write", 1800),
}


@dataclass
class AppConfig:
    # 必须是**深拷贝**：dict(DEFAULT_ROLES) 是浅拷贝，会让每个 AppConfig 实例与模块级
    # DEFAULT_ROLES 共享同一批 RoleSetting 对象，于是改一个实例的角色模型会污染全局默认值，
    # 影响此后所有新加载的配置（这个 bug 是被 tests/test_route_fallback.py 抓出来的）。
    roles: dict[str, RoleSetting] = field(
        default_factory=lambda: {rid: replace(setting) for rid, setting in DEFAULT_ROLES.items()}
    )
    #: 文档正文超过该长度时，先过一次「文件助手」压缩成结构化内容，避免规划阶段上下文爆炸
    file_agent_threshold: int = 8 * 1024
    #: 一个回合内最多并发执行的子任务数
    max_parallel: int = 3
    #: 是否允许编排器执行特权命令（用户每次仍需在界面确认）
    allow_privileged: bool = True
    #: 某个角色配置的模型路由整体不可用（密钥失效/余额耗尽）时的兜底路由。
    #: 目的是别让一个失效的密钥把整条流程卡死；回退一定会在结果里被标注出来。
    fallback_provider: str = "deepseek-official"
    fallback_model: str = "deepseek-v4-flash"
    #: 是否让编排器**直接**把视频交给 MiMo 观看（画面 + 音轨一起读）。
    #: 为什么绕开 DSH：DSH 管线里没有视频通路（pi-ai 无 video 模态、附件服务只收图片、
    #: read_image 只认 PNG/JPEG/WebP/GIF），但小米接口实测接受 video_url 且模型真能读懂。
    #: 关掉它则退回「抽帧 OCR + 音轨转写」。见 byk/video_ai.py。
    direct_video: bool = True
    #: 直接看视频所用的模型
    video_model: str = "mimo-v2.6"
    #: **禁用模型名单。代码级强制，不是靠自觉。**
    #:
    #: 用户明确要求：严禁使用 deepseek-v4-pro。任何地方（config.json、set-model、
    #: 角色注册表、真正拉起助手之前）只要发现某个角色被配成了名单里的模型，
    #: 一律**替换成 fallback_model 并显式标注**，绝不静默放行、也绝不真的调用它。
    forbidden_models: list[str] = field(default_factory=lambda: ["deepseek-v4-pro", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"])

    @classmethod
    def load(cls) -> "AppConfig":
        cfg = cls()
        if CONFIG_FILE.exists():
            try:
                raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            except Exception:
                return cfg
            for rid, val in (raw.get("roles") or {}).items():
                if rid in cfg.roles and isinstance(val, dict):
                    for k, v in val.items():
                        if hasattr(cfg.roles[rid], k):
                            setattr(cfg.roles[rid], k, v)
            for k in (
                "file_agent_threshold",
                "max_parallel",
                "allow_privileged",
                "fallback_provider",
                "fallback_model",
                "direct_video",
                "video_model",
                "forbidden_models",
            ):
                if k in raw:
                    setattr(cfg, k, raw[k])
        cfg.enforce_forbidden()
        return cfg

    def enforce_forbidden(self) -> list[str]:
        """把任何落在禁用名单里的角色模型替换成 fallback，并返回被改的角色。

        这是唯一的收口点：`load()` 每次都会调用它，所以注册表、运行器、
        DSH 插件读到的都已经是清洗过的值 —— 不可能有一条路径绕过。
        """
        banned = {m.strip().lower() for m in (self.forbidden_models or []) if m and m.strip()}
        if not banned:
            return []
        changed: list[str] = []
        for rid, setting in self.roles.items():
            allowed = {m.strip().lower() for m in (getattr(setting, "allow_forbidden_models", None) or [])}
            if (setting.model or "").strip().lower() in banned and (setting.model or "").strip().lower() not in allowed:
                setting.model = self.fallback_model
                setting.provider = self.fallback_provider
                changed.append(rid)
        return changed

    def save(self) -> None:
        CONFIG_FILE.write_text(
            json.dumps(
                {
                    "roles": {k: asdict(v) for k, v in self.roles.items()},
                    "file_agent_threshold": self.file_agent_threshold,
                    "max_parallel": self.max_parallel,
                    "allow_privileged": self.allow_privileged,
                    "fallback_provider": self.fallback_provider,
                    "fallback_model": self.fallback_model,
                    "direct_video": self.direct_video,
                    "video_model": self.video_model,
                    "forbidden_models": self.forbidden_models,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


def ensure_dirs() -> None:
    for d in (DATA, JOBS, UPLOADS, PATCHES, WEB):
        d.mkdir(parents=True, exist_ok=True)
