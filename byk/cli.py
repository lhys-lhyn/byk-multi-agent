"""命令行工具：服务、密钥、先例库、脚本化运行、单助手调用。

    python -m byk.cli serve
    python -m byk.cli secret set PRECEDENT_ROOT_PW_SRV1
    python -m byk.cli secret list
    python -m byk.cli precedent list
    python -m byk.cli precedent add --title "..." --command "..." --keywords "杀进程,重启"
    python -m byk.cli run "把项目部署到服务器" --yes
    python -m byk.cli agent --role code --task-file TASK.md    # DSH 插件调用的入口
"""
from __future__ import annotations

import argparse
import getpass
import json
import sys
import time
from pathlib import Path

from .config import AppConfig, JOBS, ensure_dirs
from .orchestrator import Orchestrator
from .precedents import PrecedentStore, SecretStore


def _cmd_serve(args: argparse.Namespace) -> int:
    from .server import main

    main(args.host, args.port)
    return 0


def _cmd_secret(args: argparse.Namespace) -> int:
    store = SecretStore()
    if args.action == "list":
        refs = store.list_refs()
        if not refs:
            print("密钥库为空。")
            return 0
        print("已录入的密钥引用（永不回显值）：")
        for r in refs:
            print(f"  - {r}")
        return 0
    if args.action == "set":
        if not args.ref:
            print("必须提供引用名，例如：secret set PRECEDENT_ROOT_PW_SRV1")
            return 2
        value = args.value or getpass.getpass(f"请输入 {args.ref} 的值（不回显）：")
        if not value:
            print("值为空，已取消。")
            return 2
        store.set(args.ref, value)
        print(f"已写入 {args.ref}。")
        return 0
    if args.action == "rm":
        if not args.ref:
            print("必须提供引用名。")
            return 2
        data_path = store.path
        import json as _json

        data = _json.loads(data_path.read_text(encoding="utf-8")) if data_path.exists() else {}
        if args.ref in data:
            data.pop(args.ref)
            data_path.write_text(_json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"已删除 {args.ref}。")
        else:
            print(f"未找到 {args.ref}。")
        return 0
    print(f"未知动作：{args.action}")
    return 2


def _cmd_precedent(args: argparse.Namespace) -> int:
    store = PrecedentStore()
    if args.action == "list":
        items = store.load()
        if not items:
            print("先例库为空。成功的特权操作会自动沉淀为先例。")
            return 0
        print(f"共 {len(items)} 条先例：")
        for p in items:
            print(f"\n  id       : {p.id}")
            print(f"  标题     : {p.title}")
            print(f"  关键词   : {', '.join(p.match_keywords)}")
            print(f"  命令     : {p.command_template}")
            print(f"  密钥引用 : {p.secret_ref or '（无）'}")
            print(f"  成功次数 : {p.success_count}")
            print(f"  最后使用 : {p.last_used_at or '从未'}")
        return 0
    if args.action == "add":
        if not args.title or not args.command:
            print("必须提供 --title 与 --command。")
            return 2
        kws = [k.strip() for k in (args.keywords or "").split(",") if k.strip()]
        p = store.add(args.title, args.command, kws, args.secret_ref)
        print(f"已新增先例 {p.id}。")
        return 0
    if args.action == "rm":
        if not args.id:
            print("必须提供 --id。")
            return 2
        print("已删除。" if store.delete(args.id) else "未找到该先例。")
        return 0
    if args.action == "match":
        if not args.text:
            print("必须提供 --text。")
            return 2
        p, why = store.match(args.text, args.text)
        print(why)
        if p:
            print(f"  命令：{p.command_template}")
            print(f"  密钥引用：{p.secret_ref or '（无）'}")
        return 0
    print(f"未知动作：{args.action}")
    return 2


