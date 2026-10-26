/**
 * 助手覆盖层单测：校验、合并、id 列表、写操作、落盘往返。不依赖 DSH 运行时，也不起子进程。
 * 运行：node test/assistants.test.js
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OVERLAY_VERSION,
  DEFAULT_OVERLAY_PATH,
  ROLE_ID_RE,
  defaultOverlayPath,
  emptyOverlay,
  roleIdsIn,
  loadOverlay,
  validateOverlay,
  mergeRegistry,
  roleIdsOf,
  explainPath,
  addRole,
  updateRole,
  removeRole,
  setEnabled,
  saveOverlay,
} from "../lib/assistants.js";

/** 造一个和 byk.cli roles --json 同结构的基准注册表。 */
const mkRole = (id, over) => ({
  id,
  name: id + "助手",
  color: "#000000",
  description: id + " 的描述",
  persona: "P-" + id,
  persona_subagent: "P-" + id + "\n\n[SUB]",
  model: "m-" + id,
  provider: "p-" + id,
  sandbox: "workspace-write",
  timeout_s: 1800,
  enabled: true,
  note: "",
  ...(over || {}),
});

const BUILTIN_ORDER = ["task", "code", "vision", "file", "audio", "research", "search"];
const BASE = { _fallback: { provider: "fallback-p", model: "fallback-m" } };
for (const id of BUILTIN_ORDER) BASE[id] = mkRole(id);
// roles.py 的 _fallback 是最后一个键；这里照样摆最后，好让"未配置时逐字段相等"是真断言。
delete BASE._fallback;
for (const id of BUILTIN_ORDER) BASE[id] = mkRole(id);
BASE._fallback = { provider: "fallback-p", model: "fallback-m" };

const TMP = mkdtempSync(join(tmpdir(), "byk-assistants-"));

// 1) 未配置覆盖层：合并结果逐字段等于基准注册表（JSON 全等），id 列表也原样
{
  for (const none of [undefined, null, {}]) {
    const m = mergeRegistry(BASE, none);
    assert.equal(JSON.stringify(m.registry), JSON.stringify(BASE));
    assert.deepEqual(m.builtinIds, BUILTIN_ORDER);
    assert.deepEqual(m.addedIds, []);
    assert.deepEqual(m.disabledIds, []);
    assert.deepEqual(m.removedIds, []);
    assert.deepEqual(roleIdsOf(BASE, none), BUILTIN_ORDER);
  }
  assert.equal(roleIdsIn(BASE).includes("_fallback"), false);
  console.log("1 未配置时逐字段相等 OK");
}

// 2) 改名：只动 name，其余字段不变，且基准注册表不被改
{
  const r = updateRole(null, "code", { name: "代码助手（改过名的）" });
  assert.equal(r.ok, true);
  const m = mergeRegistry(BASE, r.overlay);
  assert.equal(m.registry.code.name, "代码助手（改过名的）");
  assert.equal(m.registry.code.persona, BASE.code.persona);
  assert.equal(m.registry.code.model, BASE.code.model);
  // 别名 label 等价于 name
  const r2 = updateRole(null, "code", { label: "别名写法" });
  assert.equal(mergeRegistry(BASE, r2.overlay).registry.code.name, "别名写法");
  // 入参没被就地改
  assert.equal(BASE.code.name, "code助手");
  assert.equal(r.overlay === BASE, false);
  console.log("2 改名 OK");
}

// 3) 停用：enabled=false 留在注册表里、进 disabledIds，id 列表仍含它（执行期才拒绝）
{
  const r = setEnabled(null, "audio", false);
  assert.equal(r.ok, true);
  const m = mergeRegistry(BASE, r.overlay);
  assert.equal(m.registry.audio.enabled, false);
  assert.deepEqual(m.disabledIds, ["audio"]);
  assert.equal(roleIdsOf(BASE, r.overlay).includes("audio"), true);
  assert.deepEqual(roleIdsOf(BASE, r.overlay, { includeDisabled: false }).includes("audio"), false);
  assert.equal(setEnabled(null, "audio", "nope").ok, false);
  console.log("3 停用 OK");
}

// 4) 新增合法角色：追加在最后，顺序稳定
{
  let ov = addRole(null, "writer", { name: "写作助手", description: "把素材写成成稿", persona: "P-writer" }, { baseRegistry: BASE }).overlay;
  assert.ok(ov);
  const r = addRole(ov, "notes", { name: "便签助手", description: "整理便签" }, { baseRegistry: BASE });
  assert.equal(r.ok, true);
  ov = r.overlay;
  const m = mergeRegistry(BASE, ov);
  assert.deepEqual(m.addedIds, ["writer", "notes"]);
  assert.equal(m.registry.writer.persona, "P-writer");
  assert.equal(m.registry.writer.persona_subagent, "P-writer");
  assert.equal(m.registry.writer.sandbox, "workspace-write");
  assert.equal(m.registry.writer.enabled, true);
  assert.equal(m.registry.writer.id, "writer");
  assert.deepEqual(roleIdsOf(BASE, ov), BUILTIN_ORDER.concat(["writer", "notes"]));
  // 内置 id 不能当新角色加
  assert.equal(addRole(ov, "code", { name: "x", description: "y" }, { baseRegistry: BASE }).ok, false);
  // 重复新增被拒
  assert.equal(addRole(ov, "writer", { name: "x", description: "y" }, { baseRegistry: BASE }).ok, false);
  console.log("4 新增合法角色 OK");
}

