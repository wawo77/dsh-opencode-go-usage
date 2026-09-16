/**
 * 套餐适配器：把不同厂商的用量接口归一到同一个视图。
 *
 * 背景：这个插件原本只认 OpenCode Go，Go 的特性（端点、路由识别、价目表）
 * 写死在主模块里。要支持第二家就必然长成一堆 if，所以这里把"认领哪个 provider"
 * 和"怎么取数"抽成适配器，主模块只负责挑选和降级。
 *
 * 降级顺序（拿不到就不显示，绝不编数字）：
 *   1. 匹配到适配器且探测成功  → 显示该适配器的用量百分比
 *   2. 没有适配器 / 探测失败    → 顶部退回"今日 token"（本地账本，任何套餐都成立）
 *
 * 归一化视图：
 * {
 *   adapterId, planName, consoleUrl,
 *   percent, percentLabel,        // 气泡第一行的主指标
 *   windows: [{ key, label, percent, resetsAt, durationMs, calendarMonth }],
 *   credits: {...} | null,        // credits 类套餐的余额明细
 * }
 */

/** Go 的三个窗口。durationMs 用于把本地账本对齐到同一个区间。 */
export const WINDOW_SPECS = [
  { key: '5h', label: '5 小时', field: 'rolling', ms: 5 * 3_600_000, calendarMonth: false },
  { key: 'week', label: '1 周', field: 'weekly', ms: 7 * 86_400_000, calendarMonth: false },
  { key: 'month', label: '1 个月', field: 'monthly', ms: 30 * 86_400_000, calendarMonth: true },
]

/** 气泡第一行用哪个窗口：Go 官方口径里 5 小时是用户最关心的那个。 */
const GO_PRIMARY_KEY = '5h'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function toIso(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** 把接口返回的 message 字段提炼成一句人话，用于错误提示。 */
function pickMessage(body) {
  const message = firstString(body?.error?.message, body?.error, body?.message)
  return message === undefined ? '' : ` — ${message.slice(0, 120)}`
}

// ---------------------------------------------------------------------------
// OpenCode Go
// ---------------------------------------------------------------------------

/** 解析 Go 用量接口的响应，归一成窗口列表。 */
export function parseUsage(body) {
  const usage = body?.usage
  const windows = []
  if (typeof usage === 'object' && usage !== null) {
    for (const spec of WINDOW_SPECS) {
      const row = usage[spec.field]
      if (typeof row !== 'object' || row === null) continue
      const percent = Number(row.percent)
      windows.push({
        key: spec.key,
        label: spec.label,
        percent: Number.isFinite(percent) ? clamp(percent, 0, 100) : null,
        // 0% 时接口给的是占位重置时刻；置为 null，好让卡片显示"尚未开始计时"
        // 而不是一个假倒计时。
        resetsAt: percent === 0 ? null : (toIso(row.resetsAt) ?? null),
        durationMs: spec.ms,
        calendarMonth: spec.calendarMonth,
      })
    }
  }
  const planName = firstString(
    body?.plan?.name,
    body?.planName,
    body?.subscription?.plan?.name,
    body?.subscription?.name,
  )
  return { windows, planName }
}

export const goAdapter = {
  id: 'opencode-go',
  label: 'OpenCode Go',
  // 控制台深链故意不写死工作区 id：`wrk_…` 是账号相关的标识，
  // 写进公开仓库等于把仓库和某个账号关联起来。需要直达链接就用这个环境变量。
  consoleUrl: process.env.OPENCODE_GO_CONSOLE_URL ?? 'https://opencode.ai/workspace',
  /** provider id 以 opencode 开头，或 baseURL 指向 Go 网关。 */
  matches({ providerId, baseURL }) {
    return /^opencode/i.test(providerId ?? '') || /opencode\.ai\/zen\/go/i.test(baseURL ?? '')
  },
  async probe(ctx) {
    const apiKey = await ctx.resolveApiKey(ctx.providerId, ctx.apiKeyEnv ?? 'OPENCODE_GO_API_KEY')
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new Error('未找到 OpenCode Go 的 API key（OPENCODE_GO_API_KEY）')
    }
    const base = (ctx.baseURL ?? 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '')
    const body = await ctx.fetchJson(`${base}/usage`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        // 按 Go 文档对第三方客户端的要求，带上客户端标识与会话 id，
        // 而不是伪装成一个裸 HTTP 库。
        'user-agent': 'dsh-opencode-go-usage/0.2.0',
        'x-opencode-session': 'dsh-opencode-go-usage',
      },
    })
    const parsed = parseUsage(body)
    if (parsed.windows.length === 0) throw new Error('用量接口返回了无法识别的结构')
    const primary = parsed.windows.find((w) => w.key === GO_PRIMARY_KEY) ?? parsed.windows[0]
    return {
      adapterId: goAdapter.id,
      planName: parsed.planName,
      consoleUrl: goAdapter.consoleUrl,
      percent: primary.percent,
      percentLabel: primary.label,
      windows: parsed.windows,
      credits: null,
    }
  },
}

