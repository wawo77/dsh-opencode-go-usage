/**
 * Self-test for dsh-opencode-go-usage: syntax-level contracts plus the pure
 * calculations the widget depends on. Run with `node test/selftest.mjs`.
 *
 * It deliberately never touches the network or the real DSH home: the service
 * is constructed with a fake context and hand-fed probe/ledger state.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { decodePng } from '../tools/lib/png.mjs'
import { resolveRig, PART_NAMES } from '../lib/rig-geometry.js'
import { BLOCKS, syncAll } from '../tools/sync-anim.mjs'
import { createRig } from '../tools/lib/rig-render.mjs'
import { measureEars, readRig } from '../tools/ear-balance.mjs'
import { RUNTIME_FILES, checkFilesField, externalImports } from '../tools/lib/runtime-files.mjs'
import { existsSync, readdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

const host = await import(pathToFileURL(join(pkgRoot, 'lib/index.js')).href)

// --- plugin contract -------------------------------------------------------

check('host exports the cordis plugin shape', () => {
  assert.equal(host.name, 'opencode-go-usage')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
})

check('cordis.patch.yml inserts the matching row id', async () => {
  const text = await readFile(join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /id:\s*opencode-go-usage/)
  assert.match(text, /name:\s*'dsh-opencode-go-usage'/)
})

check('package.json declares host + client halves', async () => {
  const manifest = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

// --- client bundle ---------------------------------------------------------

/** The client bundle's exports, captured by the check below for later checks. */
let client = null

check('client bundle registers one loader factory and exports apply/inject', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  const loaded = []
  const sandbox = { window: { __ModuleLoader__: { load: (entry) => loaded.push(entry) } } }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  assert.equal(loaded.length, 1, 'exactly one load() call')
  const entry = loaded[0]
  // The bundle id is the package name, matching every other client bundle in
  // the profile (`@linxin666/dsh-usage`, `dsh-better-sidebar`, ...) — the
  // loader keys the browser module by the resolved manifest package name, not
  // by the cordis row id.
  assert.equal(entry.id, 'dsh-opencode-go-usage')
  assert.equal(typeof entry.factory, 'function')

  const exports = entry.factory()
  client = exports.__internals
  assert.equal(typeof exports.apply, 'function')
  // Cross-realm array: compare length, not identity of the Array prototype.
  assert.equal(exports.inject.length, 0, 'no external module requests')
  // The mount body must contain its own failures: the sandbox has no document,
  // so apply() has to swallow the ReferenceError instead of letting it reach
  // the shell's plugin loader.
  assert.doesNotThrow(() => exports.apply({ effect: () => {} }), 'apply never throws')
})

// --- price book ------------------------------------------------------------

check('price book resolves the user\'s own model and its monthly limit', () => {
  const { row, known } = host.priceRowFor('deepseek-v4.1-flash')
  assert.equal(known, true)
  assert.equal(row.monthly, 15)
  assert.equal(row.in, 0.15)
  assert.equal(row.out, 0.6)
  assert.equal(row.cacheRead, 0.003)
  assert.equal(row.peak.in, 0.3)
})

check('price book tolerates dashed spellings and case', () => {
  assert.equal(host.priceRowFor('DeepSeek-V4.1-Flash').known, true)
  assert.equal(host.priceRowFor('deepseek-v4-1-flash').known, true)
  assert.equal(host.priceRowFor('totally-unknown-model').known, false)
})

check('peak clock matches the documented UTC windows', () => {
  // 2026-09-14 is a Monday. 02:00 UTC is inside 01:00-04:00.
  assert.equal(host.isPeakAt(Date.UTC(2026, 8, 14, 2, 0)), true)
  // 04:00 UTC is the exclusive end of the first window.
  assert.equal(host.isPeakAt(Date.UTC(2026, 8, 14, 4, 0)), false)
  // 07:00 UTC is inside 06:00-10:00.
  assert.equal(host.isPeakAt(Date.UTC(2026, 8, 14, 7, 0)), true)
  // 00:30 UTC is off-peak.
  assert.equal(host.isPeakAt(Date.UTC(2026, 8, 14, 0, 30)), false)
  // 2026-09-13 is a Sunday: weekends are off-peak even mid-window.
  assert.equal(host.isPeakAt(Date.UTC(2026, 8, 13, 2, 0)), false)
})

check('bucket pricing applies the right column', () => {
  const bucket = { i: 1_000_000, o: 1_000_000, cr: 0, cw: 0 }
  const offPeak = host.bucketCostUsd('deepseek-v4.1-flash', bucket, Date.UTC(2026, 8, 14, 0, 30)).usd
  const peak = host.bucketCostUsd('deepseek-v4.1-flash', bucket, Date.UTC(2026, 8, 14, 2, 0)).usd
  assert.equal(Number(offPeak.toFixed(4)), 0.75)
  assert.equal(Number(peak.toFixed(4)), 1.5)
})

// --- usage parsing ---------------------------------------------------------

check('parseUsage reads the three windows and drops the zero placeholder', () => {
  const parsed = host.parseUsage({
    usage: {
      rolling: { percent: 7, resetsAt: '2026-09-13T10:15:58.946Z' },
      weekly: { percent: 3, resetsAt: '2026-09-14T00:00:00.946Z' },
      monthly: { percent: 0, resetsAt: '2026-10-13T05:04:09.946Z' },
    },
  })
  assert.equal(parsed.windows.length, 3)
  assert.deepEqual(parsed.windows.map((w) => w.key), ['5h', 'week', 'month'])
  assert.equal(parsed.windows[0].percent, 7)
  assert.equal(parsed.windows[1].resetsAt, '2026-09-14T00:00:00.946Z')
  assert.equal(parsed.windows[2].resetsAt, null, 'percent 0 resetsAt is a placeholder')
})

check('parseUsage survives a malformed body', () => {
  assert.equal(host.parseUsage(undefined).windows.length, 0)
  assert.equal(host.parseUsage({ usage: 'nope' }).windows.length, 0)
})

// --- service fold ----------------------------------------------------------

