/**
 * 助手覆盖层（assistants.local.json）：不改 byk/roles.py、不重建插件、不重启 DSH，
 * 就能给 BYK 的助手改名 / 改描述 / 改人格 / 停用 / 换模型，并**新增任意角色 id**。
 *
 * 用户拍板的规则：
 *   1. 允许新增任意助手 id；
 *   2. 内置角色（roles.py 里已有的）可以改名 / 停用 / 换模型，**不可删除**；
 *   3. 覆盖层文件不存在 = 合法的空覆盖，不是错误；
 *      覆盖层文件坏了 / 结构非法 = 明确报错（连文件路径一起报），绝不静默忽略。
 *
 * 除 loadOverlay / saveOverlay 之外全是纯函数：吃普通对象、吐普通对象，不改入参，
 * 也不碰文件系统。设置页（s4/s5）可以直接复用这些纯函数。
 *
 * 覆盖层文件结构（version 可省）：
 *   {
 *     "version": 1,
 *     "roles": {
 *       "code":   { "name": "代码助手（改过名的）", "enabled": false, "model": "x/y" },
 *       "writer": { "name": "写作助手", "description": "...", "persona": "..." }
 *     },
 *     "removed": ["old-added-role"]
 *   }
 * roles 里已存在于注册表（roles.py）的 id = 打补丁；不存在的 id = 新增角色。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BACKENDS } from "./routing.js";

/** 覆盖层结构版本。文件里写的 version 不得高于它。 */
export const OVERLAY_VERSION = 1;

/** 默认覆盖层文件（相对 bykRoot 的路径）。绝对路径用 defaultOverlayPath(bykRoot)。 */
export const DEFAULT_OVERLAY_PATH = "byk/assistants.local.json";

/** 角色 id 规范：小写字母开头，只含小写字母/数字/下划线/连字符，最长 32 字符。 */
export const ROLE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 覆盖层顶层允许的键。其余键报错 —— 防止把 roles 写成 role 这种静默失效的 typo。 */
const OVERLAY_KEYS = ["version", "roles", "removed", "note", "$schema"];

/**
 * 角色补丁允许的字段。
 * label 是 name 的别名（设置页里"标签"这个词更顺手），写进覆盖层后统一归一成 name。
 */
const PATCH_STRING_FIELDS = [
  "name", "label", "description", "persona", "persona_subagent",
  "model", "provider", "backend", "reasoningEffort", "sandbox", "color", "note",
];
const PATCH_BOOL_FIELDS = ["enabled"];
const PATCH_NUMBER_FIELDS = ["timeout_s"];
const PATCH_FIELDS = PATCH_STRING_FIELDS.concat(PATCH_BOOL_FIELDS, PATCH_NUMBER_FIELDS);

/** 新增一个角色至少要写出来的字段（缺了在合并前报错，不静默补默认值）。 */
const ADD_REQUIRED_FIELDS = ["name", "description"];

/** roles.py 的注册表里以 _ 开头的键（例如 _fallback）是元数据，不是角色。 */
const META_PREFIX = "_";

/** 新增角色的字段默认值（patch 里写了的以 patch 为准）。 */
const ROLE_DEFAULTS = {
  color: "",
  persona: "",
  persona_subagent: "",
  model: "",
  provider: "",
  sandbox: "workspace-write",
  timeout_s: 1800,
  enabled: true,
  note: "",
};

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 是不是元数据键（_fallback 之类）。 */
function isMetaKey(id) {
  return typeof id === "string" && id.startsWith(META_PREFIX);
}

/** 覆盖层的默认绝对路径：<bykRoot>/byk/assistants.local.json。 */
export function defaultOverlayPath(bykRoot) {
  return join(String(bykRoot || ""), "byk", "assistants.local.json");
}

/** 一份合法的空覆盖（文件不存在时用它）。 */
export function emptyOverlay() {
  return { version: OVERLAY_VERSION, roles: {}, removed: [] };
}

/** 注册表里真正是角色的 id（按注册表的原始顺序，排除 _fallback 这类元数据键）。 */
export function roleIdsIn(registry) {
  return Object.keys(registry || {}).filter((k) => !isMetaKey(k));
}

/** label 只是 name 的别名；其余字段原样保留。 */
function normalizePatch(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k === "label" ? "name" : k] = v;
  return out;
}