// ---------------------------------------------------------------------------
// Command Code（GOAT / Go / Pro / Max ...）
// ---------------------------------------------------------------------------

const CC_BASE = 'https://api.commandcode.ai'
const CC_CONSOLE_URL = 'https://commandcode.ai/billing'

/**
 * 计划表，从 command-code CLI 的 bundle 里读出来的（planId → 每月 credits）。
 * 用于在接口只给"剩余"时推出"总额"，进而算出百分比。
 */
const CC_PLANS = {
  'individual-go': { name: 'Go', monthlyCredits: 10 },
  'individual-goat': { name: 'GOAT', monthlyCredits: 70 },
  'individual-pro': { name: 'Pro', monthlyCredits: 30 },
  'individual-pro-v1': { name: 'Pro', monthlyCredits: 80 },
  'individual-provider': { name: 'Provider', monthlyCredits: 15 },
  'individual-max': { name: 'Max', monthlyCredits: 150 },
  'individual-ultra': { name: 'Ultra', monthlyCredits: 300 },
  'teams-pro': { name: 'Teams Pro', monthlyCredits: 40 },
}

/** planId 归一：小写、下划线转连字符，然后按**最长前缀**匹配（CLI 的做法）。 */
export function commandCodePlan(planId) {
  if (typeof planId !== 'string' || planId === '') return undefined
  const normalized = planId.toLowerCase().replace(/_/g, '-')
  const keys = Object.keys(CC_PLANS).sort((a, b) => b.length - a.length)
  const hit = keys.find((key) => normalized.startsWith(key))
  return hit === undefined ? undefined : { id: hit, ...CC_PLANS[hit] }
}

/**
 * 从 credits / subscription / summary 三份响应推出显示用的数字。
 * 这是照抄 CLI 里 projectUsageView() 的算法 —— 自己另发明一套只会和官方界面不一致。
 */
export function projectCredits({ credits, subscription, summary }) {
  const plan = commandCodePlan(subscription?.planId ?? credits?.planId ?? '')
  const monthly = Math.max(0, Number(credits?.monthlyCredits) || 0)
  const purchased = Math.max(0, Number(credits?.purchasedCredits) || 0)
  const free = Math.max(0, Number(credits?.freeCredits) || 0)
  const totalRemaining = monthly + purchased + free
  const totalSpent = Math.max(0, Number(summary?.totalCost) || 0)
  // 订阅生效时以"计划额度"为准；否则退化成"已花 + 还剩"，避免把赠送额度算成总额
  const planMonthly = subscription?.status === 'active' ? (plan?.monthlyCredits ?? null) : null
  const totalPool = planMonthly !== null
    ? Math.max(planMonthly, monthly) + purchased + free
    : totalSpent + totalRemaining
  const hasCredits = totalRemaining > 0 || totalSpent > 0
  const usagePercent = hasCredits && totalPool > 0 ? clamp((totalPool - totalRemaining) / totalPool * 100, 0, 100) : 0
  return {
    currency: 'USD',
    monthlyRemaining: monthly,
    purchasedRemaining: purchased,
    freeRemaining: free,
    totalRemaining,
    totalSpent,
    totalPool,
    usagePercent,
    hasCredits,
    planId: subscription?.planId ?? credits?.planId ?? null,
    planName: plan?.name ?? null,
    planMonthlyCredits: plan?.monthlyCredits ?? null,
    periodStart: toIso(subscription?.currentPeriodStart),
    periodEnd: toIso(subscription?.currentPeriodEnd),
    status: subscription?.status ?? null,
  }
}

