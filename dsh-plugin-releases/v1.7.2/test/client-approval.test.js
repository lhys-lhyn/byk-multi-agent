// dsh-plugin-byk-agents — 客户端 bundle 的确定性测试（修 2：子智能体待批审批）
//
// 在 node 里用最小桩件加载浏览器端 bundle：伪造 window.__ModuleLoader__ 捕获 factory，
// 伪造 react / document / ctx / slots，然后验证「挑哪些待批项」与「点按钮发什么 outcome」
// 这些纯逻辑——不需要真 React、不需要浏览器。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let def = null
const fakeWindow = { __ModuleLoader__: { load: (d) => { def = d } } }
// bundle 顶层只碰 window，apply 里才碰 document。
new Function('window', src)(fakeWindow)

assert.equal(def && def.id, 'dsh-plugin-byk-agents', 'bundle 必须以 dsh-plugin-byk-agents 注册')

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v })
}
const mod = def.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
const T = mod.__test
assert.ok(T && typeof T.selectChildPendings === 'function', 'bundle 必须导出 __test 纯函数')

const APPROVE = 'allowed-once'
const REJECT = 'rejected'
assert.equal(T.APPROVE_OUTCOME, APPROVE)
assert.equal(T.REJECT_OUTCOME, REJECT)

let pass = 0
const it = (name, fn) => { fn(); pass++; console.log('  \u2714 ' + name) }

// ---- 造一个假待批对象 ----
const makePending = (sessionId, opts = {}) => {
  const calls = []
  return {
    calls,
    pending: {
      kind: 'approval',
      key: 'approval:' + sessionId,
      sessionId,
      toolName: opts.toolName || 'run_code',
      reason: opts.reason || 'escalate sandbox to danger-full-access: xxx',
      answerable: opts.answerable === undefined ? true : opts.answerable,
      answer: (o) => { calls.push(o) }
    }
  }
}

console.log('== selectChildPendings / visibleChildPendings ==')
it('本会话自己的待批也一起选出来（去留交给 filterOwnIfNative 决定）', () => {
  const me = makePending('me')
  const kid = makePending('kid')
  const snapshot = { me: { pendingInteraction: me.pending }, kid: { pendingInteraction: kid.pending } }
  const byId = { me: {}, kid: { parentId: 'me' } }
  const out = T.selectChildPendings(snapshot, byId, 'me')
  assert.deepEqual(out.map((x) => x.sessionId), ['me', 'kid'])
  assert.deepEqual(out.map((x) => x.own), [true, false])
  assert.deepEqual(out.map((x) => x.descendant), [false, true])
})
it('认得出孙子会话（沿 parentId 向上回溯）', () => {
  const g = makePending('g')
  const snapshot = { g: { pendingInteraction: g.pending } }
  const byId = { g: { parentId: 'kid' }, kid: { parentId: 'me' }, me: {} }
  assert.equal(T.isDescendant('g', new Map(Object.entries(byId)), 'me'), true)
  const v = T.visibleChildPendings(snapshot, byId, 'me')
  assert.equal(v.lineageKnown, true)
  assert.deepEqual(v.items.map((x) => x.sessionId), ['g'])
})
it('谱系里查不到的会话也照样显示（宁多勿漏）', () => {
  const x = makePending('x')
  const snapshot = { x: { pendingInteraction: x.pending } }
  const byId = { x: { parentId: 'other' }, me: {}, other: {} }
  const v = T.visibleChildPendings(snapshot, byId, 'me')
  assert.equal(v.lineageKnown, true)
  assert.deepEqual(v.items.map((i) => i.sessionId), ['x'])
  assert.equal(v.items[0].descendant, false)
})
it('拿不到任何谱系信息时也一条都不漏（含本会话自己那条）', () => {
  const x = makePending('x')
  const me = makePending('me')
  const snapshot = { x: { pendingInteraction: x.pending }, me: { pendingInteraction: me.pending } }
  const v = T.visibleChildPendings(snapshot, {}, 'me')
  assert.equal(v.lineageKnown, false)
  assert.deepEqual(v.items.map((i) => i.sessionId), ['x', 'me'])
})
it('忽略非 approval 的待批项与已应答项', () => {
  const done = makePending('kid', { answerable: false })
  const other = makePending('kid2')
  other.pending.kind = 'question'
  const snapshot = { a: { pendingInteraction: done.pending }, b: { pendingInteraction: other.pending } }
  const byId = { a: { parentId: 'me' }, b: { parentId: 'me' }, me: {} }
  assert.deepEqual(T.visibleChildPendings(snapshot, byId, 'me').items, [])
})
it('没有当前会话 id 时不显示任何东西', () => {
  const kid = makePending('kid')
  const snapshot = { kid: { pendingInteraction: kid.pending } }
  assert.deepEqual(T.visibleChildPendings(snapshot, { kid: { parentId: 'me' } }, null).items, [])
})

