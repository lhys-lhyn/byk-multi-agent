// dsh-plugin-byk-agents — 设置页数据通道的确定性测试（s5-pre）
//
// 三层都断言，但**不起子进程、不连网络、不开端口**：
//   1. 客户端请求形状（bundle 的 __test.channelBody / channelCall）
//   2. 宿主处理函数的成功与失败分支（handleRequest + 假 req/res 走 createRouteHandler）
//   3. 非法输入被拒 —— 跑的是 lib/assistants.js 真正那份校验，不是测试里另写的一套
//   4. 通道不可用时的降级（没有 fetch / 网络抛错 / 非 2xx / 非 JSON 一律结构化失败）
//
// 运行：node test/settings-channel.test.js
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

import {
  SETTINGS_ROUTE,
  CHANNEL_ACTIONS,
  MAX_BODY_BYTES,
  parseRequest,
  handleRequest,
  createRouteHandler,
  buildAssistantRows,
} from '../lib/settings-channel.js'
import {
  emptyOverlay,
  explainPath,
  loadOverlay,
  roleIdsOf,
  saveOverlay,
  setEnabled,
} from '../lib/assistants.js'
import { describeEffectiveRoute } from '../lib/routing.js'

const here = dirname(fileURLToPath(import.meta.url))

let pass = 0
const step = (name) => { pass++; console.log('  \u2714 ' + name) }

// ───────────────────────────────────────────────────────────────────────────
// 【1】通道常量与请求形状
// ───────────────────────────────────────────────────────────────────────────
assert.equal(SETTINGS_ROUTE, '/api/byk/assistants')
assert.deepEqual(CHANNEL_ACTIONS, ['list', 'set-enabled', 'add-role', 'update-role', 'remove-role'])
assert.ok(MAX_BODY_BYTES > 0)
step('通道路径与动作集合固定')

assert.deepEqual(parseRequest(''), { ok: true, action: 'list', roleId: '', enabled: undefined, error: '' })
assert.deepEqual(parseRequest('{}'), { ok: true, action: 'list', roleId: '', enabled: undefined, error: '' })
assert.equal(parseRequest(null).action, 'list', '空 body 当成 list')
assert.equal(parseRequest({ op: 'list' }).action, 'list', 'op 是 action 的短写法')
assert.equal(parseRequest({ action: 'set-enabled', roleId: 'code', enabled: true }).enabled, true)
step('合法请求解析出 {action, roleId, enabled}')

// ───────────────────────────────────────────────────────────────────────────
// 【2】非法请求一律被拒，且带可读原因（不静默）
// ───────────────────────────────────────────────────────────────────────────
const rBadJson = parseRequest('{not json')
assert.equal(rBadJson.ok, false)
assert.match(rBadJson.error, /JSON/)
const rBadAction = parseRequest({ action: 'delete-everything' })
assert.equal(rBadAction.ok, false)
assert.match(rBadAction.error, /delete-everything/)
const rNoRole = parseRequest({ action: 'set-enabled', enabled: true })
assert.equal(rNoRole.ok, false)
assert.match(rNoRole.error, /roleId/)
const rBadEnabled = parseRequest({ action: 'set-enabled', roleId: 'code', enabled: 'yes' })
assert.equal(rBadEnabled.ok, false)
assert.match(rBadEnabled.error, /enabled/)
assert.equal(parseRequest([]).ok, false, '数组不是请求体')
assert.equal(parseRequest('123').ok, false, '标量不是请求体')
step('未知动作 / 缺 roleId / enabled 不是布尔 / 坏 JSON 全部拒绝')

// ───────────────────────────────────────────────────────────────────────────
// 【3】宿主处理函数：成功与失败分支
// ───────────────────────────────────────────────────────────────────────────
const okList = async () => ({ ok: true, assistants: [{ id: 'code', name: '代码助手' }], overlayPath: 'X', overlayError: '' })
const failList = async () => ({ ok: false, error: '注册表读不出来' })
const boomList = async () => { throw new Error('炸了') }

