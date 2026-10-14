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
 * ⚠️ 能力边界，不得含糊：**子智能体的审批不会被展示**，也不会被本模块看到。
 * 子会话的审批策略被 delegation 钉死为 never（user-approval src\index.ts:73），
 * 审批在子会话里直接被自动拒绝、根本不产生 approval-gate 事件，因此镜像条无从显示。
 * 本模块展示的只是「其它会话（若它们真的跑在 auto-approve preset 上）产生的 gate 事件」。
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
      '.byk-empty{flex:1 1 auto;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;font-size:13px;line-height:20px;padding:24px;text-align:center}'
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

    // ============ 跨会话提示条：conversation.input.dock（order=31，排在原生 order=30 之后） ============
    function MirrorNotice(props) {
      const frame = useFrame(props)
      const mirror = useMirror(frame.sessionId)
      const [dismissed, setDismissed] = React.useState(null)
      const notice = mirror.notice
      if (!notice) return null
      if (dismissed === notice.id) return null
      const kind = notice.kind || 'auto'
      const isPending = kind === 'manual-pending'
      const isRejected = kind === 'manual-rejected'
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
            )
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
        React.createElement('div', { className: 'byk-view-sub' }, '只显示其它会话的审批事件；当前会话的审批见「审批」页签。子智能体的审批不会被展示。')
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

        // 输入框上方独立行：排在 approval-gate 原生条（order=30）之后。
        slots.inject('conversation.input.dock', function () {
          return slots.register(
            { name: 'conversation.input.dock', id: 'byk-agents.approval-mirror', order: 31, label: '跨会话审批提示' },
            function (props) { return React.createElement(MirrorNotice, { slotsProps: props }) }
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
      }
    }

    exports.default = plugin
    exports.apply = plugin.apply
    exports.inject = plugin.inject
    return module.exports
  },
})
