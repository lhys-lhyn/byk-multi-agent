/**
 * dsh-plugin-byk-agents —— 客户端设置页 ↔ 宿主的数据通道（s5-pre 最小闭环）。
 *
 * 为什么需要第二条通道：客户端设置页的 configForms 只能读写宿主 Config 里
 * **标了 .volatile() 的标量字段**（见 lib/client.js:232-243），做不了
 * 「列出助手 / 改某个助手的开关」这类结构化读写。这里给宿主加一条 **HTTP 路由**，
 * 客户端用**同源** fetch 调用（设置页本身就由同一个 webServer 提供）。
 *
 * 通道证据（一手文件 + 行号）：
 *   packages/host/webserver/src/index.ts:22-25   Context { webServer: WebServer }
 *   packages/host/webserver/src/index.ts:42-48   WebRoute { kind, path, handler }
 *   packages/host/webserver/src/index.ts:166     register(route: WebRoute): () => void
 *   现成先例 dsh-approval-gate/src/index.mjs:722（inject webServer）/ :733-757（注册
 *     GET /api/auto-approve/events，同一套 kind/path/handler 写法）。
 *
 * 本模块**不 import 任何宿主包**，也不起进程：请求 → 纯数据操作（由宿主半区以 deps
 * 注入）→ 响应，三段都能在纯 node 下断言。
 */

/** 路由路径。客户端用相对路径同源调用。 */
export const SETTINGS_ROUTE = "/api/byk/assistants";

/** 通道支持的动作（s5 主步的 CRUD 在这里追加）。 */
export const CHANNEL_ACTIONS = ["list", "set-enabled", "add-role", "update-role", "remove-role"];

/** 请求体上限（字节）。设置页只发很小的 JSON，超长直接拒绝，不读进内存。 */
export const MAX_BODY_BYTES = 64 * 1024;

function failed(error) {
  return { ok: false, action: "", roleId: "", enabled: undefined, error: String(error) };
}

/**
 * 解析客户端请求体。只接受 JSON 对象；动作名同时接受 action 与 op 两种键
 * （s5 主步统一用 action，op 是给手写 curl 的短写法）。
 * @param raw 原始请求体（string | object | null | undefined）。
 * @returns {ok, action, roleId, enabled, error}
 */
export function parseRequest(raw) {
  let body = raw;
  if (typeof body === "string") {
    const text = body.trim();
    if (!text) body = {};
    else {
      try { body = JSON.parse(text); }
      catch (err) { return failed("请求体不是合法 JSON：" + String((err && err.message) || err)); }
    }
  }
  if (body === null || body === undefined) body = {};
  if (typeof body !== "object" || Array.isArray(body)) return failed("请求体必须是 JSON 对象");

  const rawAction = body.action !== undefined ? body.action : body.op !== undefined ? body.op : "list";
  const action = String(rawAction);
  if (CHANNEL_ACTIONS.indexOf(action) === -1) {
    return failed("未知动作 " + JSON.stringify(action) + "，可用：" + CHANNEL_ACTIONS.join("、"));
  }
  const roleId = body.roleId === undefined || body.roleId === null ? "" : String(body.roleId);
  const enabled = body.enabled;
  if (action === "set-enabled") {
    if (roleId === "") return failed("set-enabled 需要 roleId");
    if (typeof enabled !== "boolean") return failed("set-enabled 的 enabled 必须是布尔值，收到 " + JSON.stringify(enabled));
  }
  // 增删改三个动作带 fields（要写的字段集合）。fields 为空对象/非对象一律当请求形状错误拦下。
  const fields = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields) ? body.fields : null;
  if (action === "add-role" || action === "update-role") {
    if (roleId === "") return failed(action + " 需要 roleId");
    if (fields === null || Object.keys(fields).length === 0) return failed(action + " 需要 fields（至少一个要写的字段）");
  }
  if (action === "remove-role" && roleId === "") return failed("remove-role 需要 roleId");
  // 只在真的带了 fields 时挂这个键：list / set-enabled 的返回形状与 v1.6.3 逐字一致（老测试锁死了它）。
  const req = { ok: true, action, roleId, enabled, error: "" };
  if (fields !== null) req.fields = fields;
  return req;
}

function bad(action, error) {
  return { ok: false, status: 400, body: { ok: false, action, error: String(error) } };
}

/**
 * 处理一次通道请求（与 HTTP 无关，可在纯 node 下断言）。
 *
 * 错误码约定：请求形状不对 = 400；数据操作拒绝（校验失败、角色不存在、覆盖层坏）= 400
 * 且 error 透传可读原因；数据操作抛异常 = 500；一律带 ok:false + error，绝不静默。
 *
 * @param raw 请求体。
 * @param deps { list?: () => Promise, setEnabled?: (roleId, enabled) => Promise }
 * @returns {ok, status, body}
 */
