/**
 * dsh-qq —— 把 QQ 接进 DeepSeek Harness
 *
 * 一条 QQ 消息的生命周期：
 *
 *   QQ ──▶ NapCat（协议端）──OneBot v11 WS──▶ 本插件
 *                                              │
 *                                              ├─ 白名单 / 群 @ 判断
 *                                              ├─ 串行排队
 *                                              ▼
 *                                   常驻 SDK 子进程（dsh --profile qq）
 *                                              │
 *                                              ▼
 *                                   回复拆段 ──▶ OneBot ──▶ QQ
 *
 * 设置页能力：连接状态、登录号、白名单、群白名单、开关、测试发送。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { OneBotClient, extractText, mentions, splitText } from './onebot.js'
import { SdkChild } from './sdk.js'

export const name = 'qq'

/** 不强制依赖任何服务：OneBot 走网络，SDK 走子进程。 */
export const inject = []

const DEFAULTS = {
  enabled: true,
  onebotUrl: '',
  selfId: '',
  allowUsers: [],
  allowGroups: [],
  groupAtOnly: true,
  politeReject: true,
  dshBin: 'dsh',
  profile: 'qq',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: '',
  maxTokens: 0,
  cwd: '',
  maxChunk: 3000,
  splitShortMax: 120,
  splitSoftMax: 200,
  requestTimeoutMs: 300000,
  turnTimeoutMs: 240000,
  thinkEnabled: true,
  thinkPort: 3002,
  qzoneEnabled: true,
  permissionMode: 'danger-full-access',
}

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
function configPath() {
  return path.join(homeDir(), 'qq', 'config.json')
}
function loadOverrides() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}
function saveOverrides(values) {
  const next = { ...loadOverrides(), ...values }
  mkdirSync(path.dirname(configPath()), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(next, null, 2))
  return next
}

/** 把配置里的白名单统一成字符串数组。 */
function asIdList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value.split(/[,\s;，]+/).map((item) => item.trim()).filter(Boolean)
  }
  return []
}