console.log('== filterOwnIfNative（本会话自己的待批让位给原生卡片）==')
it('原生卡片在场：本会话那条让位，子会话那条照常显示', () => {
  const items = [{ sessionId: 'me', own: true }, { sessionId: 'kid', own: false }]
  assert.deepEqual(T.filterOwnIfNative(items, true).map((x) => x.sessionId), ['kid'])
})
it('原生卡片不在场：本会话那条必须由我们显示（否则就没地方点了）', () => {
  const items = [{ sessionId: 'me', own: true }, { sessionId: 'kid', own: false }]
  assert.deepEqual(T.filterOwnIfNative(items, false).map((x) => x.sessionId), ['me', 'kid'])
})
it('空列表 / undefined 不抛错', () => {
  assert.deepEqual(T.filterOwnIfNative([], true), [])
  assert.deepEqual(T.filterOwnIfNative(undefined, false), [])
})

console.log('== answerPending ==')
it('允许一次 → answer("allowed-once")', () => {
  const kid = makePending('kid')
  assert.equal(T.answerPending(kid.pending, APPROVE), true)
  assert.deepEqual(kid.calls, ['allowed-once'])
})
it('拒绝 → answer("rejected")', () => {
  const kid = makePending('kid')
  assert.equal(T.answerPending(kid.pending, REJECT), true)
  assert.deepEqual(kid.calls, ['rejected'])
})
it('已应答 / 坏对象：返回 false、绝不抛错', () => {
  const done = makePending('kid', { answerable: false })
  assert.equal(T.answerPending(done.pending, APPROVE), false)
  assert.deepEqual(done.calls, [])
  assert.equal(T.answerPending(null, APPROVE), false)
  assert.equal(T.answerPending({ answer: () => { throw new Error('boom') } }, APPROVE), false)
})

console.log('== apply 注册 ==')
it('注册待批审批条（order=25）与既有镜像/历史视图，且不缺 uiSession 时不抛错', () => {
  const registered = []
  const injected = []
  const slots = {
    inject: (name, fn) => { injected.push(name); registered.push(fn()) },
    register: (spec, comp) => ({ spec, comp })
  }
  const uiSession = {
    sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} },
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } }
  }
  globalThis.document = { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } }
  const ctx = {
    get: (n) => (n === 'slots' ? slots : n === 'uiSession' ? uiSession : undefined),
    effect: (fn) => fn()
  }
  mod.apply(ctx)
  const ids = registered.map((r) => r.spec.id)
  assert.ok(ids.includes('byk-agents.child-approvals'), '必须注册 byk-agents.child-approvals')
  const child = registered.find((r) => r.spec.id === 'byk-agents.child-approvals')
  assert.equal(child.spec.order, 25)
  assert.equal(child.spec.name, 'conversation.input.dock')
  assert.ok(ids.includes('byk-agents.approval-mirror'))
  assert.ok(ids.includes('byk-agents.approval-history'))
  // 没有 uiSession 时 apply 同样不能抛错。
  mod.apply({ get: (n) => (n === 'slots' ? slots : undefined), effect: (fn) => fn() })
})

