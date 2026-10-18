// dsh-plugin-byk-agents — 设置页 s5：助手「增删改查 + 逐助手模型/后端配置」
//
// 纯 node:assert、假 react / 假 fetch / 假 ctx；不起子进程、不 import lib/index.js。
// 覆盖规格要求的六项：列表渲染四分支、编辑提交的请求形状、新增的 id 校验与重复拦截、
// 内置删除被拦、通道错误的界面回显、两个槽位都注册（且共用同一个组件）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let def = null
new Function('window', src)({ __ModuleLoader__: { load: (d) => { def = d } } })
assert.equal(def && def.id, 'dsh-plugin-byk-agents', 'bundle 必须以 dsh-plugin-byk-agents 注册')

// ---- 可驱动的假 React：useState 真存值 + setState 触发重渲染；useEffect 只在首次挂载跑 ----
const store = { hooks: [], cursor: 0, mounted: false, dirty: false, effects: [] }
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useRef: (init) => { const i = store.cursor++; if (store.hooks.length <= i) store.hooks[i] = { current: init }; return store.hooks[i] },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useState: (init) => {
    const i = store.cursor++
    if (store.hooks.length <= i) store.hooks[i] = typeof init === 'function' ? init() : init
    const set = (v) => { store.hooks[i] = typeof v === 'function' ? v(store.hooks[i]) : v; store.dirty = true }
    return [store.hooks[i], set]
  },
  useEffect: (fn) => { store.cursor++; if (!store.mounted) store.effects.push(fn) }
}

globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.document = { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } }

const mod = def.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
const T = mod.__test
assert.ok(T && typeof T.validateDraft === 'function', 'bundle 必须导出 s5 的 __test 纯函数')

// ---- 假数据通道 ----
let fetchCalls = []
let reply = () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, assistants: [] }) })
const realFetch = globalThis.fetch
globalThis.fetch = (url, init) => {
  const body = JSON.parse(init.body)
  fetchCalls.push({ url, body })
  return Promise.resolve(reply(body))
}
const listReply = (rows) => () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, assistants: rows, overlayPath: 'C:\\byk\\assistants.local.json' }) })

// ---- 假 slots / ctx，装一次插件 ----
const registered = []
const slots = {
  inject: (name, fn) => { fn() },
  register: (spec, comp) => { registered.push({ spec, comp }); return () => {} }
}
const uiSession = {
  sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } }
}
const ctx = { get: (n) => (n === 'slots' ? slots : n === 'uiSession' ? uiSession : undefined), effect: (fn) => fn() }
mod.apply(ctx)

const SECTION = registered.filter((r) => r.spec.name === 'settings.section' && r.spec.id === 'byk-agents')[0]
const TAB = registered.filter((r) => r.spec.name === 'settings.plugins.tab')[0]
assert.ok(SECTION, '必须注册 settings.section（独立整页）')
assert.equal(TAB, undefined, '不许再注册 settings.plugins.tab（「内置插件」页里的子 tab）')
const Section = SECTION.comp
const PROPS = { slotsProps: {}, diagnosticsTarget: () => undefined }

function scenario() {
  store.hooks = []
  store.cursor = 0
  store.mounted = false
  store.dirty = false
  store.effects = []
  fetchCalls = []
}
// apply 里注册的是「壳组件」：先调一次，再把内层的真组件展开一层（同 client-approval.test.js）。
function expand(node) {
  let n = node
  let guard = 0
  while (n && typeof n === 'object' && typeof n.type === 'function' && guard < 4) { n = n.type(n.props); guard++ }
  return n
}
function render() {
  let out = null
  let guard = 0
  do {
    store.dirty = false
    store.cursor = 0
    out = expand(Section(PROPS))
    if (!store.mounted) {
      store.mounted = true
      const fns = store.effects
      store.effects = []
      for (const fn of fns) { const c = fn(); void c }
    }
    guard++
  } while (store.dirty && guard < 12)
  return out
}
const flush = () => new Promise((r) => setTimeout(r, 0))