/** 逐字段校验一个角色补丁；错误追进 errors。 */
function checkPatchFields(label, patch, errors) {
  for (const [f, v] of Object.entries(patch)) {
    if (!PATCH_FIELDS.includes(f)) {
      errors.push(label + "." + f + "：未知字段（允许：" + PATCH_FIELDS.join(", ") + "）");
      continue;
    }
    if (PATCH_STRING_FIELDS.includes(f)) {
      if (typeof v !== "string") errors.push(label + "." + f + " 必须是字符串");
    } else if (PATCH_BOOL_FIELDS.includes(f)) {
      if (typeof v !== "boolean") errors.push(label + "." + f + " 必须是布尔值");
    } else if (PATCH_NUMBER_FIELDS.includes(f)) {
      if (!(Number.isFinite(v) && v > 0)) errors.push(label + "." + f + " 必须是正数（秒）");
    }
    if (f === "backend" && typeof v === "string" && !BACKENDS.includes(v)) {
      errors.push(label + ".backend 只能是 " + BACKENDS.join(" / ") + "，实际是 " + JSON.stringify(v));
    }
  }
}

/**
 * 校验一份覆盖层对象。
 * @param overlay 待校验的对象（一般是 JSON.parse 的结果）。
 * @param opts 可选 { builtinIds }：给了才能判断"哪些是内置角色"，
 *   从而补上两条**只有对照注册表才判得出来**的规则：
 *     ・内置角色不可删除（removed 里出现内置 id 直接报错）；
 *     ・新增角色必须带最小必需字段。
 * @returns {ok, errors[]}
 */