const settingsValues = {
  'llm-pi-ai': {
    providers: {
      'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
      'opencode-go-v41': { apiKeyEnv: 'OPENCODE_GO_API_KEY', baseURL: 'https://opencode.ai/zen/go/v1' },
      'deepseek-official': { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    },
  },
  'agent-default-model': { provider: 'opencode-go-v41', model: 'deepseek-v4.1-flash' },
}
const fakeCtx = {
  get: (serviceName) => (serviceName === 'settings'
    ? { get: (ns) => settingsValues[ns] }
    : undefined),
}

check('service picks the active Go route', () => {
  const service = new host.GoUsageService(fakeCtx)
  const active = service.activeRoute()
  assert.equal(active.route.id, 'opencode-go-v41')
  assert.equal(active.model, 'deepseek-v4.1-flash')
})

check('the local ledger counts supported providers, not just Go', () => {
  const service = new host.GoUsageService(fakeCtx)
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  // 有适配器的 provider 要记 —— token 统计和哪家套餐无关。
  // 原来只记 Go，导致给 DeepSeek 官方加适配器后"今日 token"是空的：
  // 界面显示了余额，却说今天一个 token 都没用。
  service.record('deepseek-official', 'deepseek-v4-flash', usage, Date.now())
  assert.equal(service.buckets.size, 1, 'DeepSeek 官方有适配器，应当计入')
  service.record('opencode-go-v41', 'deepseek-v4.1-flash', usage, Date.now())
  assert.equal(service.buckets.size, 2)
  // 没有适配器的 provider 仍不记：这种情况界面走"只显示本地统计"的中性提示，
  // 账本留白才一致
  service.record('anthropic-official', 'claude-sonnet', usage, Date.now())
  assert.equal(service.buckets.size, 2, '没有适配器的 provider 不该进账本')
  service.record(undefined, 'x', usage, Date.now())
  assert.equal(service.buckets.size, 2, 'provider 缺失时不该崩，也不该记')
})

check('view() reports server percentages and a local estimate', () => {
  const service = new host.GoUsageService(fakeCtx)
  const now = Date.now()
  service.probe = {
    at: now,
    planName: undefined,
    windows: [
      { key: '5h', percent: 7, resetsAt: new Date(now + 3 * 3_600_000).toISOString() },
      { key: 'week', percent: 3, resetsAt: new Date(now + 2 * 86_400_000).toISOString() },
      { key: 'month', percent: 1, resetsAt: new Date(now + 20 * 86_400_000).toISOString() },
    ],
  }
  service.record('opencode-go-v41', 'deepseek-v4.1-flash',
    { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, now - 60_000)

  const view = service.view()
  assert.equal(view.ok, true)
  assert.equal(view.plan.name, 'OpenCode Go')
  assert.equal(view.windows.length, 3)
  assert.equal(view.windows[0].percent, 7, 'server percentage passes through untouched')
  assert.equal(view.windows[0].local.calls, 1)
  assert.equal(view.probe.ok, true)
  assert.equal(view.probe.routeId, 'opencode-go-v41')

  const expected = host.bucketCostUsd('deepseek-v4.1-flash',
    { i: 1_000_000, o: 1_000_000, cr: 0, cw: 0 }, now - 60_000).usd
  assert.equal(view.windows[0].local.usd, Math.round(expected * 1e4) / 1e4)
  assert.equal(view.local.topModel, 'deepseek-v4.1-flash')
  assert.equal(view.local.topModelMonthlyLimitUsd, 15)
})

check('a call outside the 5h window still counts toward the longer ones', () => {
  const service = new host.GoUsageService(fakeCtx)
  const now = Date.now()
  service.probe = {
    at: now,
    windows: [
      { key: '5h', percent: 0, resetsAt: null },
      { key: 'month', percent: 1, resetsAt: new Date(now + 20 * 86_400_000).toISOString() },
    ],
  }
  service.record('opencode-go-v41', 'deepseek-v4.1-flash',
    { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, now - 10 * 3_600_000)
  const view = service.view()
  assert.equal(view.windows[0].local.calls, 0, 'older than the rolling 5h window')
  const month = view.windows.filter((w) => w.key === 'month')[0]
  assert.equal(month.local.calls, 1)
})

check('the 5h window is anchored on the server reset, not on "now - 5h"', () => {
  const service = new host.GoUsageService(fakeCtx)
  const now = Date.now()
  // The server says the current 5-hour bucket closes in 3 hours, so it opened
  // 2 hours ago. A call 4 hours back belongs to the PREVIOUS bucket: summing
  // from `now - 5h` would wrongly include it and drift above the official
  // percentage this widget is displayed next to.
  service.probe = {
    at: now,
    windows: [{ key: '5h', percent: 7, resetsAt: new Date(now + 3 * 3_600_000).toISOString() }],
  }
  service.record('opencode-go-v41', 'deepseek-v4.1-flash',
    { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, now - 4 * 3_600_000)
  service.record('opencode-go-v41', 'deepseek-v4.1-flash',
    { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, now - 30 * 60_000)

  const fiveHour = service.view().windows.filter((w) => w.key === '5h')[0]
  assert.equal(fiveHour.local.calls, 1, 'only the call inside the server bucket counts')
  assert.ok(fiveHour.local.usd > 0)
})

check('the 5h window falls back to a rolling 5h when the server sends no instant', () => {
  const service = new host.GoUsageService(fakeCtx)
  const now = Date.now()
  service.probe = { at: now, windows: [{ key: '5h', percent: 0, resetsAt: null }] }
  service.record('opencode-go-v41', 'deepseek-v4.1-flash',
    { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, now - 2 * 3_600_000)
  const fiveHour = service.view().windows.filter((w) => w.key === '5h')[0]
  assert.equal(fiveHour.local.calls, 1, 'inside now - 5h')
})

// --- pet sprite + client-facing behaviour ----------------------------------

check('the built sprite is a real RGBA PNG that actually has transparency', async () => {
  const bytes = await readFile(host.PET_SPRITE_PATH)
  assert.ok(bytes.length > 1000, 'sprite is not empty')
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG signature')
  const sprite = decodePng(bytes)
  assert.equal(sprite.rgba.length, sprite.width * sprite.height * 4)
  let transparent = 0
  let opaque = 0
  for (let i = 3; i < sprite.rgba.length; i += 4) {
    if (sprite.rgba[i] === 0) transparent += 1
    else if (sprite.rgba[i] === 255) opaque += 1
  }
  const total = sprite.width * sprite.height
  assert.ok(sprite.width > 100 && sprite.height > 100, `sprite is ${sprite.width}x${sprite.height}`)
  assert.ok(transparent / total > 0.15, `only ${(transparent / total * 100).toFixed(1)}% transparent — background not removed?`)
  assert.ok(opaque / total > 0.15, `only ${(opaque / total * 100).toFixed(1)}% opaque — figure missing?`)
})

check('the host advertises the sprite URL to the browser', () => {
  const service = new host.GoUsageService(fakeCtx)
  assert.equal(service.view().pet.spriteUrl, host.PET_SPRITE_URL)
  assert.equal(host.PET_SPRITE_URL, '/opencode-go-usage-assets/pet.png')
  assert.ok(host.ASSET_PREFIX.startsWith('/'), 'asset prefix is absolute')
})

check('the sprite route 404s an unknown path and serves the sprite otherwise', async () => {
  const route = host.makeSpriteRoute()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, host.ASSET_PREFIX)
  // Drive the handler with a loopback-shaped request/response pair.
  const invoke = (url) => new Promise((resolve) => {
    const req = { url, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }
    const res = {
      status: 0,
      headers: undefined,
      body: undefined,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) { this.body = body; resolve(this) },
    }
    route.handler(req, res)
  })
  const missing = await invoke(`${host.ASSET_PREFIX}/nope.png`)
  assert.equal(missing.status, 404)
  const served = await invoke(host.PET_SPRITE_URL)
  assert.equal(served.status, 200)
  assert.equal(served.headers['content-type'], 'image/png')
  assert.equal(served.body.length, served.headers['content-length'] | 0)
})

check('a non-loopback request is refused the sprite', async () => {
  const route = host.makeSpriteRoute()
  const res = await new Promise((resolve) => {
    const req = { url: host.PET_SPRITE_URL, headers: { host: 'example.com' }, socket: { remoteAddress: '10.0.0.7' } }
    route.handler(req, {
      status: 0,
      writeHead(status) { this.status = status },
      end() { resolve(this) },
    })
  })
  assert.equal(res.status, 403)
})

check('mood thresholds bucket the 5-hour percentage', () => {
  assert.equal(client.moodFor(null), 'unknown')
  assert.equal(client.moodFor(0), 'calm')
  assert.equal(client.moodFor(client.WARN_AT - 1), 'calm')
  assert.equal(client.moodFor(client.WARN_AT), 'warn')
  assert.equal(client.moodFor(client.DANGER_AT - 1), 'warn')
  assert.equal(client.moodFor(client.DANGER_AT), 'danger')
  assert.equal(client.moodFor(100), 'danger')
})

check('colour follows the same thresholds', () => {
  assert.equal(client.colorFor(null), '#8b949e')
  assert.equal(client.colorFor(10), '#3fb950')
  assert.equal(client.colorFor(70), '#d29922')
  assert.equal(client.colorFor(95), '#f85149')
})

check('every mood has both copy and a face', () => {
  for (const mood of ['calm', 'warn', 'danger', 'unknown']) {
    assert.ok(Array.isArray(client.LINES[mood]) && client.LINES[mood].length > 0, `LINES.${mood}`)
    assert.ok(Array.isArray(client.FACES[mood]) && client.FACES[mood].length > 0, `FACES.${mood}`)
    for (const line of client.LINES[mood]) assert.ok(line.trim().length > 0, `empty line in LINES.${mood}`)
    for (const face of client.FACES[mood]) assert.ok(/[()]/.test(face), `FACES.${mood} entry is not a kaomoji: ${face}`)
  }
  assert.ok(client.FAREWELL.length > 0, 'FAREWELL')
  assert.ok(client.POKE.length > 0, 'POKE')
  // The unprompted alerts only exist for thresholds worth interrupting for.
  assert.ok(client.MOOD_ALERT.warn && client.MOOD_ALERT.danger && client.MOOD_ALERT.calm)
  assert.equal(client.MOOD_ALERT.unknown, undefined, 'never interrupt for "no data"')
})

check('countdown and money format for display', () => {
  const now = Date.now()
  assert.equal(client.countdown(null), '尚未开始计时')
  assert.equal(client.countdown(new Date(now - 1000).toISOString()), '已到重置时刻')
  // countdown 内部用 Date.now() 并按分钟/小时**向下取整**，而这里的时间戳是
  // 按"现在"算出来的 —— 断言执行时已经过去几毫秒，正好卡在整数边界上就会少一格
  // （实测出现过 3 天 2 小时 → 3 天 1 小时）。多给 30 秒余量把边界推开。
  const MARGIN = 30_000
  assert.match(client.countdown(new Date(now + 90 * 60_000 + MARGIN).toISOString()), /^1 小时 30 分后重置$/)
  assert.match(client.countdown(new Date(now + 3 * 86_400_000 + 2 * 3_600_000 + MARGIN).toISOString()),
    /^3 天 2 小时后重置$/)
  assert.equal(client.money(0), '本地 ≈ $0')
  assert.equal(client.money(0.004), '本地 ≈ <$0.01')
  assert.equal(client.money(1.234), '本地 ≈ $1.23')
})

check('card text is HTML-escaped', () => {
  assert.equal(client.escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;')
  assert.equal(client.escapeHtml('a & "b"'), 'a &amp; &quot;b&quot;')
  assert.equal(client.escapeHtml(null), '')
})

check('the size setting clamps, persists, and rides the payload', async () => {
  // Write into a throwaway directory: a test must never touch the real
  // ~/.dsh/opencode-go-usage state, which holds the user's actual layout.
  const service = new host.GoUsageService(fakeCtx)
  service.dir = await mkdtemp(join(tmpdir(), 'oguw-test-'))
  service.statePath = join(service.dir, 'state.json')
  service.ledgerPath = join(service.dir, 'ledger.json')
  assert.equal(service.size, host.DEFAULT_SIZE, 'starts at the default')

  const saved = await service.saveSize(999)
  assert.equal(saved, host.SIZE_MAX, 'clamped to the upper bound')
  assert.equal(service.size, host.SIZE_MAX)
  assert.equal((await service.saveSize(1)), host.SIZE_MIN, 'clamped to the lower bound')
  assert.equal((await service.saveSize(200.6)), 201, 'rounded')
  assert.equal((await service.saveSize('not a number')), host.DEFAULT_SIZE, 'garbage falls back to the default')

  const view = service.view()
  assert.equal(view.pet.size, service.size)
  assert.equal(view.pet.min, host.SIZE_MIN)
  assert.equal(view.pet.max, host.SIZE_MAX)

  // The persisted document carries both display facts, so neither write can
  // clobber the other.
  const state = JSON.parse(await readFile(service.statePath, 'utf8'))
  assert.equal(state.size, service.size)
  assert.ok(typeof state.position.left === 'number', 'position survived the size write')
  await rm(service.dir, { recursive: true, force: true })
})

check('the built sprite matches the aspect ratio the client CSS declares', async () => {
  // Read the ratio straight out of the bundle's stylesheet rather than from an
  // exported constant: the CSS is what actually sizes the image, so a padded
  // sprite paired with the old ratio would silently stretch the character.
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  const match = /aspect-ratio:(\d+)\s*\/\s*(\d+)/.exec(source)
  assert.ok(match !== null, 'the bundle declares an aspect-ratio')
  const [, cssW, cssH] = match
  const sprite = decodePng(await readFile(host.PET_SPRITE_PATH))
  const cssRatio = Number(cssW) / Number(cssH)
  const spriteRatio = sprite.width / sprite.height
  assert.ok(Math.abs(cssRatio - spriteRatio) < 0.005,
    `CSS says ${cssW}/${cssH} (${cssRatio.toFixed(3)}) but the sprite is ${sprite.width}x${sprite.height} (${spriteRatio.toFixed(3)})`)
})

check('a failed probe keeps the last readings and surfaces the error', () => {
  const service = new host.GoUsageService(fakeCtx)
  service.probe = { at: Date.now(), windows: [{ key: '5h', percent: 7, resetsAt: null }] }
  service.probeError = 'HTTP 401: invalid key'
  const view = service.view()
  assert.equal(view.probe.ok, false)
  assert.equal(view.probe.error, 'HTTP 401: invalid key')
  assert.equal(view.windows[0].percent, 7, 'a stale reading is still better than none')
})

// --- 骨骼桌宠：几何 / 动画 / 两条渲染路径 ------------------------------------

/** 与 makeSpriteRoute 的测试同一套请求-响应替身。 */
function driveSpriteRoute(route, url) {
  return new Promise((resolve) => {
    const req = { url, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }
    const res = {
      status: 0,
      headers: undefined,
      body: undefined,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) { this.body = body; resolve(this) },
    }
    route.handler(req, res)
  })
}

check('rig parts are all present and the geometry resolves', async () => {
  const rig = JSON.parse(await readFile(join(pkgRoot, 'assets/rig/rig.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(pkgRoot, 'assets/rig/parts/manifest.json'), 'utf8'))
  const geometry = resolveRig(rig, manifest)
  for (const name of PART_NAMES) {
    const p = geometry.parts[name]
    assert.ok(p, `geometry has ${name}`)
    // 每个部件都必须有轴心与落点矩阵，缺一个就会画到画布外面去
    assert.ok(p.pivotCanvasX > 0 && p.pivotCanvasY > 0, `${name} pivot is inside the canvas`)
    assert.equal(p.place.length, 6, `${name} place is a 2x3 affine`)
    assert.ok(Number.isFinite(p.place[2]) && Number.isFinite(p.place[5]), `${name} place has finite offsets`)
    const bytes = await readFile(join(pkgRoot, 'assets/rig/parts', `${name}.png`))
    const img = decodePng(bytes)
    assert.equal(img.width, p.width, `${name} width matches the manifest`)
    assert.equal(img.height, p.height, `${name} height matches the manifest`)
  }
  const bodyBytes = await readFile(join(pkgRoot, 'assets/rig/parts/body.png'))
  const bodyImg = decodePng(bodyBytes)
  assert.equal(bodyImg.width, geometry.body.width)
  assert.ok(geometry.canvas.width > 0 && geometry.canvas.height > 0, 'canvas has a size')
  // 画布必须装得下主体本身，否则说明有效包围盒算错了
  assert.ok(geometry.canvas.width >= geometry.body.width, 'canvas covers the body width')
  assert.ok(geometry.canvas.height >= geometry.body.height, 'canvas covers the body height')
})

check('the rig asset route serves whitelisted parts and refuses anything else', async () => {
  const route = host.makeSpriteRoute()
  for (const rel of host.RIG_FILES.keys()) {
    const res = await driveSpriteRoute(route, `${host.RIG_ASSET_PREFIX}/${rel}`)
    assert.equal(res.status, 200, `${rel} should be served`)
    assert.equal(res.body.length, res.headers['content-length'] | 0, `${rel} length header`)
  }
  const json = await driveSpriteRoute(route, `${host.RIG_ASSET_PREFIX}/rig.json`)
  assert.match(json.headers['content-type'], /application\/json/)
  // 穿越尝试与白名单外的名字都必须 404
  for (const bad of ['../rig.json', 'parts/../../package.json', 'parts/nope.png', '']) {
    const res = await driveSpriteRoute(route, `${host.RIG_ASSET_PREFIX}/${bad}`)
    assert.equal(res.status, 404, `${JSON.stringify(bad)} must not be served`)
  }
})

check('the state payload advertises the rig geometry to the browser', () => {
  const rig = host.rigDescriptor()
  assert.ok(rig !== null, 'rig descriptor resolves')
  assert.deepEqual(rig.canvas.width > 0 && rig.canvas.height > 0, true)
  assert.equal(rig.body.url, `${host.RIG_ASSET_PREFIX}/parts/body.png`)
  for (const name of PART_NAMES) {
    assert.ok(rig.parts[name], `descriptor carries ${name}`)
    assert.ok(rig.parts[name].url.endsWith(`/parts/${name}.png`))
    assert.equal(rig.parts[name].place.length, 6)
  }
  // 画在前面的必须在后面之前：耳朵/尾巴在主体之后，呆毛在主体之前
  assert.ok(rig.order.indexOf('body') < rig.order.indexOf('ahoge'), 'ahoge draws in front')
  assert.ok(rig.order.indexOf('tail') < rig.order.indexOf('body'), 'tail draws behind')
  assert.equal(new host.GoUsageService(fakeCtx).view().pet.rig.canvas.width, rig.canvas.width)
})

check('every inline block in the client is generated from tools/lib/', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  // 客户端不能 import，动画数学与音效合成各内联一份；两份都必须是生成的，
  // 手抄迟早走样，而"客户端的行为和离线验证的不一致"是最难查的一类问题。
  assert.equal(syncAll(source), source,
    'lib/client.js 的内联块与 tools/lib/ 下的源文件不一致 —— 跑 node tools/sync-anim.mjs')
  for (const block of BLOCKS) {
    assert.match(source, new RegExp(`${block.mark}:start`), `缺少 ${block.mark} 块`)
  }
  // 循环时长必须真的内联进去了，否则客户端取模会拿到 undefined
  assert.match(source, /const LOOP_SECONDS = \d+/)
  // 音效的时长与采样率同理
  assert.match(source, /const DUCK_SECONDS = [\d.]+/)
})

check("the client's matrices match the offline renderer's, item by item", () => {
  const descriptor = host.rigDescriptor()
  const offline = createRig({ root: pkgRoot })
  const names = ['body', 'ahoge', 'earLeft', 'earRight', 'tail']
  for (const t of [0, 0.4, 1.5, 2.99, 3.0, 3.46, 4.3, 5.5, 6]) {
    const mine = client.rigInternals.matrices(t, descriptor, 0.5)
    const theirs = offline.matrices(t, 0.5)
    for (const name of names) {
      for (let i = 0; i < 6; i += 1) {
        assert.ok(Math.abs(mine[name][i] - theirs[name][i]) < 1e-9,
          `${name}[${i}] at t=${t}: client ${mine[name][i]} vs offline ${theirs[name][i]}`)
      }
    }
  }
})

check('the client animation loop closes on itself', () => {
  const { LOOP_SECONDS, bodyTransform, ahogeAngle, earAngle, tailAngle } = client.rigInternals
  assert.ok(LOOP_SECONDS > 0)
  const sample = (t) => {
    const b = bodyTransform(t)
    return [b.sx, b.sy, b.dy, ahogeAngle(t), earAngle(t, 'left'), earAngle(t, 'right'), tailAngle(t)]
  }

  // (1) 周期闭合。紧支撑脉冲项逐位相等；正弦项因为 sin(4π+φ) 与 sin(φ) 在浮点里
  //     差最后几位（实测 ~2.5e-15 度），所以这里用阈值而不是逐位相等。
  //     这个量级对应亚像素位移 ~1e-14 px，渲染结果仍然逐字节相同（render-anim.mjs 有验证）。
  const at0 = sample(0)
  const atT = sample(LOOP_SECONDS)
  for (let i = 0; i < at0.length; i += 1) {
    assert.ok(Math.abs(at0[i] - atT[i]) < 1e-9, `channel ${i}: t=0 vs t=T 差 ${Math.abs(at0[i] - atT[i])}`)
  }

  // (2) 真正的接缝条件：客户端把时间对 LOOP_SECONDS 取模，永远取不到 t=T，
  //     它经历的是 …→t=T⁻ 然后跳到 t=0。所以关键是「跨越接缝的那一步」不能比
  //     循环内部普通相邻帧的步子更大 —— 否则就会看到一下顿挫。
  const DT = 1 / 60
  const steps = []
  const wrapStep = at0.map((v, i) => Math.abs(v - sample(LOOP_SECONDS - DT)[i]))
  for (let k = 0; k * DT < LOOP_SECONDS - DT; k += 1) {
    const a = sample(k * DT), b = sample((k + 1) * DT)
    for (let i = 0; i < a.length; i += 1) steps.push(Math.abs(b[i] - a[i]))
  }
  const innerMax = Math.max(...steps)
  const wrapMax = Math.max(...wrapStep)
  assert.ok(wrapMax <= Math.max(1e-9, innerMax * 1.5),
    `接缝步子 ${wrapMax} 明显大于循环内最大步子 ${innerMax} —— 存在跳变`)

  // (3) 确认它真的在动，否则「首尾相同」是静止带来的假阳性。
  //     用整循环幅度而不是单点比较 —— 单点可能恰好落在与 t=0 相近的相位上。
  let ahogePeak = 0, tailPeak = 0, earPeak = 0
  for (let k = 0; k <= 240; k += 1) {
    const t = (k * LOOP_SECONDS) / 240
    ahogePeak = Math.max(ahogePeak, Math.abs(ahogeAngle(t)))
    tailPeak = Math.max(tailPeak, Math.abs(tailAngle(t)))
    earPeak = Math.max(earPeak, Math.abs(earAngle(t, 'left')))
  }
  assert.ok(ahogePeak > 5, `呆毛幅度只有 ${ahogePeak.toFixed(2)}°`)
  assert.ok(tailPeak > 5, `尾巴幅度只有 ${tailPeak.toFixed(2)}°`)
  assert.ok(earPeak > 5, `左耳幅度只有 ${earPeak.toFixed(2)}°`)
  assert.ok(innerMax > 0, 'the loop has motion at all')
})

check('the skeleton pet starts when the state document arrives, not at mount', async () => {
  // 回归守卫：snapshot 在挂载时是 null，rig 描述来自状态文档。
  // 若把 startRig() 只放在挂载流程里，它会读到 null 就返回、再也不重试，
  // 表现就是"装了新插件但看不到新动画"。
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  const branch = source.match(/if \(first\) \{[\s\S]*?\n {8}\}/)
  assert.ok(branch, 'client.js 里找不到 if (first) 分支')
  assert.match(branch[0], /startRig\(\)/, 'startRig() 没挂在「首次拿到状态文档」的分支里')
  assert.match(branch[0], /adoptSprite\(\)/, 'adoptSprite() 也该在同一分支（同一类时序问题）')
})

check('the click bounce outranks the hover animation', async () => {
  // 回归守卫：`.oguw-pet:hover .oguw-sprite` 的特异度高于 `.oguw-pop`，
  // 而点击时鼠标必然还在角色上 —— 直接加类会被 hover 顶掉，
  // 表现就是"点了只有轻微抬起、没有压缩弹动"。这里比对两条规则的选择器权重。
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  const weight = (selector) => (selector.match(/[.[:]/g) ?? []).length
  const hover = source.match(/'([^']*:hover[^']*)\{animation:oguw-hover/)
  const pop = source.match(/'([^']*\[data-popping="1"\][^']*)\{animation:oguw-pop/)
  assert.ok(hover, '找不到 hover 动画规则')
  assert.ok(pop, '找不到 data-popping 驱动的弹动规则')
  assert.ok(weight(pop[1]) > weight(hover[1]),
    `弹动选择器权重 ${weight(pop[1])} 没超过 hover 的 ${weight(hover[1])}：${pop[1]} vs ${hover[1]}`)
  // 反馈必须由根节点属性驱动，而不是往角色元素上直接加类
  assert.match(source, /ui\.root\.dataset\.popping = '1'/)
  assert.doesNotMatch(source, /ui\.sprite\.classList\.(add|remove)\('oguw-pop'/)
})

check('the character element has both rig and flat variants', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  assert.match(source, /class="oguw-sprite oguw-rigcanvas"/)
  assert.match(source, /class="oguw-sprite oguw-flatimg"/)
  assert.match(source, /\.oguw-rigcanvas\{display:none\}/)
  assert.match(source, /\[data-mode="rig"\] \.oguw-breathe\{animation:none\}/)
})

check('facing mirrors the character toward the middle of the screen', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  // 镜像必须放在单独一层，否则会和呼吸/弹动的 transform 互相覆盖
  assert.match(source, /class="oguw-breathe"><div class="oguw-facing">/)
  assert.match(source, /\.oguw-facing\{transform:scaleX\(var\(--oguw-flip,1\)\)/)
  assert.match(source, /--oguw-flip/)
  assert.match(source, /function applyFacing\(left, width\)/)
  // 判定必须用角色中心与屏幕中线比，不能用左右边缘
  assert.match(source, /var centerX = left \+ width \/ 2/)
  assert.match(source, /var onLeft = centerX < window\.innerWidth \/ 2/)
  // 贴着位置变化的三条路径都要刷新朝向：状态更新、拖动过程、窗口缩放
  assert.match(source, /applyFacing\(left, width\)/)
  assert.match(source, /拖动过程中就转身[\s\S]{0,80}applyFacing\(left, width\)/)
})

check('the character reports today\'s token spend', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  assert.match(source, /function formatTokens\(value\)/)
  assert.match(source, /function todayUsage\(\)/)
  // 气泡（不用点开就能看）和卡片注释都要用今日口径，且拆出输入/输出/缓存
  assert.match(source, /'今日 ' \+ formatTokens\(local\.todayTokens\)/)
  assert.match(source, /formatTokens\(local\.todayInTokens\)/)
  assert.match(source, /formatTokens\(local\.todayOutTokens\)/)
  assert.match(source, /formatTokens\(local\.todayCachedTokens\)/)
  assert.match(source, /class="oguw-today"/)
  // 宿主必须真的把这些字段发出来，否则客户端显示的是 undefined
  const doc = new host.GoUsageService(fakeCtx).view()
  for (const field of ['todayTokens', 'todayInTokens', 'todayOutTokens', 'todayCachedTokens', 'todayUsd', 'todayCalls']) {
    assert.equal(typeof doc.local[field], 'number', `local.${field} 应该是数字`)
  }
  // "今日"必须从本机零点起算 —— 不是 UTC 零点，也不是"最近 24 小时"
  const midnight = new Date(doc.generatedAt)
  midnight.setHours(0, 0, 0, 0)
  assert.equal(doc.local.todaySince, midnight.getTime(), 'todaySince 应该是本机当天零点')
  assert.ok(doc.local.todaySince <= doc.generatedAt, 'todaySince 不晚于当前时刻')
  // 拆项之和不得超过总量（超了说明窗口算重了）
  assert.ok(doc.local.todayInTokens + doc.local.todayOutTokens <= doc.local.todayTokens + 1,
    'in + out 不应超过 total（total 还含缓存）')
})

check('the click reaction is a vertical squash only, no sideways sway', async () => {
  // 左右晃动会和朝向镜像、骨骼待机动画叠在一起，看起来像站不稳，已按需求去掉。
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  assert.doesNotMatch(source, /oguw-sway/, '不该再有 sway 动画')
  assert.doesNotMatch(source, /swaying/, '不该再有 swaying 状态')
  assert.doesNotMatch(source, /bounce\((true|false)\)/, 'bounce 不再带参数')
  // 弹动幅度要够看得见：压缩那一下的纵向缩放明显小于 1，回弹明显大于 1
  const pop = source.match(/@keyframes oguw-pop\{([\s\S]*?)\}\}/)
  assert.ok(pop, '找不到 oguw-pop keyframes')
  const scales = [...pop[1].matchAll(/scale\(([\d.]+),\s*([\d.]+)\)/g)].map((m) => Number(m[2]))
  assert.ok(scales.length >= 6, `oguw-pop 关键帧太少：${scales.length}`)
  // 幅度按需求定在"纵向压缩/回弹各约 15%"这一档。范围写得比实现宽一点，
  // 但足以挡住"又不小心改成 30%"或"小到看不见"这两种回归。
  const minScale = Math.min(...scales)
  const maxScale = Math.max(...scales)
  assert.ok(minScale <= 0.9 && minScale >= 0.6, `纵向压缩 ${minScale}，落在 0.6~0.9 之外`)
  assert.ok(maxScale >= 1.1 && maxScale <= 1.4, `纵向回弹 ${maxScale}，落在 1.1~1.4 之外`)
  // 时长必须由 POP_MS 统一换算，否则 JS 定时器会提前把动画撤掉
  assert.match(source, /var popSeconds = \(POP_MS \/ 1000\)/)
  assert.match(source, /\}, POP_MS \+ 40\)/)
})

check('draw order comes from rig.json and is validated', async () => {
  const rig = JSON.parse(await readFile(join(pkgRoot, 'assets/rig/rig.json'), 'utf8'))
  assert.ok(Array.isArray(rig.order), 'rig.json 应该显式声明绘制顺序')
  assert.equal(rig.order.length, 5)
  // 两只耳朵都藏在头发后面（画在 body 之前），露出来的只有耳尖。
  // 注意桌宠贴屏幕左半边时会被水平镜像，屏幕上左边那只耳朵其实是角色的右耳 ——
  // 反馈层级问题前先确认镜像状态，否则很容易把两只耳朵改反。
  assert.ok(rig.order.indexOf('earLeft') < rig.order.indexOf('body'),
    '左耳应该画在主体之前（藏在头发后面）')
  assert.ok(rig.order.indexOf('earRight') < rig.order.indexOf('body'),
    '右耳应该画在主体之前（藏在头发后面）')
  const geometry = resolveRig(rig, JSON.parse(await readFile(join(pkgRoot, 'assets/rig/parts/manifest.json'), 'utf8')))
  assert.deepEqual(geometry.order, rig.order)
  // 顺序写坏时必须报错，而不是悄悄少画一个（用真实清单，确保撞的是顺序校验本身）
  const manifest = JSON.parse(await readFile(join(pkgRoot, 'assets/rig/parts/manifest.json'), 'utf8'))
  assert.throws(() => resolveRig({ ...rig, order: ['body', 'ahoge'] }, manifest), /order/)
  assert.throws(() => resolveRig({ ...rig, order: ['body', 'ahoge', 'earLeft', 'earRight', 'ahoge'] }, manifest), /order/)
})

check('both ear tips peek out by the same amount', async () => {
  // 这条直接对应需求："两只耳朵都在头发后面，露出来的耳尖要差不多"。
  // 靠肉眼在缩略图上判断不可靠，所以数像素：耳朵覆盖、主体没覆盖 = 真正露出来的量。
  const rig = readRig()
  const measured = measureEars(rig)
  const left = measured.sides.earLeft
  const right = measured.sides.earRight

  // 1) 露出的量要相当。右侧头发与蝴蝶结更大，同落点下右耳会被挡得更多，
  //    所以右耳的 x 是往外挪过的（见 tools/ear-balance.mjs --sweep）。
  const ratio = left.visible / right.visible
  assert.ok(ratio > 0.85 && ratio < 1.18,
    `左右露出比 ${ratio.toFixed(2)}，超出配平范围（左 ${left.visible} / 右 ${right.visible}）`)
  // 2) 也不能小到看不见
  assert.ok(Math.min(left.visible, right.visible) > 4000,
    `露出的耳尖太小：左 ${left.visible} / 右 ${right.visible}`)
  // 3) 耳根必须仍被头发盖住，否则接缝会露出来变成"漂浮的鳍"
  assert.ok(left.rootCovered, '左耳耳根露在头发外面了')
  assert.ok(right.rootCovered, '右耳耳根露在头发外面了')
})

check('the package ships every file it reads at runtime', async () => {
  // 这个插件会**静默降级**：少了 assets/rig/parts 里任何一张部件图，宿主照常启动、
  // 界面照常显示，只是角色退回静态整图。在别人的机器上极难排查，所以在这里拦住。
  const pkg = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  const { missing, ok } = checkFilesField(pkg)
  assert.ok(ok, `package.json 的 files 漏了：${missing.join('、')}`)
  for (const file of RUNTIME_FILES) {
    assert.ok(existsSync(join(pkgRoot, file)), `运行时文件不存在：${file}`)
  }
  // lib/ 必须自包含：装到别的机器后包目录就是全部，引用 ../../tools 会直接崩
  const sources = {}
  for (const file of RUNTIME_FILES.filter((f) => f.startsWith('lib/') && f.endsWith('.js'))) {
    sources[file] = await readFile(join(pkgRoot, file), 'utf8')
  }
  const offenders = externalImports(sources)
  assert.deepEqual(offenders, [], `lib/ 引用了包外的东西：${offenders.join('、')}`)
})

// --- 套餐适配器 -------------------------------------------------------------
//
// Command Code 那边没有可用的 key，无法实机验证，所以这一层靠假响应兜住：
// 端点、字段名、百分比算法都是从 command-code CLI 的 bundle 里逆出来的，
// 一旦哪天接口改了字段，这里的假响应就该同步更新。

check('adapters claim providers by id or baseURL', () => {
  assert.equal(host.adapterFor({ providerId: 'opencode-go-v41' }).id, 'opencode-go')
  assert.equal(host.adapterFor({ providerId: 'weird', baseURL: 'https://opencode.ai/zen/go/v1' }).id, 'opencode-go')
  assert.equal(host.adapterFor({ providerId: 'command-code' }).id, 'command-code')
  assert.equal(host.adapterFor({ providerId: 'cmdc', baseURL: 'https://api.commandcode.ai' }).id, 'command-code')
  assert.equal(host.adapterFor({ providerId: 'deepseek-official' }).id, 'deepseek')
  // 认不出来必须返回 undefined（而不是随便挑一个），主模块据此走"本地统计"路径
  assert.equal(host.adapterFor({ providerId: 'anthropic-official' }), undefined)
  assert.equal(host.adapterFor({ providerId: 'some-local-llama', baseURL: 'http://127.0.0.1:11434/v1' }), undefined)
  assert.equal(host.adapterFor({}), undefined)
})

check('Command Code plan ids map to their monthly credits', () => {
  assert.deepEqual(host.commandCodePlan('individual-goat'), { id: 'individual-goat', name: 'GOAT', monthlyCredits: 70 })
  assert.equal(host.commandCodePlan('individual-go').monthlyCredits, 10)
  assert.equal(host.commandCodePlan('INDIVIDUAL_PRO').name, 'Pro')
  // 下划线写法也要认（接口侧两种都出现过）
  assert.equal(host.commandCodePlan('individual_max').monthlyCredits, 150)
  // 最长前缀：provider 不能被 pro 抢先匹配
  assert.equal(host.commandCodePlan('individual-pro-v1').monthlyCredits, 80)
  assert.equal(host.commandCodePlan('individual-provider').name, 'Provider')
  assert.equal(host.commandCodePlan('unknown-plan'), undefined)
  assert.equal(host.commandCodePlan(null), undefined)
})

check('credits projection mirrors the CLI formula', () => {
  const view = host.projectCredits({
    credits: { monthlyCredits: 42.5, purchasedCredits: 10, freeCredits: 0, planId: 'individual-goat' },
    subscription: { planId: 'individual-goat', status: 'active', currentPeriodStart: '2026-09-01T00:00:00Z', currentPeriodEnd: '2026-10-01T00:00:00Z' },
    summary: { totalCost: 17.5 },
  })
  assert.equal(view.planName, 'GOAT')
  assert.equal(view.totalRemaining, 52.5)
  assert.equal(view.totalSpent, 17.5)
  // 订阅生效时以计划额度为准：max(70, 42.5) + 10 + 0 = 80
  assert.equal(view.totalPool, 80)
  // 已用 = 80 - 52.5 = 27.5 → 34.375%
  assert.equal(Math.round(view.usagePercent * 100) / 100, 34.38)
  assert.equal(view.hasCredits, true)
  assert.equal(view.periodEnd, '2026-10-01T00:00:00.000Z')
})

check('credits projection degrades without a subscription', () => {
  // 没有订阅状态时总额退化成"已花 + 还剩"，避免把赠送额度当成总额
  const view = host.projectCredits({
    credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 3 },
    subscription: {},
    summary: { totalCost: 12 },
  })
  assert.equal(view.totalPool, 20)
  assert.equal(view.totalRemaining, 8)
  assert.equal(view.usagePercent, 60)
  assert.equal(view.planName, null)
  // 一分钱数据都没有时不能算出 NaN
  const empty = host.projectCredits({ credits: {}, subscription: {}, summary: {} })
  assert.equal(empty.usagePercent, 0)
  assert.equal(empty.hasCredits, false)
  assert.ok(Number.isFinite(empty.totalPool))
})

check('windowLimits parsing survives both shapes and junk', () => {
  const asArray = host.projectWindowLimits([
    { label: '5 小时', used: 25, cap: 100, resetAt: '2026-09-14T20:00:00Z' },
    { label: '每周', used: 1, cap: 0 },
  ])
  assert.equal(asArray.length, 2)
  assert.equal(asArray[0].percent, 25)
  assert.equal(asArray[0].label, '5 小时')
  assert.equal(asArray[0].resetsAt, '2026-09-14T20:00:00.000Z')
  // cap 为 0 时不能算出 Infinity/NaN，要留 null
  assert.equal(asArray[1].percent, null)

  const asObject = host.projectWindowLimits({ daily: { used: 3, limit: 12 } })
  assert.equal(asObject.length, 1)
  assert.equal(asObject[0].percent, 25)
  assert.equal(asObject[0].label, 'daily')

  // 未公开接口：认不出来就返回空数组，绝不能抛
  assert.deepEqual(host.projectWindowLimits(null), [])
  assert.deepEqual(host.projectWindowLimits(undefined), [])
  assert.deepEqual(host.projectWindowLimits('nonsense'), [])
  assert.deepEqual(host.projectWindowLimits([{ unrelated: true }, 7, null]), [])
})

check('the Command Code adapter normalizes a fake response', async () => {
  const calls = []
  const adapter = host.adapterFor({ providerId: 'command-code' })
  const view = await adapter.probe({
    providerId: 'command-code',
    resolveApiKey: async () => 'fake-key',
    readCommandCodeAuthFile: async () => undefined,
    fetchJson: async (url, init) => {
      calls.push(url)
      assert.equal(init.headers.authorization, 'Bearer fake-key')
      if (url.includes('/alpha/whoami')) return { org: { id: 'org_1' } }
      if (url.includes('/alpha/billing/credits')) {
        return { credits: { monthlyCredits: 52.5, purchasedCredits: 0, freeCredits: 0, planId: 'individual-goat', windowLimits: [{ label: '5 小时', used: 25, cap: 100 }] } }
      }
      if (url.includes('/alpha/billing/subscriptions')) {
        return { data: { planId: 'individual-goat', status: 'active', currentPeriodStart: '2026-09-01T00:00:00Z', currentPeriodEnd: '2026-10-01T00:00:00Z' } }
      }
      return { totalCost: 17.5 }
    },
  })
  // 四个端点都要打到，且 credits/subscriptions 带上 orgId
  assert.equal(calls.length, 4)
  assert.ok(calls.some((u) => u.includes('/alpha/whoami?limits=1')))
  assert.ok(calls.some((u) => u.includes('/alpha/billing/credits?orgId=org_1')))
  assert.ok(calls.some((u) => u.includes('/alpha/usage/summary?') && u.includes('orgId=org_1') && u.includes('since=')))
  assert.equal(view.adapterId, 'command-code')
  assert.equal(view.planName, 'Command Code GOAT')
  assert.equal(view.percentLabel, '本期')
  assert.equal(Math.round(view.percent * 100) / 100, 25)   // 80 总额 - 60 剩余 → 25%
  assert.equal(view.windows[0].key, 'period')
  assert.equal(view.windows[1].key, 'window-0')            // windowLimits 也跟着出来了
  assert.equal(view.credits.totalRemaining, 52.5)
})

check('the Command Code adapter reports a missing key as an error, not as zero', async () => {
  const adapter = host.adapterFor({ providerId: 'command-code' })
  await assert.rejects(
    () => adapter.probe({
      providerId: 'command-code',
      resolveApiKey: async () => undefined,
      readCommandCodeAuthFile: async () => undefined,
      fetchJson: async () => { throw new Error('不该发请求') },
    }),
    /COMMAND_CODE_API_KEY/,
  )
})

check('a non-2xx probe surfaces as an error rather than a zero reading', async () => {
  // fetchJson 是模块内部的，这里走适配器验证它的语义：
  // HTTP 失败必须抛，否则界面会显示成 0% 而不是"未授权"
  const adapter = host.adapterFor({ providerId: 'opencode-go' })
  await assert.rejects(
    () => adapter.probe({
      providerId: 'opencode-go',
      resolveApiKey: async () => 'k',
      fetchJson: async () => { throw new Error('HTTP 401 — Invalid Authorization header') },
    }),
    /401/,
  )
})

check('an unclaimed provider degrades to local stats instead of erroring', async () => {
  const settings = {
    'llm-pi-ai': { providers: { 'anthropic-official': { apiKeyEnv: 'ANTHROPIC_API_KEY' } } },
    'agent-default-model': { provider: 'anthropic-official', model: 'claude-sonnet' },
  }
  const ctx = { get: (n) => (n === 'settings' ? { get: (ns) => settings[ns] } : undefined) }
  const service = new host.GoUsageService(ctx)
  await service.probeNow()
  // 没有适配器是正常情况：不该报错，只给一句中性说明
  assert.equal(service.probeError, undefined)
  assert.equal(service.probe, undefined)
  const view = service.view()
  assert.equal(view.primary, null)
  assert.equal(view.probe.ok, false)      // 没有官方数据
  assert.equal(view.probe.error, null)    // 但不是失败
  assert.match(view.probe.note, /anthropic-official/)
  assert.equal(view.credits, null)
})

check('the bubble follows the host-provided primary reading', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  // 客户端不能写死窗口 key —— 换套餐时它不该跟着改
  assert.match(source, /function primaryReading\(\)/)
  assert.match(source, /snapshot\.primary/)
  assert.match(source, /escapeHtml\(reading\.label\)/)
  assert.doesNotMatch(source, /'<span class="oguw-quota-label">5 小时<\/span>'/)
})

// --- 点击音效（小黄鸭） -----------------------------------------------------

check('the duck call renders deterministically and is normalized', async () => {
  const { renderDuck, DUCK_SECONDS } = await import('../tools/lib/duck.mjs')
  const a = renderDuck(48000)
  const b = renderDuck(48000)
  assert.equal(a.length, Math.floor(48000 * DUCK_SECONDS))
  // 纯函数：同样的采样率必须得到逐位相同的样本 —— 这是"离线试听 WAV
  // 与实机听到的是同一个声音"的前提
  assert.deepEqual(Array.from(a), Array.from(b))
  // 不同采样率要给出等长（秒）的样本，而不是等长的数组
  assert.equal(renderDuck(44100).length, Math.floor(44100 * DUCK_SECONDS))
  // 归一化到 0.9：太小声听不见，顶到 1.0 会在设备上削波
  let peak = 0
  for (const value of a) peak = Math.max(peak, Math.abs(value))
  assert.ok(peak > 0.85 && peak <= 0.9001, `峰值 ${peak}`)
  // 两端要收敛到静音，否则接上其它声音会"啪"一声
  assert.ok(Math.abs(a[0]) < 0.02, `开头不是静音：${a[0]}`)
  assert.ok(Math.abs(a[a.length - 1]) < 0.02, `结尾不是静音：${a[a.length - 1]}`)
})

check('the duck call rises then falls, like a squeeze toy', async () => {
  const { duckPitch, duckEnvelope } = await import('../tools/lib/duck.mjs')
  // 捏下去 → 音高被挤上去 → 随气压回落；平音或单调都不像鸭子
  const samples = []
  for (let i = 0; i <= 20; i += 1) samples.push(duckPitch(i / 20))
  const peakAt = samples.indexOf(Math.max(...samples))
  assert.ok(peakAt > 2 && peakAt < 18, `音高峰值在第 ${peakAt}/20 段，不是中间`)
  assert.ok(samples[0] < samples[peakAt], '开头应该比峰值低')
  assert.ok(samples[20] < samples[peakAt], '结尾应该比峰值低')
  assert.ok(samples[peakAt] > samples[0] * 1.5, '上滑幅度太小，听不出"吱"')
  // 包络：快起音 + 单调衰减
  assert.equal(duckEnvelope(0), 0)
  assert.ok(duckEnvelope(0.06) === 1, '起音点应该是满音量')
  assert.ok(duckEnvelope(0.5) < duckEnvelope(0.2), '后半段必须衰减')
  assert.equal(duckEnvelope(1), 0)
})

check('the click sound is wired to the click, and only there', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  // 合成块是生成的，不是手抄的
  assert.match(source, /@oguw-duck:start/)
  assert.match(source, /function renderDuck\(rate\)/)
  // 播放走 Web Audio，并且要能应付浏览器把 AudioContext 挂起的情况
  assert.match(source, /function playDuck\(\)/)
  assert.match(source, /ctx\.state === 'suspended'/)
  assert.match(source, /createBufferSource/)
  // 播放抽成了通用 playTone，音色作为参数传入（鸭子 / 啵 共用同一条路径）
  assert.match(source, /function playTone\(name, render, volume, rate\)/)
  // 用真实采样率生成，而不是把 48k 的样本硬塞给 44.1k 的设备
  assert.match(source, /render\(ctx\.sampleRate\)/)
  assert.match(source, /playTone\('duck', renderDuck, 0\.55, 1\)/)
  // 只在 poke() 里响
  const poke = source.match(/function poke\(\) \{[\s\S]*?\n {4}\}/)
  assert.ok(poke, '找不到 poke()')
  assert.match(poke[0], /playDuck\(\)/, 'poke() 里没有播放音效')
  // 音效必须在用户手势里启动；AudioContext 懒建才不会一上来就被挂起
  assert.match(source, /function audioContext\(\)/)
})

check('the sound preference persists and can be muted', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  assert.match(source, /function soundEnabled\(\)/)
  assert.match(source, /pet\.sound !== false/, '默认必须是"开"')
  assert.match(source, /function saveSound\(on\)/)
  assert.match(source, /API \+ '\/sound'/)
  assert.match(source, /oguw-sound/)

  // 宿主侧：路由存在、语义正确（非 false 即开）
  const service = new host.GoUsageService(fakeCtx)
  assert.equal(service.sound, true, '默认开')
  assert.equal(service.view().pet.sound, true)
  assert.equal(await service.saveSound(false), false)
  assert.equal(service.view().pet.sound, false)
  assert.equal(await service.saveSound(true), true)
  // 传垃圾值也当"开"，只有明确的 false 才静音
  assert.equal(await service.saveSound('nonsense'), true)
  assert.equal(await service.saveSound(0), true)
  const route = host.makeSoundRoute(service)
  assert.equal(route.path, `${host.API_PREFIX}/sound`)
})

check('the boop renders deterministically and is shorter than the duck', async () => {
  const { renderBoop, boopPitch, boopEnvelope, BOOP_SECONDS } = await import('../tools/lib/boop.mjs')
  const { DUCK_SECONDS } = await import('../tools/lib/duck.mjs')
  const a = renderBoop(48000)
  const b = renderBoop(48000)
  assert.deepEqual(Array.from(a), Array.from(b), '纯函数必须逐位可复现')
  assert.equal(a.length, Math.floor(48000 * BOOP_SECONDS))
  // 缩放是高频动作，声音必须比点击更短
  assert.ok(BOOP_SECONDS < DUCK_SECONDS, `啵 ${BOOP_SECONDS}s 不该比鸭子 ${DUCK_SECONDS}s 长`)
  let peak = 0
  for (const value of a) peak = Math.max(peak, Math.abs(value))
  assert.ok(peak > 0.85 && peak <= 0.9001, `峰值 ${peak}`)
  assert.ok(Math.abs(a[0]) < 0.02 && Math.abs(a[a.length - 1]) < 0.02, '两端必须收敛到静音')

  // "q 弹"来自**快速**上滑：峰值要出现在前 40% 之内，慢了就不弹了
  const pitches = []
  for (let i = 0; i <= 20; i += 1) pitches.push(boopPitch(i / 20))
  const peakAt = pitches.indexOf(Math.max(...pitches))
  assert.ok(peakAt <= 8, `音高峰值在第 ${peakAt}/20 段，上滑太慢，不弹`)
  assert.ok(pitches[peakAt] > pitches[0] * 1.8, '上滑幅度太小')
  assert.ok(pitches[20] < pitches[peakAt], '结尾应该回落')
  assert.equal(boopEnvelope(0), 0)
  assert.ok(boopEnvelope(0.11) > 0.99, '起音点应该接近满音量')
  assert.equal(boopEnvelope(1), 0)
})

check('the boop is rounder than the duck, so repeated resizes do not grate', async () => {
  const { renderBoop } = await import('../tools/lib/boop.mjs')
  const { renderDuck } = await import('../tools/lib/duck.mjs')
  /** 一阶差分的平均绝对值：越高说明波形越"有棱角"（高频成分越多）。 */
  const roughness = (samples) => {
    let sum = 0
    for (let i = 1; i < samples.length; i += 1) sum += Math.abs(samples[i] - samples[i - 1])
    return sum / (samples.length - 1)
  }
  const boop = roughness(renderBoop(48000))
  const duck = roughness(renderDuck(48000))
  // 鸭子走带通（鼻音、尖），啵走低通（圆）；滚轮一次手势会连响好几次，
  // 两者若一样刺耳，连续缩放会很难受
  assert.ok(boop < duck, `啵的粗糙度 ${boop.toFixed(4)} 不该高于鸭子的 ${duck.toFixed(4)}`)
})

check('resizing plays the boop, throttled', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  assert.match(source, /@oguw-bo[o]?p:start/)
  assert.match(source, /function renderBoop\(rate\)/)
  assert.match(source, /function playBoop\(\)/)
  assert.match(source, /function playTone\(name, render, volume, rate\)/)
  // 必须限流：滚轮一次手势会触发几十个事件，逐个播放就是机关枪
  assert.match(source, /now - lastBoopAt < \d+/)
  // 轻微随机变调：同一段采样连播会像机械音
  assert.match(source, /source\.playbackRate\.value = rate/)
  assert.match(source, /0\.94 \+ Math\.random\(\) \* 0\.12/)
  // 只在尺寸真的变了时响 —— 到上下限还继续滚，角色没动却一直响会很怪
  const resize = source.match(/function resizeTo\(size, immediate\) \{[\s\S]*?\n {4}\}/)
  assert.ok(resize, '找不到 resizeTo()')
  assert.match(resize[0], /if \(changed\) playBoop\(\)/)
  assert.match(resize[0], /var changed = /)
})