export function apply(ctx, rawConfig = {}) {
  const appliedKey = Symbol.for('dsh-qq.applied')
  if (globalThis[appliedKey]) {
    ctx.logger?.info?.('qq: 已有一个实例在运行，跳过重复装载')
    return
  }
  globalThis[appliedKey] = true

  const saved = loadOverrides()
  const cfg = {
    ...DEFAULTS,
    ...rawConfig,
    ...saved,
    allowUsers: asIdList(saved.allowUsers ?? rawConfig.allowUsers ?? DEFAULTS.allowUsers),
    allowGroups: asIdList(saved.allowGroups ?? rawConfig.allowGroups ?? DEFAULTS.allowGroups),
  }

  const log = (msg) => ctx.logger?.info?.(`qq: ${msg}`)

  if (!cfg.enabled) {
    ctx.logger?.info?.('qq: 已禁用')
    return
  }
  if (!cfg.onebotUrl) {
    ctx.logger?.warn?.('qq: 未配置 onebotUrl，插件空转（设置页里可以填）')
  }

  // ---- 运行时状态 --------------------------------------------------------

  const runtime = {
    startedAt: Date.now(),
    bot: null,
    sdk: null,
    queue: [],
    working: false,
    stats: { received: 0, replied: 0, rejected: 0, errors: 0 },
    lastError: '',
    login: null,
    lastMessageAt: 0,
    lastMessageText: '',
  }

  function ensureSdk() {
    if (runtime.sdk) return runtime.sdk
    runtime.sdk = new SdkChild({
      dshBin: cfg.dshBin,
      profile: cfg.profile,
      cwd: cfg.cwd || process.cwd(),
      provider: cfg.provider,
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort || undefined,
      maxTokens: cfg.maxTokens || undefined,
      requestTimeoutMs: cfg.requestTimeoutMs,
      permissionMode: cfg.permissionMode,
      logger: log,
      env: { DSH_NO_HEARTBEAT: '1' },
      onExit: (error) => {
        runtime.lastError = String(error?.message || error)
        runtime.sdk = null
      },
    })
    return runtime.sdk
  }

  function ensureBot() {
    if (runtime.bot) return runtime.bot
    if (!cfg.onebotUrl) return null
    const bot = new OneBotClient({ url: cfg.onebotUrl, logger: log })
    bot.onEvent(handleEvent)
    bot.connect()
    runtime.bot = bot
    // 连上之后拉一次登录信息
    setTimeout(async () => {
      try {
        runtime.login = await bot.loginInfo()
        log(`已登录：${runtime.login?.nickname}（${runtime.login?.user_id}）`)
      } catch {
        /* 还没连上就算了 */
      }
    }, 4000)
    return bot
  }

  // ---- 消息处理 ----------------------------------------------------------

  function sessionIdFor(key) {
    return `qq-${cfg.selfId || 'unknown'}-${key}`
  }

  async function handleEvent(event) {
    if (event.post_type === 'meta_event') {
      if (event.meta_event_type === 'lifecycle') log(`NapCat 生命周期：${event.sub_type}`)
      return
    }
    if (event.post_type !== 'message') return
    if (cfg.selfId && event.self_id && String(event.self_id) !== String(cfg.selfId)) return

    const userId = String(event.user_id)
    const isGroup = event.message_type === 'group'
    const text = extractText(event.message)
    if (!text) return

    runtime.stats.received += 1
    runtime.lastMessageAt = Date.now()
    runtime.lastMessageText = text.slice(0, 200)

    // 白名单：只有名单里的人能驱动
    if (!cfg.allowUsers.includes(userId)) {
      if (isGroup) return
      runtime.stats.rejected += 1
      if (cfg.politeReject) {
        try { await runtime.bot?.sendPrivate(userId, '我是私人小助手，只认主人哦 🐟') } catch {}
      }
      return
    }

    if (isGroup) {
      if (!cfg.allowGroups.includes(String(event.group_id))) return
      if (cfg.groupAtOnly && !mentions(event.message, cfg.selfId)) return
    }

    const cleaned = text.replace(/^@\S+\s*/, '').trim()
    if (!cleaned) return

    const key = isGroup ? `group-${event.group_id}` : `private-${userId}`
    runtime.queue.push({
      key,
      text: cleaned,
      reply: isGroup
        ? { type: 'group', targetId: event.group_id }
        : { type: 'private', targetId: event.user_id },
    })
    drain()
  }

  async function drain() {
    if (runtime.working) return
    runtime.working = true
    try {
      while (runtime.queue.length) {
        const job = runtime.queue.shift()
        try {
          await runJob(job)
        } catch (error) {
          runtime.stats.errors += 1
          runtime.lastError = String(error?.message || error)
          log(`处理失败：${runtime.lastError}`)
          try {
            await sendText(job.reply, `呜…这边出了点问题：${runtime.lastError}`)
          } catch {}
        }
      }
    } finally {
      runtime.working = false
    }
  }

  async function runJob(job) {
    const sdk = ensureSdk()
    log(`提问 ${job.key}：${job.text.slice(0, 120)}`)
    const answer = await sdk.ask(sessionIdFor(job.key), job.text, cfg.turnTimeoutMs)
    if (!answer) {
      await sendText(job.reply, '（这次啥也没说出来…再问一次？）')
      return
    }
    await sendText(job.reply, answer)
    runtime.stats.replied += 1
    log(`回答 ${job.key}：${answer.slice(0, 120)}`)
  }

  async function sendText(reply, text) {
    const bot = runtime.bot
    if (!bot) throw new Error('OneBot 未连接')
    const chunks = splitText(text, cfg.maxChunk, {
      shortMax: cfg.splitShortMax,
      softMax: cfg.splitSoftMax,
    })
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 350))
      if (reply.type === 'group') await bot.sendGroup(reply.targetId, chunk)
      else await bot.sendPrivate(reply.targetId, chunk)
    }
  }

  // ---- HTTP：设置页 + 心跳 /think ----------------------------------------

  const requestHandler = async (req, res) => {
    const url = (req.url || '').split('?')[0]
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const readBody = () => new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => resolve(body))
    })

    // 心跳插件的思考接口
    if (url === '/think' && req.method === 'POST') {
      try {
        const { prompt } = JSON.parse((await readBody()) || '{}')
        if (!prompt) return json(400, { error: 'prompt required' })
        const text = await ensureSdk().ask(`qq-${cfg.selfId || 'unknown'}-heartbeat`, prompt, cfg.turnTimeoutMs)
        return json(200, { ok: true, text })
      } catch (error) {
        return json(500, { ok: false, error: String(error?.message || error) })
      }
    }

    if (!url.startsWith('/api/qq')) return json(404, { error: 'not found' })

    try {
      if (url === '/api/qq/state' && req.method === 'GET') {
        return json(200, {
          config: publicConfig(),
          runtime: {
            startedAt: runtime.startedAt,
            connected: Boolean(runtime.bot?.connected),
            login: runtime.login,
            queue: runtime.queue.length,
            working: runtime.working,
            stats: runtime.stats,
            lastError: runtime.lastError,
            lastMessageAt: runtime.lastMessageAt,
            lastMessageText: runtime.lastMessageText,
          },
        })
      }
      if (url === '/api/qq/config' && req.method === 'GET') return json(200, { config: publicConfig() })
      if (url === '/api/qq/config' && req.method === 'POST') {
        let input
        try { input = JSON.parse((await readBody()) || '{}') } catch { return json(400, { ok: false, error: '不是合法 JSON' }) }
        const patch = sanitize(input)
        saveOverrides(patch)
        for (const [key, value] of Object.entries(patch)) cfg[key] = value
        // 连接参数变了就重连；profile 变了就重建 SDK
        if (patch.onebotUrl !== undefined || patch.selfId !== undefined) {
          runtime.bot?.stop()
          runtime.bot = null
          runtime.login = null
          ensureBot()
        }
        if (patch.profile !== undefined || patch.dshBin !== undefined || patch.permissionMode !== undefined) {
          runtime.sdk?.stop()
          runtime.sdk = null
        }
        log(`设置已更新：${JSON.stringify(patch)}`)
        return json(200, { ok: true, config: publicConfig() })
      }
      if (url === '/api/qq/test' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}')
        const target = String(body.targetId || cfg.allowUsers[0] || '')
        if (!target) return json(400, { ok: false, error: '没有可发送的目标（先填白名单或 targetId）' })
        await sendText({ type: 'private', targetId: target }, String(body.text || '测试消息 🐟'))
        return json(200, { ok: true })
      }
      if (url === '/api/qq/qzone' && req.method === 'POST') {
        if (!cfg.qzoneEnabled) return json(403, { ok: false, error: '发说说功能已在设置里关闭' })
        const body = JSON.parse((await readBody()) || '{}')
        const content = String(body.content || '').trim()
        if (!content) return json(400, { ok: false, error: 'content 不能为空' })
        if (!runtime.bot?.connected) return json(503, { ok: false, error: 'OneBot 未连接' })

        // 可见范围：默认 64（仅自己）。对话里可以指定。
        const rights = { 1: '所有人', 4: '好友', 16: '部分好友', 64: '仅自己', 128: '部分好友不可见' }
        let ugcRight = Number(body.ugcRight ?? body.ugc_right ?? 64)
        if (!rights[ugcRight]) return json(400, { ok: false, error: `ugcRight 只能是 ${Object.keys(rights).join('/')}` })
        let targetUins = Array.isArray(body.targetUins)
          ? body.targetUins.map(String)
          : asIdList(body.targetUins || body.target_uins || '')
        if ((ugcRight === 16 || ugcRight === 128) && targetUins.length === 0) {
          return json(400, { ok: false, error: '16/128 需要 targetUins（指定哪些好友）' })
        }
        if (ugcRight !== 16 && ugcRight !== 128) targetUins = []

        const params = { content, ugc_right: ugcRight }
        if (targetUins.length) params.target_uins = targetUins
        if (Array.isArray(body.images) && body.images.length) params.images = body.images

        const result = await runtime.bot.call('send_qzone_msg', params)
        const tid = result?.tid ?? ''
        log(`发说说成功（${rights[ugcRight]}）：${content.slice(0, 60)} tid=${tid}`)
        return json(200, { ok: true, tid, ugcRight, visibility: rights[ugcRight], targetUins })
      }
      if (url === '/api/qq/qzone' && req.method === 'GET') {
        return json(200, {
          enabled: cfg.qzoneEnabled,
          default: 64,
          options: {
            1: '所有人可见',
            4: '好友可见',
            16: '指定好友可见（需 targetUins）',
            64: '仅自己可见',
            128: '指定好友不可见（需 targetUins）',
          },
        })
      }
      if (url === '/api/qq/reconnect' && req.method === 'POST') {
        runtime.bot?.stop()
        runtime.bot = null
        runtime.login = null
        ensureBot()
        return json(200, { ok: true })
      }
      if (url === '/api/qq/think' && req.method === 'POST') {
        const body = JSON.parse((await readBody()) || '{}')
        const prompt = String(body.prompt || '')
        if (!prompt) return json(400, { ok: false, error: 'prompt required' })
        const text = await ensureSdk().ask(`qq-${cfg.selfId || 'unknown'}-probe`, prompt, cfg.turnTimeoutMs)
        return json(200, { ok: true, text })
      }
      return json(404, { error: 'not found' })
    } catch (error) {
      return json(500, { ok: false, error: String(error?.message || error) })
    }
  }
  const server = http.createServer(requestHandler)

  function publicConfig() {
    return {
      enabled: cfg.enabled,
      onebotUrl: cfg.onebotUrl,
      selfId: cfg.selfId,
      allowUsers: cfg.allowUsers,
      allowGroups: cfg.allowGroups,
      groupAtOnly: cfg.groupAtOnly,
      politeReject: cfg.politeReject,
      dshBin: cfg.dshBin,
      profile: cfg.profile,
      provider: cfg.provider,
      model: cfg.model,
      cwd: cfg.cwd,
      maxChunk: cfg.maxChunk,
      splitShortMax: cfg.splitShortMax,
      splitSoftMax: cfg.splitSoftMax,
      thinkEnabled: cfg.thinkEnabled,
      thinkPort: cfg.thinkPort,
      qzoneEnabled: cfg.qzoneEnabled,
      permissionMode: cfg.permissionMode,
    }
  }

  /** 只接受已知字段，避免设置页把插件配崩。 */
  function sanitize(input) {
    const patch = {}
    if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
    if (typeof input.groupAtOnly === 'boolean') patch.groupAtOnly = input.groupAtOnly
    if (typeof input.politeReject === 'boolean') patch.politeReject = input.politeReject
    if (typeof input.qzoneEnabled === 'boolean') patch.qzoneEnabled = input.qzoneEnabled
    if (typeof input.permissionMode === 'string') {
      const allowed = ['danger-full-access', 'workspace-write', 'read-only']
      patch.permissionMode = allowed.includes(input.permissionMode) ? input.permissionMode : 'danger-full-access'
    }
    for (const key of ['onebotUrl', 'selfId', 'dshBin', 'profile', 'provider', 'model', 'cwd', 'permissionMode']) {
      if (typeof input[key] === 'string') patch[key] = input[key].trim()
    }
    if (input.allowUsers !== undefined) patch.allowUsers = asIdList(input.allowUsers)
    if (input.allowGroups !== undefined) patch.allowGroups = asIdList(input.allowGroups)
    if (input.maxChunk !== undefined) {
      const value = Number(input.maxChunk)
      if (!Number.isFinite(value) || value < 200 || value > 10000) throw new Error('maxChunk 必须在 200~10000')
      patch.maxChunk = Math.round(value)
    }
    if (input.splitShortMax !== undefined) {
      const value = Number(input.splitShortMax)
      if (!Number.isFinite(value) || value < 10 || value > 1000) throw new Error('splitShortMax 必须在 10~1000')
      patch.splitShortMax = Math.round(value)
    }
    if (input.splitSoftMax !== undefined) {
      const value = Number(input.splitSoftMax)
      if (!Number.isFinite(value) || value < 20 || value > 2000) throw new Error('splitSoftMax 必须在 20~2000')
      patch.splitSoftMax = Math.round(value)
    }
    const nextShortMax = patch.splitShortMax ?? cfg.splitShortMax
    const nextSoftMax = patch.splitSoftMax ?? cfg.splitSoftMax
    if (nextSoftMax < nextShortMax) throw new Error('splitSoftMax 不能小于 splitShortMax')
    return patch
  }

  // 浏览器里的设置页只能访问 dsh 自己的 webServer，所以同一套 handler 要挂两份：
  // 一份在独立端口（给心跳 /think + 本机调试），一份在 webServer 的 /api/qq 下。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (child) => {
        try {
          child.webServer.register({ kind: 'prefix', path: '/api/qq', handler: requestHandler })
          log('已挂到 dsh webServer：/api/qq/*')
        } catch (error) {
          log(`webServer 注册失败：${error?.message || error}`)
        }
      })
    } catch (error) {
      log(`webServer 注入失败：${error?.message || error}`)
    }
  }

  let httpServer = null
  if (cfg.thinkEnabled && cfg.thinkPort) {
    try {
      httpServer = server.listen(cfg.thinkPort, '127.0.0.1', () => {
        log(`接口就绪：http://127.0.0.1:${cfg.thinkPort}（/think、/api/qq/*）`)
      })
      // listen 的错误是异步事件，必须显式监听，否则会变成 uncaughtException 把 dsh 弄崩
      httpServer.on('error', (error) => {
        log(`端口 ${cfg.thinkPort} 不可用：${error.message}（换个 thinkPort，或等旧进程释放）`)
        httpServer = null
      })
    } catch (error) {
      log(`端口 ${cfg.thinkPort} 占用：${error.message}`)
    }
  }

  // 启动
  if (cfg.onebotUrl) ensureBot()

  ctx.effect(() => () => {
    log('正在停止…')
    runtime.bot?.stop()
    runtime.sdk?.stop()
    try { httpServer?.close() } catch {}
    globalThis[appliedKey] = false
  })

  log(`已启动：OneBot=${cfg.onebotUrl || '(未配置)'} 白名单=${cfg.allowUsers.join(',') || '(空)'} profile=${cfg.profile}`)
}

export function __resetConfig() {
  saveOverrides({})
}
