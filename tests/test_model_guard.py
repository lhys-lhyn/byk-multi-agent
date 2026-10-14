"""禁用模型的硬闸测试（全离线，不发起任何模型调用、不花钱）。

用户明确要求：**严禁使用 deepseek-v4-pro**。这条不能靠自觉，必须在代码层面封死，
所以这里把三道关卡都钉成回归测试：

  1. `AppConfig.load()` —— 就算 config.json 被手改成禁用模型，读出来也已被清洗
  2. `set_role_model()` —— 连"设置"这一步都拒绝，并且能识别大小写/空格变体
  3. `dsh_runner.run_agent()` —— 真正拉起进程之前再查一次，直接拒绝执行

    python tests/test_model_guard.py
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from byk.config import CONFIG_FILE, AppConfig  # noqa: E402
from byk import dsh_runner as R  # noqa: E402
from byk.roles import set_role_model  # noqa: E402

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


def main() -> int:
    backup = None
    if CONFIG_FILE.exists():
        backup = CONFIG_FILE.with_suffix(".json.testbak")
        shutil.copyfile(CONFIG_FILE, backup)

    try:
        print("\n[1] 默认禁用名单")
        cfg = AppConfig()
        check("默认就禁用 deepseek-v4-pro",
              "deepseek-v4-pro" in cfg.forbidden_models, str(cfg.forbidden_models))

        print("\n[2] config.json 被手改成禁用模型时，load() 必须清洗掉")
        raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {"roles": {}}
        raw.setdefault("roles", {})
        raw["roles"]["code"] = {"id": "code", "model": "deepseek-v4-pro", "provider": "deepseek-official"}
        CONFIG_FILE.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
        loaded = AppConfig.load()
        check("code 的模型已被替换", loaded.roles["code"].model != "deepseek-v4-pro",
              loaded.roles["code"].model)
        check("替换成的是兜底模型", loaded.roles["code"].model == loaded.fallback_model,
              f"{loaded.roles['code'].model} vs {loaded.fallback_model}")
        check("兜底 provider 也一并换掉", loaded.roles["code"].provider == loaded.fallback_provider,
              loaded.roles["code"].provider)

        print("\n[3] 通过 set_model 也设不进去")
        for variant in ("deepseek-v4-pro", "DeepSeek-V4-Pro", "  deepseek-v4-pro  "):
            try:
                set_role_model("code", variant, "deepseek-official")
                check(f"拒绝设置 {variant!r}", False, "竟然设置成功了")
            except ValueError as exc:
                check(f"拒绝设置 {variant!r}", "禁用名单" in str(exc), str(exc)[:80])

        print("\n[4] 真正拉起助手之前再查一次（即使有人绕过 load 直接塞 cfg）")
        forced = AppConfig()
        forced.roles["code"].model = "deepseek-v4-pro"
        forced.roles["code"].provider = "deepseek-official"
        forced.forbidden_models = ["deepseek-v4-pro"]
        res = R.run_agent("code", "# 任务", Path(tempfile.mkdtemp(prefix="guard-")), cfg=forced)
        check("run_agent 拒绝执行", not res.ok, str(res.ok))
        check("拒绝理由点名禁用名单", "禁用名单" in (res.error or ""), str(res.error)[:100])

        print("\n[5] 非禁用模型不受影响")
        ok_cfg = AppConfig()
        ok_cfg.roles["code"].model = "deepseek-v4-flash"
        check("flash 不在禁用名单里",
              ok_cfg.roles["code"].model not in (ok_cfg.forbidden_models or []))
        try:
            info = set_role_model("code", "deepseek-v4-flash", "deepseek-official")
            check("flash 可以正常设置", info["model"] == "deepseek-v4-flash", str(info["model"]))
        except Exception as exc:
            check("flash 可以正常设置", False, repr(exc))

        print("\n[6] 当前落盘配置里没有任何禁用模型")
        final = AppConfig.load()
        offenders = [rid for rid, s in final.roles.items()
                     if (s.model or "").lower() in {m.lower() for m in final.forbidden_models}]
        check("没有任何角色在用禁用模型", not offenders, str(offenders))
    finally:
        if backup and backup.exists():
            shutil.copyfile(backup, CONFIG_FILE)
            backup.unlink()
            print("\n（已恢复原 config.json）")

    print(f"\n{'=' * 50}\n通过 {PASS} 项，失败 {FAIL} 项")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