// 5) 新增非法 id / 非字段 / 错类型一律被拒
{
  for (const bad of ["9bad", "Bad", "UPPER", "has space", "a".repeat(33), "", "角色", "a.b"]) {
    assert.equal(addRole(null, bad, { name: "n", description: "d" }).ok, false, "应拒绝 id=" + bad);
  }
  assert.equal(ROLE_ID_RE.test("a"), true);
  assert.equal(ROLE_ID_RE.test("a_1-x"), true);
  assert.equal(updateRole(null, "code", { nope: 1 }).ok, false);
  assert.equal(updateRole(null, "code", { timeout_s: -1 }).ok, false);
  assert.equal(updateRole(null, "code", { enabled: "yes" }).ok, false);
  assert.equal(updateRole(null, "code", {}).ok, false);
  const v = validateOverlay({ role: {} });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /顶层键/.test(e)));
  console.log("5 非法 id / 未知字段 / 错类型被拒 OK");
}

// 6) 删除内置角色被拒；只能删覆盖层自己新增的
{
  const r = removeRole(null, "code", { baseRegistry: BASE });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /不可删除/.test(e)));
  assert.ok(r.errors.some((e) => /setEnabled/.test(e)));
  // 手写 removed 也一样拦下来
  assert.throws(() => mergeRegistry(BASE, { removed: ["code"] }), /内置角色不可删除/);
  const v = validateOverlay({ removed: ["code"] }, { builtinIds: BUILTIN_ORDER });
  assert.equal(v.ok, false);

  // 新增的角色可以删：删完 id 列表回到原样，removedIds 记着它
  const added = addRole(null, "writer", { name: "写作助手", description: "写" }, { baseRegistry: BASE }).overlay;
  assert.deepEqual(roleIdsOf(BASE, added), BUILTIN_ORDER.concat(["writer"]));
  const rm = removeRole(added, "writer", { baseRegistry: BASE });
  assert.equal(rm.ok, true);
  const m = mergeRegistry(BASE, rm.overlay);
  assert.deepEqual(roleIdsOf(BASE, rm.overlay), BUILTIN_ORDER);
  assert.deepEqual(m.addedIds, []);
  assert.deepEqual(m.removedIds, ["writer"]);
  assert.equal(mergeRegistry(BASE, rm.overlay).registry.writer, undefined);
  // roles 与 removed 同时写同一个 id 属于自相矛盾
  assert.equal(validateOverlay({ roles: { writer: { name: "n", description: "d" } }, removed: ["writer"] }).ok, false);
  console.log("6 删除内置被拒 / 新增可删 OK");
}

// 7) 坏 JSON 明确报错；文件不存在 = 合法空覆盖
{
  const missing = join(TMP, "nope-not-here.json");
  const miss = loadOverlay(missing);
  assert.equal(miss.ok, true);
  assert.equal(miss.existed, false);
  assert.deepEqual(miss.overlay, emptyOverlay());
  assert.equal(miss.path, missing);

  const bad = join(TMP, "bad.json");
  writeFileSync(bad, "{ this is not json", "utf8");
  const r = loadOverlay(bad);
  assert.equal(r.ok, false);
  assert.equal(r.existed, true);
  assert.ok(r.error.includes(bad), "错误里要有文件路径");
  assert.match(r.error, /JSON/);

  const badShape = join(TMP, "bad-shape.json");
  writeFileSync(badShape, JSON.stringify({ roles: { "NO GOOD": {} } }), "utf8");
  const r2 = loadOverlay(badShape);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /结构非法/);

  const good = join(TMP, "good.json");
  writeFileSync(good, JSON.stringify({ version: OVERLAY_VERSION, roles: { code: { name: "改名了" } } }), "utf8");
  const r3 = loadOverlay(good);
  assert.equal(r3.ok, true);
  assert.equal(r3.existed, true);
  assert.equal(mergeRegistry(BASE, r3.overlay).registry.code.name, "改名了");
  console.log("7 坏 JSON 报错 / 缺文件是空覆盖 OK");
}