const rList = await handleRequest({ action: 'list' }, { list: okList })
assert.equal(rList.status, 200)
assert.equal(rList.body.ok, true)
assert.equal(rList.body.assistants.length, 1)
assert.equal(rList.body.overlayPath, 'X')
step('list 成功 -> 200 + assistants')

const rListFail = await handleRequest({ action: 'list' }, { list: failList })
assert.equal(rListFail.status, 400)
assert.equal(rListFail.body.ok, false)
assert.equal(rListFail.body.error, '注册表读不出来')
step('list 失败 -> 400 且原因原样透传')

const rListBoom = await handleRequest({ action: 'list' }, { list: boomList })
assert.equal(rListBoom.status, 500)
assert.match(rListBoom.body.error, /炸了/)
step('宿主实现抛异常 -> 500，不把异常抛给 HTTP 层')

const rNoImpl = await handleRequest({ action: 'list' }, {})
assert.equal(rNoImpl.status, 400)
assert.match(rNoImpl.body.error, /list/)
step('宿主没提供实现 -> 400 且说明缺哪一个')

const okWrite = async (roleId, enabled) => ({ ok: true, roleId, enabled, overlayPath: 'Y' })
const rWrite = await handleRequest({ action: 'set-enabled', roleId: 'code', enabled: false }, { setEnabled: okWrite })
assert.equal(rWrite.status, 200)
assert.equal(rWrite.body.roleId, 'code')
assert.equal(rWrite.body.enabled, false)
step('set-enabled 成功 -> 200 并回带新状态')

const rWriteBad = await handleRequest({ action: 'set-enabled', roleId: 'code', enabled: 'yes' }, { setEnabled: okWrite })
assert.equal(rWriteBad.status, 400)
assert.equal(rWriteBad.body.ok, false, '非法输入连宿主实现都不该进')
step('set-enabled 非法输入在通道层就被挡下')

// ───────────────────────────────────────────────────────────────────────────
// 【4】真 HTTP 语义：GET / POST / 其它方法 / 超大 body / 坏 JSON
// ───────────────────────────────────────────────────────────────────────────
function fakeRes() {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(text) { out.body = text === undefined ? '' : String(text) },
  }
}
function fakeReq(method, bodyText, declaredLength) {
  const chunks = bodyText === undefined ? [] : [Buffer.from(String(bodyText), 'utf8')]
  const headers = {}
  if (declaredLength !== undefined) headers['content-length'] = String(declaredLength)
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}
const route = createRouteHandler({ list: okList, setEnabled: okWrite })

const resGet = fakeRes()
await route(fakeReq('GET'), resGet)
assert.equal(resGet.out.status, 200)
assert.equal(JSON.parse(resGet.out.body).assistants.length, 1)
step('GET /api/byk/assistants 直接列助手（方便 curl 排查）')

const resPost = fakeRes()
await route(fakeReq('POST', JSON.stringify({ action: 'set-enabled', roleId: 'code', enabled: true })), resPost)
assert.equal(resPost.out.status, 200)
assert.equal(JSON.parse(resPost.out.body).enabled, true)
step('POST 按 body 里的 action 分发')

const resPut = fakeRes()
await route(fakeReq('PUT', '{}'), resPut)
assert.equal(resPut.out.status, 405)
step('其它方法 -> 405')

const resBig = fakeRes()
await route(fakeReq('POST', '{}', MAX_BODY_BYTES + 1), resBig)
assert.equal(resBig.out.status, 413)
step('声明超长的 body -> 413，不读进内存')

const resBad = fakeRes()
await route(fakeReq('POST', '{半截'), resBad)
assert.equal(resBad.out.status, 400)
assert.match(JSON.parse(resBad.out.body).error, /JSON/)
step('坏 JSON -> 400 且带原因')