/**
 * 把 windowLimits 归一成窗口列表。**字段名刻意写得宽容**：
 * 这个接口是未公开的 /alpha，我只从 CLI 的用量界面反推出字段含义
 * （WindowLimitMeter 读 label/used/cap/resetAt），没有真实响应可对照，
 * 所以键名、数组/对象两种形态都要能接，认不出来就返回空数组而不是崩。
 */
export function projectWindowLimits(raw) {
  if (raw === null || raw === undefined) return []
  const entries = Array.isArray(raw)
    ? raw.map((value, index) => [String(index), value])
    : (typeof raw === 'object' ? Object.entries(raw) : [])
  const out = []
  for (const [key, value] of entries) {
    if (typeof value !== 'object' || value === null) continue
    const label = firstString(value.label, value.name, value.window, value.key, key)
    const used = Number(value.used ?? value.spent ?? value.consumed)
    const cap = Number(value.cap ?? value.limit ?? value.total ?? value.max)
    const resetsAt = toIso(value.resetAt ?? value.resetsAt ?? value.reset_at)
    if (!Number.isFinite(used) && !Number.isFinite(cap)) continue
    out.push({
      key: `window-${key}`,
      label: label ?? key,
      percent: Number.isFinite(used) && Number.isFinite(cap) && cap > 0
        ? clamp((used / cap) * 100, 0, 100)
        : null,
      resetsAt,
      durationMs: undefined,
      calendarMonth: false,
      used: Number.isFinite(used) ? used : null,
      cap: Number.isFinite(cap) ? cap : null,
    })
  }
  return out
}

export const commandCodeAdapter = {
  id: 'command-code',
  label: 'Command Code',
  consoleUrl: CC_CONSOLE_URL,
  matches({ providerId, baseURL }) {
    return /command[-_]?code/i.test(providerId ?? '') || /commandcode\.ai/i.test(baseURL ?? '')
  },
  /**
   * Key 的三条来路，按 CLI 自己的顺序：环境变量 → ~/.commandcode/auth.json
   * → DSH 的凭据服务（有人在 DSH 里配了 commandcode provider 时）。
   */
  async resolveKey(ctx) {
    const fromEnv = await ctx.resolveApiKey(ctx.providerId, 'COMMAND_CODE_API_KEY')
    if (typeof fromEnv === 'string' && fromEnv !== '') return { key: fromEnv, source: 'COMMAND_CODE_API_KEY' }
    const fromFile = await ctx.readCommandCodeAuthFile()
    if (typeof fromFile === 'string' && fromFile !== '') return { key: fromFile, source: '~/.commandcode/auth.json' }
    return { key: null, source: null }
  },
  async probe(ctx) {
    const { key, source } = await commandCodeAdapter.resolveKey(ctx)
    if (key === null) {
      throw new Error('未找到 Command Code 的 API key（COMMAND_CODE_API_KEY 或 ~/.commandcode/auth.json）')
    }
    const base = (ctx.baseURL ?? CC_BASE).replace(/\/+$/, '')
    const headers = { authorization: `Bearer ${key}` }
    const get = (path) => ctx.fetchJson(base + path, { headers })

    // 顺序照抄 CLI 的 fetchUsageData：先 whoami 拿 orgId，其余三个都要它
    const whoami = await get('/alpha/whoami?limits=1')
    const orgId = whoami?.org?.id ?? whoami?.user?.orgId ?? null
    const orgQuery = orgId === null ? '' : `?orgId=${encodeURIComponent(orgId)}`
    const [credits, subscriptions] = await Promise.all([
      get(`/alpha/billing/credits${orgQuery}`),
      get(`/alpha/billing/subscriptions${orgQuery}`),
    ])
    const subscription = subscriptions?.data ?? subscriptions ?? {}
    const since = subscription?.currentPeriodStart ?? null
    const sinceQuery = [
      orgId === null ? null : `orgId=${encodeURIComponent(orgId)}`,
      since === null ? null : `since=${encodeURIComponent(since)}`,
    ].filter(Boolean).join('&')
    const summary = await get(`/alpha/usage/summary${sinceQuery === '' ? '' : `?${sinceQuery}`}`)

    const creditView = projectCredits({
      credits: credits?.credits ?? credits,
      subscription,
      summary: summary?.data ?? summary,
    })
    const windows = [
      {
        key: 'period',
        label: '本期',
        percent: creditView.usagePercent,
        resetsAt: creditView.periodEnd,
        durationMs: creditView.periodStart !== undefined && creditView.periodEnd !== undefined
          ? Math.max(0, Date.parse(creditView.periodEnd) - Date.parse(creditView.periodStart))
          : undefined,
        calendarMonth: false,
      },
      ...projectWindowLimits((credits?.credits ?? credits)?.windowLimits),
    ]
    return {
      adapterId: commandCodeAdapter.id,
      planName: creditView.planName === null ? undefined : `Command Code ${creditView.planName}`,
      consoleUrl: CC_CONSOLE_URL,
      percent: creditView.usagePercent,
      percentLabel: '本期',
      windows,
      credits: creditView,
      keySource: source,
      orgId,
    }
  },
}

