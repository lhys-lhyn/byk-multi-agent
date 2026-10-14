"""模型路由失效时的回退行为测试（全部用桩，不拉起任何助手、不花钱）。

为什么需要这个机制：密钥失效（401）、余额耗尽（429/402）是**路由级**失败，
与任务本身无关。但如果中招的恰好是流程入口（任务助手），整条链会连规划都做不出来。
所以要回退到兜底路由继续干活 —— 同时必须**明确标注**，绝不能静默降级。

反过来，任务本身做不出来（文件不存在、代码报错）属于**任务级**失败，
换路由重试只会白花钱，必须不触发回退。

    python tests/test_route_fallback.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import byk.dsh_runner as R  # noqa: E402
from byk.config import AppConfig  # noqa: E402

PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}  {detail}")


def make(role_id: str, ok: bool, output: str, stderr: str, job) -> R.AgentResult:
    return R.AgentResult(
        role=role_id, ok=ok, output=output, exit_code=0 if ok else 1,
        duration_s=0.1, stderr=stderr, job_dir=str(job),
    )


def run_with(cfg: AppConfig, stub, job_name: str, tmp: Path):
    """装上桩、跑一次 run_agent、还原桩。"""
    orig = R._spawn_agent
    R._spawn_agent = stub
    try:
        return R.run_agent("vision", "# 任务说明", tmp / job_name, cfg=cfg)
    finally:
        R._spawn_agent = orig


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="byk-fallback-"))
    cfg = AppConfig.load()
    cfg.roles["vision"].model = "mimo-v2.6"
    cfg.roles["vision"].provider = "xiaomi"

    print("\n[1] 路由失效（401）-> 回退到兜底并标注来源与原因")
    calls: list[str] = []

    def stub_auth(role_id, task_md, job_dir, *, model, provider, sandbox,
                  default_timeout, on_delta=None, timeout_s=None):
        calls.append(f"{provider}/{model}")
        if provider == "xiaomi":
            return make(role_id, False, "", 'dsh: AUTH: 401: {"message":"Invalid API Key"}', job_dir)
        return make(role_id, True, "兜底成功了", "", job_dir)

    res = run_with(cfg, stub_auth, "j1", tmp)
    check("先试原路由，失败后才试兜底",
          calls == ["xiaomi/mimo-v2.6", "deepseek-official/deepseek-v4-flash"], str(calls))
    check("最终成功", res.ok)
    check("输出来自兜底那次", "兜底成功" in res.output, res.output)
    check("标注了原路由", res.fallback_from == "xiaomi/mimo-v2.6", str(res.fallback_from))
    check("标注了失败原因且含 AUTH",
          bool(res.fallback_reason) and "AUTH" in res.fallback_reason, str(res.fallback_reason))

    print("\n[2] 任务级失败（非路由问题）-> 不回退，避免白花钱")
    calls.clear()

    def stub_task_fail(role_id, task_md, job_dir, *, model, provider, sandbox,
                       default_timeout, on_delta=None, timeout_s=None):
        calls.append(f"{provider}/{model}")
        return make(role_id, False, "任务做不出来", "普通错误：文件不存在", job_dir)

    res2 = run_with(cfg, stub_task_fail, "j2", tmp)
    check("只尝试了一次", calls == ["xiaomi/mimo-v2.6"], str(calls))
    check("未标记回退", res2.fallback_from is None, str(res2.fallback_from))
    check("失败被如实返回", not res2.ok)

    print("\n[3] 兜底也失败 -> 仍然标注原路由与原因，不掩盖")
    calls.clear()

    def stub_all_auth(role_id, task_md, job_dir, *, model, provider, sandbox,
                      default_timeout, on_delta=None, timeout_s=None):
        calls.append(f"{provider}/{model}")
        return make(role_id, False, "", f"dsh: AUTH: 401: invalid ({provider})", job_dir)

    res3 = run_with(cfg, stub_all_auth, "j3", tmp)
    check("两次都试了", len(calls) == 2, str(calls))
    check("仍标注原路由", res3.fallback_from == "xiaomi/mimo-v2.6", str(res3.fallback_from))
    check("仍标注原因", bool(res3.fallback_reason), str(res3.fallback_reason))
    check("结果如实为失败", not res3.ok)

    print("\n[4] 角色本就用兜底模型 -> 不重复尝试同一条路由")
    cfg2 = AppConfig.load()
    cfg2.roles["vision"].model = cfg2.fallback_model
    cfg2.roles["vision"].provider = cfg2.fallback_provider
    calls.clear()
    res4 = run_with(cfg2, stub_all_auth, "j4", tmp)
    check("只尝试一次", len(calls) == 1, str(calls))
    check("未标记回退（本来就在兜底上）", res4.fallback_from is None, str(res4.fallback_from))

    print("\n[5] 限额类错误同样算路由失败")
    calls.clear()

    def stub_quota(role_id, task_md, job_dir, *, model, provider, sandbox,
                   default_timeout, on_delta=None, timeout_s=None):
        calls.append(f"{provider}/{model}")
        if provider == "xiaomi":
            return make(role_id, False, "", 'dsh: QUOTA: 429: {"code":"1113"}', job_dir)
        return make(role_id, True, "兜底成功", "", job_dir)

    res5 = run_with(cfg, stub_quota, "j5", tmp)
    check("429 也触发回退", len(calls) == 2, str(calls))
    check("回退后成功", res5.ok and "兜底成功" in res5.output)

    print("\n[6] 配置实例之间互不干扰（防止改一个实例污染全局默认值）")
    a = AppConfig.load()
    b = AppConfig.load()
    a.roles["vision"].model = "故意改成一个奇怪的值"
    check("改 A 不影响 B", b.roles["vision"].model != "故意改成一个奇怪的值",
          b.roles["vision"].model)
    from byk.config import DEFAULT_ROLES
    check("改 A 也不污染模块级默认值",
          DEFAULT_ROLES["vision"].model != "故意改成一个奇怪的值",
          DEFAULT_ROLES["vision"].model)

    print(f"\n{'=' * 50}\n通过 {PASS} 项，失败 {FAIL} 项")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
