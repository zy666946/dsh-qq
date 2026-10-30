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

/** 按长度硬切，避免超过 QQ 单条上限。 */
function hardSplit(text, max) {
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

/** 把一段长文字按句子切成小块，块与块之间留一点呼吸感。 */
function splitSentences(text, softMax) {
  const sentences = text.replace(/\n/g, ' ').match(/[^。！？!?…]+[。！？!?…]*/g) || [text]
  const out = []
  let current = ''

  for (const sentence of sentences) {
    const part = sentence.trim()
    if (!part) continue
    if (part.length > softMax) {
      if (current) {
        out.push(current.trim())
        current = ''
      }
      // 单句太长也不从中间硬切：宁可整句发，只有超过 maxChunk 才在最后兜底。
      out.push(part)
    } else if (current && current.length + part.length > softMax) {
      out.push(current.trim())
      current = part
    } else {
      current += part
    }
  }

  if (current.trim()) out.push(current.trim())
  return out
}

/**
 * 聊天文本分条：
 * - 很短的话不拆，保持一条；
 * - 长文本优先按空行分段，再按句子切到 softMax（默认约 160 字）；
 * - 单句不硬切，避免出现半句话；
 * - 含代码块时不拆，避免把代码切碎。
 */
export function splitText(text, max = 3000, options = {}) {
  if (!text) return []
  const trimmed = String(text).trim()
  if (!trimmed) return []
  if (trimmed.includes('```')) return hardSplit(trimmed, max)

  const shortMax = Math.min(max, Number.isFinite(options.shortMax) ? Math.max(1, Math.round(options.shortMax)) : 100)
  const softLimit = Math.min(max, Number.isFinite(options.softMax) ? Math.max(shortMax, Math.round(options.softMax)) : 160)
  if (trimmed.length <= shortMax) return [trimmed.replace(/\n{2,}/g, '\n')]

  const softMax = softLimit
  const paragraphs = trimmed.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  const chunks = []

  for (const paragraph of paragraphs) {
    if (paragraph.length > softMax) chunks.push(...splitSentences(paragraph, softMax))
    else chunks.push(paragraph)
  }

  // 太碎的短句并到相邻块里，避免一条只有几个字。
  const merged = []
  for (const chunk of chunks) {
    const last = merged[merged.length - 1]
    if (last && (last.length < 40 || chunk.length < 40) && last.length + 1 + chunk.length <= softMax) {
      merged[merged.length - 1] = `${last}\n${chunk}`
    } else {
      merged.push(chunk)
    }
  }

  // 最后一块太短（比如只剩一句「🐟」）就并回上一块，别单独发一条。
  if (merged.length > 1 && merged[merged.length - 1].length < 40) {
    const last = merged[merged.length - 1]
    const previous = merged[merged.length - 2]
    if (previous.length + 1 + last.length <= max) {
      merged[merged.length - 2] = `${previous}\n${last}`
      merged.pop()
    }
  }

  // 正常聊天最多拆 4 条；再多就像刷屏了，宁可每条长一点。
  const MAX_MESSAGES = 4
  let finalChunks = merged
  if (merged.length > MAX_MESSAGES) {
    const joined = merged.join('\n')
    const target = Math.min(max, Math.ceil(joined.length / MAX_MESSAGES))
    const packed = []
    let current = ''
    for (const chunk of merged) {
      const candidate = current ? `${current}\n${chunk}` : chunk
      if (current && candidate.length > target && packed.length < MAX_MESSAGES - 1) {
        packed.push(current)
        current = chunk
      } else {
        current = candidate
      }
    }
    if (current) packed.push(current)
    finalChunks = packed
  }

  return finalChunks.flatMap((chunk) => (chunk.length > max ? hardSplit(chunk, max) : [chunk])).filter(Boolean)
}