def _cmd_run(args: argparse.Namespace) -> int:
    ensure_dirs()
    orch = Orchestrator(AppConfig.load())
    turn = orch.start_turn(args.text)
    print(f"回合 {turn.turn_id} 已启动；等待规划结果……")

    confirmed = False
    answered: set[str] = set()
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        t = orch.get_turn(turn.turn_id)
        if t is None:
            print("回合丢失。")
            return 1
        if t.stage == "awaiting_confirmation" and not confirmed:
            confirmed = True
            plan = t.plan
            print("\n" + "=" * 70)
            print(f"计划已就绪，目标：{plan.goal if plan else '（无）'}")
            if plan:
                for a in plan.assumptions:
                    print(f"  假设：{a}")
                for q in plan.questions:
                    print(f"  待澄清：{q}")
                for s in plan.subtasks:
                    priv = " [需提权]" if s.needs_privilege else ""
                    print(f"  - {s.id} [{s.role}]{priv} {s.title}")
            print("=" * 70)
            if args.yes:
                orch.confirm_plan(turn.turn_id, True)
                print("已自动确认（--yes）。")
            else:
                ans = input("是否执行？[y/N] ").strip().lower()
                if ans in ("y", "yes"):
                    orch.confirm_plan(turn.turn_id, True)
                else:
                    orch.confirm_plan(turn.turn_id, False)
                    print("已取消。")
                    return 0
        if t.pending_confirmation and t.pending_confirmation.id not in answered:
            conf = t.pending_confirmation
            answered.add(conf.id)
            print("\n" + "!" * 70)
            print(f"提权确认：{conf.title}")
            print(f"理由：{conf.reason}")
            print(f"命令：{conf.command_preview}")
            print(f"风险：{conf.risk}    密钥：{conf.secret_source}")
            print("!" * 70)
            if args.yes:
                orch.answer_confirmation(conf.id, True, True)
                print("已自动批准（--yes）。")
            else:
                ans = input("是否批准执行？[y/N] ").strip().lower()
                orch.answer_confirmation(conf.id, ans in ("y", "yes"), ans in ("y", "yes"))
        if t.stage in ("completed", "failed", "cancelled"):
            print("\n" + "=" * 70)
            print(f"最终阶段：{t.stage}")
            if t.error:
                print(f"错误：{t.error}")
            for s in t.subtasks:
                print(f"  - {s.id} [{s.role}] {s.status} ({s.duration_s}s)")
            print("=" * 70)
            print(t.summary or "（无汇总）")
            print("\n产物目录：", t.workdir)
            return 0 if t.stage == "completed" else 1
        time.sleep(1.0)

    print("等待超时。")
    return 1


def _cmd_roles(args: argparse.Namespace) -> int:
    from .roles import role_list, role_registry

    if getattr(args, "json", False):
        # DSH 插件就是靠这个拿到"用哪个模型、注什么人格"的。
        # 每次都重新读 → 改了模型下一次调用即生效。
        print(json.dumps(role_registry(), ensure_ascii=False))
        return 0

    cfg = AppConfig.load()
    for r in role_list():
        setting = cfg.roles.get(r["id"])
        print(f"{r['id']:9} {r['name']:6}  模型={r['model']:20} 沙箱={getattr(setting,'sandbox','-'):18} {r['description']}")
        if r["note"]:
            print(f"{'':9} 注意：{r['note']}")
    return 0


def _cmd_set_model(args: argparse.Namespace) -> int:
    """动态改某个助手的模型。改完下一次调用就生效，无需重启任何东西。"""
    from .roles import set_role_model

    if not args.model and not args.provider and not args.reset:
        print("没给 --model / --provider / --reset，什么也没改。")
        print("示例：byk set-model --role vision --model mimo-v2.6 --provider xiaomi")
        return 2
    try:
        if args.reset:
            info = set_role_model(args.role, None, None)
            print(f"已把 {info['role']} 重置回代码默认：{info['provider']}/{info['model']}")
        else:
            info = set_role_model(args.role, args.model, args.provider)
            print(f"已把 {info['role']} 改为：{info['provider']}/{info['model']}")
        print(f"配置文件：{info['config_file']}")
        if info.get("forbidden_models"):
            print(f"禁用模型（硬闸）：{', '.join(info['forbidden_models'])}")
        print("（DSH 插件每次调用都会重新读取，无需重启）")
        return 0
    except KeyError as exc:
        print(f"{exc}")
        return 2
    except ValueError as exc:
        print(f"拒绝：{exc}")
        return 2


