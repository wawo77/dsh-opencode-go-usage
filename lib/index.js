/**
 * dsh-opencode-go-usage — host half.
 *
 * Two jobs, both inside the DSH host process so the API key never reaches the
 * browser:
 *
 *  1. Probe OpenCode's Go-plan usage endpoint with the key DSH already holds
 *     for the `opencode.ai/zen/go` provider routes, and serve the three quota
 *     windows (rolling 5h / weekly / monthly) it returns.
 *  2. Fold live session token usage into a timestamped local ledger and price
 *     it against Go's published per-model price book, so the widget can show a
 *     local dollar estimate next to the official percentage.
 *
 * The two numbers answer different questions and are labelled as such in the
 * UI: the percentage is the server's authoritative, subscription-wide figure
 * (it includes traffic from any client), while the dollar estimate covers only
 * calls that went through this DSH install.
 *
 * @module dsh-opencode-go-usage
 */

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PART_NAMES as RIG_PART_NAMES, resolveRig } from './rig-geometry.js'
import {
  WINDOW_SPECS, parseUsage, adapterFor, ADAPTERS,
  commandCodePlan, projectCredits, projectWindowLimits, projectBalance,
} from './providers.js'

/** Stable cordis plugin name (matches the cordis.patch.yml insert id). */
export const name = 'opencode-go-usage'

/** Services required before the plugin can register its routes. */
export const inject = ['webServer']

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Route prefix for the browser half. */
const API_PREFIX = '/api/opencode-go-usage'

/** Route prefix serving the pet sprite (built by tools/build-assets.mjs). */
const ASSET_PREFIX = '/opencode-go-usage-assets'

/** The pet sprite, resolved against this package rather than the process cwd. */
const PET_SPRITE_PATH = fileURLToPath(new URL('../assets/pet.png', import.meta.url))

/** Public URL of the pet sprite, handed to the browser half in the payload. */
const PET_SPRITE_URL = `${ASSET_PREFIX}/pet.png`

/**
 * 骨骼桌宠的部件目录。几何由 lib/rig-geometry.js 解析 —— 宿主、离线渲染器
 * 共用同一份，网页端只拿结果套变换，不再自己算一遍布局。
 */
const RIG_DIR = fileURLToPath(new URL('../assets/rig', import.meta.url))
const RIG_ASSET_PREFIX = `${ASSET_PREFIX}/rig`

/**
 * 资源白名单：只有列在这里的文件取得到，请求路径直接查表，
 * 不做任何路径拼接，因此不存在路径穿越。
 */
const RIG_FILES = new Map([
  ['rig.json', 'application/json; charset=utf-8'],
  ['parts/manifest.json', 'application/json; charset=utf-8'],
  ['parts/body.png', 'image/png'],
  ...RIG_PART_NAMES.map((name) => [`parts/${name}.png`, 'image/png']),
])

/**
 * The official Go-plan usage endpoint (`https://opencode.ai/zen/go/v1/usage`)
 * now lives with the Go adapter in lib/providers.js — endpoints travel with
 * their adapter, so this module no longer knows any provider's URL.
 * 各家的端点、字段、鉴权都随适配器走，主模块只负责挑选与降级。
 */

/** Console deep link for the widget's footer. */
/**
 * 控制台兜底深链。**不带工作区 id** —— 那是账号相关标识，不该进公开仓库。
 * 想直达自己的工作区就设 OPENCODE_GO_CONSOLE_URL（Go 适配器也读它）。
 */
const CONSOLE_URL = process.env.OPENCODE_GO_CONSOLE_URL ?? 'https://opencode.ai/workspace'

/** 桌宠的名字。显示在卡片标题上方与悬停提示里。 */
const PET_NAME = '蓝色大肥鱼'

/** Per-probe HTTP timeout. */
const PROBE_TIMEOUT_MS = 10_000

/** How long a probe result stays fresh enough to serve without re-probing. */
const PROBE_FRESH_MS = 45_000

/** Background probe cadence. */
const POLL_INTERVAL_MS = 60_000

/** Ledger flush debounce; the fold stays in memory until it goes quiet. */
const FLUSH_DEBOUNCE_MS = 15_000

/** Ledger bucket size — one minute of calls folds into one row. */
const BUCKET_MS = 60_000

/** Ledger retention, comfortably past the 30-day window. */
const RETAIN_DAYS = 32

/** Plan label shown as the card's title. */
const PLAN_LABEL = 'OpenCode Go'

/** Plan price caption. */
const PLAN_PRICE = '$10/月'

/** Default anchor (bottom-left, clear of the pet's bottom-right dock). */
const DEFAULT_POSITION = { left: 20, bottom: 20 }

/** Default on-screen height of the character, and the adjustable bounds. */
const DEFAULT_SIZE = 150
const SIZE_MIN = 90
const SIZE_MAX = 260

/** Environment variable the stock `opencode-go` route names. */
const DEFAULT_KEY_ENV = 'OPENCODE_GO_API_KEY'