function collect(node, pred) {
  const out = []
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    if (pred(n)) out.push(n)
    if (n.children) walk(n.children)
  }
  walk(node)
  return out
}
function text(node) {
  const bits = []
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (typeof n === 'string' || typeof n === 'number') { bits.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.children) walk(n.children)
  }
  walk(node)
  return bits.join(' | ')
}
const buttons = (root, label) => collect(root, (n) => n.props && (n.props.className || '').indexOf('byk-set-btn') === 0 && text(n) === label)
const byClass = (root, cls) => collect(root, (n) => n.props && n.props.className === cls)
// 表单打开后，界面上会有两个「新增助手」按钮：上面那个（禁用）是开关，真正提交的是表单里的那个。
const submitAdd = (root) => {
  const bs = buttons(root, '新增助手')
  return bs.filter((b) => !b.props.disabled)[0] || bs[0]
}
const inputs = (root) => byClass(root, 'byk-set-input')

const ROWS = [
  { id: 'code', name: '代码助手', enabled: true, origin: 'builtin',
    originText: '内置角色（byk/roles.py），覆盖层未改动', editedFields: [],
    routeText: 'deepseek-official / deepseek-flash', routeSummary: '低谷期',
    route: { backend: 'llm', provider: 'deepseek-official', model: 'deepseek-flash' }, unavailable: '' },
  { id: 'translate', name: '翻译助手', enabled: true, origin: 'overlay',
    originText: '覆盖层新增的角色', editedFields: ['name', 'description'],
    routeText: 'local-extract', routeSummary: '',
    route: { backend: 'local-extract', provider: '', model: '' }, unavailable: '' }
]

let pass = 0
const it = async (name, fn) => { await fn(); pass++; console.log('  \u2714 ' + name) }

await it('只注册设置左侧导航一项，不再注册内置插件页的 tab', async () => {
  assert.equal(SECTION.spec.name, 'settings.section')
  assert.equal(SECTION.spec.label, 'BYK 助手')
  assert.equal(TAB, undefined, 'settings.plugins.tab 必须不存在：同一设置页不许在两个地方各出现一次')
  assert.equal(registered.filter((r) => r.spec.name === 'settings.section').length, 1, 'settings.section 只注册一次')
})

await it('纯函数：id 校验 / 重复拦截 / 空名称 / 请求体形状', async () => {
  assert.equal(T.ROLE_ID_RE.source, '^[a-z][a-z0-9_-]{0,31}$', 'id 规则要与宿主 lib/assistants.js:37 一致')
  assert.deepEqual(T.BACKEND_OPTIONS, ['llm', 'asr', 'local', 'local-extract'])
  assert.equal(T.validateDraft({ mode: 'add', id: 'Bad ID', name: 'x', fields: { name: 'x' } }).ok, false)
  assert.ok(T.validateDraft({ mode: 'add', id: 'Bad ID', name: 'x', fields: { name: 'x' } }).error.includes('id 不合法'))
  assert.ok(T.validateDraft({ mode: 'add', id: 'code', ids: ['code'], name: 'x', fields: { name: 'x' } }).error.includes('已经有助手在用这个 id'))
  assert.ok(T.validateDraft({ mode: 'add', id: 'ok-id', name: '   ', fields: { name: '  ' } }).error.includes('名称不能为空'))
  assert.deepEqual(T.validateDraft({ mode: 'edit', id: 'ok-id', name: 'x', fields: { name: ' x ' } }), { ok: true, error: '', id: 'ok-id', fields: { name: 'x' } })
  assert.deepEqual(T.crudBody('add-role', 'translate', { name: '翻译', description: '', backend: 'llm' }),
    { action: 'add-role', roleId: 'translate', fields: { name: '翻译', backend: 'llm' } })
  assert.deepEqual(T.crudBody('update-role', 'vision', { backend: 'local-extract' }),
    { action: 'update-role', roleId: 'vision', fields: { backend: 'local-extract' } })
  assert.deepEqual(T.crudBody('remove-role', 'translate'), { action: 'remove-role', roleId: 'translate' })
  assert.equal(T.isBuiltinOrigin('builtin'), true)
  assert.equal(T.isBuiltinOrigin('builtin+overlay'), true)
  assert.equal(T.isBuiltinOrigin('overlay'), false)
})

