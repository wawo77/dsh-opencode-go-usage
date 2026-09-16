/**
 * End-to-end check against the RUNNING dsh web host.
 *
 * Verifies the parts that only exist once the plugin is actually loaded: the
 * three JSON routes, the sprite route, the loopback fence, and — when the
 * shell's access token is supplied — that the client bundle really made it
 * into the served boot graph.
 *
 * Usage:
 *   node test/verify-installed.mjs
 *   node test/verify-installed.mjs --token <token>     # also check the boot graph
 *   node test/verify-installed.mjs --port 3080
 *
 * Read-only: it never writes to the host or to DSH's state.
 */

const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : process.argv[at + 1]
}
const PORT = Number(argOf('--port', 3080))
const TOKEN = argOf('--token', process.env.DSH_WEB_TOKEN)
const BASE = `http://127.0.0.1:${PORT}`

let failed = 0
const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
}

async function get(path, init) {
  try {
    const response = await fetch(BASE + path, { signal: AbortSignal.timeout(8000), ...init })
    const bytes = Buffer.from(await response.arrayBuffer())
    return { response, bytes, text: bytes.toString('utf8') }
  } catch (error) {
    return { error }
  }
}

// --- the widget document ---------------------------------------------------

const state = await get('/api/opencode-go-usage/state')
if (state.error) {
  check('the host answers on ' + BASE, false, state.error.message)
} else {
  check('GET /api/opencode-go-usage/state is 200', state.response.status === 200, `got ${state.response.status}`)
  let doc
  try {
    doc = JSON.parse(state.text)
  } catch {
    check('state payload is JSON', false, state.text.slice(0, 120))
  }
  if (doc !== undefined) {
    check('payload carries the plan', typeof doc.plan?.name === 'string' && doc.plan.name.length > 0, doc.plan?.name)
    check('payload carries three windows', Array.isArray(doc.windows) && doc.windows.length === 3,
      (doc.windows || []).map((w) => w.key).join(','))
    const fiveHour = (doc.windows || []).find((w) => w.key === '5h')
    check('the 5h window has a percentage', typeof fiveHour?.percent === 'number', String(fiveHour?.percent))
    check('the probe succeeded', doc.probe?.ok === true, doc.probe?.error ?? 'ok')
    check('payload tells the browser where the sprite is', typeof doc.pet?.spriteUrl === 'string' && doc.pet.spriteUrl.endsWith('pet.png'), doc.pet?.spriteUrl)
    check('payload carries the saved position', typeof doc.position?.left === 'number' && typeof doc.position?.bottom === 'number',
      JSON.stringify(doc.position))
    console.log('\n--- live reading ---')
    console.log('plan    ', doc.plan?.name, doc.plan?.price)
    for (const window of doc.windows || []) {
      console.log(`  ${String(window.key).padEnd(6)} ${String(window.percent).padStart(3)}%  local $${window.local?.usd ?? 0}`
        + `  tok ${window.local?.tokens ?? '—'}  reset ${window.resetsAt ?? '—'}`)
    }
    console.log('today tok', doc.local?.todayTokens ?? '（宿主未提供：需要重启 dsh）',
      ' in/out/cache', [doc.local?.todayInTokens, doc.local?.todayOutTokens, doc.local?.todayCachedTokens].join('/'),
      ' since', doc.local?.todaySince ? new Date(doc.local.todaySince).toLocaleString() : '—')
    console.log('probe   ', JSON.stringify(doc.probe))
    console.log('')
  }
}

// --- the sprite ------------------------------------------------------------

const sprite = await get('/opencode-go-usage-assets/pet.png')
if (sprite.error) {
  check('GET the sprite', false, sprite.error.message)
} else {
  check('GET the sprite is 200', sprite.response.status === 200,
    sprite.response.status === 404
      ? '404 — the running host predates the sprite route; restart dsh web'
      : `got ${sprite.response.status}`)
  check('served as image/png', sprite.response.headers.get('content-type') === 'image/png',
    sprite.response.headers.get('content-type'))
  check('served bytes are a PNG', sprite.bytes.subarray(1, 4).toString('ascii') === 'PNG',
    `${sprite.bytes.length} bytes`)
}

check('an unknown sprite path is 404',
  (await get('/opencode-go-usage-assets/nope.png')).response?.status === 404)

// --- the skeleton pet: geometry, parts, and the client that draws them -------

const rigBad = (detail) => {
  check('payload advertises the rig geometry', false, detail)
  check('every rig part is served', false, 'skipped — no descriptor')
  check('rig.json is served as JSON', false, 'skipped — no descriptor')
  check('an unknown rig path is 404', false, 'skipped — no descriptor')
}

const descriptor = (() => {
  try { return JSON.parse(state.text).pet?.rig ?? null } catch { return null }
})()