export function validateOverlay(overlay, opts) {
  const o = opts || {};
  const builtinIds = Array.isArray(o.builtinIds) ? o.builtinIds : null;
  const errors = [];

  if (!isPlainObject(overlay)) {
    const what = overlay === null ? "null" : Array.isArray(overlay) ? "数组" : typeof overlay;
    return { ok: false, errors: ["覆盖层必须是一个 JSON 对象，实际是 " + what] };
  }

  for (const key of Object.keys(overlay)) {
    if (!OVERLAY_KEYS.includes(key)) {
      errors.push("未知顶层键 " + JSON.stringify(key) + "（允许：" + OVERLAY_KEYS.join(", ") + "）");
    }
  }

  if (overlay.version !== undefined) {
    if (!Number.isInteger(overlay.version) || overlay.version < 1) {
      errors.push("version 必须是 ≥1 的整数");
    } else if (overlay.version > OVERLAY_VERSION) {
      errors.push("version " + overlay.version + " 高于本插件支持的 " + OVERLAY_VERSION + "：请升级插件");
    }
  }

  const roles = overlay.roles;
  if (roles !== undefined) {
    if (!isPlainObject(roles)) {
      errors.push("roles 必须是对象");
    } else {
      for (const [id, patch] of Object.entries(roles)) {
        if (!ROLE_ID_RE.test(id)) {
          errors.push("roles[" + JSON.stringify(id) + "]：角色 id 不合法（要求 " + ROLE_ID_RE.source + "）");
          continue;
        }
        if (!isPlainObject(patch)) {
          errors.push("roles." + id + " 必须是对象");
          continue;
        }
        checkPatchFields("roles." + id, patch, errors);
        if (builtinIds && !builtinIds.includes(id)) {
          for (const req of ADD_REQUIRED_FIELDS) {
            if (typeof patch[req] !== "string" || !patch[req].trim()) {
              errors.push("roles." + id + "：新增角色缺必需字段 " + req +
                "（新增角色至少要写 " + ADD_REQUIRED_FIELDS.join(" 与 ") + "）");
            }
          }
        }
      }
    }
  }

  const removed = overlay.removed;
  if (removed !== undefined) {
    if (!Array.isArray(removed)) {
      errors.push("removed 必须是数组");
    } else {
      const seen = new Set();
      for (const id of removed) {
        if (!ROLE_ID_RE.test(id)) {
          errors.push("removed 里的 " + JSON.stringify(id) + " 不是合法角色 id");
          continue;
        }
        if (seen.has(id)) {
          errors.push("removed 里 " + JSON.stringify(id) + " 重复");
          continue;
        }
        seen.add(id);
        if (builtinIds && builtinIds.includes(id)) {
          errors.push("removed 里的 " + JSON.stringify(id) +
            " 是内置角色：内置角色不可删除，只能停用（roles." + id + ".enabled = false）");
        }
        if (isPlainObject(roles) && has(roles, id)) {
          errors.push("removed 里的 " + JSON.stringify(id) + " 同时出现在 roles 里，两处互相矛盾");
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 读一份覆盖层文件。
 * 文件不存在 = 合法空覆盖（ok:true, existed:false），**不是**错误。
 * 文件存在但坏 JSON / 结构非法 = ok:false + 可读的 error（带文件路径），不静默。
 * @param filePath 覆盖层绝对路径。
 * @returns {ok, overlay?|error?, path, existed, errors[]}
 */
export function loadOverlay(filePath) {
  const path = String(filePath || "");
  if (!path || !existsSync(path)) {
    return { ok: true, overlay: emptyOverlay(), path, existed: false, errors: [] };
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const msg = path + " 读不出来：" + String(err && err.message);
    return { ok: false, error: msg, path, existed: true, errors: [msg] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    const msg = path + " 不是合法 JSON：" + String(err && err.message);
    return { ok: false, error: msg, path, existed: true, errors: [msg] };
  }
  const v = validateOverlay(parsed);
  if (!v.ok) {
    const msg = path + " 结构非法：" + v.errors.join("；");
    return { ok: false, error: msg, path, existed: true, errors: v.errors };
  }
  return { ok: true, overlay: parsed, path, existed: true, errors: [] };
}

/** 覆盖层改了 persona 但没改 persona_subagent 时，把 roles.py 追加的那段子智能体补充继承下来。 */
function deriveSubagentPersona(base, persona) {
  const oldPersona = typeof base.persona === "string" ? base.persona : "";
  const oldSub = typeof base.persona_subagent === "string" ? base.persona_subagent : "";
  if (oldPersona && oldSub.startsWith(oldPersona)) return persona + oldSub.slice(oldPersona.length);
  return persona;
}

/** 把补丁盖到一个已有角色上，返回**新的**对象（不改入参）。 */
function applyPatch(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = v;
  if (has(patch, "persona") && !has(patch, "persona_subagent")) {
    out.persona_subagent = deriveSubagentPersona(base, patch.persona);
  }
  return out;
}

/** 用一个补丁造出一个新角色。 */
function newRole(id, patch) {
  const persona = typeof patch.persona === "string" ? patch.persona : "";
  const out = { id, ...ROLE_DEFAULTS, ...patch, persona };
  if (!has(patch, "persona_subagent")) out.persona_subagent = persona;
  return out;
}

/**
 * 基准注册表 + 覆盖层 -> 合并结果。
 * 覆盖层非法时**抛错**（不是返回半个结果）：调用方要么先用 validateOverlay 自查，
 * 要么就吃这个异常，绝不能拿着"看起来还行"的注册表往下跑。
 *
 * 顺序契约：registry 的键序 = 基准注册表原样（含 _fallback 的位置），新增角色追加在最后；
 * 同一个 id 不会出现两次（对象键天然去重）。
 *
 * @param baseRegistry byk.cli roles --json 的结果（或任何同结构的表）。
 * @param overlay 覆盖层对象；null / undefined / 空对象都等于"没有覆盖层"。
 * @returns {registry, builtinIds[], addedIds[], disabledIds[], removedIds[]}
 */
export function mergeRegistry(baseRegistry, overlay) {
  const base = isPlainObject(baseRegistry) ? baseRegistry : {};
  const builtinIds = roleIdsIn(base);
  const raw = overlay === undefined || overlay === null ? {} : overlay;

  const v = validateOverlay(raw, { builtinIds });
  if (!v.ok) throw new Error("助手覆盖层非法：" + v.errors.join("；"));

  const ovRoles = isPlainObject(raw.roles) ? raw.roles : {};
  const removed = Array.isArray(raw.removed) ? raw.removed.slice() : [];
  // 只有"不是内置角色"的 id 才删得掉（内置的会被上面的校验拦下来）。
  const removedIds = removed.filter((id) => !builtinIds.includes(id));
  const addedIds = Object.keys(ovRoles).filter((id) => !builtinIds.includes(id) && !removedIds.includes(id));

  const registry = { ...base };
  for (const [id, patch] of Object.entries(ovRoles)) {
    if (removedIds.includes(id)) continue;
    const flat = normalizePatch(patch);
    registry[id] = builtinIds.includes(id) ? applyPatch(base[id] || {}, flat) : newRole(id, flat);
  }

  const disabledIds = roleIdsIn(registry).filter((id) => registry[id] && registry[id].enabled === false);
  return { registry, builtinIds, addedIds, disabledIds, removedIds };
}

/**
 * 当前生效的角色 id 列表：内置 ∪ 新增 − 删除，顺序稳定（内置按注册表原序，新增追加在后）。
 * 默认**包含已停用**的角色（它们仍然"存在"，只是执行时会被明确拒绝）；
 * 只想拿到可调用的那些，传 { includeDisabled: false }。
 */
export function roleIdsOf(baseRegistry, overlay, opts) {
  const m = mergeRegistry(baseRegistry, overlay);
  const ids = roleIdsIn(m.registry);
  if (opts && opts.includeDisabled === false) {
    return ids.filter((id) => m.registry[id] && m.registry[id].enabled !== false);
  }
  return ids;
}

/**
 * 说明某个角色 id 的配置来自哪一层 —— 直接拼给用户/模型看。
 * @returns {id, source, builtin, added, editedFields[], enabled, text}
 *   source: "builtin"（原样来自 roles.py）| "builtin+overlay"（内置，被覆盖层改过）
 *           | "overlay"（覆盖层新增）| "unknown"（两边都没有）
 */
export function explainPath(id, baseRegistry, overlay) {
  const base = isPlainObject(baseRegistry) ? baseRegistry : {};
  const builtin = has(base, id) && !isMetaKey(id);
  const ovRoles = isPlainObject(overlay) && isPlainObject(overlay.roles) ? overlay.roles : {};
  const patched = has(ovRoles, id);
  const editedFields = patched ? Object.keys(normalizePatch(ovRoles[id])) : [];
  const source = builtin ? (patched ? "builtin+overlay" : "builtin") : patched ? "overlay" : "unknown";

  let enabled = builtin && base[id] ? base[id].enabled !== false : true;
  if (patched && typeof ovRoles[id].enabled === "boolean") enabled = ovRoles[id].enabled;

  let text;
  if (source === "builtin") text = "内置角色（byk/roles.py），覆盖层未改动";
  else if (source === "builtin+overlay") text = "内置角色（byk/roles.py），覆盖层改了：" + editedFields.join("、");
  else if (source === "overlay") text = "覆盖层新增的角色";
  else text = "注册表和覆盖层里都没有这个 id";

  return { id, source, builtin, added: !builtin && patched, editedFields, enabled, text };
}

// ── 写操作：全部只改内存里的覆盖层对象，落盘交给 saveOverlay ──────────────

/** 深拷贝一份覆盖层，保证写操作不改调用方手里的对象。 */
function cloneOverlay(overlay) {
  const o = isPlainObject(overlay) ? overlay : {};
  return {
    ...o,
    roles: { ...(isPlainObject(o.roles) ? o.roles : {}) },
    removed: Array.isArray(o.removed) ? o.removed.slice() : [],
  };
}

function fail(overlay, errors) {
  return { ok: false, overlay: cloneOverlay(overlay), errors };
}

function succeed(overlay) {
  return { ok: true, overlay, errors: [] };
}

/** 从 opts 里取"哪些 id 是内置角色"：可以直接给 builtinIds，也可以给 baseRegistry。 */
function builtinListOf(opts) {
  const o = opts || {};
  if (Array.isArray(o.builtinIds)) return o.builtinIds;
  if (isPlainObject(o.baseRegistry)) return roleIdsIn(o.baseRegistry);
  return null;
}

/**
 * 新增一个角色。返回**新的** overlay 对象（原对象不动），不落盘。
 * @param overlay 现有覆盖层（可为 null）。
 * @param id 角色 id，必须符合 ROLE_ID_RE。
 * @param fields 至少 { name, description }；可选 persona/description/... 见 PATCH_FIELDS。
 * @param opts 可选 { builtinIds } 或 { baseRegistry }：给了就顺带拒绝"把内置角色当新角色加"。
 * @returns {ok, overlay, errors[]}
 */
export function addRole(overlay, id, fields, opts) {
  const ov = cloneOverlay(overlay);
  const errors = [];
  const patch = normalizePatch(fields);
  if (!ROLE_ID_RE.test(String(id))) {
    errors.push("角色 id 不合法（要求 " + ROLE_ID_RE.source + "）：" + JSON.stringify(String(id)));
  }
  checkPatchFields("roles." + id, patch, errors);
  for (const req of ADD_REQUIRED_FIELDS) {
    if (typeof patch[req] !== "string" || !patch[req].trim()) {
      errors.push("新增角色缺必需字段 " + req +
        "（新增角色至少要写 " + ADD_REQUIRED_FIELDS.join(" 与 ") + "）");
    }
  }
  if (has(ov.roles, id)) errors.push("覆盖层里已经有角色 id " + JSON.stringify(id) + "：要改它请用 updateRole");
  const builtinIds = builtinListOf(opts);
  if (builtinIds && builtinIds.includes(id)) {
    errors.push(JSON.stringify(id) + " 是内置角色，不能当新角色添加：要改它请用 updateRole");
  }
  if (errors.length) return fail(ov, errors);

  ov.roles[id] = patch;
  ov.removed = ov.removed.filter((x) => x !== id);
  return succeed(ov);
}

/**
 * 改一个已有角色（内置或覆盖层新增都行）。字段是**浅合并**的：只写要改的那几个。
 * @returns {ok, overlay, errors[]}
 */
export function updateRole(overlay, id, fields, opts) {
  const ov = cloneOverlay(overlay);
  const errors = [];
  const patch = normalizePatch(fields);
  if (!ROLE_ID_RE.test(String(id))) {
    errors.push("角色 id 不合法（要求 " + ROLE_ID_RE.source + "）：" + JSON.stringify(String(id)));
  }
  if (!Object.keys(patch).length) errors.push("没给要改的字段");
  checkPatchFields("roles." + id, patch, errors);
  const builtinIds = builtinListOf(opts);
  if (builtinIds && !builtinIds.includes(id) && !has(ov.roles, id)) {
    errors.push("没有角色 id " + JSON.stringify(id) + "：内置列表和覆盖层里都没有它");
  }
  if (errors.length) return fail(ov, errors);

  ov.roles[id] = { ...(ov.roles[id] || {}), ...patch };
  ov.removed = ov.removed.filter((x) => x !== id);
  return succeed(ov);
}

/**
 * 删掉一个角色。**内置角色删不掉**（返回 ok:false 并提示改用停用）；
 * 只能删覆盖层自己新增的角色。
 * @param opts { builtinIds } 或 { baseRegistry }：不传就不做"是不是内置"的判断，
 *   由 mergeRegistry 在合并时兜底报错。强烈建议传。
 * @returns {ok, overlay, errors[]}
 */
export function removeRole(overlay, id, opts) {
  const ov = cloneOverlay(overlay);
  const errors = [];
  if (!ROLE_ID_RE.test(String(id))) {
    errors.push("角色 id 不合法（要求 " + ROLE_ID_RE.source + "）：" + JSON.stringify(String(id)));
  }
  const builtinIds = builtinListOf(opts);
  if (builtinIds && builtinIds.includes(id)) {
    errors.push("内置角色 " + JSON.stringify(id) + " 不可删除，只能停用：" +
      "setEnabled(overlay, " + JSON.stringify(id) + ", false)");
  }
  if (!errors.length && builtinIds && !has(ov.roles, id)) {
    errors.push("覆盖层里没有角色 id " + JSON.stringify(id) + "，没有可删的东西");
  }
  if (errors.length) return fail(ov, errors);

  delete ov.roles[id];
  if (!ov.removed.includes(id)) ov.removed.push(id);
  return succeed(ov);
}

/**
 * 启用/停用一个角色。内置角色靠"加一条 enabled 补丁"实现，不动 roles.py。
 * @returns {ok, overlay, errors[]}
 */
export function setEnabled(overlay, id, enabled, opts) {
  const ov = cloneOverlay(overlay);
  const errors = [];
  if (!ROLE_ID_RE.test(String(id))) {
    errors.push("角色 id 不合法（要求 " + ROLE_ID_RE.source + "）：" + JSON.stringify(String(id)));
  }
  if (typeof enabled !== "boolean") errors.push("enabled 必须是布尔值");
  const builtinIds = builtinListOf(opts);
  if (builtinIds && !builtinIds.includes(id) && !has(ov.roles, id)) {
    errors.push("没有角色 id " + JSON.stringify(id) + "：内置列表和覆盖层里都没有它");
  }
  if (errors.length) return fail(ov, errors);

  ov.roles[id] = { ...(ov.roles[id] || {}), enabled };
  return succeed(ov);
}

/**
 * 把覆盖层写回磁盘（2 空格缩进 + 结尾换行）。写之前先校验结构。
 * @param filePath 目标绝对路径（父目录不存在会自动建）。
 * @param overlay 覆盖层对象。
 * @param opts 可选 { builtinIds }：给了才校验"新增角色必需字段"。
 * @returns {ok, path, error}
 */
export function saveOverlay(filePath, overlay, opts) {
  const path = String(filePath || "");
  if (!path) return { ok: false, path, error: "没给覆盖层文件路径" };
  const v = validateOverlay(overlay, opts || {});
  if (!v.ok) return { ok: false, path, error: "覆盖层结构非法，未写盘：" + v.errors.join("；") };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(overlay, null, 2) + "\n", "utf8");
    return { ok: true, path, error: "" };
  } catch (err) {
    return { ok: false, path, error: String(err && err.message) };
  }
}
