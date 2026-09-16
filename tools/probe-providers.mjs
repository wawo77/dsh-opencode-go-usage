/**
 * 直接跑一遍各套餐适配器的探测，把归一化结果打印出来。
 *
 *   node tools/probe-providers.mjs --provider opencode-go-v41
 *   node tools/probe-providers.mjs --provider command-code
 *   node tools/probe-providers.mjs --provider command-code --base-url https://staging-api.commandcode.ai
 *
 * 为什么需要它：适配器里的端点与字段是从各家 CLI 的包里逆出来的，其中
 * Command Code 的 /alpha 系列是未公开接口，官方随时可能改字段。在**有 key 的
 * 机器**上跑一次这个，就能立刻看出是接口变了还是 key 不对，而不用去翻宿主日志。
 *
 * key 的来路与插件内一致：DSH 凭据服务（这里没有，会跳过）→ 环境变量 →
 * ~/.dsh/.credentials.yaml → Command Code 另加 ~/.commandcode/auth.json。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { adapterFor, ADAPTERS } from '../lib/providers.js'

const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : process.argv[at + 1]
}

const providerId = argOf('--provider')
const baseURL = argOf('--base-url')

if (providerId === undefined) {
  console.log('用法: node tools/probe-providers.mjs --provider <id> [--base-url <url>]')
  console.log('\n已注册的适配器:')
  for (const adapter of ADAPTERS) {
    console.log(`  ${adapter.id.padEnd(16)} ${adapter.label}`)
  }
  console.log('\n例如: --provider opencode-go-v41   /   --provider command-code')
  process.exit(1)
}

/** 与主模块同序的 key 解析（凭据服务不在场，从环境变量与文件兜底）。 */
async function readCredentialsFile(envName) {
  try {
    const text = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = new RegExp(`^\\s*${envName}\\s*:\\s*(.+)$`, 'm').exec(text)
    return match === null ? undefined : match[1].trim().replace(/^['"]|['"]$/g, '') || undefined
  } catch {
    return undefined
  }
}

async function readCommandCodeAuthFile() {
  try {
    const parsed = JSON.parse(await readFile(join(homedir(), '.commandcode', 'auth.json'), 'utf8'))
    const key = typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : ''
    return key === '' ? undefined : key
  } catch {
    return undefined
  }
}

const adapter = adapterFor({ providerId, baseURL })
if (adapter === undefined) {
  console.error(`provider "${providerId}" 没有对应的适配器 —— 插件会退回"只显示本地统计"`)
  process.exit(1)
}

console.log(`适配器  : ${adapter.id} (${adapter.label})`)
console.log(`provider: ${providerId}`)
console.log(`baseURL : ${baseURL ?? '(适配器默认)'}`)
console.log('')

const ctx = {
  providerId,
  baseURL,
  async resolveApiKey(id, envName) {
    const named = envName ?? 'OPENCODE_GO_API_KEY'
    const fromEnv = process.env[named]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      console.log(`key     : 来自环境变量 ${named}`)
      return fromEnv.trim()
    }
    const fromFile = await readCredentialsFile(named)
    if (fromFile !== undefined) console.log(`key     : 来自 ~/.dsh/.credentials.yaml (${named})`)
    return fromFile
  },
  readCommandCodeAuthFile,
  async fetchJson(url, init) {
    const response = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.json().catch(() => undefined)
    const ok = response.ok ? 'ok  ' : 'FAIL'
    console.log(`  ${ok} ${response.status} ${url.replace(/[?].*$/, '')}${url.includes('?') ? '?' + url.split('?')[1].slice(0, 60) : ''}`)
    if (!response.ok) {
      const message = body?.error?.message ?? body?.message ?? ''
      throw new Error(`HTTP ${response.status}${message === '' ? '' : ` — ${message}`}`)
    }
    return body
  },
}

try {
  const view = await adapter.probe(ctx)
  console.log('\n--- 归一化结果 ---')
  console.log('套餐      :', view.planName ?? '(未识别)')
  if (view.kind === 'balance' && view.balance !== undefined) {
    // 按量计费的钱包：主指标是余额本身，没有百分比可打
    const b = view.balance
    console.log('主指标    : 余额 ' + b.symbol + b.total
      + (b.available === false ? '  ← 账户不可用（余额不足）' : ''))
    console.log('  充值    :', b.symbol + b.toppedUp)
    console.log('  赠送    :', b.symbol + b.granted)
    console.log('  币种    :', b.currency)
  } else {
    console.log('主指标    :', `${view.percentLabel} ${view.percent === null ? '—' : view.percent.toFixed(1) + '%'}`)
  }
  if (view.windows.length === 0) {
    console.log('窗口      : （无 —— 按量计费没有配额周期）')
  } else {
    console.log('窗口      :')
    for (const window of view.windows) {
      console.log(`  ${String(window.label).padEnd(10)} ${window.percent === null ? '—' : window.percent.toFixed(1) + '%'}`
        + `${window.resetsAt ? `  重置 ${window.resetsAt}` : ''}`)
    }
  }
  if (view.credits !== null && view.credits !== undefined) {
    const c = view.credits
    console.log('credits   :')
    console.log(`  剩余 ${c.totalRemaining} / 共 ${c.totalPool}  (月度 ${c.monthlyRemaining}`
      + ` / 加购 ${c.purchasedRemaining} / 赠送 ${c.freeRemaining})`)
    console.log(`  本期 ${c.periodStart ?? '—'} → ${c.periodEnd ?? '—'}  状态 ${c.status ?? '—'}`)
  }
  console.log('\n这就是桌宠气泡与卡片会显示的内容。')
} catch (error) {
  console.error(`\n探测失败: ${error.message}`)
  console.error('（401 说明 key 不对；404 说明端点变了，需要重新核对适配器）')
  process.exitCode = 1
}