/**
 * The three quota windows, in display order, with their server field names.
 * Every window is anchored on the server's own reset instant — including the
 * "rolling" one, which is a fixed 5-hour bucket closing at `resetsAt` rather
 * than a sliding window: summing from `now - 5h` would pull in calls the
 * server already dropped, so the local estimate would drift above the
 * official percentage. The `now - ms` fallback only runs when the server sent
 * no usable instant (a zero percent carries a placeholder).
 *
 * 定义已随适配器搬到 lib/providers.js；这里保留说明，并从那里导入/转发导出，
 * 让既有测试与调用方的路径不变。
 */

// ---------------------------------------------------------------------------
// Price book
// ---------------------------------------------------------------------------

/**
 * Go's published price book in USD per 1M tokens, transcribed from
 * opencode.ai/docs/go (2026-09-11 revision). `monthly` is that model's own
 * included monthly limit; Go's limits are per model (5h = 20% of it, weekly =
 * 50%, monthly = 100%), which is exactly why the server's percentage cannot be
 * converted back into one dollar amount — hence the local estimate.
 *
 * `peak` carries the DeepSeek family's peak-hour column; models without a
 * `peak` field bill flat.
 */
const PRICE_BOOK = {
  'glm-5.3-flash': { in: 0.15, out: 0.5, cacheRead: 0.03, monthly: 60 },
  'glm-5.3': { in: 1.4, out: 4.4, cacheRead: 0.26, monthly: 15 },
  'glm-5.2': { in: 1.4, out: 4.4, cacheRead: 0.26, monthly: 60 },
  'glm-5.1': { in: 1.4, out: 4.4, cacheRead: 0.26, monthly: 60 },
  'kimi-k3': { in: 3.0, out: 15.0, cacheRead: 0.3, monthly: 15 },
  'kimi-k2.7-code': { in: 0.95, out: 4.0, cacheRead: 0.19, monthly: 60 },
  'kimi-k2.6': { in: 0.95, out: 4.0, cacheRead: 0.16, monthly: 60 },
  'longcat-2.0': { in: 0.3, out: 1.2, cacheRead: 0.006, monthly: 60 },
  'mimo-v2.5': { in: 0.14, out: 0.28, cacheRead: 0.0028, monthly: 60 },
  'mimo-v2.5-pro': { in: 0.435, out: 0.87, cacheRead: 0.003625, monthly: 15 },
  'minimax-m3': { in: 0.3, out: 1.2, cacheRead: 0.06, monthly: 60 },
  'minimax-m2.7': { in: 0.3, out: 1.2, cacheRead: 0.06, cacheWrite: 0.375, monthly: 60 },
  'minimax-m2.5': { in: 0.3, out: 1.2, cacheRead: 0.06, cacheWrite: 0.375, monthly: 60 },
  'muse-spark-1.3-contributor': { in: 0.1, out: 0.2, cacheRead: 0.002, monthly: 60 },
  'muse-spark-1.2-contributor': { in: 0.1, out: 0.2, cacheRead: 0.002, monthly: 60 },
  'qwen3.8-max': { in: 2.0, out: 6.0, cacheRead: 0.25, cacheWrite: 2.5, monthly: 15 },
  'qwen3.8-flash': { in: 0.15, out: 0.47, cacheRead: 0.016, cacheWrite: 0.2, monthly: 30 },
  'qwen3.7-max': { in: 2.5, out: 7.5, cacheRead: 0.5, cacheWrite: 3.125, monthly: 30 },
  'qwen3.7-plus': { in: 0.4, out: 1.6, cacheRead: 0.04, cacheWrite: 0.5, monthly: 60 },
  'qwen3.6-plus': { in: 0.5, out: 3.0, cacheRead: 0.05, cacheWrite: 0.625, monthly: 60 },
  'deepseek-v4.1-flash': {
    in: 0.15, out: 0.6, cacheRead: 0.003,
    peak: { in: 0.3, out: 1.2, cacheRead: 0.006 }, monthly: 15,
  },
  'deepseek-v4-pro': {
    in: 0.66, out: 1.98, cacheRead: 0.022,
    peak: { in: 1.32, out: 3.96, cacheRead: 0.044 }, monthly: 15,
  },
  'deepseek-v4-flash': {
    in: 0.15, out: 0.6, cacheRead: 0.003,
    peak: { in: 0.3, out: 1.2, cacheRead: 0.006 }, monthly: 30,
  },
  'deepseek-v4-flash-vision-exp': {
    in: 0.15, out: 0.6, cacheRead: 0.003,
    peak: { in: 0.3, out: 1.2, cacheRead: 0.006 }, monthly: 15,
  },
  'hy4-preview': { in: 0.834, out: 2.501, cacheRead: 0.042, monthly: 30 },
  hy3: { in: 0.14, out: 0.58, cacheRead: 0.035, monthly: 60 },
  'grok-4.6': { in: 2.0, out: 6.0, cacheRead: 0.5, monthly: 15 },
  'gpt-5.6-luna': { in: 0.2, out: 1.2, cacheRead: 0.02, cacheWrite: 0.25, monthly: 15 },
}

/** Fallback row for a model id the book does not know (flagged in the UI). */
const FALLBACK_PRICE = PRICE_BOOK['deepseek-v4.1-flash']

/**
 * DeepSeek's peak windows on Go, in minutes-of-day UTC: 01:00-04:00 and
 * 06:00-10:00, Monday through Friday. Everything else (nights, weekends) is
 * off-peak. Beijing is UTC+8 year-round, so this is the doc's 09:00-12:00 /
 * 14:00-18:00 Beijing window stated in UTC.
 */
