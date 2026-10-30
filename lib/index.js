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
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { OneBotClient, extractText, mentions, splitText } from './onebot.js'
import { SdkChild } from './sdk.js'

export const name = 'qq'

/** 不强制依赖任何服务：OneBot 走网络，SDK 走子进程。 */
export const inject = []

const execFileAsync = promisify(execFile)

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
  contextWindow: 1000000,
  splitShortMax: 100,
  splitSoftMax: 160,
  requestTimeoutMs: 300000,
  turnTimeoutMs: 3600000,
  thinkEnabled: true,
  thinkPort: 3002,
  qzoneEnabled: true,
  permissionMode: 'danger-full-access',
  autoInstallChildPlugins: false,
}

/** 把 SDK 的 usage/context 整理成设置页能直接渲染的一行。 */
export function summarizeContext(context, fallbackWindow = 0) {
  const usage = context?.usage !== null && typeof context?.usage === 'object' ? context.usage : {}
  const num = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  const contextWindow = num(context?.contextWindow) || num(fallbackWindow)
  const inputTokens = num(usage.inputTokens)
  const outputTokens = num(usage.outputTokens)
  const cacheReadTokens = num(usage.cacheReadTokens)
  const cacheWriteTokens = num(usage.cacheWriteTokens)
  const usedTokens = num(usage.totalTokens) || (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens)
  const percent = contextWindow > 0 ? Math.round((usedTokens / contextWindow) * 1000) / 10 : 0
  return {
    contextWindow,
    usedTokens,
    percent,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    updatedAt: num(context?.updatedAt),
  }
}

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 子进程 profile 里值得装、但没装也能跑的插件。只提示，不擅自安装。 */
const OPTIONAL_CHILD_PLUGINS = [
  { pkg: '@furongjun1999/dsh-memory', why: '跨会话记忆（灵枢），装了 QQ 侧就能共用网页那边的记忆' },
]

/**
 * 检查 SDK 子进程用的 profile 里有没有那些「可选但很香」的插件。
 * 返回缺的那几个；要不要自动装由 autoInstallChildPlugins 决定。
 */
function checkChildProfilePlugins(profile, log) {
  const dir = path.join(homeDir(), 'profiles', profile)
  if (!existsSync(dir)) {
    log(`提示：子进程 profile「${profile}」还没建，先跑 dsh --profile ${profile} --from-default-profile sdk`)
    return []
  }
  let bundles = []
  try {
    bundles = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))?.dsh?.profile?.bundles ?? []
  } catch { return [] }
  const missing = OPTIONAL_CHILD_PLUGINS.filter((item) => !bundles.includes(item.pkg))
  for (const item of missing) {
    log(`提示：子进程 profile「${profile}」没装 ${item.pkg} —— ${item.why}。要装就执行：dsh plugin --profile ${profile} add ${item.pkg}`)
  }
  return missing
}

let autoInstalling = false

/**
 * 把可选插件装进子进程 profile（只有 autoInstallChildPlugins 打开时才会走到这里）。
 * 装完重建 SDK 子进程，新插件下一句话就能用。
 */