check('the pet has a name, and the host owns it', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  assert.match(source, /var DEFAULT_PET_NAME = '蓝色大肥鱼'/)
  assert.match(source, /function petName\(\)/)
  assert.match(source, /pet\.name/)
  // 名字要出现在悬停提示与卡片标题上方
  assert.match(source, /class="oguw-petname"/)
  assert.match(source, /ui\.petname\.textContent = petName\(\)/)
  assert.match(source, /pet\.setAttribute\('title', petName\(\)/)
  assert.match(source, /\.oguw-petname\{/)

  const view = new host.GoUsageService(fakeCtx).view()
  assert.equal(view.pet.name, '蓝色大肥鱼', '宿主必须把名字放进载荷')
})

// --- DeepSeek 官方（按量计费的钱包） ----------------------------------------

check('the DeepSeek adapter reads the balance and reports it as a balance, not a percent', async () => {
  const adapter = host.adapterFor({ providerId: 'deepseek-official' })
  assert.equal(adapter.id, 'deepseek')
  assert.equal(host.adapterFor({ providerId: 'x', baseURL: 'https://api.deepseek.com' }).id, 'deepseek')

  let called = null
  const view = await adapter.probe({
    providerId: 'deepseek-official',
    resolveApiKey: async (id, env) => { assert.equal(env, 'DEEPSEEK_API_KEY'); return 'k' },
    fetchJson: async (url, init) => {
      called = url
      assert.equal(init.headers.authorization, 'Bearer k')
      // 真实响应结构（本机实测）
      return {
        is_available: false,
        balance_infos: [{ currency: 'CNY', total_balance: '-2.71', granted_balance: '0.00', topped_up_balance: '-2.71' }],
      }
    },
  })
  assert.equal(called, 'https://api.deepseek.com/user/balance')
  // 按量计费没有配额，绝不能编一个百分比出来
  assert.equal(view.kind, 'balance')
  assert.equal(view.percent, null)
  assert.equal(view.balance.currency, 'CNY')
  assert.equal(view.balance.symbol, '¥')
  assert.equal(view.balance.total, -2.71)
  assert.equal(view.balance.available, false, '余额为负时 is_available 是 false')
  // 没有配额窗口
  assert.deepEqual(view.windows, [])
})

check('balance projection tolerates missing and weird fields', () => {
  // 接口按币种返回多组，实测只有一条；空数组不能崩
  const empty = host.projectBalance({})
  assert.equal(empty.total, null)
  assert.equal(empty.currency, 'CNY')
  assert.equal(empty.available, true, '缺 is_available 时按可用处理，不要误报欠费')
  // 未知币种没有符号，不能拼出 "undefined12.3"
  const usd = host.projectBalance({ balance_infos: [{ currency: 'USD', total_balance: '12.3' }] })
  assert.equal(usd.symbol, '$')
  assert.equal(usd.total, 12.3)
  const unknown = host.projectBalance({ balance_infos: [{ currency: 'XYZ', total_balance: '5' }] })
  assert.equal(unknown.symbol, '', '未知币种的符号应该是空串，不是 undefined')
})

check('a balance provider drives the bubble and the mood', async () => {
  const source = await readFile(join(pkgRoot, 'lib/client.js'), 'utf8')
  // 主指标有两种形态，客户端按 kind 分支
  assert.match(source, /primary\.kind === 'balance'/)
  assert.match(source, /function colorForBalance\(balance\)/)
  assert.match(source, /function moodFromBalance\(balance\)/)
  assert.match(source, /function currentMood\(\)/)
  // 情绪不能再无条件走百分比 —— 否则用 DeepSeek 时会永远说"未知用量"
  assert.doesNotMatch(source, /moodFor\(primaryPercent\(\)\)/)
  // 余额为负要染红，且用色与套餐那三档一致
  assert.match(source, /balance\.available === false \|\| \(typeof total === 'number' && total <= 0\)\) return '#f85149'/)
  // 卡片里要显示"账户不可用"，那比数字本身更该被看见
  assert.match(source, /账户不可用/)

  // 宿主侧：余额走 primary，不是 percent
  const ctx = {
    get: (n) => (n === 'settings' ? {
      get: (ns) => (ns === 'llm-pi-ai'
        ? { providers: { 'deepseek-official': { apiKeyEnv: 'DEEPSEEK_API_KEY' } } }
        : { provider: 'deepseek-official', model: 'deepseek-flash' }),
    } : undefined),
  }
  const service = new host.GoUsageService(ctx)
  service.probe = {
    at: Date.now(),
    kind: 'balance',
    planName: 'DeepSeek',
    percent: null,
    percentLabel: '',
    balance: { currency: 'CNY', symbol: '¥', total: -2.71, granted: 0, toppedUp: -2.71, available: false },
    windows: [],
    credits: null,
  }
  const doc = service.view()
  assert.equal(doc.primary.kind, 'balance')
  assert.equal(doc.primary.balance.total, -2.71)
  assert.equal(doc.primary.label, '余额')
  assert.equal(doc.windows.length, 0)
})