// ---------------------------------------------------------------------------
// DeepSeek 官方 API（按量计费的钱包）
// ---------------------------------------------------------------------------

const DEEPSEEK_BASE = 'https://api.deepseek.com'
const DEEPSEEK_CONSOLE_URL = 'https://platform.deepseek.com/usage'

/** 币种符号。接口给的是 CNY/USD 这类代码，界面上要的是符号。 */
const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥' }

/**
 * 余额低于这个数就当作"快用完了"。按量计费的钱包**没有配额**，
 * 所以没有客观的百分比可算；这个阈值只是为了让数字变色，是个提示不是事实。
 */
const BALANCE_LOW = 10

/**
 * 把 /user/balance 的响应归一成余额视图。
 * 取第一条 balance_infos —— 该接口按币种返回多组，实测只有一个（CNY）。
 */
export function projectBalance(body) {
  const info = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : undefined
  const currency = firstString(info?.currency) ?? 'CNY'
  const total = Number(info?.total_balance)
  return {
    currency,
    symbol: CURRENCY_SYMBOLS[currency] ?? '',
    total: Number.isFinite(total) ? total : null,
    granted: Number(info?.granted_balance) || 0,
    toppedUp: Number(info?.topped_up_balance) || 0,
    // 官方给的可用标记。余额为负时它是 false —— 这比数字本身更该被强调
    available: body?.is_available !== false,
  }
}

export const deepSeekAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  consoleUrl: DEEPSEEK_CONSOLE_URL,
  matches({ providerId, baseURL }) {
    return /deepseek/i.test(providerId ?? '') || /api\.deepseek\.com/i.test(baseURL ?? '')
  },
  async probe(ctx) {
    const key = await ctx.resolveApiKey(ctx.providerId, 'DEEPSEEK_API_KEY')
    if (typeof key !== 'string' || key === '') {
      throw new Error('未找到 DeepSeek 的 API key（DEEPSEEK_API_KEY）')
    }
    const base = (ctx.baseURL ?? DEEPSEEK_BASE).replace(/\/+$/, '')
    const body = await ctx.fetchJson(`${base}/user/balance`, {
      headers: { authorization: `Bearer ${key}` },
    })
    const balance = projectBalance(body)
    if (balance.total === null) throw new Error('余额接口返回了无法识别的结构')
    return {
      adapterId: deepSeekAdapter.id,
      planName: 'DeepSeek',
      consoleUrl: DEEPSEEK_CONSOLE_URL,
      // 按量计费没有"本期用了百分之多少"这回事，硬算一个只会误导。
      // 主指标改成余额本身，客户端按 kind 分支渲染。
      kind: 'balance',
      percent: null,
      percentLabel: '',
      balance,
      // 没有配额窗口：既没有重置时刻，也就没有"本期"可对齐
      windows: [],
      credits: null,
    }
  },
}

/** 注册表。加一家新套餐 = 加一个适配器，主模块不用改。 */
export const ADAPTERS = [goAdapter, commandCodeAdapter, deepSeekAdapter]

export function adapterFor({ providerId, baseURL }) {
  return ADAPTERS.find((adapter) => adapter.matches({ providerId, baseURL }))
}

export { clamp, pickMessage, toIso, firstString, CURRENCY_SYMBOLS, BALANCE_LOW }