// ───────────────────────────────────────────────────────────────────────────
// 【5】真的落盘：复用 lib/assistants.js 的校验，非法输入不碰文件
// ───────────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'byk-settings-'))
const overlayFile = join(dir, 'assistants.local.json')
const builtinIds = ['code', 'vision']
const registry = { code: { name: '代码助手' }, vision: { name: '视觉助手' } }

const deps = {
  list: async () => {
    const loaded = loadOverlay(overlayFile)
    const overlay = loaded.existed ? loaded.overlay : emptyOverlay()
    const ids = roleIdsOf(registry, overlay, { builtinIds })
    const assistants = buildAssistantRows({
      ids,
      registry,
      overlay,
      config: undefined,
      now: 1760000000,
      describe: describeEffectiveRoute,
      explain: explainPath,
    })
    return { ok: true, assistants, overlayPath: overlayFile, overlayError: loaded.ok ? '' : loaded.error }
  },
  setEnabled: async (roleId, enabled) => {
    const loaded = loadOverlay(overlayFile)
    if (!loaded.ok) return { ok: false, error: '覆盖层读取失败，拒绝写入：' + loaded.error }
    const overlay = loaded.existed ? loaded.overlay : emptyOverlay()
    const next = setEnabled(overlay, roleId, enabled, { builtinIds })
    if (!next.ok) return { ok: false, error: next.errors.join('；') }
    const saved = saveOverlay(overlayFile, next.overlay, { builtinIds })
    if (!saved.ok) return { ok: false, error: saved.error }
    return { ok: true, roleId, enabled: enabled === true, overlayPath: overlayFile }
  },
}

const first = await handleRequest({ action: 'list' }, deps)
assert.equal(first.status, 200)
assert.deepEqual(first.body.assistants.map((a) => a.id), ['code', 'vision'])
const codeRow = first.body.assistants[0]
assert.equal(codeRow.name, '代码助手')
assert.equal(codeRow.enabled, true)
assert.ok(codeRow.routeText.length > 0, '每一行都要能说出当前用什么模型/后端')
step('list 给出行：id / 名称 / 是否启用 / 当前路由')

const off = await handleRequest({ action: 'set-enabled', roleId: 'code', enabled: false }, deps)
assert.equal(off.status, 200)
assert.equal(JSON.parse(readFileSync(overlayFile, 'utf8')).roles.code.enabled, false)
step('set-enabled 真的写进了 assistants.local.json')

const afterOff = await handleRequest({ action: 'list' }, deps)
assert.equal(afterOff.body.assistants[0].enabled, false)
step('写回后列表反映新状态')

const before = readFileSync(overlayFile, 'utf8')
const unknown = await handleRequest({ action: 'set-enabled', roleId: 'no-such-role', enabled: true }, deps)
assert.equal(unknown.status, 400)
assert.match(unknown.body.error, /no-such-role/)
assert.equal(readFileSync(overlayFile, 'utf8'), before, '拒绝的请求不许碰文件')
step('不存在的角色被拒，文件原封不动')

const badId = await handleRequest({ action: 'set-enabled', roleId: '国产角色', enabled: true }, deps)
assert.equal(badId.status, 400)
assert.equal(readFileSync(overlayFile, 'utf8'), before)
step('非法角色 id 被拒（ROLE_ID_RE），文件原封不动')

// 行构造的降级：一个坏的/停用的角色不能让整页空白
const rows = buildAssistantRows({
  ids: ['code', 'vision', 'ghost'],
  registry: { code: { name: '代码助手' }, vision: { name: '视觉助手', enabled: false } },
  overlay: null,
  now: 1760000000,
  describe: describeEffectiveRoute,
  explain: explainPath,
})
assert.equal(rows.length, 3)
assert.equal(rows[0].unavailable, '')
assert.equal(rows[0].enabled, true)
assert.equal(rows[1].enabled, false, '注册表说停用，行就是停用')
assert.ok(rows[2].unavailable.length > 0, '路由解析不了的角色要写上原因，而不是把整页炸掉')
const noDescribe = buildAssistantRows({ ids: ['code'], registry, overlay: null, describe: null })
assert.match(noDescribe[0].unavailable, /路由/)
step('单个角色解析失败 -> 该行写原因，整页仍在')