export async function handleRequest(raw, deps) {
  const req = parseRequest(raw);
  if (!req.ok) return { ok: false, status: 400, body: { ok: false, action: "", error: req.error } };
  const d = deps || {};
  try {
    if (req.action === "list") {
      const r = typeof d.list === "function" ? await d.list() : { ok: false, error: "宿主没有提供 list 实现" };
      if (!r || r.ok !== true) return bad(req.action, (r && r.error) || "列出助手失败");
      return {
        ok: true, status: 200,
        body: {
          ok: true, action: req.action,
          assistants: Array.isArray(r.assistants) ? r.assistants : [],
          overlayPath: String(r.overlayPath || ""),
          overlayError: String(r.overlayError || ""),
        },
      };
    }
    if (req.action === "add-role" || req.action === "update-role" || req.action === "remove-role") {
      const fnName = req.action === "add-role" ? "addRole" : req.action === "update-role" ? "updateRole" : "removeRole";
      const fn = d[fnName];
      if (typeof fn !== "function") return bad(req.action, "宿主没有提供 " + fnName + " 实现");
      const w = await fn(req.roleId, req.fields || {});
      if (!w || w.ok !== true) return bad(req.action, (w && w.error) || "写入失败");
      return {
        ok: true, status: 200,
        body: {
          ok: true, action: req.action,
          roleId: String(w.roleId || req.roleId),
          overlayPath: String(w.overlayPath || ""),
          assistant: w.assistant || null,
          // 写成功顺带回带最新列表，客户端据此刷新（拿不到就不带，前端会自己再 list 一次）
          assistants: Array.isArray(w.assistants) ? w.assistants : undefined,
        },
      };
    }
    const r = typeof d.setEnabled === "function" ? await d.setEnabled(req.roleId, req.enabled) : { ok: false, error: "宿主没有提供 setEnabled 实现" };
    if (!r || r.ok !== true) return bad(req.action, (r && r.error) || "写入失败");
    // 写回成功后**由宿主回带最新行**，客户端不再自己拼状态。
    return {
      ok: true, status: 200,
      body: {
        ok: true, action: req.action,
        roleId: String(r.roleId || req.roleId),
        enabled: r.enabled === true,
        overlayPath: String(r.overlayPath || ""),
        assistant: r.assistant || null,
      },
    };
  } catch (err) {
    return { ok: false, status: 500, body: { ok: false, action: req.action, error: String((err && err.message) || err) } };
  }
}

/** 读请求体；超长/读失败返回结构化错误（不抛）。 */
async function readBody(req) {
  const declared = Number(req.headers && req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "请求体超过 " + MAX_BODY_BYTES + " 字节" };
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size > MAX_BODY_BYTES) return { ok: false, status: 413, error: "请求体超过 " + MAX_BODY_BYTES + " 字节" };
      chunks.push(buf);
    }
  } catch (err) {
    return { ok: false, status: 400, error: "读请求体失败：" + String((err && err.message) || err) };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * node:http 处理函数：GET/HEAD = list，POST = 按 body 里的 action 分发。
 * 用法与 dsh-approval-gate/src/index.mjs:733 一致，交给 webServer.register。
 * @param deps 同 handleRequest。
 * @returns (req, res) => Promise<void>
 */
export function createRouteHandler(deps) {
  return async function handler(req, res) {
    const send = function (status, obj) {
      try {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(obj));
      } catch (e) { /* 客户端已断开，没有可写的地方 */ }
    };
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        const r = await handleRequest({ action: "list" }, deps);
        send(r.status, r.body);
        return;
      }
      if (req.method !== "POST") { send(405, { ok: false, action: "", error: "method not allowed" }); return; }
      const text = await readBody(req);
      if (!text.ok) { send(text.status, { ok: false, action: "", error: text.error }); return; }
      const r = await handleRequest(text.text, deps);
      send(r.status, r.body);
    } catch (err) {
      send(500, { ok: false, action: "", error: String((err && err.message) || err) });
    }
  };
}

/**
 * 把注册表 + 覆盖层摊平成设置页要的行（纯函数）。
 *
 * 行结构（s5 主步沿用）：
 *   { id, name, enabled, origin, originText, editedFields[], routeText, routeSummary,
 *     route:{backend,provider,model,source,text,summary}|null, unavailable }
 *
 * 单个角色路由解析失败或已停用**不抛**：原因写进 unavailable，行照样返回 ——
 * 一个坏角色不能让整页空白。
 *
 * @param input { ids, registry, overlay, config, now, describe, explain }
 * @returns rows[]
 */
export function buildAssistantRows(input) {
  const src = input || {};
  const ids = Array.isArray(src.ids) ? src.ids : [];
  const registry = src.registry && typeof src.registry === "object" ? src.registry : {};
  const overlay = src.overlay && typeof src.overlay === "object" ? src.overlay : null;
  const describe = typeof src.describe === "function" ? src.describe : null;
  const explain = typeof src.explain === "function" ? src.explain : null;
  return ids.map(function (id) {
    const meta = registry[id] && typeof registry[id] === "object" ? registry[id] : {};
    let info = { source: "unknown", text: "", editedFields: [], enabled: true };
    if (explain) {
      try { info = explain(id, registry, overlay) || info; } catch (e) { /* 说明不上就退回默认视图 */ }
    }
    const row = {
      id: String(id),
      name: String(meta.name || meta.label || id),
      enabled: meta.enabled !== false && info.enabled !== false,
      origin: String(info.source || "unknown"),
      originText: String(info.text || ""),
      editedFields: Array.isArray(info.editedFields) ? info.editedFields.slice() : [],
      routeText: "",
      routeSummary: "",
      route: null,
      unavailable: "",
    };
    if (!describe) { row.unavailable = "宿主没有提供路由解析器"; return row; }
    try {
      const route = describe(id, { now: src.now, config: src.config, registry: registry, overlay: overlay });
      row.route = {
        backend: route.backend, provider: route.provider, model: route.model,
        source: route.source, text: route.text, summary: route.summary,
      };
      row.routeText = String(route.text || "");
      row.routeSummary = String(route.summary || "");
    } catch (err) {
      row.unavailable = String((err && err.message) || err);
    }
    return row;
  });
}