const PEAK_WINDOWS_UTC = [
  { from: 60, to: 240 },
  { from: 360, to: 600 },
]

/** Normalize a model id for price-book lookup. */
function normalizeModelId(model) {
  return String(model ?? '').trim().toLowerCase().replace(/_/g, '-')
}

/** Whether `atMs` falls in a DeepSeek peak window. */
function isPeakAt(atMs) {
  const at = new Date(atMs)
  const weekday = at.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes()
  return PEAK_WINDOWS_UTC.some((w) => minuteOfDay >= w.from && minuteOfDay < w.to)
}

/** Resolve the price row for a model id, plus whether the book knew it. */
function priceRowFor(model) {
  const id = normalizeModelId(model)
  if (Object.prototype.hasOwnProperty.call(PRICE_BOOK, id)) return { row: PRICE_BOOK[id], known: true }
  // Tolerate route-specific spellings such as `deepseek-v4-1-flash`.
  const squeezed = id.replace(/v(\d)-(\d)/g, 'v$1.$2')
  if (Object.prototype.hasOwnProperty.call(PRICE_BOOK, squeezed)) {
    return { row: PRICE_BOOK[squeezed], known: true }
  }
  const hit = Object.keys(PRICE_BOOK).find((key) => id.startsWith(key) || key.startsWith(id))
  if (hit !== undefined) return { row: PRICE_BOOK[hit], known: true }
  return { row: FALLBACK_PRICE, known: false }
}

/** Price one bucket in USD, in the billing period the call ran in. */
function bucketCostUsd(model, bucket, atMs) {
  const { row, known } = priceRowFor(model)
  const column = row.peak !== undefined && isPeakAt(atMs) ? row.peak : row
  const spend = (bucket.i * column.in
    + bucket.o * column.out
    + bucket.cr * column.cacheRead
    + bucket.cw * (column.cacheWrite ?? 0)) / 1_000_000
  return { usd: spend, known }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Resolve the DSH home directory the same way the family's plugins do. */
function dshHomeDir() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim()
    if (trimmed === '~') return homedir()
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
    return trimmed
  }
  return join(homedir(), '.dsh')
}

