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
      this.connected = false
      if (this.stopped) return
      this.logger(`OneBot 断开，${Math.round(this.reconnectDelayMs / 1000)}s 后重连`)
      this.#scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      /* close 事件会跟着来，这里不重复处理 */
    })
  }

  #scheduleReconnect() {
    if (this.stopped) return
    setTimeout(() => this.connect(), this.reconnectDelayMs)
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