check('the published sources carry no account identifiers or machine paths', async () => {
  // 真漏过一次：OpenCode 的工作区 id 被写死在控制台深链里，公开出去等于把
  // 仓库和某个账号关联起来。这条把"不该出现的东西"钉进测试，上传前必跑。
  const BANNED = [
    ['OpenCode 工作区 id', /\bwrk_[A-Za-z0-9]{16,}/],
    ['Windows 用户目录', /[A-Za-z]:\\Users\\[^\\\s"']+/],
    ['macOS 用户目录', /\/Users\/[^/\s"']+/],
    ['Linux 家目录', /\/home\/[^/\s"']+/],
    ['密钥形态', /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ]
  const TEXT = /\.(js|mjs|cjs|json|md|yml|yaml|ps1|txt)$/i
  const SKIP = new Set(['node_modules', 'dist', '.snapshots', '.npm-cache', '.scratch', '.git'])
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && TEXT.test(entry.name)) files.push(abs)
    }
  }
  walk(pkgRoot)
  // 上传文件夹若已生成，一并扫掉 —— 那才是真正会被公开的东西
  const uploadDir = join(pkgRoot, 'dist', 'github-upload')
  if (existsSync(uploadDir)) walk(uploadDir)

  assert.ok(files.length > 20, `只扫到 ${files.length} 个文件，路径可能不对`)
  const hits = []
  for (const abs of files) {
    const text = await readFile(abs, 'utf8')
    for (const [label, re] of BANNED) {
      const m = re.exec(text)
      // 命中时只说文件与类别，不把命中的原文写进测试输出（那等于二次泄漏）
      if (m !== null) hits.push(`${abs.slice(pkgRoot.length + 1)} → ${label}`)
    }
  }
  assert.deepEqual(hits, [], `发现账号标识/本机路径/密钥：\n  ${hits.join('\n  ')}`)
})

// --- run -------------------------------------------------------------------

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
