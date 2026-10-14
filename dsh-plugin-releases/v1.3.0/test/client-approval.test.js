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
it('排除当前会话自己的待批（交给原生卡片）', () => {
  const me = makePending('me')
  const kid = makePending('kid')
  const snapshot = { me: { pendingInteraction: me.pending }, kid: { pendingInteraction: kid.pending } }
  const byId = { me: {}, kid: { parentId: 'me' } }
  const out = T.selectChildPendings(snapshot, byId, 'me')
  assert.deepEqual(out.map((x) => x.sessionId), ['kid'])
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
it('有谱系信息时剔除无关会话', () => {
  const x = makePending('x')
  const snapshot = { x: { pendingInteraction: x.pending } }
  const byId = { x: { parentId: 'other' }, me: {}, other: {} }
  const v = T.visibleChildPendings(snapshot, byId, 'me')
  assert.deepEqual(v.items, [])
})
it('拿不到任何谱系信息时退化为「所有非当前会话」（宁多勿漏）', () => {
  const x = makePending('x')
  const me = makePending('me')
  const snapshot = { x: { pendingInteraction: x.pending }, me: { pendingInteraction: me.pending } }
  const v = T.visibleChildPendings(snapshot, {}, 'me')
  assert.equal(v.lineageKnown, false)
  assert.deepEqual(v.items.map((i) => i.sessionId), ['x'])
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

console.log('\nclient-approval.test.js: ' + pass + ' 例全过');
