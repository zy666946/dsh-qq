/**
 * dsh-qq · 常驻 SDK 子进程
 *
 * QQ 消息最终要交给模型，这里维护一个常驻的 `dsh --profile sdk` 子进程：
 * 握手一次，之后每来一条 QQ 消息就 session/prompt 一次，把它当成一个
 * 长期在线的「聊天大脑」。
 *
 * 注意：同一个 profile 不能被两个 dsh 实例同时占用（会卡在启动）。
 * 所以这里的 profile 默认是 `qq`，需要事先用
 *   dsh --profile qq --from-default-profile sdk --dump-config
 * 初始化一次。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class SdkChild {
  constructor(options) {
    this.options = options
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.turns = new Map()
    this.startPromise = null
    this.stopping = false
    this.context = {
      contextWindow: Number(options.contextWindow) || 0,
      usage: null,
      updatedAt: 0,
    }
    this.logger = options.logger || (() => {})
  }

  get ready() {
    return this.startPromise !== null
  }

  getContext() {
    return { ...this.context, usage: this.context.usage === null ? null : { ...this.context.usage } }
  }

  async start() {
    if (this.startPromise) {
      // 已经起过（可能正在握手）：等它完成
      return this.startPromise
    }
    this.startPromise = (async () => {
      const { dshBin, profile, cwd, env, onExit } = this.options
      this.logger(`启动 SDK 子进程：${dshBin} --profile ${profile}`)
      this.proc = spawn(dshBin, ['--profile', profile], {
        cwd,
        env: {
          ...process.env,
          ...env,
          DSH_NO_HEARTBEAT: '1',
          // 决定 QQ 会话的 sandbox 与审批策略（见 dsh 的 sandbox-policy / approval 默认值）
          ...(this.options.permissionMode ? { DSH_PERMISSION_MODE: this.options.permissionMode } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const rl = createInterface({ input: this.proc.stdout })
      rl.on('line', (line) => this.#onLine(line))

      this.proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim()
        if (text) this.logger(`sdk stderr: ${text.slice(0, 400)}`)
      })
      this.proc.on('error', (error) => {
        this.logger(`SDK 启动失败：${error.message}`)
        this.startPromise = null
        onExit?.(error)
      })
      this.proc.on('exit', (code) => {
        this.logger(`SDK 退出 code=${code}`)
        this.startPromise = null
        for (const [, pending] of this.pending) pending.reject(new Error('sdk exited'))
        this.pending.clear()
        if (!this.stopping) onExit?.(new Error(`sdk exited ${code}`))
      })

      await this.request('initialize', {
        cwd,
        provider: this.options.provider,
        model: this.options.model,
        ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
        ...(this.options.maxTokens ? { maxTokens: this.options.maxTokens } : {}),
      })
      this.logger('SDK 握手成功')
    })()
    return this.startPromise
  }

  #onLine(line) {
    const text = line.trim()
    if (!text) return
    let msg
    try { msg = JSON.parse(text) } catch { return }

    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else pending.resolve(msg.result)
      return
    }

    if (msg.method === 'session.event') {
      const { sessionId, event } = msg.params || {}
      // 上下文窗口 / token 用量：这两个事件即使不属于当前 turn 也要收下。
      if (event?.type === 'request/context') {
        const windowSize = Number(event.data?.contextWindow)
        if (Number.isFinite(windowSize) && windowSize > 0) {
          this.context.contextWindow = windowSize
          this.context.updatedAt = Date.now()
          this.options.onContext?.({ ...this.context })
        }
      }
      if (event?.type === 'assistant/message') {
        const usage = event.data?.usage
        if (usage !== null && typeof usage === 'object') {
          this.context.usage = usage
          const windowSize = Number(event.data?.contextWindow)
          if (Number.isFinite(windowSize) && windowSize > 0) this.context.contextWindow = windowSize
          this.context.updatedAt = Date.now()
          this.options.onContext?.({ ...this.context })
        }
      }

      const turn = this.turns.get(sessionId)
      if (!turn) return
      if (event?.type === 'assistant/message') {
        const content = event.data?.message?.content || []
        turn.buffer += content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('')
      }
      return
    }

    if (msg.method === 'session.status') {
      const { sessionId, status } = msg.params || {}
      const turn = this.turns.get(sessionId)
      if (!turn) return
      if (status === 'running') turn.sawRunning = true
      if (status === 'idle' && turn.sawRunning && !turn.done) {
        turn.done = true
        clearTimeout(turn.timer)
        this.turns.delete(sessionId)
        turn.resolve(turn.buffer.trim())
      }
    }
  }

  request(method, params) {
    if (!this.proc) return Promise.reject(new Error('SDK 未运行'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`请求超时：${method}`))
        }
      }, this.options.requestTimeoutMs || 300000)
    })
  }

  /**
   * 问一句话，等它说完。
   * @param {string} sessionId 会话 id（同一条会话有连续记忆）
   * @param {string} text 用户消息
   * @returns {Promise<string>} 助手最终文本
   */
  async ask(sessionId, text, timeoutMs = 3600000, options = {}) {
    await this.start()
    // 会话可能已经持久化在磁盘上（进程重启后内存里没有），
    // 直接 prompt 会让 SDK 尝试新建同名会话并报 already exists。
    // 先尝试恢复，失败（真没这个会话）就让它懒创建。
    try {
      await this.request('session/resume', { sessionId })
    } catch {
      /* 新会话，忽略 */
    }
    return new Promise((resolve, reject) => {
      const turn = { buffer: '', sawRunning: false, done: false, timedOut: false, resolve, reject }
      this.turns.set(sessionId, turn)
      turn.timer = setTimeout(() => {
        if (turn.done) return
        // 有 onTimeout 时保留这一轮：只发一句「还在想」，继续等 idle。
        if (typeof options.onTimeout === 'function') {
          turn.timedOut = true
          clearTimeout(turn.timer)
          try { options.onTimeout() } catch {}
          return
        }
        turn.done = true
        this.turns.delete(sessionId)
        resolve(turn.buffer.trim() || '（想太久了，这次先这样）')
      }, timeoutMs)

      this.request('session/prompt', {
        sessionId,
        contentBlocks: [{ type: 'text', text }],
      }).catch((error) => {
        clearTimeout(turn.timer)
        this.turns.delete(sessionId)
        reject(error)
      })
    })
  }

  stop() {
    this.stopping = true
    try { this.proc?.kill('SIGTERM') } catch {}
    this.proc = null
    this.startPromise = null
  }
}
