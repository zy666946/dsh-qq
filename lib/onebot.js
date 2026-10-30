/**
 * dsh-qq · OneBot v11 客户端（正向 WebSocket）
 *
 * 只做三件事：连上、收事件、调 API。重连、请求超时、echo 配对都在这里。
 * 兼容 NapCat / LLOneBot / Lagrange。
 */
export class OneBotClient {
  constructor(options) {
    this.url = options.url
    this.logger = options.logger || (() => {})
    this.nextEcho = 1
    this.pending = new Map()
    this.handlers = new Set()
    this.ws = null
    this.connected = false
    this.stopped = false
    this.reconnectDelayMs = options.reconnectDelayMs || 3000
    this.maxReconnectDelayMs = options.maxReconnectDelayMs || 30000
    this.reconnectTimer = null
    this.reconnectAttempt = 0
  }

  connect() {
    if (this.stopped) return
    this.logger(`连接 OneBot：${this.url.replace(/access_token=[^&]*/, 'access_token=***')}`)
    let ws
    try {
      ws = new WebSocket(this.url)
    } catch (error) {
      this.logger(`WebSocket 创建失败：${error.message}`)
      this.#scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.connected = true
      this.reconnectAttempt = 0
      this.logger('OneBot 已连接')
    })
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.echo !== undefined && msg.echo !== null) {
        const pending = this.pending.get(msg.echo)
        if (!pending) return
        this.pending.delete(msg.echo)
        if (msg.status === 'failed' || (msg.retcode !== undefined && msg.retcode !== 0)) {
          pending.reject(new Error(`OneBot ${msg.retcode}: ${msg.message || 'failed'}`))
        } else {
          pending.resolve(msg.data)
        }
        return
      }
      for (const handler of this.handlers) {
        try { handler(msg) } catch (error) { this.logger(`事件处理异常：${error.message}`) }
      }
    })
    ws.addEventListener('close', () => {
      this.#handleDrop(ws)
    })
    // Node 的 WebSocket 在「连都连不上」（NapCat 还没起来）时只触发 error，不触发 close，
    // 光挂 close 会永远等不到重连。两条路都走 handleDrop，靠 timer 去重。
    ws.addEventListener('error', (event) => {
      this.#handleDrop(ws, event?.error?.message || 'error')
    })
  }

  #handleDrop(ws, reason) {
    if (this.stopped) return
    if (ws && this.ws !== ws) return // 旧连接晚到的 close，忽略
    if (this.reconnectTimer) return // 已经安排好重连了
    this.connected = false
    // 这里不要再调 ws.close()：error 时 undici 会同步派发 close，套娃就栈溢出了
    if (reason) this.logger(`OneBot 连接异常：${reason}`)
    this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    const attempt = this.reconnectAttempt++
    const delay = Math.min(this.reconnectDelayMs * 2 ** attempt, this.maxReconnectDelayMs)
    this.logger(`OneBot 断开，${Math.round(delay / 1000)}s 后重连`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  call(action, params = {}) {
    if (!this.connected || !this.ws) return Promise.reject(new Error('OneBot 未连接'))
    const echo = String(this.nextEcho++)
    return new Promise((resolve, reject) => {
      this.pending.set(echo, { resolve, reject })
      this.ws.send(JSON.stringify({ action, params, echo }))
      setTimeout(() => {
        if (this.pending.has(echo)) {
          this.pending.delete(echo)
          reject(new Error(`OneBot 超时：${action}`))
        }
      }, 30000)
    })
  }

  onEvent(handler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  async sendPrivate(userId, text) {
    return this.call('send_private_msg', { user_id: Number(userId), message: text })
  }

  async sendGroup(groupId, text) {
    return this.call('send_group_msg', { group_id: Number(groupId), message: text })
  }

  async loginInfo() {
    return this.call('get_login_info', {})
  }

  stop() {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try { this.ws?.close() } catch {}
    this.ws = null
    this.connected = false
  }
}

/** 从 OneBot 消息段数组里取出纯文本。 */
export function extractText(message) {
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const segment of message) {
    if (segment.type === 'text') parts.push(segment.data?.text ?? '')
    else if (segment.type === 'image') parts.push('[图片]')
    else if (segment.type === 'face') parts.push('')
    else if (segment.type === 'at') parts.push('')
  }
  return parts.join('').trim()
}

/** 群消息里是否 @ 了某个号。 */
export function mentions(message, qq) {
  if (!Array.isArray(message)) return false
  return message.some((segment) => segment.type === 'at' && String(segment.data?.qq) === String(qq))
}

/** 长文本按换行切成若干段，避免超过 QQ 单条上限。 */
export function splitText(text, max = 3000) {
  if (!text) return []
  const out = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}