def _cmd_usage(args: argparse.Namespace) -> int:
    from .usage import format_usage, run_report, sessions_dir, turn_usage

    if args.turn:
        u = turn_usage(args.turn)
        if u is None:
            print(f"读不到回合 {args.turn} 的用量（会话日志不存在或工具不可用）。")
            return 1
        print(f"回合 {args.turn}（会话目录 {sessions_dir()}）\n")
        print(format_usage(u))
        return 0

    data = run_report("all" if args.all else "jobs")
    if data is None:
        print("计量工具不可用：需要 Node 与 tools/usage_report.js。")
        return 1
    t = data.get("totals", {})
    print(f"扫描会话 {data.get('sessions', 0)} 个（{'全部' if args.all else '仅助手'}）\n")
    print(f"模型请求      : {t.get('steps', 0):,}")
    print(f"输入 token    : {t.get('input', 0):,}")
    print(f"缓存命中 token: {t.get('cache', 0):,}")
    print(f"输出 token    : {t.get('output', 0):,}（推理 {t.get('reasoning', 0):,}）")
    print(f"web_search 请求: {t.get('search', 0):,}（单独计费）")
    bm = data.get("byModel") or {}
    if bm:
        print("\n按模型：")
        for name, v in sorted(bm.items(), key=lambda kv: -kv[1].get("output", 0)):
            print(f"  {name:24} 请求={v.get('steps', 0):>5}  输入={v.get('input', 0):>10,}  输出={v.get('output', 0):>9,}")
    return 0


def _cmd_agent(args: argparse.Namespace) -> int:
    """跑**单个**助手。这是给 DSH 插件用的入口：插件把工具调用转成这条命令。

    与 `run` 的区别：不做任务拆解、不做确认、不需要编排器，就是"把活派给某个助手"。
    结果写 stdout，便于调用方直接取用；失败信息写 stderr 并返回非零退出码。
    """
    import sys as _sys
    import uuid

    from .config import JOBS, ensure_dirs
    from .dsh_runner import run_agent

    ensure_dirs()
    if args.task_file:
        task = Path(args.task_file).read_text(encoding="utf-8")
    else:
        task = args.task or ""
    if not task.strip():
        print("必须提供任务文本（--task 或 --task-file）", file=_sys.stderr)
        return 2

    job_dir = Path(args.job_dir) if args.job_dir else JOBS / f"adhoc-{uuid.uuid4().hex[:8]}"
    res = run_agent(args.role, task, job_dir, timeout_s=args.timeout)

    if res.fallback_from:
        print(
            f"[byk] 注意：本应使用 {res.fallback_from}，该路由不可用，已回退到兜底路由执行。",
            file=_sys.stderr,
        )
    if res.output:
        print(res.output)
    if not res.ok:
        print(f"[byk] {res.role} 失败：{res.error}", file=_sys.stderr)
        return 1
    return 0