// ───────────────────────────────────────────────────────────────────────────
// 【6】客户端半区：请求形状 + 通道不可用时的降级
// ───────────────────────────────────────────────────────────────────────────
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
let def = null
const fakeWindow = { __ModuleLoader__: { load: (d) => { def = d } } }
new Function('window', src)(fakeWindow)
assert.equal(def && def.id, 'dsh-plugin-byk-agents', 'bundle 必须以 dsh-plugin-byk-agents 注册')

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
}
const mod = def.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
const T = mod.__test
assert.ok(T && typeof T.channelBody === 'function', 'bundle 必须导出设置通道的 __test 纯函数')
assert.equal(T.CHANNEL_PATH, SETTINGS_ROUTE, '两半区的路径必须是同一个常量')

assert.deepEqual(T.channelBody('list'), { action: 'list' })
assert.deepEqual(T.channelBody('set-enabled', 'code', false), { action: 'set-enabled', roleId: 'code', enabled: false })
assert.deepEqual(T.channelBody('set-enabled', 'code', 'yes'), { action: 'set-enabled', roleId: 'code', enabled: false }, '非布尔一律当 false，宿主会再挡一次')
step('客户端请求形状与宿主 parseRequest 对得上')

assert.equal(T.normalizeChannelResponse(null).ok, false)
assert.equal(T.normalizeChannelResponse({ ok: false, error: '宿主拒绝了这次请求' }).error, '宿主拒绝了这次请求')
assert.equal(T.normalizeChannelResponse({ ok: true, assistants: [{ id: 'code' }] }).assistants.length, 1)
assert.deepEqual(T.normalizeChannelResponse({ ok: true }).assistants, [], '缺 assistants 当成空列表而不是崩')
step('响应归一化：非 JSON / ok:false / 缺字段都有确定结果')

const vRow = T.assistantRowView({})
assert.equal(vRow.id, '')
assert.equal(vRow.enabled, false)
assert.equal(vRow.model, '')
step('未知行渲染成空模型而不是 undefined')

const realFetch = globalThis.fetch
let seen = null
try {
  globalThis.fetch = undefined
  const noFetch = await T.channelCall('list')
  assert.equal(noFetch.ok, false)
  assert.match(noFetch.error, /fetch/)
  step('通道不可用时返回可读错误（设置页据此显示一行说明，不假装开关有效）')

  globalThis.fetch = async (url, init) => {
    seen = { url, init }
    return { status: 200, json: async () => ({ ok: true, assistants: [{ id: 'code' }] }) }
  }
  const ok = await T.channelCall('set-enabled', 'code', true)
  assert.equal(ok.ok, true)
  assert.equal(seen.url, '/api/byk/assistants', '必须是同源相对路径')
  assert.deepEqual(JSON.parse(seen.init.body), { action: 'set-enabled', roleId: 'code', enabled: true })
  step('同源 POST，body 与宿主约定一致')

  globalThis.fetch = async () => ({ status: 500, json: async () => ({ ok: false, error: 'boom' }) })
  const bad = await T.channelCall('list')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /HTTP 500/)
  step('非 2xx -> 结构化失败并带上状态码')

  globalThis.fetch = async () => { throw new Error('net down') }
  const thrown = await T.channelCall('list')
  assert.equal(thrown.ok, false)
  assert.match(thrown.error, /net down/)
  step('网络抛错被收敛，不冒到渲染层')
} finally {
  if (realFetch === undefined) delete globalThis.fetch
  else globalThis.fetch = realFetch
}

assert.ok(src.indexOf('数据通道不可用：') > 0, '设置页必须有「通道不可用」的降级文案')
step('降级文案在渲染代码里（通道不可用时显示的就是它）')

// ───────────────────────────────────────────────────────────────────────────
rmSync(dir, { recursive: true, force: true })
console.log('settings-channel.test.js：' + pass + ' 项全部通过')
