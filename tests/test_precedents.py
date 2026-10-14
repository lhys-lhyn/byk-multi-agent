"""提权先例库、密钥库、依赖分层的单元测试（不执行任何真实特权命令）。

    python tests/test_precedents.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from byk.models import SubTask  # noqa: E402
from byk.orchestrator import Orchestrator  # noqa: E402
from byk.precedents import (  # noqa: E402
    MASK,
    SECRET_PLACEHOLDER,
    PrecedentStore,
    SecretStore,
)

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
    tmp = Path(tempfile.mkdtemp(prefix="byk-test-"))
    secrets = SecretStore(tmp / "secrets.json")
    store = PrecedentStore(tmp / "precedents.json", secrets)

    print("\n[1] 密钥库")
    secrets.set("PRECEDENT_ROOT_PW_SRV1", "hunter2-super-secret")
    check("写入后可读回", secrets.get("PRECEDENT_ROOT_PW_SRV1") == "hunter2-super-secret")
    check("has() 正确", secrets.has("PRECEDENT_ROOT_PW_SRV1"))
    check("不存在的引用返回 None", secrets.get("NOPE") is None)
    check("list_refs 只列引用名", secrets.list_refs() == ["PRECEDENT_ROOT_PW_SRV1"])

    print("\n[2] 密钥绝不出现在先例库里")
    p = store.add(
        title="以 root 结束占用 8080 的旧进程",
        command_template=f"ssh root@srv1 'echo {SECRET_PLACEHOLDER} | sudo -S systemctl stop byk-old'",
        keywords=["杀进程", "重启", "端口占用", "8080"],
        secret_ref="PRECEDENT_ROOT_PW_SRV1",
    )
    raw = (tmp / "precedents.json").read_text(encoding="utf-8")
    check("先例文件不含明文口令", "hunter2-super-secret" not in raw)
    check("先例文件含密钥引用", "PRECEDENT_ROOT_PW_SRV1" in raw)

    print("\n[3] 命令预览必须掩码")
    preview = store.preview(p.command_template, p.secret_ref)
    check("预览中占位符被替换成掩码", MASK in preview)
    check("预览中不含明文", "hunter2-super-secret" not in preview)
    check("无密钥引用时不改动命令", store.preview("ls -la", None) == "ls -la")

    print("\n[4] 命令构造")
    cmd, err = store.build_command(p.command_template, p.secret_ref)
    check("构造成功无错误", err is None, str(err))
    check("占位符已替换为真值", "hunter2-super-secret" in cmd)
    cmd2, err2 = store.build_command(p.command_template, "MISSING_REF")
    check("密钥缺失时报错", err2 is not None and "找不到" in err2, str(err2))
    cmd3, err3 = store.build_command(p.command_template, None)
    check("无引用时报错", err3 is not None, str(err3))

    print("\n[5] 先例匹配")
    hit, why = store.match("部署时发现端口 8080 被占用，需要杀进程后重启", "systemctl stop byk-old")
    check("命中历史先例", hit is not None and hit.id == p.id, why)
    check("理由说明了成功次数", "成功" in why, why)
    miss, why2 = store.match("把一张图片转成 PNG 格式", "convert a.png b.png")
    check("不相关操作不误命中", miss is None, why2)

    print("\n[6] 成功次数累加（这是'复刻先例'的基础）")
    p2 = store.record_success(p.command_template, "部署时端口 8080 被占用，需要杀进程重启", "杀进程,重启", p.secret_ref)
    check("命中同一条先例而非新建", p2.id == p.id, f"{p2.id} vs {p.id}")
    check("成功次数累加到 1", p2.success_count == 1, str(p2.success_count))
    p3 = store.record_success(p.command_template, "部署时端口 8080 被占用，需要杀进程重启", "杀进程,重启", p.secret_ref)
    check("再来一次累加到 2", p3.success_count == 2, str(p3.success_count))
    check("先例总数仍为 1", len(store.load()) == 1, str(len(store.load())))

    print("\n[7] 无关操作沉淀为新先例")
    p_new = store.record_success("rm -rf /tmp/x", "清理临时目录释放空间", "清理,临时目录", None)
    check("新建了先例", p_new.id != p.id)
    check("先例总数为 2", len(store.load()) == 2, str(len(store.load())))
    check("新先例无密钥引用", p_new.secret_ref is None)

    print("\n[8] 依赖分层（可并行的不被串行化）")
    orch = Orchestrator.__new__(Orchestrator)  # 不跑 __init__，只测纯函数
    subs = [
        SubTask(id="st_1", title="审查代码", detail="", role="code"),
        SubTask(id="st_2", title="读文档", detail="", role="file"),
        SubTask(id="st_3", title="部署", detail="", role="code", depends_on=["st_1"]),
        SubTask(id="st_4", title="汇报", detail="", role="code", depends_on=["st_3", "st_2"]),
    ]
    waves = orch._topo_waves(subs)
    check("分了 3 层", len(waves) == 3, str([len(w) for w in waves]))
    check("st_1 与 st_2 在第一层并发", {s.id for s in waves[0]} == {"st_1", "st_2"}, str([s.id for s in waves[0]]))
    check("st_3 在第二层", {s.id for s in waves[1]} == {"st_3"}, str([s.id for s in waves[1]]))
    check("st_4 在第三层", {s.id for s in waves[2]} == {"st_4"}, str([s.id for s in waves[2]]))

    print("\n[9] 依赖成环不死锁")
    cyclic = [
        SubTask(id="a", title="A", detail="", role="code", depends_on=["b"]),
        SubTask(id="b", title="B", detail="", role="code", depends_on=["a"]),
    ]
    w = orch._topo_waves(cyclic)
    check("成环时仍能返回全部任务而不死锁", sum(len(x) for x in w) == 2, str([[s.id for s in x] for x in w]))

    print("\n[10] 依赖指向不存在的任务时不卡住")
    dangling = [SubTask(id="x", title="X", detail="", role="code", depends_on=["ghost"])]
    wx = orch._topo_waves(dangling)
    check("悬空依赖被当作可执行", len(wx) == 1 and wx[0][0].id == "x", str([[s.id for s in t] for t in wx]))

    print(f"\n{'=' * 50}\n通过 {PASS} 项，失败 {FAIL} 项")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
