/**
 * dsh-plugin-byk-agents — 跨会话审批镜像（浏览器端 bundle）
 *
 * 这是 dsh-approval-gate 原生提示条的**替代实现**，不是它的增强：原生条只显示
 * **当前会话**的审批事件（client.js:189 带 sessionId 拉取，服务端 src\index.mjs:749 按
 * sessionId 过滤）。本模块故意**不带** sessionId 拉全量事件（src\index.mjs:739 该参数可选、
 * 不传即不过滤），再按每条事件自带的 sessionId（src\index.mjs:290）标注来源会话后镜像展示，
 * 于是「别的会话发生了什么」在主对话里也能一眼看到。
 *
 * 硬规则（与原生条零重复）：只渲染 ev.sessionId !== 当前会话 id 的事件；
 * 当前会话的事件一律交给 dsh-approval-gate 的原生条，同一事件永远不会出现两条提示条。
 *
 * 除了上面那条「只读镜像」，本模块还负责**把等待人工的审批都搬到主对话**：
 * 客户端 dsh-client-ui-approval 把待批项登记在 ctx.sessions.scopeOf(owner) 算出的会话键上
 * （lib/client.js:285），而原生卡片只挂当前会话的 conversation.composer（:343-354）——
 * 于是「登记在子会话键上的审批」在主对话里既看不到、也没法点。
 * 本模块从 uiSession 的全局待批快照里取出所有待批项，在输入框上方给出「允许一次 / 拒绝」按钮。
 * 显示规则（v1.4.1 定稿）：全都显示；只有本会话自己那条在原生面板已在场时才让位，避免两套按钮。
 * 详见 selectChildPendings / filterOwnIfNative / ChildApprovalStrip。
 *
 * 数据源：轮询 host 提供的 GET /api/auto-approve/events（不带 sessionId、可带 since）。
 * 字段名与注册方式照抄 dsh-approval-gate\client.js，不引入新的客户端服务依赖（inject: ['timer']）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-byk-agents',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    // 跨会话事件频率低，5 秒足够（原生条是 2 秒），降低空轮询开销。
    const POLL_MS = 5000
    // 一条「等待人工审批」的提示最多挂多久（毫秒）。超过它就不再当作「正在等你」：
    // 本窗口既然拿不到这条审批的应答句柄，也不能无限期地把它挂在输入框上方。历史仍留在「跨会话审批」时间线里。
    const PENDING_HOLD_MS = 10 * 60 * 1000
    // 单条提示条的停留时长（等人工审批的 pending 不自动收起）。
    const NOTICE_HOLD_MS = 6000
    // 每次轮询向回多扫的事件条数：id 是跨会话共享的全局递增游标，
    // 多会话并发时单一游标可能跳过另一会话较早写入的事件，回扫 + id 去重表兜底。
    const SCAN_BACK = 50

    // 降级只告警一次，之后静默；绝不抛错、绝不刷屏、绝不影响对话。
    let degraded = false
    function warnOnce(reason) {
      if (degraded) return
      degraded = true
      try {
        console.warn('[byk-agents] 跨会话审批镜像已降级（不再重试提示）：' + reason)
      } catch (e) { /* console 不可用时无处可写，忽略 */ }
    }


    // ================= 子智能体待批审批（在主对话里直接允许/拒绝） =================
    //
    // 数据源：客户端 uiSession 服务的全局待批快照 sessionStatus（dsh-client-ui-session\
    // lib\client.js:148-156 getSnapshot/subscribe，:299-312 按 sessionId 收录**所有**会话的
    // 待批项），配合会话列表行的 parentId（dsh-api-session-controller\lib\client.js:3514）
    // 判断「这是不是我（当前会话）的后代会话」。
    //
    // 应答词表（宿主 dsh-user-approval\lib\index.js:31-32）：'allowed-once' 是唯一授权，
    // 'rejected' 是拒绝。待批对象就是 dsh-client-ui-approval 的 PendingApproval 实例
    // （该模块私有，不能 import、不能 instanceof），这里只把它当「有 answer()/answerable
    // 的普通对象」用——Click → pending.answer(outcome) → 宿主 waterfall 收到该 outcome。
    const APPROVE_OUTCOME = 'allowed-once'
    const REJECT_OUTCOME = 'rejected'
    // 谱系向上回溯的最大层数，防脏数据成环。
    const MAX_LINEAGE_HOPS = 32

    function asMap(value) {
      if (value instanceof Map) return value
      const m = new Map()
      if (value && typeof value === 'object') { for (const k of Object.keys(value)) m.set(k, value[k]) }
      return m
    }

    function parentOf(row) {
      if (!row || typeof row !== 'object') return null
      let p = row.parentId
      if (p === undefined || p === null) p = row.parentSessionId
      if (p === undefined || p === null) p = row.parentSession
      return (p === undefined || p === null) ? null : String(p)
    }

    function isDescendant(sessionId, byId, ancestorId) {
      let cur = String(sessionId)
      for (let hops = 0; hops < MAX_LINEAGE_HOPS; hops++) {
        const parent = parentOf(byId.get(cur))
        if (parent === null || parent === cur) return false
        if (parent === String(ancestorId)) return true
        cur = parent
      }
      return false
    }

    /**
     * 纯函数：从待批快照里挑出「需要我在主对话里应答」的条目。
     * 当前会话自己的待批**一律排除**（它由原生卡片负责，避免同一请求出现两份 UI）。
     * @param statusById 会话状态表 sessionId -> {pendingInteraction}
     * @param byId 会话列表行 sessionId -> {parentId}
     * @param currentSessionId 当前正在看的会话
     * @returns [{sessionId, pending, descendant}]
     */
    function selectChildPendings(statusById, byId, currentSessionId) {
      const status = asMap(statusById)
      const rows = asMap(byId)
      const me = (currentSessionId === undefined || currentSessionId === null) ? null : String(currentSessionId)
      const out = []
      for (const entry of status.entries()) {
        const sid = String(entry[0])
        const box = entry[1]
        const pending = box && box.pendingInteraction
        if (!pending || pending.kind !== 'approval') continue
        if (pending.answerable === false) continue
        const owner = (pending.sessionId === undefined || pending.sessionId === null) ? sid : String(pending.sessionId)
        out.push({ sessionId: owner, pending: pending, descendant: me !== null && isDescendant(owner, rows, me), own: me !== null && owner === me })
      }
      return out
    }

    /**
     * 纯函数：最终显示什么。宁可多显示几条，也绝不漏掉正在等我的那条审批——所有已知待批
     * 都返回；本会话自己的那条由原生审批卡片负责，只在原生卡片缺席时才由我们补一份
     * （见 filterOwnIfNative）。当前会话身份未知时不显示（无从判断是不是自己的）。
     * @returns {items, lineageKnown}
     */
    function visibleChildPendings(statusById, byId, currentSessionId) {
      const rows = asMap(byId)
      let lineageKnown = false
      for (const row of rows.values()) { if (parentOf(row) !== null) { lineageKnown = true; break } }
      const me = (currentSessionId === undefined || currentSessionId === null) ? null : String(currentSessionId)
      if (me === null) return { items: [], lineageKnown: lineageKnown }
      return { items: selectChildPendings(statusById, byId, me), lineageKnown: lineageKnown }
    }

    /**
     * 纯函数：本会话自己的待批，在原生审批卡片在场时让位给它（避免同一条审批出现两套按钮）；
     * 原生卡片不在场时必须由我们显示，否则这条审批就没有任何可点的地方了。
     */
    function filterOwnIfNative(items, nativePresent) {
      const list = items || []
      if (!nativePresent) return list
      return list.filter(function (it) { return it.own !== true })
    }

    /** 原生审批面板（ApprovalPanel）是否已在页面上——CSS Module 类名以 ApprovalPanel_module 开头。 */
    function hasNativeApprovalPanel() {
      try {
        if (typeof document === 'undefined' || !document.querySelector) return false
        return document.querySelector('[class*="ApprovalPanel_module"]') !== null
      } catch (e) { return false }
    }

    /** 一次点击 → 一次应答。坏掉的 pending 只告警不抛错，绝不影响对话。 */
    function answerPending(pending, outcome) {
      if (!pending || typeof pending.answer !== 'function') return false
      if (pending.answerable === false) return false
      try { pending.answer(outcome); return true }
      catch (e) { warnOnce('应答待批审批失败：' + String((e && e.message) || e)); return false }
    }

    /** 订阅全局待批快照；快照一变就重渲染（getSnapshot 是同步读，无需本地状态镜像）。 */
    function useChildPendings(uiSession, currentSessionId) {
      const [, setTick] = React.useState(0)
      React.useEffect(function () {
        if (!uiSession || !currentSessionId) return
        let alive = true
        const bump = function () { if (alive) setTick(function (n) { return n + 1 }) }
        bump()
        let off = null
        try {
          if (uiSession.sessionStatus && typeof uiSession.sessionStatus.subscribe === 'function') off = uiSession.sessionStatus.subscribe(bump)
        } catch (e) { warnOnce('订阅待批快照失败：' + String((e && e.message) || e)) }
        return function () {
          alive = false
          if (typeof off === 'function') { try { off() } catch (e) { /* 已退订 */ } }
        }
      }, [uiSession, currentSessionId])
      if (!uiSession || !currentSessionId) return { items: [], lineageKnown: false, byId: null }
      let status = null
      let byId = null
      try { status = uiSession.sessionStatus.getSnapshot() } catch (e) { return { items: [], lineageKnown: false, byId: null } }
      try { byId = uiSession.sessions.list.getSnapshot().byId } catch (e) { byId = null }
      const view = visibleChildPendings(status, byId, currentSessionId)
      return { items: view.items, lineageKnown: view.lineageKnown, byId: byId }
    }

    // 单条待批最多展示的原因字符数；超出只截尾，绝不省略成一行（用户要看清「要动什么」）。
    const REASON_LIMIT = 600

    // 宿主 dsh-sandbox 的 approveEscalation 给 displayReason 的是本地化文案对象 {en, zh}
    // （dsh-sandbox/lib/index.js:109-113）。原生 ApprovalPanel 走 ctx.locale.resolveText，
    // 这里没有 locale 服务，所以自己挑语言：优先 reason（就是中文拼好的完整句），对象只兜底。
    function reasonValue(r) {
      if (r === undefined || r === null || r === '') return ''
      if (typeof r === 'string') return r
      if (typeof r !== 'object') return String(r)
      const keys = ['zh', 'zh-CN', 'zh_CN', 'en', 'en-US', 'en_US']
      for (const k of keys) {
        const v = r[k]
        if (typeof v === 'string' && v !== '') return v
      }
      for (const k of Object.keys(r)) {
        const v = r[k]
        if (typeof v === 'string' && v !== '') return v
      }
      return ''
    }

    /** 完整原因（换行原样保留，只在超长时截尾）。 */
    function reasonText(pending, limit) {
      // displayReason 可能是 {en, zh} 对象，直接 String() 会显示成 [object Object]：
      // 优先取 reason（宿主已拼好的中文句），再把对象按语言解开。
      const t = reasonValue(pending && pending.reason) || reasonValue(pending && pending.displayReason)
      const max = limit === undefined ? REASON_LIMIT : limit
      return t.length > max ? t.slice(0, max) + '\u2026' : t
    }

    /**
     * 从 chat 快照里按 callId 找那条 tool-call 的命令文本（与原生 ApprovalCommand 同源：
     * ui-chat 182-189 遍历 snapshot.nodes.values()，匹配 callId + phase==='start' 后取
     * JSON.parse(argsRaw).args.command）。纯函数，拿不到就返回 null。
     */
    function commandFromChatSnapshot(snapshot, callId) {
      try {
        if (!snapshot || !snapshot.nodes || typeof snapshot.nodes.values !== 'function') return null
        const want = String(callId)
        for (const node of snapshot.nodes.values()) {
          if (!node || node.kind !== 'tool-call' || !node.data) continue
          const root = node.data.root
          if (root === undefined || root === null) continue
          if (String(root.callId) !== want) continue
          if (root.phase !== 'start') continue
          if (root.argsRaw === undefined || root.argsRaw === null) continue
          const parsed = JSON.parse(root.argsRaw)
          const cmd = parsed && parsed.args ? parsed.args.command : undefined
          if (typeof cmd === 'string' && cmd !== '') return cmd
        }
      } catch (e) { return null }
      return null
    }

    /** 来源会话的可读名字：列表行的 displayTitle（标题 / 子代理标签 / 会话 id 三级回退）。 */
    function titleOf(byId, sessionId) {
      const rows = asMap(byId)
      const row = rows.get(String(sessionId))
      if (row && typeof row === 'object') {
        for (const f of ['displayTitle', 'title', 'label']) {
          const v = row[f]
          if (typeof v === 'string' && v !== '') return v
        }
      }
      return null
    }

    /** 等待时长：秒级够用，超过 1 分钟给「x 分 y 秒」。 */
    function formatWait(ms) {
      const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
      if (sec < 60) return '已等待 ' + sec + ' 秒'
      const m = Math.floor(sec / 60)
      const r = sec % 60
      return '已等待 ' + m + ' 分 ' + (r < 10 ? '0' + r : r) + ' 秒'
    }

    /** 点过按钮之后那一行显示什么。 */
    function resultLabel(outcome) {
      return outcome === REJECT_OUTCOME ? '已拒绝' : '已允许一次'
    }

    // 服务引用可以是「值」，也可以是「每次调用都重新取一次的函数」。
    function resolveProp(value) {
      if (typeof value !== 'function') return value
      try { return value() } catch (e) { return undefined }
    }

    // ---------- 宿主设置通道：客户端 ui-settings 的 configForms 服务 ----------
    //
    // 读值 form.getSnapshot()（该命名空间的 volatile 投影），写值 form.set(field,value) /
    // form.unset(field)（内部走 remote.settings.mutate）。宿主 @deepseek-ai/dsh-settings 只暴露
    // schema 里标了 .volatile() 的字段，所以宿主 Config 的 diagnostics 必须带 .volatile()。
    //
    // **用 ctx.get 而不是写进 inject**：cordis 的 inject 是硬依赖，服务缺席时这条客户端 entry
    // 会永远 pending，而 web 引导把 pending entry 当启动失败整条抛出
    // （packages/client/web/README.md:66）——本插件宿主半区已因同一理由把 agentTeams 排除在
    // inject 之外（lib/index.js:281-295），本文件对 slots / uiSession 也是这么做的。
    // 设置页命名空间 = configEditor 条目 id；两种历史写法都试一遍，取真的被服务（ready）的那个。
    const DIAGNOSTICS_NAMESPACES = ['byk-agents', 'include:byk-agents']

    /** 命名空间的读写句柄；服务/命名空间不可用时返回 undefined（静默降级，绝不抛）。 */
    function formFor(forms, namespace) {
      if (!forms || typeof forms.get !== 'function') return undefined
      try {
        const form = forms.get(namespace)
        return form === undefined || form === null ? undefined : form
      } catch (e) {
        return undefined
      }
    }

    /** 读一次快照；拿不到返回 undefined（绝不抛）。 */
    function formSnapshot(form) {
      if (!form || typeof form.getSnapshot !== 'function') return undefined
      try { return form.getSnapshot() } catch (e) { return undefined }
    }

    /** 诊断开关是否打开：读不到设置一律当作关。 */
    function diagnosticsOn(snap) {
      return !!(snap && snap.value && snap.value.diagnostics === true)
    }

    /** 挑一个真的被宿主服务的命名空间；都不 ready 时退回第一个能拿到的（组件据此显示「不可用」）。 */
    function pickDiagnosticsTarget(forms) {
      let fallback = null
      for (let i = 0; i < DIAGNOSTICS_NAMESPACES.length; i++) {
        const namespace = DIAGNOSTICS_NAMESPACES[i]
        const form = formFor(forms, namespace)
        if (form === undefined) continue
        const snap = formSnapshot(form)
        if (snap && snap.status === 'ready') return { namespace: namespace, form: form }
        if (fallback === null) fallback = { namespace: namespace, form: form }
      }
      return fallback
    }

    /** 订阅 configForm 快照（form 缺席时什么都不订阅）。 */
    function useFormSnapshot(form) {
      const [snap, setSnap] = React.useState(function () { return formSnapshot(form) })
      React.useEffect(function () {
        setSnap(formSnapshot(form))
        if (!form || typeof form.subscribe !== 'function') return undefined
        let off
        try { off = form.subscribe(function () { setSnap(formSnapshot(form)) }) } catch (e) { off = undefined }
        return function () {
          if (!off) return
          try { off() } catch (e) { /* 卸载期订阅已失效，忽略 */ }
        }
      }, [form])
      return snap
    }

    // ---------- 设置页数据通道（HTTP）：宿主 lib/settings-channel.js 的另一半 ----------
    //
    // 为什么不用 configForms：它只代理宿主 Config 里标了 .volatile() 的标量字段，
    // 读不出助手列表、也写不了 assistants.local.json。宿主半区用 WebServer 注册了
    // /api/byk/assistants（见 lib/index.js 的「设置页数据通道」一段），这里用**同源**
    // fetch 调用 —— DSH web 的设置页本来就由同一个 webServer 提供。
    //
    // 通道不可用时（桌面端 file:// 或未注册）一律**结构化失败**：返回 {ok:false,error}，
    // 设置页显示一行说明，绝不假装开关有效、也不把异常抛进渲染层。
    const CHANNEL_PATH = '/api/byk/assistants'

    /** 请求体构造（纯函数，测试直接断言形状）。 */
    function channelBody(action, roleId, enabled) {
      const body = { action: String(action) }
      if (body.action === 'set-enabled') {
        body.roleId = String(roleId === undefined || roleId === null ? '' : roleId)
        body.enabled = enabled === true
      }
      return body
    }

    /** 归一化宿主响应（非 JSON / ok:false 都收敛成 {ok:false,error}）。 */
    function normalizeChannelResponse(json) {
      if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        return { ok: false, error: '宿主返回的不是 JSON 对象', assistants: [] }
      }
      if (json.ok !== true) {
        return { ok: false, error: String(json.error || '宿主拒绝了这次请求'), assistants: [] }
      }
      return {
        ok: true,
        error: '',
        assistants: Array.isArray(json.assistants) ? json.assistants : [],
        overlayPath: String(json.overlayPath || '')
      }
    }

    /** 一次通道调用；fetch 缺席 / 网络错误 / 非 2xx 都返回结构化失败，绝不抛。 */
    /** 发一个请求体到数据通道；fetch 缺席 / 网络错误 / 非 2xx 都返回结构化失败，绝不抛。 */
    function channelPost(body) {
      const f = typeof globalThis.fetch === 'function' ? globalThis.fetch : null
      if (f === null) {
        return Promise.resolve({ ok: false, error: '这个界面没有 fetch，数据通道不可用', assistants: [] })
      }
      let sent
      try {
        sent = f(CHANNEL_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      } catch (e) {
        return Promise.resolve({ ok: false, error: '数据通道请求失败：' + String((e && e.message) || e), assistants: [] })
      }
      return Promise.resolve(sent).then(function (res) {
        return Promise.resolve(res && typeof res.json === 'function' ? res.json() : null).then(
          function (json) {
            const norm = normalizeChannelResponse(json)
            const status = res && typeof res.status === 'number' ? res.status : 0
            if (!norm.ok && status && status !== 200) norm.error = 'HTTP ' + status + '：' + norm.error
            return norm
          },
          function (e) {
            return { ok: false, error: '数据通道响应读不出来：' + String((e && e.message) || e), assistants: [] }
          }
        )
      }, function (e) {
        return { ok: false, error: '数据通道请求失败：' + String((e && e.message) || e), assistants: [] }
      })
    }

    /** 老入口（list / set-enabled）保持原签名：先拼 body，再走同一条 channelPost。 */
    function channelCall(action, roleId, enabled) {
      return channelPost(channelBody(action, roleId, enabled))
    }

    /** 一行助手的显示模型（纯函数）：id / 名称 / 开关 / 当前模型或后端。 */
    function assistantRowView(row) {
      const r = row && typeof row === 'object' ? row : {}
      return {
        id: String(r.id || ''),
        name: String(r.name || r.id || ''),
        enabled: r.enabled === true,
        model: String(r.routeText || ''),
        routeSummary: String(r.routeSummary || ''),
        originText: String(r.originText || ''),
        unavailable: String(r.unavailable || '')
      }
    }

    // ---------- s5：助手增删改查的纯函数（设置页两个入口共用同一份） ----------
    //
    // 角色 id 规范与宿主 lib/assistants.js:37 的 ROLE_ID_RE 逐字一致。浏览器 bundle 拿不到
    // 宿主模块，只能复制一份 —— **改校验规则必须两处一起改**。
    const ROLE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
    /** backend 取值域，与宿主 lib/routing.js:40 的 BACKENDS 逐字一致。 */
    const BACKEND_OPTIONS = ['llm', 'asr', 'local', 'local-extract']
    /** 表单里可编辑的自由文本字段（backend 走下拉，开关走 set-enabled，都不在其中）。 */
    const EDITABLE_FIELDS = ['name', 'description', 'backend', 'provider', 'model', 'reasoningEffort']

    /** 内置角色（含被覆盖层改过的内置角色）不可删除，只能停用。origin 来自宿主 explainPath 的 source。 */
    function isBuiltinOrigin(origin) {
      const s = origin === undefined || origin === null ? '' : String(origin)
      return s.indexOf('builtin') === 0
    }

    /** 修剪字符串字段、丢掉空串（空串 = 「这一项不改」，因为宿主 update-role 是浅合并）。 */
    function cleanFields(fields) {
      const out = {}
      const src = fields && typeof fields === 'object' ? fields : {}
      for (const key of Object.keys(src)) {
        const v = src[key]
        if (v === undefined || v === null) continue
        if (typeof v === 'string') {
          const t = v.trim()
          if (t !== '') out[key] = t
        } else if (typeof v === 'boolean' || typeof v === 'number') {
          out[key] = v
        }
      }
      return out
    }

    /** 发请求之前的本地校验：非法 id / 重复 id / 空名称都在这里拦下，不指望宿主兜底。 */
    function validateDraft(input) {
      const it = input && typeof input === 'object' ? input : {}
      const mode = String(it.mode || 'add')
      const id = String(it.id === undefined || it.id === null ? '' : it.id).trim()
      const ids = Array.isArray(it.ids) ? it.ids.map(String) : []
      if (mode === 'add') {
        if (id === '') return { ok: false, error: '请先填助手 id' }
        if (!ROLE_ID_RE.test(id)) {
          return { ok: false, error: '助手 id 不合法：要以小写字母开头，只含小写字母/数字/下划线/连字符，最长 32 个字符（当前：' + id + '）' }
        }
        if (ids.indexOf(id) >= 0) return { ok: false, error: '已经有助手在用这个 id 了：' + id }
      } else if (id === '') {
        return { ok: false, error: '没给要改的助手 id' }
      }
      if (String(it.name === undefined || it.name === null ? '' : it.name).trim() === '') {
        return { ok: false, error: '名称不能为空' }
      }
      const fields = cleanFields(it.fields)
      if (Object.keys(fields).length === 0) return { ok: false, error: '没有要提交的改动' }
      return { ok: true, error: '', id: id, fields: fields }
    }

    /** 编辑表单的初值（纯函数）：从宿主给的行里取出可编辑字段。 */
    function assistantEditView(row) {
      const r = row && typeof row === 'object' ? row : {}
      const route = r.route && typeof r.route === 'object' ? r.route : {}
      return {
        id: String(r.id || ''),
        name: String(r.name || r.id || ''),
        description: String(r.description || ''),
        backend: String(route.backend || ''),
        provider: String(route.provider || ''),
        model: String(route.model || ''),
        reasoningEffort: String(route.reasoningEffort || r.reasoningEffort || '')
      }
    }

    /** CRUD 的请求体（纯函数，形状与宿主契约一致，测试直接断言）。 */
    function crudBody(action, roleId, fields) {
      const act = String(action)
      const body = { action: act }
      if (act === 'add-role' || act === 'update-role' || act === 'remove-role') {
        body.roleId = String(roleId === undefined || roleId === null ? '' : roleId)
      }
      if (act === 'add-role' || act === 'update-role') body.fields = cleanFields(fields)
      return body
    }
    // 诊断行（order=24）：**默认不显示**。只有设置页「显示诊断条」打开（宿主 volatile 字段
    // diagnostics=true）时才渲染；服务/命名空间读不到时一律当作关（理由见上面 configForms 一段）。
    function StripDiagnostics(props) {
      const frame = useFrame(props)
      const uiSession = resolveProp(props.uiSession)
      const target = resolveProp(props.diagnosticsTarget)
      const diagSnap = useFormSnapshot(target ? target.form : undefined)
      const [, setDiagTick] = React.useState(0)
      React.useEffect(function () {
        const t = setInterval(function () { setDiagTick(function (n) { return n + 1 }) }, 2000)
        return function () { clearInterval(t) }
      }, [])
      if (!diagnosticsOn(diagSnap)) return null
      let snapSize = '未读'
      const pend = []
      try {
        const snap = uiSession.sessionStatus.getSnapshot()
        snapSize = String(snap.size)
        snap.forEach(function (box, sid) {
          if (box && box.pendingInteraction) {
            pend.push(shortId(String(sid)) + ':' + String((box.pendingInteraction && box.pendingInteraction.kind) || '?'))
          }
        })
      } catch (e) {
        snapSize = '取不到(' + String((e && e.message) || e).slice(0, 40) + ')'
      }
      return React.createElement('div', { className: 'byk-diag' },
        '[byk 诊断] uiSession=' + (uiSession ? '有' : '无') +
        ' · 本会话=' + (frame && frame.sessionId ? shortId(frame.sessionId) : '未知') +
        ' · 快照会话数=' + snapSize +
        ' · 带待批=' + (pend.length ? pend.join(' ') : '0'))
    }

    // ============ 设置页「BYK 助手」：settings.section ============
    //
    // 本插件第一个设置面：目前只有一行「显示诊断条」，后续七个助手的开关都长在这一页里。
    // 用整页（settings.section）而不是 General 里的一行（settings.general.item），因为后面会有
    // 多个设置项；槽位契约见 packages/client/ui-settings/src/client/contract/slots.ts:57 / :92。
    function BykSettingsSection(props) {
      const target = resolveProp(props.diagnosticsTarget)
      const namespace = target ? target.namespace : DIAGNOSTICS_NAMESPACES[0]
      const form = target ? target.form : undefined
      const missing = form === undefined || form === null
      // 服务/命名空间可能晚于设置页就绪（ui-settings 与本文件其它服务一样是惰性的）：
      // 只在缺席时每秒重渲染一次，拿到即停；不抛异常、不做 IO。
      const [, setTick] = React.useState(0)
      React.useEffect(function () {
        if (!missing) return undefined
        const t = setInterval(function () { setTick(function (n) { return n + 1 }) }, 1000)
        return function () { clearInterval(t) }
      }, [missing])
      const snap = useFormSnapshot(form)
      const [busy, setBusy] = React.useState(false)
      const status = snap && snap.status ? String(snap.status) : 'unavailable'
      const value = snap && snap.value && typeof snap.value === 'object' ? snap.value : {}
      const on = value.diagnostics === true
      const writable = !!(snap && snap.writable)
      // 打开 = set('diagnostics', true)；关闭 = unset，回到组合层默认值（Config 里 default(false)）。
      const toggle = function () {
        if (missing || busy) return
        setBusy(true)
        const settle = function (ok) {
          setBusy(false)
          if (ok === false) warnOnce('设置写入被宿主拒绝：' + namespace + '.diagnostics')
        }
        const fail = function (err) {
          setBusy(false)
          warnOnce('设置写入失败：' + String((err && err.message) || err))
        }
        try {
          const p = on ? form.unset('diagnostics') : form.set('diagnostics', true)
          if (p && typeof p.then === 'function') p.then(settle, fail)
          else settle(true)
        } catch (e) {
          fail(e)
        }
      }
      // ---- 助手列表：走宿主 HTTP 数据通道（同源 fetch），不走 configForms ----
      const [assistants, setAssistants] = React.useState(null)
      const [channelError, setChannelError] = React.useState('')
      const [channelBusy, setChannelBusy] = React.useState('')
      const reloadAssistants = function () {
        setChannelBusy('list')
        return channelCall('list').then(function (r) {
          setChannelBusy('')
          if (r.ok) { setAssistants(r.assistants); setChannelError('') }
          else { setAssistants(null); setChannelError(r.error) }
          return r
        })
      }
      // 首次挂载拉一次；组件卸载后不再 setState。
      React.useEffect(function () {
        let alive = true
        channelCall('list').then(function (r) {
          if (!alive) return
          if (r.ok) { setAssistants(r.assistants); setChannelError('') }
          else { setAssistants(null); setChannelError(r.error) }
        })
        return function () { alive = false }
      }, [])
      // 唯一的真实写回动作：切换某助手的启用状态。成功后**重新拉列表**，以宿主为准。
      const toggleAssistant = function (view) {
        if (channelBusy) return
        setChannelBusy(view.id)
        channelCall('set-enabled', view.id, !view.enabled).then(function (r) {
          if (!r.ok) { setChannelBusy(''); setChannelError(r.error); return }
          setChannelError('')
          return reloadAssistants()
        })
      }

      // ---- s5：助手增删改查的表单状态与提交（两个入口共用同一个组件，所以只写一份） ----
      // form: null | { mode: 'edit' | 'add', id, fields: { name, description, backend, provider, model, reasoningEffort } }
      const [draft, setDraft] = React.useState(null)
      const [formError, setFormError] = React.useState('')
      const [confirming, setConfirming] = React.useState('')
      const patchField = function (key, value) {
        setFormError('')
        setDraft(function (prev) {
          if (!prev) return prev
          if (key === '__id') return { mode: prev.mode, id: value, fields: prev.fields }
          const fields = {}
          for (const k of Object.keys(prev.fields)) fields[k] = prev.fields[k]
          fields[key] = value
          return { mode: prev.mode, id: prev.id, fields: fields }
        })
      }
      const openEdit = function (raw) {
        const e = assistantEditView(raw)
        setFormError('')
        setConfirming('')
        setDraft({
          mode: 'edit',
          id: e.id,
          fields: {
            name: e.name,
            description: e.description,
            backend: e.backend,
            provider: e.provider,
            model: e.model,
            reasoningEffort: e.reasoningEffort
          }
        })
      }
      const openAdd = function () {
        setFormError('')
        setConfirming('')
        setDraft({ mode: 'add', id: '', fields: { name: '', description: '', backend: BACKEND_OPTIONS[0], provider: '', model: '', reasoningEffort: '' } })
      }
      const closeForm = function () { setFormError(''); setDraft(null) }
      const submitForm = function () {
        if (!draft || channelBusy !== '') return
        const isAdd = draft.mode === 'add'
        const ids = (assistants || []).map(function (r) { return String(assistantRowView(r).id) })
        const check = validateDraft({ mode: isAdd ? 'add' : 'edit', id: draft.id, ids: ids, name: draft.fields.name, fields: draft.fields })
        if (!check.ok) { setFormError(check.error); return }
        setFormError('')
        setChannelBusy(isAdd ? 'add' : draft.id)
        channelPost(crudBody(isAdd ? 'add-role' : 'update-role', check.id, check.fields)).then(function (r) {
          setChannelBusy('')
          if (!r.ok) { setFormError(r.error); return }
          setDraft(null)
          setChannelError('')
          return reloadAssistants()
        })
      }
      // 删除：内置角色按钮上就禁用，这里再拦一道（双保险），宿主还会再挡第三次。
      const removeRow = function (raw) {
        if (channelBusy !== '') return
        const v = assistantRowView(raw)
        if (isBuiltinOrigin(raw && raw.origin)) {
          setFormError('内置角色不可删除，只能停用：' + v.id)
          setConfirming('')
          return
        }
        setFormError('')
        setChannelBusy(v.id)
        channelPost(crudBody('remove-role', v.id)).then(function (r) {
          setChannelBusy('')
          if (!r.ok) { setFormError(r.error); return }
          setConfirming('')
          setChannelError('')
          return reloadAssistants()
        })
      }
      /** 编辑 / 新增共用的小表单。 */
      const renderEditor = function () {
        if (!draft) return null
        const isAdd = draft.mode === 'add'
        const field = function (key, label, opts) {
          const o = opts || {}
          const value = key === '__id' ? draft.id : (draft.fields[key] || '')
          const onInput = function (e) { patchField(key, e && e.target ? String(e.target.value) : '') }
          if (Array.isArray(o.options)) {
            return React.createElement('div', { className: 'byk-set-field', key: key },
              React.createElement('div', { className: 'byk-set-sub' }, label),
              React.createElement('select', { className: 'byk-set-input', value: value, onChange: onInput },
                o.options.map(function (v) {
                  return React.createElement('option', { value: v, key: v }, v === '' ? '（不修改）' : v)
                })))
          }
          return React.createElement('div', { className: 'byk-set-field', key: key },
            React.createElement('div', { className: 'byk-set-sub' }, label),
            React.createElement('input', {
              className: 'byk-set-input',
              type: 'text',
              value: value,
              placeholder: o.placeholder || '',
              onChange: onInput
            }))
        }
        const fields = []
        if (isAdd) {
          fields.push(field('__id', '助手 id', { placeholder: '小写字母开头，只含小写字母/数字/下划线/连字符，最长 32 个字符' }))
        }
        fields.push(field('name', '名称', { placeholder: isAdd ? '必填' : '留空 = 不修改' }))
        fields.push(field('description', '描述', { placeholder: isAdd ? '必填' : '留空 = 不修改' }))
        fields.push(field('backend', '后端 backend', { options: [''].concat(BACKEND_OPTIONS) }))
        fields.push(field('provider', 'provider', { placeholder: '留空 = 不修改' }))
        fields.push(field('model', 'model', { placeholder: '留空 = 不修改' }))
        fields.push(field('reasoningEffort', '推理强度 reasoningEffort', { placeholder: '留空 = 不修改' }))
        return React.createElement('div', { className: 'byk-set-row byk-set-form' },
          React.createElement('div', { className: 'byk-set-body' }, fields),
          React.createElement('button', {
            type: 'button',
            className: 'byk-set-btn byk-set-btn-primary',
            disabled: channelBusy !== '',
            onClick: submitForm
          }, isAdd ? '新增助手' : '保存'),
          React.createElement('button', {
            type: 'button',
            className: 'byk-set-btn',
            disabled: channelBusy !== '',
            onClick: closeForm
          }, '取消'))
      }
      // 新增表单挂在列表下方；编辑表单挂在被编辑的那一行下面（两者不会同时存在）。
      const addEditor = draft && draft.mode === 'add' ? renderEditor() : null
      const addButton = React.createElement('button', {
        type: 'button',
        className: 'byk-set-btn byk-set-btn-primary',
        disabled: channelBusy !== '' || !!draft,
        onClick: openAdd
      }, '新增助手')
      const errorLine = formError
        ? React.createElement('div', { className: 'byk-set-note byk-set-error' }, formError)
        : null

      const head = React.createElement('div', { className: 'byk-set-head' },
        React.createElement('div', { className: 'byk-set-h1' }, 'BYK 助手'),
        React.createElement('div', { className: 'byk-set-h2' }, 'BYK 专业助手（byk_role / byk_plan / byk_batch / byk_hire / byk_judge / byk_mood）的开关与偏好，直接写进宿主配置。'))
      const row = React.createElement('div', { className: 'byk-set-row' },
        React.createElement('div', { className: 'byk-set-body' },
          React.createElement('div', { className: 'byk-set-title' }, '显示诊断条'),
          React.createElement('div', { className: 'byk-set-sub' }, '在输入框上方显示 [byk 诊断] 行（uiSession 状态 / 快照会话数 / 待批数量）。对应宿主配置 diagnostics。')),
        React.createElement('button', {
          type: 'button',
          className: on ? 'byk-set-switch byk-set-switch-on' : 'byk-set-switch',
          disabled: !writable || busy,
          'aria-pressed': on ? 'true' : 'false',
          onClick: toggle
        }, on ? '开' : '关'))
      const note = status === 'ready'
        ? null
        : React.createElement('div', { className: 'byk-set-note' },
            '设置不可用：宿主没有暴露 ' + namespace + '.diagnostics（status=' + status + '）。' +
            '设置页只显示宿主 schema 里标了 .volatile() 的字段——改完插件需要重启 DSH，宿主半区才会带上该字段。')
      let assistantList
      if (channelError) {
        assistantList = React.createElement('div', { className: 'byk-set-note' },
          '数据通道不可用：' + channelError +
          '（宿主半区要在带 webServer 的 profile 里注册 ' + CHANNEL_PATH +
          '；这一项不可用时，上面的宿主设置开关仍然有效）')
      } else if (assistants === null) {
        assistantList = React.createElement('div', { className: 'byk-set-note' }, '正在读取助手列表…')
      } else if (assistants.length === 0) {
        assistantList = React.createElement('div', null,
          React.createElement('div', { className: 'byk-set-note' },
            '宿主返回了空列表：角色注册表（python -m byk.cli roles --json）可能没读出来。'),
          errorLine, addButton, addEditor)
      } else {
        const listRows = assistants.map(function (raw) {
          const v = assistantRowView(raw)
          const route = v.model || (v.unavailable ? '路由未知：' + v.unavailable : '路由未知')
          const builtin = isBuiltinOrigin(raw && raw.origin)
          const rowBusy = channelBusy !== ''
          const editing = !!draft && draft.mode === 'edit' && draft.id === v.id
          const item = []
          item.push(React.createElement('div', { className: 'byk-set-row', key: v.id + '.row' },
            React.createElement('div', { className: 'byk-set-body' },
              React.createElement('div', { className: 'byk-set-title' }, v.name + '（' + v.id + '）'),
              React.createElement('div', { className: 'byk-set-sub' }, (v.enabled ? '已启用' : '已停用') + ' · ' + route),
              v.routeSummary ? React.createElement('div', { className: 'byk-set-sub' }, v.routeSummary) : null,
              v.originText ? React.createElement('div', { className: 'byk-set-sub' }, v.originText) : null,
              builtin ? React.createElement('div', { className: 'byk-set-sub' }, '内置角色：可以改名 / 停用 / 换模型，不能删除。') : null),
            React.createElement('button', {
              type: 'button',
              className: v.enabled ? 'byk-set-switch byk-set-switch-on' : 'byk-set-switch',
              disabled: rowBusy,
              'aria-pressed': v.enabled ? 'true' : 'false',
              onClick: function () { toggleAssistant(v) }
            }, v.enabled ? '开' : '关'),
            React.createElement('button', {
              type: 'button',
              className: 'byk-set-btn',
              disabled: rowBusy,
              onClick: function () { openEdit(raw) }
            }, '编辑'),
            React.createElement('button', {
              type: 'button',
              className: 'byk-set-btn',
              disabled: builtin || rowBusy,
              title: builtin ? '内置角色不可删除，只能停用' : '',
              onClick: function () { setConfirming(v.id) }
            }, builtin ? '删除（内置不可删）' : '删除')))
          if (confirming === v.id) {
            item.push(React.createElement('div', { className: 'byk-set-row', key: v.id + '.confirm' },
              React.createElement('div', { className: 'byk-set-body' },
                React.createElement('div', { className: 'byk-set-sub' }, '删除助手 ' + v.id + '？这一步会写进 assistants.local.json。')),
              React.createElement('button', {
                type: 'button',
                className: 'byk-set-btn byk-set-btn-danger',
                disabled: rowBusy,
                onClick: function () { removeRow(raw) }
              }, '确认删除'),
              React.createElement('button', {
                type: 'button',
                className: 'byk-set-btn',
                disabled: rowBusy,
                onClick: function () { setConfirming('') }
              }, '取消')))
          }
          if (editing) item.push(renderEditor())
          return React.createElement('div', { className: 'byk-set-item', key: v.id }, item)
        })
        assistantList = React.createElement('div', null,
          React.createElement('div', { className: 'byk-set-title' }, '助手（' + assistants.length + '）'),
          errorLine, listRows, addButton, addEditor)
      }
      return React.createElement('div', { className: 'byk-settings' }, head, row, note, assistantList)
    }

    // ============ 子智能体待批审批条：conversation.input.dock（order=25） ============
    function ChildApprovalStrip(props) {
      // dock 槽渲染器给的 standard props（含 useChat / useSession / sessionId 等 hook）。
      const slotsProps = props && props.slotsProps ? props.slotsProps : {}
      // 审批前就能看到要跑什么命令：dock 槽是 session scope，standard props 里带当前会话
      // binding 的 chat hook（ui-chat per-binding 注册，经 standardProps 合成进来）。hooks 必须
      // 在任何 return 之前调用，所以这里一次取到快照，下面按各行自己的 callId 解析（纯函数）。
      const useChatHook = slotsProps.useChat
      let chatSnap = null
      if (typeof useChatHook === 'function') {
        try { chatSnap = useChatHook(function (s) { return s }) } catch (e) { chatSnap = null }
      }
      const frame = useFrame(props)
      const uiSession = resolveProp(props.uiSession)
      const svcMissing = uiSession === undefined || uiSession === null
      // 服务还没就绪时每秒重试一次（只是重渲染，不做任何 IO），拿到即停。
      const [, setSvcTick] = React.useState(0)
      React.useEffect(function () {
        if (!svcMissing) return undefined
        const t = setInterval(function () { setSvcTick(function (n) { return n + 1 }) }, 1000)
        return function () { clearInterval(t) }
      }, [svcMissing])
      const view = useChildPendings(uiSession, frame.sessionId)
      const items = filterOwnIfNative(view.items, hasNativeApprovalPanel())
      const [answered, setAnswered] = React.useState({})
      // 首次看到某条待批的时刻，用来算「已等待 xx 秒」（只在有内容时每秒刷新）。
      const seenRef = React.useRef({})
      const active = items.length > 0
      const [, setTick] = React.useState(0)
      React.useEffect(function () {
        if (!active) return
        const t = setInterval(function () { setTick(function (n) { return n + 1 }) }, 1000)
        return function () { clearInterval(t) }
      }, [active])
      if (!frame.sessionId || !active) return null
      const nowMs = Date.now()
      const markAnswered = function (key, outcome) {
        setAnswered(function (prev) { const next = Object.assign({}, prev); next[key] = outcome; return next })
      }
      const rows = items.map(function (it) {
        const p = it.pending
        const key = String(p.key || it.sessionId)
        const done = answered[key] !== undefined
        const first = seenRef.current[key]
        if (first === undefined) seenRef.current[key] = nowMs
        const waited = formatWait(nowMs - (first === undefined ? nowMs : first))
        const title = titleOf(view.byId, it.sessionId)
        const origin = (it.own ? '本会话' : (it.descendant ? '子会话' : '其它会话')) + ' · ' + (title || shortId(it.sessionId))
        const reason = reasonText(p) || '（提问方未给出原因）'
        // 用上面取到的 chat 快照解析本条自己的 callId（与原生 ApprovalCommand 同源：
        // 找 phase==='start' 的 tool-call 取 args.command）。拿不到就只少一行。
        const command = commandFromChatSnapshot(chatSnap, p.callId)
        return React.createElement('div', { className: 'byk-child-row', key: key },
          React.createElement('div', { className: 'byk-child-body' },
            React.createElement('div', { className: 'byk-child-head' },
              React.createElement('span', { className: 'byk-child-tool' }, '工具 ' + String(p.toolName || 'unknown')),
              React.createElement('span', { className: 'byk-tag byk-tag-src' }, origin),
              React.createElement('span', { className: 'byk-child-wait' }, done ? resultLabel(answered[key]) : waited)
            ),
            React.createElement('div', { className: 'byk-child-reason' },
              React.createElement('span', { className: 'byk-child-reason-label' }, '要做什么'),
              React.createElement('span', { className: 'byk-child-text' }, reason)
            ),
            command ? React.createElement('div', { className: 'byk-child-cmd' }, command) : null,
          ),
          React.createElement('div', { className: 'byk-child-actions' },
            React.createElement('button', {
              type: 'button',
              className: 'byk-child-btn byk-child-btn-reject',
              disabled: done,
              onClick: function () { if (answerPending(p, REJECT_OUTCOME)) markAnswered(key, REJECT_OUTCOME) }
            }, '拒绝'),
            React.createElement('button', {
              type: 'button',
              className: 'byk-child-btn byk-child-btn-allow',
              disabled: done,
              onClick: function () { if (answerPending(p, APPROVE_OUTCOME)) markAnswered(key, APPROVE_OUTCOME) }
            }, '允许一次')
          )
        )
      })
      const tools = []
      for (const it of items) { const n = String((it.pending && it.pending.toolName) || 'unknown'); if (tools.indexOf(n) < 0) tools.push(n) }
      return React.createElement('div', { className: 'byk-child' },
        React.createElement('div', { className: 'byk-child-card' },
          React.createElement('div', { className: 'byk-child-title' }, '子智能体待批审批 · ' + items.length + ' 条 · ' + tools.join('/')),
          rows
        )
      )
    }


    const KIND_TAGS = {
      'manual-pending': '等待人工审批',
      'manual-approved': '人工审批通过',
      'manual-rejected': '已拒绝',
      auto: '自动放行'
    }
    const VERDICT_LABELS = {
      rule: '白名单规则',
      'flash-safe': 'Flash 判定安全',
      learned: '沉淀规则',
      fpHit: '已确认操作',
      'flash-same': 'Flash 同类验证'
    }

    const CSS = [
      '.byk-mirror{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;flex:none}',
      '.byk-mirror-card{box-sizing:border-box;display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:6px 10px 6px 12px;box-shadow:var(--dsw-shadow-lv1)}',
      '.byk-mirror-card-pending{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}',
      '.byk-mirror-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.byk-mirror-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.byk-mirror-tool{flex:none;color:var(--dsw-alias-label-primary);font:500 12px/18px var(--ds-font-family-code)}',
      '.byk-mirror-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.byk-mirror-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.byk-tag{box-sizing:border-box;flex:none;height:18px;border-radius:9px;align-items:center;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}',
      '.byk-tag-src{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}',
      '.byk-tag-warn{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}',
      '.byk-tag-err{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.byk-time{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}',
      '.byk-mirror-note{color:var(--dsw-alias-state-warn-label);font-size:11px;line-height:16px}',
      '.byk-mirror-close{width:24px;height:24px;flex:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;padding:0}',
      '.byk-mirror-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.byk-view{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1)}',
      '.byk-view-head{box-sizing:border-box;flex:none;border-bottom:1px solid var(--dsw-alias-border-l2);padding:10px 14px 8px;display:flex;flex-direction:column;gap:2px}',
      '.byk-view-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}',
      '.byk-view-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.byk-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px 14px 48px;display:flex;flex-direction:column;gap:2px}',
      '.byk-row{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;padding:9px 10px;border-radius:10px}',
      '.byk-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.byk-row-top{display:flex;align-items:center;gap:8px;min-width:0}',
      '.byk-row-tool{flex:none;color:var(--dsw-alias-label-primary);font:500 12px/18px var(--ds-font-family-code)}',
      '.byk-row-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-all;white-space:pre-wrap}',
      '.byk-files{display:flex;flex-wrap:wrap;gap:4px}',
      '.byk-file{box-sizing:border-box;max-width:260px;height:20px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;align-items:center;padding:0 7px;font:11px/18px var(--ds-font-family-code);display:inline-flex;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.byk-empty{flex:1 1 auto;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;font-size:13px;line-height:20px;padding:24px;text-align:center}',
      '.byk-diag{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width, 100%) - var(--dsh-composer-dock-inset, 0px));margin:0 auto;color:var(--dsw-alias-label-tertiary);font:11px/16px var(--ds-font-family-code);white-space:pre-wrap;word-break:break-all}',
      '.byk-child{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;flex:none}',
      '.byk-child-card{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary);border-radius:12px;padding:8px 10px;box-shadow:var(--dsw-shadow-lv1)}',
      '.byk-child-title{color:var(--dsw-alias-state-warn-label);font-size:12px;font-weight:500;line-height:18px}',
      '.byk-child-row{display:flex;align-items:center;gap:10px;min-width:0}',
      '.byk-child-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.byk-child-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.byk-child-tool{flex:none;color:var(--dsw-alias-label-primary);font:500 12px/18px var(--ds-font-family-code)}',
      '.byk-child-text{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all}',
      '.byk-child-cmd{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-family:var(--dsh-font-mono, monospace);white-space:pre-wrap;word-break:break-all;max-height:54px;overflow-y:auto}',
      '.byk-child-actions{flex:none;display:flex;align-items:center;gap:6px}',
      '.byk-child-wait{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}',
      '.byk-child-reason{display:flex;gap:6px;min-width:0;max-height:78px;overflow-y:auto}',
      '.byk-child-reason-label{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.byk-child-btn{box-sizing:border-box;height:24px;border-radius:999px;padding:0 10px;font-size:12px;line-height:22px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.byk-child-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.byk-child-btn:disabled{opacity:.5;cursor:default}',
      '.byk-child-btn-allow{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.byk-child-btn-reject{color:var(--dsw-alias-label-secondary)}',
      '.byk-settings{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:4px 0}',
      '.byk-set-head{display:flex;flex-direction:column;gap:2px}',
      '.byk-set-h1{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}',
      '.byk-set-h2{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.byk-set-row{box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.byk-set-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.byk-set-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.byk-set-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.byk-set-switch{box-sizing:border-box;flex:none;min-width:52px;height:26px;border-radius:999px;padding:0 12px;font-size:12px;line-height:24px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}',
      '.byk-set-switch-on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.byk-set-switch:disabled{opacity:.5;cursor:default}',
      '.byk-set-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
    '.byk-set-item{display:flex;flex-direction:column;gap:6px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-separator-secondary,currentColor)}',
    '.byk-set-field{display:flex;flex-direction:column;gap:4px;padding:2px 0}',
    '.byk-set-input{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-separator-secondary,currentColor);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}',
    '.byk-set-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-separator-secondary,currentColor);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}',
    '.byk-set-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.byk-set-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
    '.byk-set-btn-danger{border-color:var(--dsw-alias-label-error,currentColor);color:var(--dsw-alias-label-error,currentColor)}',
    '.byk-set-error{color:var(--dsw-alias-label-error,var(--dsw-alias-label-primary))}',
    '.byk-set-form{gap:8px}',
    ].join('\n')

    function fmtTime(iso) {
      try {
        const d = new Date(iso)
        const p = (n) => String(n).padStart(2, '0')
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      } catch (e) { return String(iso || '') }
    }

    function shortId(id) {
      const s = String(id || '')
      return s.length > 6 ? s.slice(0, 6) : (s || '未知')
    }

    // 来源标注：拿不到会话谱系就只标「其它会话 · <短 id>」，不谎称「子会话」。
    function sourceLabel(sessionId, lineage) {
      const short = shortId(sessionId)
      if (lineage === 'subagent') return '子会话 · ' + short
      return '其它会话 · ' + short
    }

    function kindTag(kind) {
      return KIND_TAGS[kind] || KIND_TAGS.auto
    }

    function noticeTitle(ev) {
      const kind = (ev && ev.kind) || 'auto'
      const text = String((ev && (ev.justification || ev.reason)) || '')
      const head = kindTag(kind)
      if (kind === 'auto') {
        const label = VERDICT_LABELS[(ev && ev.verdict) || ''] || (ev && ev.verdict) || '自动放行'
        return '其它会话' + head + ' · ' + label + (text ? '：' + text : '')
      }
      return '其它会话' + head + (text ? '：' + text : '')
    }

    function fetchEvents(since) {
      // 不带 sessionId：src\index.mjs:739 取参数默认空串，:749 只在传了 sessionId 时才过滤，
      // 所以这里拿到的是全部会话的事件，每条自带 sessionId。
      const q = '/api/auto-approve/events' + (since ? '?since=' + since : '')
      return fetch(q, { headers: { 'cache-control': 'no-cache' } }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      }).then(function (data) {
        return (data && Array.isArray(data.events)) ? data.events : []
      })
    }

    /**
     * 解析当前会话 id 与（尽力而为的）会话谱系索引。
     * 当前会话 id 取不到时**一律不渲染**——做不到「只显示非当前会话」这条硬规则时，
     * 宁可什么都不显示，也不能把当前会话的事件再显示一遍造成双提示条。
     */
    function useFrame(props) {
      const sp = (props && props.slotsProps) || {}
      let state = null
      try {
        if (sp && typeof sp.useSessions === 'function') state = sp.useSessions(function (s) { return s })
      } catch (e) { state = null }
      let sessionId = (props && props.sessionId) || sp.sessionId || null
      if (!sessionId && state && state.current) sessionId = state.current
      // 谱系索引：只有客户端真的给出了带 parentSession / delegationDepth 的会话列表时才认「子会话」。
      let index = null
      if (state && typeof state === 'object') {
        for (const key of Object.keys(state)) {
          const v = state[key]
          if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && (v[0].id || v[0].sessionId)) {
            index = {}
            for (const item of v) {
              const sid = String(item.id || item.sessionId || '')
              if (!sid) continue
              const isChild = !!(item.parentSession || item.parentSessionId) ||
                item.origin === 'subagent' || Number(item.delegationDepth) > 0
              index[sid] = isChild ? 'subagent' : 'other'
            }
            break
          }
        }
      }
      return { sessionId: sessionId ? String(sessionId) : null, index: index }
    }

    /** 轮询全量事件，按 id 去重，按来源会话分流。 */
    function useMirror(sessionId) {
      const [state, setState] = React.useState({ events: [], notice: null, tick: 0 })
      const cursorRef = React.useRef(0)
      const seenRef = React.useRef(new Set())
      const bootedRef = React.useRef(false)

      React.useEffect(function () {
        let alive = true
        if (!sessionId) return

        const accept = function (list, isBoot) {
          const fresh = []
          for (const ev of list) {
            // 负载字段缺失（无 id）时跳过该条，不崩。
            if (!ev || typeof ev.id !== 'number') continue
            if (seenRef.current.has(ev.id)) continue
            seenRef.current.add(ev.id)
            if (ev.id > cursorRef.current) cursorRef.current = ev.id
            // 无 sessionId 的事件无法归属来源，跳过而不是冒名显示。
            if (!ev.sessionId) continue
            if (String(ev.sessionId) === sessionId) continue // 当前会话 → 交给原生条
            fresh.push(ev)
          }
          // 去重表不再无限增长：只保留游标附近的事件 id。
          if (seenRef.current.size > 500) {
            const floor = cursorRef.current - 500
            for (const id of Array.from(seenRef.current)) if (id < floor) seenRef.current.delete(id)
          }
          if (fresh.length === 0) return
          setState(function (prev) {
            const events = prev.events.concat(fresh).slice(-100)
            // 首轮只建立基线（游标 + 去重表），不为历史事件弹提示。
            if (isBoot) return { events: events, notice: prev.notice, tick: prev.tick + 1 }
            const last = fresh[fresh.length - 1]
            return { events: events, notice: last, tick: prev.tick + 1 }
          })
        }

        // 开轮询前先静默拉一次全量，只把游标推到最新，不弹任何历史提示。
        fetchEvents(0).then(function (evs) {
          if (!alive) return
          accept(evs, true)
          bootedRef.current = true
        }).catch(function (e) {
          warnOnce(String((e && e.message) || e))
          bootedRef.current = true
        })

        const timer = setInterval(function () {
          if (!alive || !bootedRef.current) return
          const since = Math.max(0, cursorRef.current - SCAN_BACK)
          fetchEvents(since).then(function (evs) {
            if (!alive) return
            accept(evs, false)
          }).catch(function (e) {
            warnOnce(String((e && e.message) || e))
          })
        }, POLL_MS)

        return function () { alive = false; clearInterval(timer) }
      }, [sessionId])

      // 非 pending 的提示条定时收起。
      React.useEffect(function () {
        const n = state.notice
        if (!n) return
        if ((n.kind || 'auto') === 'manual-pending') return
        const t = setTimeout(function () {
          setState(function (prev) { return { events: prev.events, notice: null, tick: prev.tick } })
        }, NOTICE_HOLD_MS)
        return function () { clearTimeout(t) }
      }, [state.notice, state.tick])

      return state
    }

    /**
     * 纯函数：这条通知之后，同一个会话是否又产生了新事件。
     * 同一会话在等待人工审批之后又发起了新的工具调用，说明它当时并没有被这条审批卡住 ——
     * 那条审批早已被处理（人工点了，或随会话结束被取消），不该继续显示成「正在等待」。
     */
    function hasLaterEvent(events, notice) {
      if (!notice || !Array.isArray(events)) return false
      const sid = String(notice.sessionId || '')
      const id = Number(notice.id)
      for (const ev of events) {
        if (!ev || String(ev.sessionId || '') !== sid) continue
        if (Number(ev.id) > id) return true
      }
      return false
    }

    /**
     * 纯函数：决定一条跨会话通知怎么处置。
     *   'none'   —— 没有通知
     *   'normal' —— 普通提示条（自动放行 / 人工通过 / 人工拒绝），照旧定时收起
     *   'wait'   —— manual-pending 且本窗口的待批表里没有它：照常显示，但必须说明「本窗口不能代答」
     *   'dup'    —— manual-pending 且它就在本窗口的待批表里：交给带按钮的待批条，镜像卡让位
     *   'stale'  —— manual-pending 但已经不可能再等了（同一会话后续又有事件，或超过 holdMs 兜底）
     */
    function noticeDisposition(notice, opts) {
      const o = opts || {}
      if (!notice) return 'none'
      if ((notice.kind || 'auto') !== 'manual-pending') return 'normal'
      const live = o.liveIds
      const hasLive = !!(live && typeof live.has === 'function')
      if (hasLive && live.has(String(notice.sessionId || ''))) return 'dup'
      if (o.laterEvent === true) return 'stale'
      const ts = Date.parse(String(notice.ts || ''))
      const now = typeof o.now === 'number' ? o.now : Date.now()
      const hold = typeof o.holdMs === 'number' ? o.holdMs : PENDING_HOLD_MS
      if (Number.isFinite(ts) && now - ts > hold) return 'stale'
      return hasLive ? 'wait' : 'normal'
    }

    // ============ 跨会话提示条：conversation.input.dock（order=31，排在原生 order=30 之后） ============
    function MirrorNotice(props) {
      const frame = useFrame(props)
      const mirror = useMirror(frame.sessionId)
      const uiSession = resolveProp(props.uiSession)
      const live = useChildPendings(uiSession, frame.sessionId)
      const [dismissed, setDismissed] = React.useState(null)
      const notice = mirror.notice
      const liveIds = new Set()
      for (const it of (live.items || [])) liveIds.add(String(it.sessionId))
      const disposition = noticeDisposition(notice, {
        liveIds: uiSession ? liveIds : null,
        laterEvent: hasLaterEvent(mirror.events, notice),
        now: Date.now()
      })
      if (!notice) return null
      // 已经不可能再等的（同一会话后续又有事件 / 兜底超时）不再冒充「正在等待」；
      // 本窗口拿得到这条审批时让位给带按钮的待批条，避免同一条审批出现两套说法。
      if (disposition === 'stale' || disposition === 'dup') return null
      if (dismissed === notice.id) return null
      const kind = notice.kind || 'auto'
      const isPending = kind === 'manual-pending'
      const isRejected = kind === 'manual-rejected'
      const cannotAnswerHere = disposition === 'wait'
      const cardCls = 'byk-mirror-card' + (isPending ? ' byk-mirror-card-pending' : '')
      const tagCls = isRejected ? 'byk-tag byk-tag-err' : isPending ? 'byk-tag byk-tag-warn' : 'byk-tag'
      return React.createElement('div', { className: 'byk-mirror' },
        React.createElement('div', { className: cardCls },
          React.createElement('div', { className: 'byk-mirror-body' },
            React.createElement('div', { className: 'byk-mirror-head' },
              React.createElement('span', { className: 'byk-mirror-tool' }, notice.tool || 'tool'),
              React.createElement('span', { className: 'byk-mirror-text' }, noticeTitle(notice))
            ),
            React.createElement('div', { className: 'byk-mirror-meta' },
              React.createElement('span', { className: 'byk-tag byk-tag-src' }, sourceLabel(notice.sessionId, frame.index ? frame.index[String(notice.sessionId)] : null)),
              React.createElement('span', { className: tagCls }, kindTag(kind)),
              React.createElement('span', { className: 'byk-time' }, fmtTime(notice.ts))
            ),
            cannotAnswerHere
              ? React.createElement('div', { className: 'byk-mirror-note' },
                '这条审批不在本窗口（属于会话 ' + shortId(notice.sessionId) + '）：请到那个会话里点「允许一次 / 拒绝」，本窗口无法代答。')
              : null
          ),
          React.createElement('button', {
            type: 'button',
            className: 'byk-mirror-close',
            title: '关闭提示',
            'aria-label': '关闭提示',
            onClick: function () { setDismissed(notice.id) }
          }, '\u2715')
        )
      )
    }

    // ============ 跨会话审批时间线：conversation.view（order=21，紧邻原生「审批」order=20） ============
    function MirrorHistory(props) {
      const frame = useFrame(props)
      const mirror = useMirror(frame.sessionId)
      const events = mirror.events.slice().reverse()
      const header = React.createElement('div', { className: 'byk-view-head' },
        React.createElement('div', { className: 'byk-view-title' }, '跨会话审批'),
        React.createElement('div', { className: 'byk-view-sub' }, '只显示其它会话的审批事件；当前会话的审批见「审批」页签。子智能体的待批审批见输入框上方的提示条。')
      )
      const body = events.length === 0
        ? React.createElement('div', { className: 'byk-empty' }, frame.sessionId ? '暂无其它会话的审批事件' : '暂时读不到当前会话 id，已停用镜像（不影响对话）')
        : React.createElement('div', { className: 'byk-list' }, events.map(function (ev) {
            const kind = ev.kind || 'auto'
            const tagCls = kind === 'manual-rejected' ? 'byk-tag byk-tag-err' : kind === 'manual-pending' ? 'byk-tag byk-tag-warn' : 'byk-tag'
            const files = Array.isArray(ev.files) ? ev.files.slice(0, 6) : []
            return React.createElement('div', { className: 'byk-row', key: String(ev.id) },
              React.createElement('div', { className: 'byk-row-top' },
                React.createElement('span', { className: 'byk-row-tool' }, ev.tool || 'tool'),
                React.createElement('span', { className: tagCls }, kindTag(kind)),
                React.createElement('span', { className: 'byk-tag byk-tag-src' }, sourceLabel(ev.sessionId, frame.index ? frame.index[String(ev.sessionId)] : null)),
                React.createElement('span', { className: 'byk-time' }, fmtTime(ev.ts))
              ),
              React.createElement('div', { className: 'byk-row-text' }, String(ev.justification || ev.reason || '')),
              files.length > 0
                ? React.createElement('div', { className: 'byk-files' }, files.map(function (f, i) {
                    return React.createElement('span', { className: 'byk-file', key: String(i) }, String(f))
                  }))
                : null
            )
          }))
      return React.createElement('div', { className: 'byk-view' }, header, body)
    }

    const plugin = {
      inject: ['timer'],
      async apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        // 待批审批的数据源：客户端 uiSession 服务。**每次渲染惰性解析**：apply 早于该服务就绪时，
        // 也能在服务就绪后自己恢复，而不是整场会话静默失效（拿不到仍静默不显示，不影响对话）。
        function resolveUiSession() {
          try {
            const svc = ctx.get('uiSession')
            return svc === undefined ? undefined : svc
          } catch (e) {
            return undefined
          }
        }

        // 设置读写入口：客户端 ui-settings 的 configForms（同上，每次渲染惰性解析）。
        // 服务缺席 / 命名空间不被服务时返回 undefined，设置页显示一行说明而不是假装开关有效。
        function resolveDiagnosticsTargetForRender() {
          let forms
          try {
            forms = ctx.get('configForms')
          } catch (e) {
            return undefined
          }
          if (forms === undefined || forms === null) return undefined
          try { return pickDiagnosticsTarget(forms) } catch (e) { return undefined }
        }

        let styleEl = null
        try {
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin-css', 'byk-agents')
          styleEl.textContent = CSS
          document.head.appendChild(styleEl)
        } catch (e) {
          warnOnce('注入样式失败：' + String((e && e.message) || e))
        }
        ctx.effect(() => {
          return () => {
            if (styleEl && styleEl.parentNode) {
              try { styleEl.parentNode.removeChild(styleEl) } catch (e) { /* 卸载期 DOM 已消失，忽略 */ }
            }
          }
        })

        // 子智能体待批审批：排在 approval-gate 原生条（order=30）与跨会话镜像（order=31）之前。
        slots.inject('conversation.input.dock', function () {
          return slots.register(
            { name: 'conversation.input.dock', id: 'byk-agents.child-approvals', order: 25, label: '子智能体待批审批' },
            function (props) { return React.createElement(ChildApprovalStrip, { slotsProps: props, uiSession: resolveUiSession }) }
          )
        })

        // 诊断行（order=24）：**默认不渲染**，只有设置页开关（宿主 volatile 字段 diagnostics）为 true 时出现。
        slots.inject('conversation.input.dock', function () {
          return slots.register(
            { name: 'conversation.input.dock', id: 'byk-agents.diag', order: 24, label: 'byk 诊断' },
            function (props) { return React.createElement(StripDiagnostics, { slotsProps: props, uiSession: resolveUiSession, diagnosticsTarget: resolveDiagnosticsTargetForRender }) }
          )
        })

        // 输入框上方独立行：排在 approval-gate 原生条（order=30）之后。
        slots.inject('conversation.input.dock', function () {
          return slots.register(
            { name: 'conversation.input.dock', id: 'byk-agents.approval-mirror', order: 31, label: '跨会话审批提示' },
            function (props) { return React.createElement(MirrorNotice, { slotsProps: props, uiSession: resolveUiSession }) }
          )
        })

        // 审批时间线：同 slot 追加一项，紧邻原生「审批」页签。
        slots.inject('conversation.view', function () {
          return slots.register(
            {
              name: 'conversation.view',
              id: 'byk-agents.approval-history',
              order: 21,
              label: '跨会话审批',
              inject: (sessionId) => ({ sessionId })
            },
            function (props) { return React.createElement(MirrorHistory, { slotsProps: props }) }
          )
        })

        // 设置页整页（settings.section）：注册进 DSH 设置面板，导航里显示「BYK 助手」。
        // 槽位由客户端 ui-settings 声明；没有设置面板的 profile 里这个 inject 永远不触发，
        // 只是这一项不安装，不影响其它三处卡片。
        // 只注册这一个入口。早先还额外注册过一个 settings.plugins.tab（「设置 → 内置插件」
        // 页里的同名 tab，与整页共用同一个组件），结果同一个设置页在两个地方各出现一次；
        // 用户明确要求只保留设置左侧导航里的一项，故该入口已删除，不要再加回来。
        const bykSettingsEntry = function (props) {
          return React.createElement(BykSettingsSection, { slotsProps: props, diagnosticsTarget: resolveDiagnosticsTargetForRender })
        }
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'byk-agents', order: 40, label: 'BYK 助手' },
            bykSettingsEntry
          )
        })
      }
    }

    // 供 node 侧确定性测试直接调用（纯函数，不依赖 React/DOM）。
    exports.__test = {
      APPROVE_OUTCOME: APPROVE_OUTCOME,
      REJECT_OUTCOME: REJECT_OUTCOME,
      asMap: asMap,
      parentOf: parentOf,
      isDescendant: isDescendant,
      selectChildPendings: selectChildPendings,
      visibleChildPendings: visibleChildPendings,
      filterOwnIfNative: filterOwnIfNative,
      answerPending: answerPending,
      reasonValue: reasonValue,
      reasonText: reasonText,
      commandFromChatSnapshot: commandFromChatSnapshot,
      titleOf: titleOf,
      shortId: shortId,
      formatWait: formatWait,
      resultLabel: resultLabel,
      noticeDisposition: noticeDisposition,
      hasLaterEvent: hasLaterEvent,
      channelBody: channelBody,
      normalizeChannelResponse: normalizeChannelResponse,
      channelCall: channelCall,
      channelPost: channelPost,
      crudBody: crudBody,
      validateDraft: validateDraft,
      cleanFields: cleanFields,
      isBuiltinOrigin: isBuiltinOrigin,
      assistantEditView: assistantEditView,
      assistantRowView: assistantRowView,
      BACKEND_OPTIONS: BACKEND_OPTIONS,
      EDITABLE_FIELDS: EDITABLE_FIELDS,
      ROLE_ID_RE: ROLE_ID_RE,
      CHANNEL_PATH: CHANNEL_PATH
    }

    exports.default = plugin
    exports.apply = plugin.apply
    exports.inject = plugin.inject
    return module.exports
  },
})