console.log('== v1.3.1 展示辅助函数 ==')
it('reasonText：原样保留换行，不截断短原因', () => {
  assert.equal(T.reasonText({ reason: 'line1\nline2' }), 'line1\nline2')
  // 新语义：reason（宿主拼好的中文完整句）优先，displayReason 只兜底。
  assert.equal(T.reasonText({ reason: 'a', displayReason: 'b' }), 'a')
})
it('reasonText：超长才截尾加省略号，缺原因返回空串', () => {
  assert.equal(T.reasonText({ reason: 'x'.repeat(20) }, 10), 'x'.repeat(10) + '\u2026')
  assert.equal(T.reasonText({}), '')
  assert.equal(T.reasonText(null), '')
})
it('titleOf：displayTitle → title → label → null', () => {
  const byId = { a: { displayTitle: 'A' }, b: { title: 'B' }, c: { label: 'C' }, d: {} }
  assert.equal(T.titleOf(byId, 'a'), 'A')
  assert.equal(T.titleOf(byId, 'b'), 'B')
  assert.equal(T.titleOf(byId, 'c'), 'C')
  assert.equal(T.titleOf(byId, 'd'), null)
  assert.equal(T.titleOf(byId, 'missing'), null)
  assert.equal(T.titleOf(new Map([['e', { displayTitle: 'E' }]]), 'e'), 'E')
})
it('formatWait：秒 / 分秒，负数归零', () => {
  assert.equal(T.formatWait(0), '已等待 0 秒')
  assert.equal(T.formatWait(12500), '已等待 12 秒')
  assert.equal(T.formatWait(65000), '已等待 1 分 05 秒')
  assert.equal(T.formatWait(-5), '已等待 0 秒')
})
it('resultLabel：拒绝 / 允许一次', () => {
  assert.equal(T.resultLabel(REJECT), '已拒绝')
  assert.equal(T.resultLabel(APPROVE), '已允许一次')
})
it('shortId：短的原样，长的截 6 位，空的给未知', () => {
  assert.equal(T.shortId('abc'), 'abc')
  assert.equal(T.shortId('eb62efc5-7293-499d-a2d6-b03f652eb7c1'), 'eb62ef')
  assert.equal(T.shortId(''), '未知')
})

console.log('== 待批条渲染（最小桩 React）==')
it('渲染：输出工具名 / 来源会话标题 / 要做什么 / 完整原因 / 两个按钮', () => {
  const registered = []
  const slots = {
    inject: (name, fn) => { registered.push(fn()) },
    register: (spec, comp) => ({ spec, comp })
  }
  const pending = {
    kind: 'approval', key: 'approval:1', toolName: 'write', sessionId: 'kid',
    reason: 'escalate sandbox to danger-full-access: 写桌面文件',
    answerable: true, answer: () => {}
  }
  const uiSession = {
    sessionStatus: { getSnapshot: () => new Map([['kid', { pendingInteraction: pending }]]), subscribe: () => () => {} },
    sessions: { list: { getSnapshot: () => ({ byId: { kid: { displayTitle: '子代理 A', parentId: 'me' } } }) } }
  }
  const ctx = { get: (n) => (n === 'slots' ? slots : n === 'uiSession' ? uiSession : undefined), effect: (fn) => fn() }
  mod.apply(ctx)
  const comp = registered.find((r) => r.spec.id === 'byk-agents.child-approvals').comp
  const wrapper = comp({ sessionId: 'me' })
  // apply 里注册的是「壳组件」，真正的待批条是它的子组件，这里展开一层。
  const tree = wrapper && typeof wrapper.type === 'function' ? wrapper.type(wrapper.props) : wrapper
  const flat = []
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (typeof n === 'string' || typeof n === 'number') { flat.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.children) n.children.forEach(walk)
  }
  walk(tree)
  const text = flat.join(' | ')
  assert.ok(text.includes('子智能体待批审批 · 1 条'), '标题带条数：' + text.slice(0, 80))
  assert.ok(text.includes('工具 write'), '显示工具名')
  assert.ok(text.includes('子代理 A'), '显示来源会话标题')
  assert.ok(text.includes('要做什么'), '有「要做什么」标签')
  assert.ok(text.includes('写桌面文件'), '显示完整原因')
  assert.ok(text.includes('已等待'), '显示等待时长')
  assert.ok(text.includes('拒绝') && text.includes('允许一次'), '有两个按钮')
})