def _read_extract_paths(args: argparse.Namespace) -> list[str]:
    """汇总待提取的路径：位置参数 + --paths-file 清单（每行一个），去重但保持顺序。"""
    paths = [p.strip() for p in (getattr(args, "paths", None) or []) if p and p.strip()]
    if getattr(args, "paths_file", None):
        raw_text = Path(args.paths_file).read_text(encoding="utf-8")
        paths += [line.strip() for line in raw_text.splitlines() if line.strip()]
    seen: set[str] = set()
    out: list[str] = []
    for p in paths:
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def _cmd_extract(args: argparse.Namespace) -> int:
    """把文件交给本地提取层变成「文本 + 元数据」。**全程本地推理，不调用任何大模型。**

    这是给 DSH 插件 backend="local-extract" 用的入口：插件写一份路径清单，调
    `python -m byk.cli extract --json --paths-file <清单>`，再读 stdout 的 JSON。
    --json 时 stdout 只有那一个 JSON 对象；只要有文件失败就以退出码 1 结束，
    但**仍然打印完整 JSON**（调用方靠它知道缺哪个库、该装什么）。
    """
    from .extract import SUPPORTED_EXTENSIONS, extract_file, extract_many
    from .extract import __version__ as extract_version

    try:
        paths = _read_extract_paths(args)
    except OSError as exc:
        print(f"读不了路径清单 {args.paths_file}：{exc}", file=sys.stderr)
        return 2
    if not paths:
        print(
            "没有待提取的文件：请给位置参数，或用 --paths-file 给一份清单（每行一个绝对路径）。",
            file=sys.stderr,
        )
        return 2

    kwargs = {"ocr_lang": args.ocr_lang, "whisper_model": args.whisper_model}
    if len(paths) > 1:
        results = extract_many(paths, **kwargs)
    else:
        results = [extract_file(paths[0], **kwargs)]

    failed = [r for r in results if not r.ok]
    if args.json:
        payload = {
            "ok": not failed,
            "version": extract_version,
            "supported_extensions": list(SUPPORTED_EXTENSIONS),
            "results": [r.to_dict() for r in results],
        }
        print(json.dumps(payload, ensure_ascii=False))
    else:
        for r in results:
            mark = "OK  " if r.ok else "失败"
            print(f"[{mark}] {r.path}  kind={r.kind}  method={r.method}")
            if r.ok:
                print(r.text)
            else:
                print(f"  原因：{r.error}")
        print(f"\n共 {len(results)} 个文件，失败 {len(failed)} 个。")
        if failed:
            print("本地提取层不会自动改用云端模型：请先修好上面点名的问题。", file=sys.stderr)
    return 0 if not failed else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="byk", description="BYK 多智能体系统")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("serve", help="启动本地服务与 Web 界面")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8760)
    p.set_defaults(func=_cmd_serve)

    p = sub.add_parser("secret", help="管理本地密钥库（值永不入库到先例）")
    p.add_argument("action", choices=["set", "list", "rm"])
    p.add_argument("ref", nargs="?")
    p.add_argument("--value", default=None)
    p.set_defaults(func=_cmd_secret)

    p = sub.add_parser("precedent", help="管理提权先例库")
    p.add_argument("action", choices=["list", "add", "rm", "match"])
    p.add_argument("--title")
    p.add_argument("--command")
    p.add_argument("--keywords")
    p.add_argument("--secret-ref", dest="secret_ref")
    p.add_argument("--id")
    p.add_argument("--text")
    p.set_defaults(func=_cmd_precedent)

    p = sub.add_parser("run", help="以命令行方式跑一个回合")
    p.add_argument("text")
    p.add_argument("--yes", action="store_true", help="自动确认计划与提权（谨慎使用）")
    p.add_argument("--timeout", type=int, default=3600)
    p.set_defaults(func=_cmd_run)

    p = sub.add_parser("agent", help="跑单个助手（DSH 插件用此入口）")
    p.add_argument("--role", required=True, help="task/code/vision/file/audio/research/search")
    p.add_argument("--task", help="任务文本")
    p.add_argument("--task-file", dest="task_file", help="从文件读任务文本（推荐，避开命令行长度限制）")
    p.add_argument("--job-dir", dest="job_dir", help="工作目录；省略则自动生成")
    p.add_argument("--timeout", type=int, default=None, help="超时秒数")
    p.set_defaults(func=_cmd_agent)

    p = sub.add_parser("roles", help="查看角色与模型分工")
    p.add_argument("--json", action="store_true", help="输出完整注册表 JSON（DSH 插件用）")
    p.set_defaults(func=_cmd_roles)

    p = sub.add_parser("set-model", help="动态改某个助手的模型（立刻生效，无需重启）")
    p.add_argument("--role", required=True)
    p.add_argument("--model")
    p.add_argument("--provider")
    p.add_argument("--reset", action="store_true", help="重置回代码默认")
    p.set_defaults(func=_cmd_set_model)

    p = sub.add_parser("extract", help="本地提取：把文件变成文本 + 元数据（不调用任何大模型）")
    p.add_argument("paths", nargs="*", help="待提取文件的绝对路径（少量文件可直接给）")
    p.add_argument("--paths-file", dest="paths_file",
                   help="路径清单文件，每行一个绝对路径（推荐，绕开命令行长度上限）")
    p.add_argument("--json", action="store_true", help="输出 JSON（DSH 插件用这个）")
    p.add_argument("--ocr-lang", dest="ocr_lang", default="ch", help="图片 OCR 语言，默认 ch")
    p.add_argument("--whisper-model", dest="whisper_model", default="small",
                   help="音频/视频转写用的 whisper 模型，默认 small")
    p.set_defaults(func=_cmd_extract)

    p = sub.add_parser("usage", help="查看真实 token 用量（读自 DSH 会话日志）")
    p.add_argument("--turn", help="只看某个回合")
    p.add_argument("--all", action="store_true", help="包含非助手的全部会话")
    p.set_defaults(func=_cmd_usage)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