/** Clamp a number into [min, max]. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Coerce to a finite number, else 0. */
function num(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Normalize an epoch/ISO instant to ISO 8601, else undefined. */
function toIso(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim()
    if (/^\d+$/.test(text)) return toIso(Number(text))
    const date = new Date(text)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return undefined
}

/** Best-effort typed service read; absent services resolve to undefined. */
function serviceOf(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/** Read a foreign settings namespace's resolved value. */
function readNamespace(ctx, ns) {
  const settings = serviceOf(ctx, 'settings')
  if (settings === undefined || typeof settings.get !== 'function') return undefined
  try {
    return settings.get(ns)
  } catch {
    return undefined
  }
}

/** Atomic JSON write through a unique temp file + fsync + rename. */
async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(JSON.stringify(value), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** Read and parse a JSON file, or undefined when absent/corrupt. */
async function readJsonFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Write one JSON response. */
function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/** IPv4 127/8 predicate. */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket address names the loopback range. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/**
 * Request-level trust fence, mirroring the family's shared implementation: a
 * loopback socket AND a loopback Host header, plus browser same-origin
 * markers. Account usage is personal data, so it never crosses this fence.
 */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  const hostOk = hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname)
  if (!hostOk) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Read a bounded JSON body; undefined on empty/invalid/oversized. */
async function readJsonBody(req, maxBytes = 4096) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      return undefined
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return undefined
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class GoUsageService {
  constructor(ctx) {
    this.ctx = ctx
    this.dir = join(dshHomeDir(), 'opencode-go-usage')
    this.statePath = join(this.dir, 'state.json')
    this.ledgerPath = join(this.dir, 'ledger.json')
    /** Persisted widget anchor. */
    this.position = { ...DEFAULT_POSITION }
    /** Persisted on-screen character height in CSS pixels. */
    this.size = DEFAULT_SIZE
    /** Click sound on/off. Default on; the card has a toggle. */
    this.sound = true
    /** Per-minute call buckets, keyed `${minute}|${provider}|${model}`. */
    this.buckets = new Map()
    /** Session id → { provider, model } for the in-flight request. */
    this.routes = new Map()
    /** Last successful probe: normalized view from a provider adapter. */
    this.probe = undefined
    /** Last probe failure message. */
    this.probeError = undefined
    /** Which adapter produced `probe` (null when no adapter claimed the provider). */
    this.probeAdapter = undefined
    /** Neutral explanation when no adapter matches — not an error. */
    this.probeNote = undefined
    this.probing = false
    this.dirty = false
    this.flushTimer = undefined
    this.disposed = false
    /** Models seen in the local ledger that the price book does not know. */
    this.unknownModels = new Set()
  }

  async start() {
    await mkdir(this.dir, { recursive: true }).catch(() => {})
    const state = await readJsonFile(this.statePath)
    if (state?.position !== undefined) {
      const left = num(state.position.left)
      const bottom = num(state.position.bottom)
      this.position = { left: Math.max(0, left), bottom: Math.max(0, bottom) }
    }
    if (state?.size !== undefined) {
      const requested = num(state.size)
      this.size = requested <= 0 ? DEFAULT_SIZE : clamp(Math.round(requested), SIZE_MIN, SIZE_MAX)
      // 缺字段（老状态文件）当"开"处理
      this.sound = state.sound !== false
    }
    const ledger = await readJsonFile(this.ledgerPath)
    if (Array.isArray(ledger?.buckets)) {
      const cutoff = Date.now() - RETAIN_DAYS * 86_400_000
      for (const bucket of ledger.buckets) {
        if (typeof bucket !== 'object' || bucket === null) continue
        if (num(bucket.t) * BUCKET_MS < cutoff) continue
        this.buckets.set(bucketKey(bucket), bucket)
      }
    }
    // Fold the ledger once at startup so the first page load already has a
    // local estimate even before any new call is recorded.
    await this.probeNow()
  }

  dispose() {
    this.disposed = true
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (this.dirty) void this.flush()
  }

  // -- configuration ------------------------------------------------------

  /** Every configured provider route that points at OpenCode's Go gateway. */
  goRoutes() {
    const section = readNamespace(this.ctx, 'llm-pi-ai')
    const providers = section?.providers
    const out = []
    if (typeof providers === 'object' && providers !== null) {
      for (const [id, config] of Object.entries(providers)) {
        const baseURL = typeof config?.baseURL === 'string' ? config.baseURL : ''
        if (/opencode\.ai\/zen\/go/i.test(baseURL) || /^opencode/i.test(id)) {
          out.push({
            id,
            baseURL,
            apiKeyEnv: typeof config?.apiKeyEnv === 'string' ? config.apiKeyEnv : undefined,
          })
        }
      }
    }
    return out
  }

  /** The route the agent is currently configured to run on, when it is a Go route. */
  activeRoute() {
    const routes = this.goRoutes()
    if (routes.length === 0) return undefined
    const fallback = readNamespace(this.ctx, 'agent-default-model')
    const provider = typeof fallback?.provider === 'string' ? fallback.provider : undefined
    const model = typeof fallback?.model === 'string' ? fallback.model : undefined
    const match = provider === undefined ? undefined : routes.find((route) => route.id === provider)
    return { route: match ?? routes[0], model, provider }
  }

  /**
   * 当前真正配置的 provider —— **不限于 Go 路由**。
   *
   * 适配器匹配必须用它：`activeRoute()` 会把非 Go 的 provider 整个过滤掉，
   * 于是"用户换成了别家套餐"在那条路径上根本看不见，probeNow 会拿着
   * providerId 的默认值照样去探 Go —— 表现就是换套餐后界面还显示 Go 的数字。
   * 返回 undefined 表示连 agent-default-model 都没配。
   */
  configuredProvider() {
    const fallback = readNamespace(this.ctx, 'agent-default-model')
    const providerId = typeof fallback?.provider === 'string' && fallback.provider !== ''
      ? fallback.provider
      : undefined
    if (providerId === undefined) {
      // 没配默认模型时退回第一个 Go 路由，保持老行为
      const go = this.goRoutes()[0]
      return go === undefined
        ? undefined
        : { providerId: go.id, baseURL: go.baseURL, apiKeyEnv: go.apiKeyEnv }
    }
    const section = readNamespace(this.ctx, 'llm-pi-ai')
    const config = section?.providers?.[providerId]
    return {
      providerId,
      baseURL: typeof config?.baseURL === 'string' ? config.baseURL : undefined,
      apiKeyEnv: typeof config?.apiKeyEnv === 'string' ? config.apiKeyEnv : undefined,
    }
  }

  /** Whether a session's provider route is accounted by the local ledger. */
  isGoProvider(provider) {
    if (typeof provider !== 'string' || provider === '') return false
    if (/^opencode/i.test(provider)) return true
    return this.goRoutes().some((route) => route.id === provider)
  }

  /** The apiKeyEnv a route names, when configured. */
  apiKeyEnvFor(providerId) {
    const route = this.goRoutes().find((entry) => entry.id === providerId)
    return route?.apiKeyEnv
  }

  /**
   * Resolve a provider's API key: the pi-ai credential record first, then the
   * profile's apiKeyEnv reference, then the ambient process environment, then
   * the credential file's raw reference as a last resort.
   *
   * `envOverride` 让适配器指定自己那家的环境变量名（Command Code 用的是
   * COMMAND_CODE_API_KEY，与 provider 在 DSH 里叫什么无关）。
   */
  async resolveApiKey(providerId, envOverride) {
    const credentials = serviceOf(this.ctx, 'credentials')
    const named = envOverride ?? this.apiKeyEnvFor(providerId)
    if (credentials !== undefined) {
      try {
        const record = await credentials.readRecord(`llm-pi-ai/${providerId}`)
        if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key !== '') {
          return record.key
        }
      } catch {
        // Invalid record ids read as absent.
      }
      if (typeof named === 'string' && named !== '') {
        try {
          const resolved = await credentials.resolve(named)
          if (typeof resolved?.value === 'string' && resolved.value !== '') return resolved.value
        } catch {
          // Malformed references read as absent.
        }
      }
    }
    const envName = named ?? DEFAULT_KEY_ENV
    const fromEnv = process.env[envName]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
    return await readCredentialFileRef(envName)
  }

  // -- probing ------------------------------------------------------------

  /**
   * Probe the active provider's usage endpoint now; never throws.
   *
   * 走适配器注册表：认领当前 provider 的那家负责取数与归一。**没有适配器不是错误**
   * ——用户在用别家套餐是正常情况，此时顶部退回本地账本的"今日 token"，
   * 不该在界面上报红。只有"有适配器但探测失败"才算 error。
   */
  async probeNow() {
    if (this.probing || this.disposed) return
    this.probing = true
    try {
      const active = this.configuredProvider()
      const providerId = active?.providerId ?? 'opencode-go'
      const adapter = adapterFor({ providerId, baseURL: active?.baseURL })
      if (adapter === undefined) {
        this.probe = undefined
        this.probeAdapter = undefined
        this.probeError = undefined
        this.probeNote = `当前 provider (${providerId}) 没有对应的用量适配器，只显示本地统计`
        return
      }
      const view = await adapter.probe({
        providerId,
        baseURL: active?.baseURL,
        apiKeyEnv: active?.apiKeyEnv,
        resolveApiKey: (id, env) => this.resolveApiKey(id, env),
        readCommandCodeAuthFile: () => readCommandCodeAuthKey(),
        fetchJson: (url, init) => fetchJson(url, init),
      })
      this.probe = { ...view, at: Date.now() }
      this.probeAdapter = adapter.id
      this.probeError = undefined
      this.probeNote = undefined
    } catch (error) {
      this.probeError = error instanceof Error ? error.message.slice(0, 200) : String(error)
    } finally {
      this.probing = false
    }
  }

  // -- ledger -------------------------------------------------------------

  /** Record one assistant message's token usage. */
  record(provider, model, usage, atMs) {
    if (!this.isGoProvider(provider)) return
    const bucket = {
      t: Math.floor(atMs / BUCKET_MS),
      p: String(provider),
      m: String(model || 'unknown'),
      i: num(usage?.inputTokens),
      o: num(usage?.outputTokens),
      cr: num(usage?.cacheReadTokens),
      cw: num(usage?.cacheWriteTokens),
      n: 1,
    }
    if (bucket.i === 0 && bucket.o === 0 && bucket.cr === 0 && bucket.cw === 0) return
    const key = bucketKey(bucket)
    const existing = this.buckets.get(key)
    if (existing === undefined) this.buckets.set(key, bucket)
    else {
      existing.i += bucket.i
      existing.o += bucket.o
      existing.cr += bucket.cr
      existing.cw += bucket.cw
      existing.n += 1
    }
    if (!priceRowFor(bucket.m).known) this.unknownModels.add(bucket.m)
    this.prune()
    this.markDirty()
  }

  /** Drop buckets past the retention horizon. */
  prune() {
    const cutoff = Math.floor((Date.now() - RETAIN_DAYS * 86_400_000) / BUCKET_MS)
    for (const [key, bucket] of this.buckets) {
      if (bucket.t < cutoff) this.buckets.delete(key)
    }
  }

  markDirty() {
    this.dirty = true
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, FLUSH_DEBOUNCE_MS)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  async flush() {
    if (!this.dirty) return
    this.dirty = false
    const payload = { version: 1, buckets: [...this.buckets.values()] }
    try {
      await writeJsonAtomic(this.ledgerPath, payload)
    } catch {
      // A failed persist keeps the in-memory fold authoritative; the next
      // markDirty retries.
      this.dirty = true
    }
  }

  async savePosition(left, bottom) {
    this.position = { left: Math.max(0, Math.round(left)), bottom: Math.max(0, Math.round(bottom)) }
    await this.writeState()
  }

  /** Persist a new on-screen height, clamped to the adjustable bounds. */
  async saveSize(size) {
    const requested = num(size)
    // 0 is what a missing/garbage value parses to, not a real request, so it
    // falls back to the default rather than clamping down to the minimum.
    this.size = requested <= 0 ? DEFAULT_SIZE : clamp(Math.round(requested), SIZE_MIN, SIZE_MAX)
    await this.writeState()
    return this.size
  }

  /** Persist the click-sound preference. Anything not exactly false means on. */
  async saveSound(sound) {
    this.sound = sound !== false
    await this.writeState()
    return this.sound
  }

  /** One atomic write for all persisted display facts. */
  async writeState() {
    try {
      await writeJsonAtomic(this.statePath, {
        version: 1,
        position: this.position,
        size: this.size,
        sound: this.sound,
      })
    } catch {
      // Display persistence is cosmetic; keep the in-memory values.
    }
  }

  // -- views --------------------------------------------------------------

  /** Fold one window's buckets into a local spend estimate. */
  windowStats(startMs, endMs) {
    let usd = 0
    let calls = 0
    let tokens = 0
    let inTokens = 0
    let outTokens = 0
    let cachedTokens = 0
    const byModel = new Map()
    for (const bucket of this.buckets.values()) {
      const atMs = bucket.t * BUCKET_MS
      if (atMs < startMs || atMs > endMs) continue
      const { usd: cost } = bucketCostUsd(bucket.m, bucket, atMs)
      usd += cost
      calls += bucket.n
      tokens += bucket.i + bucket.o + bucket.cr + bucket.cw
      inTokens += bucket.i
      outTokens += bucket.o
      cachedTokens += bucket.cr + bucket.cw
      const entry = byModel.get(bucket.m) ?? { model: bucket.m, usd: 0, calls: 0 }
      entry.usd += cost
      entry.calls += bucket.n
      byModel.set(bucket.m, entry)
    }
    const models = [...byModel.values()].sort((a, b) => b.usd - a.usd)
    return { usd, calls, tokens, inTokens, outTokens, cachedTokens, topModel: models[0], models }
  }

  /** The document the browser half renders. */
  view() {
    const now = Date.now()
    // 窗口来自适配器（归一化后的），不再固定是 Go 那三个 ——
    // Command Code 给的是"本期"加它自己的 windowLimits。
    const specs = this.probe?.windows ?? WINDOW_SPECS
    const windows = specs.map((spec) => {
      const resetsAt = spec.resetsAt
      // 本地账本要对齐到同一个区间。窗口自带时长最好；没有就按 key 回到
      // WINDOW_SPECS 查（老版本的探测结果、或只填了百分比与重置时刻的假数据
      // 都会走到这里）；再没有才退回"距今 30 天"，宁可区间偏大也不凭空截断。
      const known = WINDOW_SPECS.find((entry) => entry.key === spec.key)
      const durationMs = Number.isFinite(spec.durationMs)
        ? spec.durationMs
        : (known?.ms ?? 30 * 86_400_000)
      const calendarMonth = spec.calendarMonth ?? known?.calendarMonth ?? false
      let startMs = now - durationMs
      if (typeof resetsAt === 'string') {
        const resetMs = Date.parse(resetsAt)
        if (Number.isFinite(resetMs)) {
          startMs = calendarMonth ? subtractMonth(resetMs) : resetMs - durationMs
        }
      }
      const local = this.windowStats(startMs, now)
      return {
        key: spec.key,
        label: spec.label,
        percent: spec.percent ?? null,
        resetsAt: resetsAt ?? null,
        limitUsd: null,
        // credits 类窗口特有的绝对值，卡片上能直接显示"还剩 $X / 共 $Y"
        used: spec.used ?? null,
        cap: spec.cap ?? null,
        local: {
          usd: round4(local.usd),
          calls: local.calls,
          tokens: local.tokens,
          inTokens: local.inTokens,
          outTokens: local.outTokens,
          cachedTokens: local.cachedTokens,
          topModel: local.topModel?.model ?? null,
        },
      }
    })
    // 气泡第一行的主指标。两种形态：
    //   percent —— 套餐制（Go / Command Code），显示"用了百分之多少"
    //   balance —— 按量计费的钱包（DeepSeek 官方），显示余额本身
    // 没有适配器数据时为 null，客户端会退回"今日 token"。
    const primarySpec = specs.find((spec) => spec.percent !== null && spec.percent !== undefined)
    let primary = null
    if (this.probe !== undefined) {
      if (this.probe.kind === 'balance' && this.probe.balance !== undefined) {
        primary = { kind: 'balance', label: '余额', balance: this.probe.balance }
      } else {
        primary = {
          kind: 'percent',
          label: this.probe.percentLabel ?? primarySpec?.label ?? '',
          percent: this.probe.percent ?? primarySpec?.percent ?? null,
        }
      }
    }
    const monthStats = this.windowStats(now - 30 * 86_400_000, now)
    const todayStart = startOfLocalDay(now)
    const todayStats = this.windowStats(todayStart, now)
    const stale = this.probe === undefined || now - this.probe.at > PROBE_FRESH_MS * 2
    return {
      ok: true,
      generatedAt: now,
      plan: {
        name: this.probe?.planName ?? PLAN_LABEL,
        price: this.probe?.credits === null || this.probe?.credits === undefined ? PLAN_PRICE : '',
        consoleUrl: this.probe?.consoleUrl ?? CONSOLE_URL,
      },
      primary,
      credits: this.probe?.credits ?? null,
      windows,
      probe: {
        ok: this.probe !== undefined && this.probeError === undefined,
        stale,
        at: this.probe?.at ?? null,
        error: this.probeError ?? null,
        // 没有适配器不是错误：给客户端一句中性说明，界面不该报红
        note: this.probeNote ?? null,
        adapter: this.probeAdapter ?? null,
        routeId: this.configuredProvider()?.providerId ?? null,
      },
      local: {
        monthUsd: round4(monthStats.usd),
        monthCalls: monthStats.calls,
        // token 统计：总量 + 输入/输出/缓存拆分。缓存单列是因为它便宜得多，
        // 和输入混在一起会让人误判花费结构。
        // today 是主口径（气泡和卡片注释都显示它），窗口/月度只作参考。
        todayTokens: todayStats.tokens,
        todayInTokens: todayStats.inTokens,
        todayOutTokens: todayStats.outTokens,
        todayCachedTokens: todayStats.cachedTokens,
        todayUsd: round4(todayStats.usd),
        todayCalls: todayStats.calls,
        todaySince: todayStart,
        monthTokens: monthStats.tokens,
        monthInTokens: monthStats.inTokens,
        monthOutTokens: monthStats.outTokens,
        monthCachedTokens: monthStats.cachedTokens,
        topModel: monthStats.topModel?.model ?? null,
        topModelMonthlyLimitUsd: monthStats.topModel === undefined
          ? null
          : priceRowFor(monthStats.topModel.model).row.monthly,
        unknownModels: [...this.unknownModels],
      },
      position: this.position,
      pet: {
        spriteUrl: PET_SPRITE_URL,
        // 桌宠的名字 —— 宿主说了算，客户端只负责显示
        name: PET_NAME,
        size: this.size,
        sound: this.sound,
        min: SIZE_MIN,
        max: SIZE_MAX,
        // null 表示 rig 不可用，客户端退回静态整图
        rig: rigDescriptor(),
      },
    }
  }
}

/** Fold-key for a bucket row. */
function bucketKey(bucket) {
  return `${bucket.t}|${bucket.p}|${bucket.m}`
}

/** Round to 4 decimals so the payload stays readable. */
function round4(value) {
  return Math.round(value * 1e4) / 1e4
}

/** Subtract one calendar month from an instant. */
function subtractMonth(ms) {
  const date = new Date(ms)
  date.setUTCMonth(date.getUTCMonth() - 1)
  return date.getTime()
}

/**
 * 本机时区的当天零点。
 *
 * 用本地时区而不是 UTC：用户问"今天用了多少"，脑子里的是自己日历上的今天。
 * 注意服务器给的窗口锚点是 UTC（resetsAt），两者口径不同是故意的 ——
 * 窗口跟着订阅的重置时刻走，"今日"跟着用户的日历走。
 */
function startOfLocalDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// parseUsage / parseUsage 的窗口定义已随适配器搬到 lib/providers.js，这里只管转发导出。

/** First non-empty string among the candidates. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Best-effort human message from a provider error body. */
function pickMessage(body) {
  const message = firstString(body?.error?.message, body?.message, body?.error)
  return message === undefined ? '' : `: ${message.slice(0, 120)}`
}

/**
 * Last-resort key lookup: the credential file DSH's local provider writes,
 * read as plain YAML. Only used when the credentials service is unavailable,
 * so the plugin still works in a partially composed profile.
 */
async function readCredentialFileRef(envName) {
  try {
    const text = await readFile(join(dshHomeDir(), '.credentials.yaml'), 'utf8')
    const match = new RegExp(`^\\s*${envName}\\s*:\\s*(.+)$`, 'm').exec(text)
    if (match === null) return undefined
    return match[1].trim().replace(/^['"]|['"]$/g, '') || undefined
  } catch {
    return undefined
  }
}

/**
 * Command Code CLI 自己的登录态：~/.commandcode/auth.json 里的 apiKey。
 * 适配器在环境变量没有 key 时读它 —— 用户既然装了那个 CLI，就不该要求他
 * 把 key 再抄一份到环境变量里。
 */
async function readCommandCodeAuthKey() {
  try {
    const text = await readFile(join(homedir(), '.commandcode', 'auth.json'), 'utf8')
    const parsed = JSON.parse(text)
    const key = typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : ''
    return key === '' ? undefined : key
  } catch {
    return undefined
  }
}

/**
 * 取 JSON。**非 2xx 一律抛错**并带上响应里的一句话说明 —— 适配器靠异常区分
 * "这家没有数据"和"这家有数据但返回 0"，把 401 悄悄当成空数据会让界面
 * 显示成 0% 而不是"未授权"。
 */
async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${pickMessage(body)}`)
  }
  return body
}

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

/** Register the service, its routes, and the session fold. */
export function apply(ctx) {
  const state = new GoUsageService(ctx)

  // Every registration below is individually guarded. The loader mounts a
  // bundle's patch rows as one transaction group: an exception escaping this
  // body would roll the whole group back and abort `dsh web` startup, so a
  // failure here must degrade this widget alone, never the shell.
  const guard = (label, body) => {
    try {
      return ctx.effect(body, label)
    } catch {
      return () => {}
    }
  }

  guard('opencode-go-usage: service', () => () => { state.dispose() })

  // Live fold: session events carry the route (request/header, request/context)
  // and the token totals (assistant/message). Guards keep a malformed event
  // from ever reaching the session loop.
  guard('opencode-go-usage: session fold', () => ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id ?? session?.sessionId ?? 'unknown'
      if (event?.type === 'request/header') {
        const config = event.data?.header?.config
        if (config !== undefined) state.routes.set(sessionId, { provider: config.provider, model: config.model })
        return
      }
      if (event?.type === 'request/context') {
        const data = event.data
        if (data !== undefined) state.routes.set(sessionId, { provider: data.provider, model: data.model })
        return
      }
      if (event?.type === 'assistant/message') {
        const usage = event.data?.usage
        if (usage === undefined || usage === null) return
        const route = state.routes.get(sessionId) ?? {}
        state.record(route.provider, route.model ?? 'unknown', usage, Date.now())
      }
    } catch {
      // A malformed event must never break the session loop.
    }
  }))

  // Background probe loop.
  guard('opencode-go-usage: probe loop', () => {
    const timer = setInterval(() => { void state.probeNow() }, POLL_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  guard('opencode-go-usage: routes', () => {
    const disposers = [
      ctx.webServer.register(makeStateRoute(state)),
      ctx.webServer.register(makeRefreshRoute(state)),
      ctx.webServer.register(makePositionRoute(state)),
      ctx.webServer.register(makeSizeRoute(state)),
      ctx.webServer.register(makeSoundRoute(state)),
      ctx.webServer.register(makeSpriteRoute()),
    ]
    return () => { for (const dispose of disposers) dispose() }
  })

  // Boot the fold and take a first reading without blocking activation.
  void state.start().catch(() => {})
}

/**
 * GET the pet sprite. Served under its own prefix so the browser can use it as
 * a plain `<img src>`; the loopback fence still applies, and a same-origin
 * image request passes it (no Origin header, sec-fetch-site=same-origin).
 * The bytes are read per request: the file is small, and reading it late means
 * a rebuilt sprite shows up on reload instead of needing a host restart.
 */
/**
 * 组装交给浏览器的 rig 描述：部件 URL + 落点矩阵 + 画布尺寸 + 前后顺序。
 * 每次 state 请求都重读一遍 —— 文件很小，而"改完 rig.json 刷新页面就生效"
 * 比省这一次读更值钱。读失败时返回 null，客户端会退回静态整图，不至于整只消失。
 */
function rigDescriptor() {
  try {
    const geometry = resolveRig(
      JSON.parse(readFileSync(join(RIG_DIR, 'rig.json'), 'utf8')),
      JSON.parse(readFileSync(join(RIG_DIR, 'parts', 'manifest.json'), 'utf8')),
    )
    const url = (rel) => `${RIG_ASSET_PREFIX}/${rel}`
    const parts = {}
    for (const [partName, p] of Object.entries(geometry.parts)) {
      parts[partName] = {
        url: url(`parts/${partName}.png`),
        width: p.width,
        height: p.height,
        pivotCanvasX: p.pivotCanvasX,
        pivotCanvasY: p.pivotCanvasY,
        place: p.place,
      }
    }
    return {
      canvas: geometry.canvas,
      anchor: geometry.anchor,
      order: geometry.order,
      body: { ...geometry.body, url: url('parts/body.png') },
      parts,
    }
  } catch {
    return null
  }
}

function makeSpriteRoute() {
  return {
    kind: 'prefix',
    path: ASSET_PREFIX,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden: loopback-only')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      // 骨骼桌宠的部件：查白名单表，路径不做任何拼接
      if (pathname.startsWith(`${RIG_ASSET_PREFIX}/`)) {
        const rel = pathname.slice(RIG_ASSET_PREFIX.length + 1)
        const type = RIG_FILES.get(rel)
        if (type === undefined) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        try {
          const bytes = await readFile(join(RIG_DIR, ...rel.split('/')))
          res.writeHead(200, {
            'content-type': type,
            'content-length': String(bytes.length),
            'cache-control': 'no-cache',
          })
          res.end(bytes)
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`missing ${rel} — run: node tools/build-rig.mjs --write`)
        }
        return
      }
      if (pathname !== PET_SPRITE_URL) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      try {
        const bytes = await readFile(PET_SPRITE_PATH)
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(bytes.length),
          'cache-control': 'no-cache',
        })
        res.end(bytes)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('sprite missing — run: node tools/build-assets.mjs')
      }
    },
  }
}

/** GET the widget document. */
function makeStateRoute(state) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      // Serve what we have and refresh in the background; the browser polls,
      // so a stale reading is corrected on the next tick without ever making
      // the widget wait on the network.
      if (state.probe === undefined || Date.now() - state.probe.at > PROBE_FRESH_MS) void state.probeNow()
      writeJson(res, 200, state.view())
    },
  }
}

/** POST to force a probe and answer with the fresh document. */
function makeRefreshRoute(state) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/refresh`,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      await state.probeNow()
      writeJson(res, 200, state.view())
    },
  }
}