await it('列表分支一：通道不可用（没有 fetch）时降级渲染、不抛异常', async () => {
  scenario()
  globalThis.fetch = undefined
  render()
  await flush()
  const tree = render()
  assert.ok(text(tree).includes('数据通道不可用'), '要显示通道不可用：' + text(tree).slice(0, 120))
  assert.ok(text(tree).includes('这个界面没有 fetch'))
  globalThis.fetch = (url, init) => { const body = JSON.parse(init.body); fetchCalls.push({ url, body }); return Promise.resolve(reply(body)) }
})

await it('列表分支二：读取中显示「正在读取助手列表…」', async () => {
  scenario()
  reply = () => new Promise(() => {})
  const tree = render()
  assert.ok(text(tree).includes('正在读取助手列表…'))
})

await it('列表分支三：空列表照旧给说明，并且还能新增', async () => {
  scenario()
  reply = listReply([])
  render()
  await flush()
  const tree = render()
  assert.ok(text(tree).includes('宿主返回了空列表'))
  assert.equal(buttons(tree, '新增助手').length >= 1, true, '空列表时也要能新增')
})

await it('列表分支四：有行时渲染名称(id) / 有效模型 / 来源，内置角色删除按钮禁用', async () => {
  scenario()
  reply = listReply(ROWS)
  render()
  await flush()
  const tree = render()
  const t = text(tree)
  assert.ok(t.includes('代码助手（code）'), t.slice(0, 200))
  assert.ok(t.includes('翻译助手（translate）'))
  assert.ok(t.includes('deepseek-official / deepseek-flash'), '要显示当前有效模型')
  assert.ok(t.includes('内置角色（byk/roles.py），覆盖层未改动'), '要显示来源')
  assert.ok(t.includes('内置角色：可以改名 / 停用 / 换模型，不能删除。'))
  const delBuiltin = buttons(tree, '删除（内置不可删）')[0]
  assert.ok(delBuiltin, '内置角色要有删除按钮（禁用 + 文案）')
  assert.equal(delBuiltin.props.disabled, true, '内置角色的删除按钮必须禁用')
  assert.equal(delBuiltin.props.title, '内置角色不可删除，只能停用')
  assert.equal(buttons(tree, '删除')[0].props.disabled, false, '覆盖层新增的角色可以删（按钮可用）')
  assert.equal(buttons(tree, '编辑').length, 2, '每行都有编辑按钮')
})

await it('编辑提交：请求形状是 update-role + roleId + fields，成功后再拉一次列表', async () => {
  scenario()
  reply = listReply(ROWS)
  render()
  await flush()
  let tree = render()
  buttons(tree, '编辑')[0].props.onClick()
  tree = render()
  let fields = inputs(tree)
  assert.equal(fields.length, 6, '编辑表单：name/description/backend/provider/model/reasoningEffort')
  assert.equal(fields[0].props.value, '代码助手', '名称要用当前值预填')
  fields[4].props.onChange({ target: { value: 'deepseek-v4' } })
  tree = render()
  const before = fetchCalls.length
  buttons(tree, '保存')[0].props.onClick()
  await flush()
  const sent = fetchCalls[before]
  assert.deepEqual(sent.body, {
    action: 'update-role',
    roleId: 'code',
    fields: { name: '代码助手', backend: 'llm', provider: 'deepseek-official', model: 'deepseek-v4' }
  })
  assert.ok(expectedListCall(fetchCalls, before), '写成功后要重新拉列表')
  tree = render()
  assert.ok(!text(tree).includes('update-role'), '请求体不该漏到界面上')
})
function expectedListCall(calls, from) {
  return calls.slice(from + 1).some((c) => c.body.action === 'list')
}

await it('新增：非法 id 被本地拦下，且一个请求都不发', async () => {
  scenario()
  reply = listReply(ROWS)
  render()
  await flush()
  let tree = render()
  buttons(tree, '新增助手')[0].props.onClick()
  tree = render()
  let f = inputs(tree)
  f[0].props.onChange({ target: { value: 'Bad ID' } })
  tree = render()
  f = inputs(tree)
  f[1].props.onChange({ target: { value: '翻译助手' } })
  tree = render()
  const before = fetchCalls.length
  submitAdd(tree).props.onClick()
  tree = render()
  assert.equal(fetchCalls.length, before, '非法 id 不许发请求')
  assert.ok(text(tree).includes('助手 id 不合法'), '要给出可读中文提示：' + text(tree).slice(0, 200))
})