async function autoInstallChildPlugins({ profile, missing, runtime, log, dshBin }) {
  if (autoInstalling || !missing.length) return
  autoInstalling = true
  const record = { profile, at: Date.now(), results: [], finishedAt: 0 }
  runtime.autoInstall = record
  try {
    for (const item of missing) {
      const entry = { pkg: item.pkg, ok: false, error: '' }
      record.results.push(entry)
      log(`自动安装子进程插件 ${item.pkg}（profile=${profile}）…`)
      try {
        await execFileAsync(dshBin, ['plugin', '--profile', profile, 'add', item.pkg], {
          cwd: homeDir(),
          timeout: 180000,
          maxBuffer: 4 * 1024 * 1024,
        })
        entry.ok = true
        log(`已装进 profile「${profile}」：${item.pkg}`)
      } catch (error) {
        entry.error = String(error?.stderr || error?.message || error).trim().slice(0, 300)
        log(`安装 ${item.pkg} 失败：${entry.error}`)
      }
    }
    if (record.results.some((entry) => entry.ok)) {
      log('子进程插件有变化，重建 SDK 子进程')
      runtime.sdk?.stop()
      runtime.sdk = null
    }
  } finally {
    record.finishedAt = Date.now()
    autoInstalling = false
  }
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

/** 通知「想你了」插件：这一轮对话已经回复完了，并带上最近几轮。 */
function writeHeartbeatTurn(turn) {
  try {
    const file = path.join(homeDir(), 'heartbeat', 'last-turn.json')
    let previous = []
    try {
      const existing = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(existing?.recentTurns)) previous = existing.recentTurns
      else if (existing && (existing.userText || existing.replyText)) previous = [existing]
    } catch {
      // 第一次写，没有旧文件
    }
    const entry = {
      userAt: Number(turn.userAt) || 0,
      userText: String(turn.userText || '').slice(0, 200),
      replyAt: Number(turn.replyAt) || 0,
      replyText: String(turn.replyText || '').slice(0, 200),
    }
    const recentTurns = [...previous, entry]
      .filter((item) => item && typeof item === 'object' && Number(item.replyAt) > 0)
      .filter((item, index, list) => list.findIndex((x) => x.replyAt === item.replyAt && x.userAt === item.userAt) === index)
      .slice(-5)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...entry, recentTurns }, null, 2))
  } catch {
    // 没装/没权限都不影响 QQ 回复
  }
}


function guessImageExt(contentType, source) {
  const type = String(contentType || '').toLowerCase()
  if (type.includes('png')) return 'png'
  if (type.includes('webp')) return 'webp'
  if (type.includes('gif')) return 'gif'
  if (type.includes('bmp')) return 'bmp'
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  const match = String(source || '').split('?')[0].match(/\.(png|jpe?g|webp|gif|bmp)$/i)
  return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
}