it('reasonText：displayReason 是 {en,zh} 对象时按中文取，不再 [object Object]', () => {
  const obj = { en: 'Allow this operation with danger-full-access permissions: copy file', zh: '允许本次操作使用 danger-full-access 权限：把文件复制到桌面' }
  assert.equal(T.reasonText({ displayReason: obj }), '把文件复制到桌面'.length > 0 ? obj.zh : '')
  assert.ok(!T.reasonText({ displayReason: obj }).includes('[object Object]'))
  // reason（字符串）优先于 displayReason（对象）。
  assert.equal(T.reasonText({ reason: 'escalate sandbox to danger-full-access: 复制文件', displayReason: obj }), 'escalate sandbox to danger-full-access: 复制文件')
  // 纯对象且无中文时回退英文；嵌套/数字值不误取。
  assert.equal(T.reasonText({ displayReason: { en: 'Only English' } }), 'Only English')
  assert.equal(T.reasonValue(null), '')
  assert.equal(T.reasonValue({ zh: 1, en: null }), '')
})

it('commandFromChatSnapshot：按 callId 找 phase=start 的 tool-call 取 args.command', () => {
  const snap = { nodes: { values: () => [
    { kind: 'text', data: {} },
    { kind: 'tool-call', data: { root: { callId: 'other', phase: 'start', argsRaw: '{"args":{"command":"nope"}}' } } },
    { kind: 'tool-call', data: { root: { callId: 'c1', phase: 'end', argsRaw: '{"args":{"command":"late"}}' } } },
    { kind: 'tool-call', data: { root: { callId: 'c1', phase: 'start', argsRaw: '{"args":{"command":"Get-Process | Select -First 5"}}' } } }
  ] } }
  assert.equal(T.commandFromChatSnapshot(snap, 'c1'), 'Get-Process | Select -First 5')
  assert.equal(T.commandFromChatSnapshot(snap, 'missing'), null)
  assert.equal(T.commandFromChatSnapshot(null, 'c1'), null)
  assert.equal(T.commandFromChatSnapshot({ nodes: { values: () => [{ kind: 'tool-call', data: { root: { callId: 'c2', phase: 'start', argsRaw: 'not-json' } } }] } }, 'c2'), null)
})

it('渲染：useChat 提供快照时显示命令行', () => {
  const registered = []
  const slots = { inject: (name, fn) => { registered.push(fn()) }, register: (spec, comp) => ({ spec, comp }) }
  const pending = {
    kind: 'approval', key: 'approval:2', toolName: 'pwsh', sessionId: 'kid',
    callId: 'call-9', reason: 'escalate sandbox to danger-full-access: 修复注册表',
    answerable: true, answer: () => {}
  }
  const uiSession = {
    sessionStatus: { getSnapshot: () => new Map([['kid', { pendingInteraction: pending }]]), subscribe: () => () => {} },
    sessions: { list: { getSnapshot: () => ({ byId: { kid: { displayTitle: '子代理 B', parentId: 'me' } } }) } }
  }
  const snapshot = { nodes: { values: () => [{ kind: 'tool-call', data: { root: { callId: 'call-9', phase: 'start', argsRaw: '{"args":{"command":"reg add HKCU\\\\Software\\\\dsh-radar"}}' } } }] } }
  const useChat = (sel) => sel(snapshot)
  const ctx = { get: (n) => (n === 'slots' ? slots : n === 'uiSession' ? uiSession : undefined), effect: (fn) => fn() }
  mod.apply(ctx)
  const comp = registered.find((r) => r.spec.id === 'byk-agents.child-approvals').comp
  const wrapper = comp({ sessionId: 'me', useChat })
  const tree = wrapper && typeof wrapper.type === 'function' ? wrapper.type(wrapper.props) : wrapper
  const flat = []
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (typeof n === 'string' || typeof n === 'number') { flat.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.children) n.children.forEach(walk)
  }
  walk(tree)
  const text = flat.join(' | ')
  assert.ok(text.includes('reg add HKCU'), '审批前显示命令行：' + text.slice(0, 200))
})