if (descriptor === null) {
  rigBad('pet.rig 缺失 — 运行中的宿主早于骨骼桌宠；restart dsh web')
} else {
  const size = descriptor.canvas || {}
  check('payload advertises the rig geometry',
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0,
    `canvas ${size.width}x${size.height}`)

  const partNames = Object.keys(descriptor.parts || {})
  const expected = ['ahoge', 'earLeft', 'earRight', 'tail']
  check('payload carries all four accessories plus the body',
    expected.every((n) => partNames.includes(n)) && typeof descriptor.body?.url === 'string',
    partNames.join(','))
  // 前后顺序：尾巴与两只耳朵都在主体之后（耳朵藏在头发里，只露耳尖），呆毛在最前。
  // 注意桌宠贴左半屏时会被水平镜像，屏幕上左边那只耳朵其实是角色的右耳。
  const order = descriptor.order || []
  check('draw order: tail and both ears behind the body, ahoge topmost',
    order.indexOf('tail') < order.indexOf('body')
      && order.indexOf('earLeft') < order.indexOf('body')
      && order.indexOf('earRight') < order.indexOf('body')
      && order.indexOf('body') < order.indexOf('ahoge'),
    order.join(' -> '))

  let servedAll = true
  const details = []
  for (const [name, part] of Object.entries(descriptor.parts || {})) {
    const got = await get(new URL(part.url, BASE).pathname)
    if (got.response?.status !== 200 || got.response.headers.get('content-type') !== 'image/png') {
      servedAll = false
      details.push(`${name}:${got.response?.status ?? got.error?.message}`)
    } else if (got.bytes.subarray(1, 4).toString('ascii') !== 'PNG') {
      servedAll = false
      details.push(`${name}:not-a-png`)
    }
  }
  for (const [label, url] of [['body', descriptor.body?.url]]) {
    const got = await get(new URL(url, BASE).pathname)
    if (got.response?.status !== 200) { servedAll = false; details.push(`${label}:${got.response?.status}`) }
  }
  check('every rig part is served', servedAll, details.join(' ') || `${partNames.length + 1} files`)

  const rigJson = await get('/opencode-go-usage-assets/rig/rig.json')
  check('rig.json is served as JSON',
    rigJson.response?.status === 200 && /application\/json/.test(rigJson.response.headers.get('content-type') ?? ''),
    `got ${rigJson.response?.status} ${rigJson.response?.headers.get('content-type')}`)

  const escape = await get('/opencode-go-usage-assets/rig/../rig.json')
  check('an unknown rig path is 404',
    (await get('/opencode-go-usage-assets/rig/parts/nope.png')).response?.status === 404
      && escape.response?.status !== 200)
}

// --- routes that must exist and must refuse the wrong verb ------------------

check('POST /api/opencode-go-usage/refresh is not a 404',
  [200, 405].includes((await get('/api/opencode-go-usage/refresh', { method: 'POST' })).response?.status))
check('GET /api/opencode-go-usage/refresh is 405',
  (await get('/api/opencode-go-usage/refresh')).response?.status === 405)

// --- the shell really booted the client half --------------------------------

if (typeof TOKEN === 'string' && TOKEN !== '') {
  // 两步：先 GET /?token=… 拿 303 与 set-cookie，再带 cookie 取 shell。
  // 少这一步只会拿到 401，boot-graph 检查永远过不了。
  const shell = await (async () => {
    try {
      const first = await fetch(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      })
      const raw = typeof first.headers.getSetCookie === 'function'
        ? first.headers.getSetCookie()
        : [first.headers.get('set-cookie')].filter(Boolean)
      const jar = raw.filter(Boolean).map((c) => c.split(';')[0]).join('; ')
      const response = await fetch(`${BASE}/`, {
        headers: jar ? { cookie: jar } : {},
        signal: AbortSignal.timeout(8000),
      })
      const bytes = Buffer.from(await response.arrayBuffer())
      return { response, bytes, text: bytes.toString('utf8'), cookie: jar !== '' }
    } catch (error) {
      return { error }
    }
  })()
  if (shell.error) {
    check('GET the shell HTML', false, shell.error.message)
  } else {
    check('GET the shell HTML is 200', shell.response.status === 200,
      `got ${shell.response.status}${shell.cookie ? '' : '（没拿到 cookie，token 可能已失效）'}`)
    check('the boot graph includes this plugin\'s client bundle',
      shell.text.includes('dsh-opencode-go-usage'), 'not found in shell HTML')
    const combos = shell.text.match(/\/plugins\/\?\?[^"']*/g)
    check('the shell advertises plugin combo URLs', Array.isArray(combos) && combos.length > 0,
      `${combos?.length ?? 0} combo(s)`)
    if (Array.isArray(combos) && combos.length > 0) {
      // 把每个 combo 都下一遍：本插件的 bundle 可能在任意一个里
      let found = false
      let detail = ''
      for (const combo of combos.slice(0, 8)) {
        const bundle = await get(combo.replace(/&amp;/g, '&'), shell.cookie ? { headers: { cookie: shell.cookie } } : undefined)
        if (bundle.response?.status === 200 && bundle.text.includes('oguw-rigcanvas')) { found = true; break }
        if (bundle.response?.status === 200 && bundle.text.includes('dsh-opencode-go-usage')) {
          detail = `bundle 在 ${combo.slice(0, 60)}… 里，但没有 oguw-rigcanvas —— 服务的是旧客户端`
        }
      }
      check('the served client bundle carries the skeleton renderer', found, detail || '所有 combo 里都没找到')
    }
  }
} else {
  console.log('(skipped the boot-graph check: pass --token <token> or set DSH_WEB_TOKEN)')
}

// --- report -----------------------------------------------------------------

console.log('')
for (const { name, ok, detail } of results) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : '  -> ' + detail}`)
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
