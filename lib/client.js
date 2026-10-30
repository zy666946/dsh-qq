/**
 * dsh-qq —— 浏览器半侧：设置 → 「QQ」页
 *
 * 手写 __ModuleLoader__ bundle（无构建工具），只 require 宿主的 react。
 * 与宿主走同源 HTTP：/api/qq/*（由 lib/index.js 里的本地 HTTP 服务提供）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var API = '/api/qq'
    var NS = 'dsh-qq'

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var message = data && data.error ? data.error : ('HTTP ' + res.status)
          throw new Error(message)
        }
        return data
      })
    }
    function apiGet(path) { return fetch(API + path, { cache: 'no-store' }).then(readJson) }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n }
    function ago(ms) {
      if (!ms) return '—'
      var diff = Date.now() - ms
      if (diff < 0) return '刚刚'
      var m = Math.round(diff / 60000)
      if (m < 1) return '刚刚'
      if (m < 60) return m + ' 分钟前'
      var hh = Math.floor(m / 60)
      if (hh < 24) return hh + ' 小时前'
      return Math.floor(hh / 24) + ' 天前'
    }
    function fmtDuration(ms) {
      if (!ms) return '—'
      var s = Math.round(ms / 1000)
      if (s < 60) return s + ' 秒'
      var m = Math.floor(s / 60)
      if (m < 60) return m + ' 分钟'
      var hh = Math.floor(m / 60)
      return hh + ' 小时 ' + (m % 60) + ' 分'
    }
    function fmtNum(n) {
      var v = Number(n)
      return isFinite(v) ? v.toLocaleString('zh-CN') : '0'
    }

    var CSS = [
      '.qq-root{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#241f18);}',
      '.qq-card{background:var(--dsw-alias-bg-secondary,#fbf8f2);border:1px solid var(--dsw-alias-border-secondary,#e6dfd2);border-radius:14px;padding:14px 16px;}',
      '.qq-title{font-size:13.5px;font-weight:600;margin:0 0 10px;display:flex;align-items:center;gap:8px;}',
      '.qq-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success,#2f6b46);}',
      '.qq-dot-off{background:var(--dsw-alias-state-error,#a83a2c);}',
      '.qq-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-secondary,#eee7da);}',
      '.qq-row:last-child{border-bottom:0;}',
      '.qq-k{color:var(--dsw-alias-label-secondary,#6f6558);font-size:12.5px;}',
      '.qq-v{font-size:12.5px;text-align:right;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.qq-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;}',
      '.qq-field{display:flex;flex-direction:column;gap:5px;}',
      '.qq-label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.qq-input{height:32px;border-radius:9px;border:1px solid var(--dsw-alias-border-secondary,#ddd5c6);background:var(--dsw-alias-bg-primary,#fffdf8);color:inherit;padding:0 10px;font-size:12.5px;outline:none;min-width:0;}',
      '.qq-input:focus{border-color:var(--dsw-alias-brand-primary,#241f18);}',
      '.qq-toggle{display:flex;align-items:center;gap:9px;cursor:pointer;user-select:none;padding:6px 0;}',
      '.qq-toggle input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#241f18);cursor:pointer;}',
      '.qq-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.qq-btn{height:32px;padding:0 15px;border-radius:9px;border:1px solid var(--dsw-alias-border-secondary,#ddd5c6);background:var(--dsw-alias-bg-primary,#fffdf8);color:inherit;font-size:12.5px;cursor:pointer;}',
      '.qq-btn:hover{background:var(--dsw-alias-bg-tertiary,#f2ece0);}',
      '.qq-btn:disabled{opacity:.5;cursor:default;}',
      '.qq-btn-primary{background:var(--dsw-alias-brand-primary,#241f18);border-color:transparent;color:var(--dsw-alias-label-on-brand,#fffdf8);}',
      '.qq-msg{font-size:12.5px;border-radius:10px;padding:9px 12px;line-height:1.6;border:1px solid var(--dsw-alias-border-secondary,#e0d7c8);background:var(--dsw-alias-bg-primary,#fffdf8);}',
      '.qq-msg-ok{color:var(--dsw-alias-state-success,#2f6b46);border-color:rgba(47,107,70,.35);}',
      '.qq-msg-err{color:var(--dsw-alias-state-error,#a83a2c);border-color:rgba(168,58,44,.35);}',
      '.qq-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9084);line-height:1.6;}',
      '.qq-bar{height:8px;border-radius:999px;background:var(--dsw-alias-bg-tertiary,#f2ece0);overflow:hidden;margin:2px 0 5px;}',
      '.qq-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#241f18);transition:width .25s ease;}',
      '.qq-ctx-num{font-variant-numeric:tabular-nums;}',
      '.qq-loading{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#9a9084);padding:18px 0;}',
    ].join('')

    function QqSection(props) {
      var [data, setData] = useState(null)
      var [form, setForm] = useState(null)
      var [error, setError] = useState(null)
      var [notice, setNotice] = useState(null)
      var [busy, setBusy] = useState('')

      var load = useCallback(function () {
        return apiGet('/state').then(function (res) {
          setData(res)
          setError(null)
          return res
        }).catch(function (e) { setError(e.message) })
      }, [])

      useEffect(function () { load() }, [load])

      useEffect(function () {
        if (!data || !data.config || form !== null) return
        var c = data.config
        setForm({
          enabled: c.enabled !== false,
          onebotUrl: c.onebotUrl || '',
          selfId: c.selfId || '',
          allowUsers: (c.allowUsers || []).join(','),
          allowGroups: (c.allowGroups || []).join(','),
          groupAtOnly: c.groupAtOnly !== false,
          politeReject: c.politeReject !== false,
          profile: c.profile || 'qq',
          dshBin: c.dshBin || 'dsh',
          cwd: c.cwd || '',
          qzoneEnabled: c.qzoneEnabled !== false,
          permissionMode: c.permissionMode || 'danger-full-access',
        })
      }, [data, form])

      function update(key, value) {
        setForm(function (prev) {
          var next = {}
          for (var k in prev) next[k] = prev[k]
          next[key] = value
          return next
        })
      }

      function save() {
        if (!form) return
        setBusy('save')
        setNotice(null)
        apiPost('/config', {
          enabled: form.enabled,
          onebotUrl: form.onebotUrl,
          selfId: form.selfId,
          allowUsers: form.allowUsers,
          allowGroups: form.allowGroups,
          groupAtOnly: form.groupAtOnly,
          politeReject: form.politeReject,
          profile: form.profile,
          dshBin: form.dshBin,
          cwd: form.cwd,
          qzoneEnabled: form.qzoneEnabled,
          permissionMode: form.permissionMode,
        }).then(function () {
          setNotice({ kind: 'ok', text: '已保存并生效（连接参数变了会自动重连）' })
          return load()
        }).catch(function (e) {
          setNotice({ kind: 'err', text: '保存失败：' + e.message })
        }).then(function () { setBusy('') })
      }

      function reconnect() {
        setBusy('reconnect')
        setNotice(null)
        apiPost('/reconnect', {}).then(function () {
          setNotice({ kind: 'ok', text: '已发起重连，几秒后看状态' })
          setTimeout(load, 2500)
        }).catch(function (e) {
          setNotice({ kind: 'err', text: '重连失败：' + e.message })
        }).then(function () { setBusy('') })
      }

      function sendTest() {
        setBusy('test')
        setNotice(null)
        apiPost('/test', { text: '这是 dsh-qq 的测试消息 🐟' }).then(function (res) {
          setNotice({ kind: 'ok', text: '已发送（如果没收到，检查白名单里有没有你的号）' })
        }).catch(function (e) {
          setNotice({ kind: 'err', text: '发送失败：' + e.message })
        }).then(function () { setBusy('') })
      }

      if (error) {
        return h('div', { className: 'qq-root' },
          h('div', { className: 'qq-msg qq-msg-err' }, '读不到 QQ 插件状态：' + error),
          h('div', { className: 'qq-hint' }, 'dsh-qq 的接口在每个实例的 thinkPort（默认 3002）上；如果端口被占用，插件会在日志里提示。'))
      }
      if (!data || !form) return h('div', { className: 'qq-loading' }, '正在读取 QQ 状态…')

      var rt = data.runtime || {}
      var stats = rt.stats || {}

      return h('div', { className: 'qq-root' },

        h('div', { className: 'qq-card' },
          h('div', { className: 'qq-title' },
            h('span', { className: 'qq-dot' + (rt.connected ? '' : ' qq-dot-off') }),
            rt.connected ? 'QQ 已连接' : 'QQ 未连接'),
          h('div', { className: 'qq-row' }, h('span', { className: 'qq-k' }, '登录账号'),
            h('span', { className: 'qq-v' }, rt.login ? (rt.login.nickname + '（' + rt.login.user_id + '）') : '—')),
          h('div', { className: 'qq-row' }, h('span', { className: 'qq-k' }, '运行时长'),
            h('span', { className: 'qq-v' }, fmtDuration(Date.now() - (rt.startedAt || Date.now())))),
          h('div', { className: 'qq-row' }, h('span', { className: 'qq-k' }, '收到 / 回复 / 拒绝'),
            h('span', { className: 'qq-v' }, (stats.received || 0) + ' / ' + (stats.replied || 0) + ' / ' + (stats.rejected || 0))),
          h('div', { className: 'qq-row' }, h('span', { className: 'qq-k' }, '处理中'),
            h('span', { className: 'qq-v' }, rt.working ? '正在想…（排队 ' + rt.queue + '）' : '空闲')),
          h('div', { className: 'qq-row' }, h('span', { className: 'qq-k' }, '最后一条消息'),
            h('span', { className: 'qq-v' }, rt.lastMessageAt ? ago(rt.lastMessageAt) + '：' + (rt.lastMessageText || '') : '—')),
          rt.lastError ? h('div', { className: 'qq-msg qq-msg-err', style: { marginTop: '10px' } }, '最近错误：' + rt.lastError) : null,
        ),

        (function () {
          var ctx = rt.context || {}
          var pct = Number(ctx.percent) || 0
          var width = Math.max(0, Math.min(100, pct))
          return h('div', { className: 'qq-card' }, [
            h('div', { key: 't', className: 'qq-title' }, '上下文用量'),
            h('div', { key: 'r1', className: 'qq-row' }, [
              h('span', { key: 'k', className: 'qq-k' }, '已用 / 上限'),
              h('span', { key: 'v', className: 'qq-v qq-ctx-num' }, fmtNum(ctx.usedTokens) + ' / ' + fmtNum(ctx.contextWindow) + ' token'),
            ]),
            h('div', { key: 'bar', className: 'qq-bar' },
              h('div', { className: 'qq-bar-fill', style: { width: width.toFixed(1) + '%' } })),
            h('div', { key: 'r2', className: 'qq-row' }, [
              h('span', { key: 'k', className: 'qq-k' }, '占比'),
              h('span', { key: 'v', className: 'qq-v qq-ctx-num' }, pct.toFixed(1) + '%'),
            ]),
            h('div', { key: 'd', className: 'qq-hint' },
              '输入 ' + fmtNum(ctx.inputTokens) + ' · 输出 ' + fmtNum(ctx.outputTokens) + ' · 缓存读取 ' + fmtNum(ctx.cacheReadTokens)
              + (ctx.updatedAt ? ' · ' + ago(ctx.updatedAt) : '')),
            !ctx.contextWindow
              ? h('div', { key: 'w', className: 'qq-hint' }, '还没拿到上下文窗口；发一条消息后会自动更新。')
              : null,
          ])
        })(),

        h('div', { className: 'qq-card' },
          h('div', { className: 'qq-title' }, '连接'),
          h('div', { className: 'qq-grid' },
            h('div', { className: 'qq-field' },
              h('span', { className: 'qq-label' }, 'OneBot WebSocket 地址'),
              h('input', {
                className: 'qq-input', type: 'text',
                placeholder: 'ws://127.0.0.1:3001?access_token=xxx',
                value: form.onebotUrl,
                onChange: function (e) { update('onebotUrl', e.target.value) },
              })),
            h('div', { className: 'qq-field' },
              h('span', { className: 'qq-label' }, '机器人 QQ 号（selfId）'),
              h('input', {
                className: 'qq-input', type: 'text', placeholder: '123456789',
                value: form.selfId,
                onChange: function (e) { update('selfId', e.target.value) },
              })),
          ),
          h('label', { className: 'qq-toggle' },
            h('input', { type: 'checkbox', checked: form.enabled, onChange: function (e) { update('enabled', e.target.checked) } }),
            h('span', null, '启用 QQ 插件')),
        ),

        h('div', { className: 'qq-card' },
          h('div', { className: 'qq-title' }, '谁可以跟我说话'),
          h('div', { className: 'qq-field' },
            h('span', { className: 'qq-label' }, '私聊白名单（QQ 号，逗号分隔）'),
            h('input', {
              className: 'qq-input', type: 'text', placeholder: '10001,10002',
              value: form.allowUsers,
              onChange: function (e) { update('allowUsers', e.target.value) },
            })),
          h('div', { className: 'qq-field', style: { marginTop: '10px' } },
            h('span', { className: 'qq-label' }, '群白名单（群号，逗号分隔；留空则不进任何群）'),
            h('input', {
              className: 'qq-input', type: 'text', placeholder: '123456789',
              value: form.allowGroups,
              onChange: function (e) { update('allowGroups', e.target.value) },
            })),
          h('label', { className: 'qq-toggle' },
            h('input', { type: 'checkbox', checked: form.groupAtOnly, onChange: function (e) { update('groupAtOnly', e.target.checked) } }),
            h('span', null, '群里只在 @ 我时回复')),
          h('label', { className: 'qq-toggle' },
            h('input', { type: 'checkbox', checked: form.politeReject, onChange: function (e) { update('politeReject', e.target.checked) } }),
            h('span', null, '陌生人私聊时礼貌拒绝（关掉则完全静默）')),
        ),

        h('div', { className: 'qq-card' },
          h('div', { className: 'qq-title' }, '能力与权限'),
          h('label', { className: 'qq-toggle' },
            h('input', {
              type: 'checkbox',
              checked: form.qzoneEnabled,
              onChange: function (e) { update('qzoneEnabled', e.target.checked) },
            }),
            h('span', null, '允许发 QQ 空间说说（默认仅自己可见）')),
          h('div', { className: 'qq-hint', style: { marginBottom: '10px' } },
            '关掉后 /api/qq/qzone 会返回 403，QQ 里说「发条说说」也不会发出去。'),
          h('div', { className: 'qq-field' },
            h('span', { className: 'qq-label' }, 'QQ 会话权限'),
            h('select', {
              className: 'qq-input',
              value: form.permissionMode,
              onChange: function (e) { update('permissionMode', e.target.value) },
            },
              h('option', { value: 'danger-full-access' }, '完全权限（可执行命令、读写任意文件、不询问）'),
              h('option', { value: 'workspace-write' }, '工作区可写（超出范围会询问）'),
              h('option', { value: 'read-only' }, '只读（不能改任何文件）'),
            )),
          h('div', { className: 'qq-hint', style: { marginTop: '6px' } },
            '改权限后会自动重建思考进程，下一条消息生效。完全权限意味着它能执行任意命令，请确认你信任它。'),
        ),

        h('div', { className: 'qq-card' },
          h('div', { className: 'qq-title' }, '思考引擎'),
          h('div', { className: 'qq-grid' },
            h('div', { className: 'qq-field' },
              h('span', { className: 'qq-label' }, 'SDK profile'),
              h('input', {
                className: 'qq-input', type: 'text', placeholder: 'qq',
                value: form.profile,
                onChange: function (e) { update('profile', e.target.value) },
              })),
            h('div', { className: 'qq-field' },
              h('span', { className: 'qq-label' }, 'dsh 可执行文件'),
              h('input', {
                className: 'qq-input', type: 'text', placeholder: '/usr/local/bin/dsh',
                value: form.dshBin,
                onChange: function (e) { update('dshBin', e.target.value) },
              })),
            h('div', { className: 'qq-field' },
              h('span', { className: 'qq-label' }, '工作目录'),
              h('input', {
                className: 'qq-input', type: 'text', placeholder: '/path/to/workspace',
                value: form.cwd,
                onChange: function (e) { update('cwd', e.target.value) },
              })),
          ),
          h('div', { className: 'qq-hint', style: { marginTop: '8px' } },
            '同一个 profile 不能被两个 dsh 实例同时用。建议单独建一个：dsh --profile qq --from-default-profile sdk --dump-config'),
        ),

        h('div', { className: 'qq-actions' },
          h('button', { className: 'qq-btn qq-btn-primary', disabled: busy === 'save', onClick: save }, busy === 'save' ? '保存中…' : '保存并生效'),
          h('button', { className: 'qq-btn', disabled: busy === 'reconnect', onClick: reconnect }, '断开重连'),
          h('button', { className: 'qq-btn', disabled: busy === 'test', onClick: sendTest }, '发条测试消息'),
          h('button', { className: 'qq-btn', onClick: function () { setForm(null); load() } }, '刷新'),
        ),

        notice ? h('div', { className: 'qq-msg ' + (notice.kind === 'ok' ? 'qq-msg-ok' : 'qq-msg-err') }, notice.text) : null,
      )
    }

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-qq-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-qq: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'qq',
          order: 48,
          locale: NS,
          label: function () { return 'QQ' },
        }, function (props) { return h(QqSection, props || {}) })
      })
    }

    module.exports = { name: 'qq', inject: ['slots'], apply: apply }
    return module.exports
  },
})
