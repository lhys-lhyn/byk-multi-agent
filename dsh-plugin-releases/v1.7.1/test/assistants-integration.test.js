/**
 * 覆盖层集成断言：只检查 lib/index.js 是否真的把 lib/assistants.js 接上了，
 * 以及「没有覆盖层文件」这条路径的 id 视图与内置七角色逐元素一致（= 未配置时行为不变）。
 * 不 import index.js（它会拉 DSH 运行时），不起子进程。
 * 运行：node test/assistants-integration.test.js
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyOverlay, loadOverlay, mergeRegistry, roleIdsIn } from "../lib/assistants.js";

const SRC = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
const count = (re) => (SRC.match(re) || []).length;
const BUILTIN = ["task", "code", "vision", "file", "audio", "research", "search"];

// ---------------------------------------------------------------- 1. 接线
{
  const imp = SRC.match(/import \{([^}]*)\} from "\.\/assistants\.js";/);
  assert.ok(imp, "lib/index.js 应从 ./assistants.js 具名导入");
  for (const name of ["defaultOverlayPath", "loadOverlay", "mergeRegistry", "roleIdsIn"]) {
    assert.ok(imp[1].includes(name), `应导入 ${name}`);
  }
  assert.equal(count(/assistantsPath: z\.string\(\)\.default\(""\)/g), 1, "Config 应有 assistantsPath 且默认空串");
  assert.equal(count(/cfg\.assistantsPath/g), 1, "overlayPath() 应读 cfg.assistantsPath");
  assert.equal(count(/defaultOverlayPath\(bykRoot\)/g), 1, "留空时应回落到 defaultOverlayPath(bykRoot)");
  assert.equal(count(/async function loadMerged\(\)/g), 1, "应有 loadMerged()");
  for (const key of ["overlayError", "overlayPath", "builtinIds", "addedIds", "disabledIds", "ids"]) {
    assert.ok(SRC.includes(key), `loadMerged 的返回结构里应有 ${key}`);
  }
  assert.equal(count(/await loadRegistry\(\)/g), 1, "除了 loadMerged 内部，不应再有直接读注册表的地方");
  assert.equal(count(/await loadMerged\(\)/g), 6, "runRoleBody / planRoleIds / byk_hire 三处 + 设置页通道的 list / set-enabled / mutate 三处，都应走 loadMerged()");
}

// ------------------------------------------- 2. ROLE_IDS 的旧硬编码用法必须都已换掉
{
  assert.equal(count(/ROLE_IDS\.includes\(/g), 0, "角色校验不应再写 ROLE_IDS.includes");
  assert.equal(count(/roles: ROLE_IDS/g), 0, "byk_plan / byk_batch 的 normalizePlan 应传动态 id");
  assert.equal(count(/ROLE_IDS\.join\("、"\)/g), 0, "「未知角色」文案应列动态 id");
  assert.equal(count(/ROLE_BLURB\[id\]/g), 2, "ROLE_BLURB[id] 只应出现在 roleBlurb() 内部");
  assert.equal(count(/roleBlurb\(id\)/g), 2, "roleBlurb(id)：定义 1 处 + byk_role 描述里的调用 1 处（覆盖层新增角色没有 ROLE_BLURB）");
  assert.equal(count(/enum: \[\.\.\.ROLE_IDS\]/g), 1, "固定 enum 只应保留在 roleParam() 的回落分支里");
  assert.equal(count(/syncRoleIds/g) >= 3, true, "syncRoleIds 应被 checkRole / 描述 / 启动日志用到");
  assert.equal(count(/function checkRole\(role\)/g), 1, "应有 checkRole");
  assert.equal(count(/checkRole\(/g), 3, "checkRole 定义 1 处 + runRole / byk_hire 各 1 处");
  assert.equal(count(/roleParam\(/g), 3, "roleParam 定义 1 处 + byk_role / byk_hire 各 1 处");
  assert.equal(count(/planRoleIds\(/g), 3, "planRoleIds 定义 1 处 + byk_plan / byk_batch 各 1 处");
  assert.equal(count(/readOverlaySync\(\)/g), 4, "readOverlaySync：定义 + bootstrap + checkRole + planRoleIds（新增角色免重启）");
}

// ------------------------------------------------------------ 3. 停用角色的拒绝文案
{
  assert.equal(count(/function disabledRoleText\(role, m\)/g), 1, "应有 disabledRoleText");
  assert.equal(count(/disabledRoleText\(/g), 3, "定义 1 处 + runRoleBody / byk_hire 各 1 处");
  assert.equal(count(/overlayNote\(/g), 3, "overlayNote 定义 1 处 + runRoleBody / planRoleIds 各 1 处");
  assert.equal(count(/读取失败：\$\{/g) >= 1, true, "覆盖层坏掉时要有「读取失败：…」的点名文案");
  assert.equal(count(/registry: loaded\.registry/g), 1, "runRole 的模型路由应吃合并后的注册表");
  assert.equal(count(/\bregistry\b/g) > 0, true, "占位：确保上面的正则没有把文件读空");
assert.equal(count(/ctx\.inject\(\["webServer"\]/, true) >= 1, true, "设置页路由必须走响应式 ctx.inject([\"webServer\"])（同步取一定拿不到：web bundle 在本插件之后挂载）");
}

// -------------------------------- 4. 未配置覆盖层：id 视图与内置七角色逐元素一致（含顺序）
{
  const base = {};
  for (const id of BUILTIN) base[id] = { id, name: id + "助手", persona: "P-" + id };

  const dir = mkdtempSync(join(tmpdir(), "byk-overlay-int-"));
  try {
    const file = join(dir, "assistants.local.json");
    const loaded = loadOverlay(file);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.existed, false, "文件不存在 = 合法的空覆盖");

    const m0 = mergeRegistry(base, loaded.existed ? loaded.overlay : emptyOverlay());
    assert.deepEqual(roleIdsIn(m0.registry), BUILTIN, "没有覆盖层时 id 列表应与内置完全一致（含顺序）");
    assert.deepEqual(m0.addedIds, []);
    assert.deepEqual(m0.disabledIds, []);
    assert.deepEqual(m0.removedIds, []);
    assert.deepEqual(Object.keys(m0.registry), BUILTIN, "键序也不能变");

    // 覆盖层新增 + 停用：id 列表 = 内置 ∪ 新增 − 移除，停用的仍留在表里（好让拒绝文案能取到补丁）
    const ov = {
      version: 1,
      roles: {
        ghost: { name: "幽灵助手", description: "覆盖层新增的" },
        code: { enabled: false },
      },
      removed: [],
    };
    const m1 = mergeRegistry(base, ov);
    assert.deepEqual(roleIdsIn(m1.registry), [...BUILTIN, "ghost"], "新增角色追加在最后");
    assert.deepEqual(m1.addedIds, ["ghost"]);
    assert.deepEqual(m1.disabledIds, ["code"]);
    assert.equal(m1.registry.code.enabled, false, "停用的角色仍在注册表里");
    assert.equal(m1.registry.code.persona, "P-code", "没被补丁覆盖的字段保持原样");

    // 落盘往返：坏文件不许静默
    writeFileSync(file, "{ 这不是 JSON", "utf8");
    const broken = loadOverlay(file);
    assert.equal(broken.ok, false);
    assert.ok(String(broken.error).includes(file), "报错文案要点名覆盖层路径");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("assistants-integration: 全部断言通过");