/** POST the widget's new anchor. */
function makePositionRoute(state) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/position`,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { ok: false, error: 'invalid body' })
        return
      }
      await state.savePosition(num(body.left), num(body.bottom))
      writeJson(res, 200, { ok: true, position: state.position })
    },
  }
}

/** POST the character's on-screen height. */
function makeSizeRoute(state) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/size`,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { ok: false, error: 'invalid body' })
        return
      }
      const size = await state.saveSize(body.size)
      writeJson(res, 200, { ok: true, size })
    },
  }
}

/**
 * POST /api/opencode-go-usage/sound — persist the click-sound preference.
 * Mirrors makeSizeRoute: same fence, same verb check, same body shape.
 */
function makeSoundRoute(state) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/sound`,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { ok: false, error: 'invalid body' })
        return
      }
      const sound = await state.saveSound(body.sound)
      writeJson(res, 200, { ok: true, sound })
    },
  }
}

export { GoUsageService, PRICE_BOOK, parseUsage, isPeakAt, priceRowFor, bucketCostUsd, WINDOW_SPECS, API_PREFIX, ASSET_PREFIX, PET_SPRITE_PATH, PET_SPRITE_URL, makeSpriteRoute, rigDescriptor, RIG_ASSET_PREFIX, RIG_FILES, DEFAULT_SIZE, SIZE_MIN, SIZE_MAX, adapterFor, ADAPTERS, commandCodePlan, projectCredits, projectWindowLimits, projectBalance, makeSoundRoute }