/** 把 OneBot 消息里的图片下载到本地，交给 agent 的 read_image 看。 */
export async function downloadImages(message, logger = () => {}) {
  if (!Array.isArray(message)) return []
  const segments = message.filter((seg) => seg && seg.type === 'image' && seg.data)
  const out = []
  for (const seg of segments) {
    const candidates = [...new Set([seg.data.url, seg.data.file].filter((item) => typeof item === 'string' && item.trim() !== ''))]
    for (const source of candidates) {
      try {
        let buffer
        let contentType = ''
        if (source.startsWith('base64://')) {
          buffer = Buffer.from(source.slice('base64://'.length), 'base64')
        } else if (source.startsWith('data:image/')) {
          const comma = source.indexOf(',')
          if (comma === -1) continue
          contentType = source.slice(5, source.indexOf(';'))
          buffer = Buffer.from(source.slice(comma + 1), 'base64')
        } else if (/^https?:\/\//i.test(source)) {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 15000)
          try {
            const response = await fetch(source, { signal: controller.signal })
            if (!response.ok) continue
            contentType = response.headers.get('content-type') || ''
            buffer = Buffer.from(await response.arrayBuffer())
          } finally {
            clearTimeout(timer)
          }
        } else {
          const local = source.startsWith('file://') ? fileURLToPath(source) : source
          if (!existsSync(local)) continue
          buffer = readFileSync(local)
        }
        if (!buffer || buffer.length === 0 || buffer.length > 20 * 1024 * 1024) continue
        const dir = path.join(homeDir(), 'qq', 'images')
        mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${guessImageExt(contentType, source)}`)
        writeFileSync(file, buffer)
        out.push(file)
        break
      } catch (error) {
        logger(`图片下载失败：${String(error?.message || error).slice(0, 200)}`)
      }
    }
  }
  return out
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
    lastReplyAt: 0,
    lastReplyText: '',
    context: { contextWindow: Number(cfg.contextWindow) || 0, usage: null, updatedAt: 0 },
    autoInstall: null,
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
      contextWindow: cfg.contextWindow,
      requestTimeoutMs: cfg.requestTimeoutMs,
      permissionMode: cfg.permissionMode,
      logger: log,
      env: { DSH_NO_HEARTBEAT: '1' },
      onContext: (context) => {
        runtime.context = context
      },
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
    const messageAt = Date.now()
    runtime.lastMessageAt = messageAt
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

    const images = await downloadImages(event.message, log)
    const key = isGroup ? `group-${event.group_id}` : `private-${userId}`
    const reply = isGroup
      ? { type: 'group', targetId: event.group_id }
      : { type: 'private', targetId: event.user_id }

    // 这一轮还在想：主人说「继续」时先应一声，别另起一轮把它顶掉。
    if (runtime.working && /^(继续|接着|继续想)[。！!]?$/.test(cleaned)) {
      try { await sendText(reply, '嗯，还在想，没丢。') } catch {}
      return
    }

    runtime.queue.push({
      key,
      text: cleaned,
      userAt: messageAt,
      userText: cleaned.slice(0, 200),
      images,
      reply,
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
    const imageNote = job.images?.length
      ? `\n\n[用户发来 ${job.images.length} 张图片，已保存到：\n${job.images.map((file) => `- ${file}`).join('\n')}\n请先用 read_image 查看这些图片，再回复。]`
      : ''
    const answer = await sdk.ask(sessionIdFor(job.key), `${job.text}${imageNote}`, cfg.turnTimeoutMs, {
      onTimeout: () => {
        // 不结束这一轮，只先告诉主人「还在想」；模型 idle 后真正答案还会发出去。
        void sendText(job.reply, '这轮想得有点久，我先不丢。你回「继续」，我接着。').catch(() => {})
        log(`回复超过 ${Math.round(cfg.turnTimeoutMs / 60000)} 分钟，保留本轮继续等`)
      },
    })
    if (!answer) {
      await sendText(job.reply, '（这次啥也没说出来…再问一次？）')
      return
    }
    await sendText(job.reply, answer)
    const replyAt = Date.now()
    runtime.lastReplyAt = replyAt
    runtime.lastReplyText = answer.slice(0, 200)
    writeHeartbeatTurn({
      userAt: job.userAt || runtime.lastMessageAt,
      userText: job.userText || runtime.lastMessageText,
      replyAt,
      replyText: answer.slice(0, 200),
    })
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
            lastReplyAt: runtime.lastReplyAt,
            lastReplyText: runtime.lastReplyText,
            context: summarizeContext(runtime.context, cfg.contextWindow),
            autoInstall: runtime.autoInstall,
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
      contextWindow: cfg.contextWindow,
      splitShortMax: cfg.splitShortMax,
      splitSoftMax: cfg.splitSoftMax,
      thinkEnabled: cfg.thinkEnabled,
      thinkPort: cfg.thinkPort,
      qzoneEnabled: cfg.qzoneEnabled,
      permissionMode: cfg.permissionMode,
      autoInstallChildPlugins: cfg.autoInstallChildPlugins,
    }
  }

  /** 只接受已知字段，避免设置页把插件配崩。 */
  function sanitize(input) {
    const patch = {}
    if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
    if (typeof input.groupAtOnly === 'boolean') patch.groupAtOnly = input.groupAtOnly
    if (typeof input.politeReject === 'boolean') patch.politeReject = input.politeReject
    if (typeof input.qzoneEnabled === 'boolean') patch.qzoneEnabled = input.qzoneEnabled
    if (typeof input.autoInstallChildPlugins === 'boolean') patch.autoInstallChildPlugins = input.autoInstallChildPlugins
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
    if (input.contextWindow !== undefined) {
      const value = Number(input.contextWindow)
      if (!Number.isFinite(value) || value < 1000 || value > 10000000) throw new Error('contextWindow 必须在 1000~10000000')
      patch.contextWindow = Math.round(value)
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
  const missingChildPlugins = checkChildProfilePlugins(cfg.profile, log)
  if (missingChildPlugins.length && cfg.autoInstallChildPlugins) {
    void autoInstallChildPlugins({ profile: cfg.profile, missing: missingChildPlugins, runtime, log, dshBin: cfg.dshBin })
  }
}

export function __resetConfig() {
  saveOverrides({})
}