await it('新增：id 与已有助手重复时被拦下', async () => {
  scenario()
  reply = listReply(ROWS)
  render()
  await flush()
  let tree = render()
  buttons(tree, '新增助手')[0].props.onClick()
  tree = render()
  let f = inputs(tree)
  f[0].props.onChange({ target: { value: 'code' } })
  tree = render()
  f = inputs(tree)
  f[1].props.onChange({ target: { value: '代码助手二号' } })
  f[2].props.onChange({ target: { value: '说明' } })
  tree = render()
  const before = fetchCalls.length
  submitAdd(tree).props.onClick()
  tree = render()
  assert.equal(fetchCalls.length, before)
  assert.ok(text(tree).includes('已经有助手在用这个 id 了：code'))
})

await it('新增：合法提交发 add-role（fields 只带填过的项）并刷新列表', async () => {
  scenario()
  reply = listReply(ROWS)
  render()
  await flush()
  let tree = render()
  buttons(tree, '新增助手')[0].props.onClick()
  tree = render()
  let f = inputs(tree)
  f[0].props.onChange({ target: { value: 'translate2' } })
  tree = render()
  f = inputs(tree)
  f[1].props.onChange({ target: { value: '翻译助手' } })
  f[2].props.onChange({ target: { value: '把中文翻成英文' } })
  tree = render()
  const before = fetchCalls.length
  submitAdd(tree).props.onClick()
  await flush()
  assert.deepEqual(fetchCalls[before].body, {
    action: 'add-role',
    roleId: 'translate2',
    fields: { name: '翻译助手', description: '把中文翻成英文', backend: 'llm' }
  })
  assert.ok(expectedListCall(fetchCalls, before), '新增成功后要刷新列表')
})

await it('删除：内置角色连确认都过不去（不发 remove-role）；覆盖层新增的能删', async () => {
  scenario()
  reply = listReply(ROWS)
  render()
  await flush()
  let tree = render()
  buttons(tree, '删除（内置不可删）')[0].props.onClick()
  tree = render()
  const confirm = collect(tree, (n) => n.props && (n.props.className || '').indexOf('byk-set-btn-danger') >= 0)[0]
  assert.ok(confirm, '要先出确认按钮')
  let before = fetchCalls.length
  confirm.props.onClick()
  tree = render()
  assert.equal(fetchCalls.length, before, '内置角色不许发 remove-role')
  assert.ok(text(tree).includes('内置角色不可删除，只能停用：code'))
  buttons(tree, '删除')[0].props.onClick()
  tree = render()
  const confirm2 = collect(tree, (n) => n.props && (n.props.className || '').indexOf('byk-set-btn-danger') >= 0)[0]
  before = fetchCalls.length
  confirm2.props.onClick()
  await flush()
  assert.deepEqual(fetchCalls[before].body, { action: 'remove-role', roleId: 'translate' })
})

await it('错误回显：宿主返回 ok:false 时把中文错误显示在界面上', async () => {
  scenario()
  reply = (body) => body.action === 'list'
    ? { ok: true, status: 200, json: () => Promise.resolve({ ok: true, assistants: ROWS }) }
    : { ok: true, status: 400, json: () => Promise.resolve({ ok: false, error: '内置角色不可删除，只能停用' }) }
  render()
  await flush()
  let tree = render()
  buttons(tree, '编辑')[1].props.onClick()
  tree = render()
  buttons(tree, '保存')[0].props.onClick()
  await flush()
  tree = render()
  assert.ok(text(tree).includes('HTTP 400'), '非 2xx 要带状态码：' + text(tree).slice(0, 200))
  assert.ok(text(tree).includes('内置角色不可删除，只能停用'))
  assert.equal(collect(tree, (n) => n.props && (n.props.className || '').indexOf('byk-set-error') >= 0).length >= 1, true)
})

console.log('\nsettings-crud.test.js: ' + pass + ' 例全过')