// 8) 新增角色缺必需字段被拒（合并前就报，不静默补默认值）
{
  assert.throws(() => mergeRegistry(BASE, { roles: { writer: { description: "只有描述" } } }), /必需字段 name/);
  assert.throws(() => mergeRegistry(BASE, { roles: { writer: { name: "   ", description: "d" } } }), /必需字段 name/);
  assert.throws(() => mergeRegistry(BASE, { roles: { writer: { name: "n", description: "d", timeout_s: "1" } } }), /正数/);
  const v = validateOverlay({ roles: { writer: { description: "d" } } }, { builtinIds: BUILTIN_ORDER });
  assert.equal(v.ok, false);
  // 内置角色只写一个字段是合法的补丁，不该被"必需字段"规则误伤
  assert.equal(validateOverlay({ roles: { code: { enabled: false } } }, { builtinIds: BUILTIN_ORDER }).ok, true);
  // 顶层结构本身就坏的对象
  assert.deepEqual(validateOverlay(null), { ok: false, errors: ["覆盖层必须是一个 JSON 对象，实际是 null"] });
  console.log("8 缺必需字段被拒 OK");
}

// 9) roleIdsOf：去重、顺序稳定、可重复调用
{
  let ov = {};
  ov = addRole(ov, "writer", { name: "写作助手", description: "写" }, { baseRegistry: BASE }).overlay;
  ov = addRole(ov, "notes", { name: "便签助手", description: "记" }, { baseRegistry: BASE }).overlay;
  ov = updateRole(ov, "task", { description: "改过的描述" }, { baseRegistry: BASE }).overlay;
  const a = roleIdsOf(BASE, ov);
  const b = roleIdsOf(BASE, ov);
  assert.deepEqual(a, b);
  assert.deepEqual(a, BUILTIN_ORDER.concat(["writer", "notes"]));
  assert.equal(new Set(a).size, a.length);
  assert.equal(a.length, m9count(BASE, ov));
  function m9count(base, over) { return Object.keys(mergeRegistry(base, over).registry).filter((k) => k[0] !== "_").length; }
  // 内置角色的位置不因补丁而变
  assert.equal(a.indexOf("code"), 1);
  console.log("9 id 列表去重与顺序稳定 OK");
}

// 10) explainPath：说清这条配置来自哪一层
{
  const ov = updateRole(addRole(null, "writer", { name: "写作助手", description: "写" }, { baseRegistry: BASE }).overlay,
    "code", { model: "x/y", enabled: false }, { baseRegistry: BASE }).overlay;
  const p1 = explainPath("task", BASE, ov);
  assert.equal(p1.source, "builtin");
  assert.equal(p1.builtin, true);
  assert.deepEqual(p1.editedFields, []);
  assert.match(p1.text, /内置角色/);
  const p2 = explainPath("code", BASE, ov);
  assert.equal(p2.source, "builtin+overlay");
  assert.equal(p2.enabled, false);
  assert.deepEqual(p2.editedFields.sort(), ["enabled", "model"]);
  const p3 = explainPath("writer", BASE, ov);
  assert.equal(p3.source, "overlay");
  assert.equal(p3.added, true);
  assert.equal(explainPath("ghost", BASE, ov).source, "unknown");
  console.log("10 explainPath OK");
}

// 11) 改 persona 时把 roles.py 追加的子智能体补充继承下来；补丁是浅合并
{
  const ov = updateRole(null, "code", { persona: "新人格" }, { baseRegistry: BASE }).overlay;
  const m = mergeRegistry(BASE, ov);
  assert.equal(m.registry.code.persona, "新人格");
  assert.equal(m.registry.code.persona_subagent, "新人格\n\n[SUB]");
  const ov2 = updateRole(ov, "code", { description: "D" }, { baseRegistry: BASE }).overlay;
  const m2 = mergeRegistry(BASE, ov2);
  assert.equal(m2.registry.code.persona, "新人格");
  assert.equal(m2.registry.code.description, "D");
  console.log("11 persona 继承 + 浅合并 OK");
}

// 12) saveOverlay 落盘 -> loadOverlay 回读 -> 合并，闭环
{
  let ov = addRole(null, "writer", { name: "写作助手", description: "写成稿" }, { baseRegistry: BASE }).overlay;
  ov = setEnabled(ov, "audio", false).overlay;
  const file = join(TMP, "nested", "assistants.local.json");
  const s = saveOverlay(file, ov, { builtinIds: BUILTIN_ORDER });
  assert.equal(s.ok, true);
  assert.equal(s.error, "");
  const back = loadOverlay(file);
  assert.equal(back.ok, true);
  assert.deepEqual(back.overlay, ov);
  const m = mergeRegistry(BASE, back.overlay);
  assert.deepEqual(m.addedIds, ["writer"]);
  assert.deepEqual(m.disabledIds, ["audio"]);
  // 非法对象不落盘
  assert.equal(saveOverlay(join(TMP, "x.json"), { roles: { "BAD ID": {} } }).ok, false);
  assert.equal(saveOverlay("", ov).ok, false);
  console.log("12 落盘往返 OK");
}

// 13) 路径辅助函数
{
  assert.equal(DEFAULT_OVERLAY_PATH, "byk/assistants.local.json");
  assert.equal(defaultOverlayPath("C:/Projects/byk"), join("C:/Projects/byk", "byk", "assistants.local.json"));
  assert.equal(OVERLAY_VERSION, 1);
  console.log("13 路径/版本常量 OK");
}

rmSync(TMP, { recursive: true, force: true });
console.log("助手覆盖层测试全部通过");