// ---- 修 3：只读的跨会话提示条不再把「已经结束的审批」显示成「正在等待人工审批」 ----
console.log('== noticeDisposition / hasLaterEvent ==')
const ev0 = { id: 264, ts: '2026-10-06T02:44:23.263Z', sessionId: 'child7', tool: 'pwsh', kind: 'manual-pending', verdict: 'manual-pending' }
const liveWith = (sid) => new Set([sid])

it('没有通知就什么都不显示', () => {
  assert.equal(T.noticeDisposition(null, {}), 'none')
})
it('普通事件（自动放行/人工通过/人工拒绝）照旧走定时收起', () => {
  assert.equal(T.noticeDisposition({ kind: 'auto', sessionId: 'x' }, { liveIds: liveWith('x') }), 'normal')
  assert.equal(T.noticeDisposition({ kind: 'manual-approved', sessionId: 'x' }, {}), 'normal')
})
it('等待人工审批 + 本窗口待批表里就有它 → 让位给带按钮的待批条（dup）', () => {
  assert.equal(T.noticeDisposition(ev0, { liveIds: liveWith('child7'), laterEvent: false, now: Date.parse(ev0.ts) }), 'dup')
})
it('等待人工审批 + 本窗口没有它 + 同一会话之后又有新事件 → 已经不可能再等（stale）', () => {
  assert.equal(T.noticeDisposition(ev0, { liveIds: liveWith('other'), laterEvent: true, now: Date.parse(ev0.ts) }), 'stale')
})
it('等待人工审批 + 本窗口没有它 + 超过兜底时限（10 分钟）→ 不再当作等待（stale）', () => {
  const now = Date.parse(ev0.ts) + 10 * 60 * 1000 + 1
  assert.equal(T.noticeDisposition(ev0, { liveIds: liveWith('other'), laterEvent: false, now: now }), 'stale')
})
it('等待人工审批 + 本窗口没有它 + 还没超时 → 显示，但标记本窗口不能代答（wait）', () => {
  const now = Date.parse(ev0.ts) + 60 * 1000
  assert.equal(T.noticeDisposition(ev0, { liveIds: liveWith('other'), laterEvent: false, now: now }), 'wait')
})
it('拿不到本窗口待批表（服务缺失）时不冒充判断：未超时照旧显示（normal），超时后仍会收起', () => {
  const now = Date.parse(ev0.ts) + 60 * 1000
  assert.equal(T.noticeDisposition(ev0, { liveIds: null, laterEvent: false, now: now }), 'normal')
  assert.equal(T.noticeDisposition(ev0, { liveIds: null, laterEvent: false, now: now + 10 * 60 * 1000 }), 'stale')
})
it('hasLaterEvent 只看同一会话里 id 更大的事件', () => {
  const events = [
    { id: 263, sessionId: 'child7' },
    { id: 273, sessionId: 'other' },
    { id: 280, sessionId: 'child7' }
  ]
  assert.equal(T.hasLaterEvent(events, ev0), true, '同会话有更晚的 280 → true')
  assert.equal(T.hasLaterEvent(events, { id: 281, sessionId: 'child7' }), false, '没有更晚的 → false')
  assert.equal(T.hasLaterEvent([], ev0), false)
  assert.equal(T.hasLaterEvent(null, ev0), false)
  assert.equal(T.hasLaterEvent([{ id: 999, sessionId: 'other' }], ev0), false, '别的会话不算')
})

console.log('\nclient-approval.test.js: ' + pass + ' 例全过');
