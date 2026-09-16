/**
 * Report which client bundle the RUNNING dsh web host is actually serving.
 *
 * The browser half is snapshotted by the host, so an edit on disk does not
 * necessarily reach the page: this walks the real boot graph (authenticating
 * with the tokenized entry URL, exactly as a browser would) and inspects the
 * stored bundle. Useful right after a rollback, when the question is "did the
 * running GUI actually go back?".
 *
 * Usage: node test/which-bundle.mjs [--port 3080]
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}
const PORT = argOf('--port', 3080)
const BASE = `http://127.0.0.1:${PORT}`
const PKG = 'dsh-opencode-go-usage'

/** Tokens the bundles may or may not contain, mapped to a version label. */
const MARKERS = [
  ['oguw-ring', 'v1 圆环（初版）'],
  ['oguw-sizegroup', '图片桌宠 + CSS 待机动画 + 缩放'],
  ['oguw-canvas', '网格形变版'],
]

let token
try {
  const log = readFileSync(join(homedir(), '.dsh', 'web-host.log'), 'utf8')
  token = /token=([A-Za-z0-9_-]+)/.exec(log)?.[1]
} catch (error) {
  console.log('could not read web-host.log:', error.message)
}

let cookie = ''
if (token !== undefined) {
  const entry = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' })
  const raw = typeof entry.headers.getSetCookie === 'function'
    ? entry.headers.getSetCookie()
    : [entry.headers.get('set-cookie')]
  cookie = raw.filter(Boolean).map((c) => c.split(';')[0]).join('; ')
  console.log(`tokenized entry: HTTP ${entry.status}${cookie ? ', session cookie acquired' : ', no cookie'}`)
}

const shell = await fetch(`${BASE}/`, cookie === '' ? {} : { headers: { cookie } })
const html = await shell.text()
console.log(`shell: HTTP ${shell.status}, ${html.length} bytes`)

const combos = [...html.matchAll(/\/plugins\/[^"'\\\s]+/g)].map((m) => m[0].replace(/&amp;/g, '&'))
console.log(`plugin combo urls: ${combos.length}`)

let inspected = 0
for (const url of combos) {
  const body = await (await fetch(BASE + url)).text()
  if (!body.includes(PKG)) continue
  inspected += 1
  console.log(`\nbundle ${url.slice(0, 70)}...`)
  console.log(`  ${body.length} bytes stored by the host`)
  for (const [marker, label] of MARKERS) {
    if (body.includes(marker)) console.log(`  -> contains "${marker}"  =  ${label}`)
  }
}

if (inspected === 0) {
  console.log('\nno combo contained this plugin — the GUI may not have loaded it in this session.')
}

// Compare against what is on disk right now.
const disk = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const diskLabel = MARKERS.filter(([marker]) => disk.includes(marker)).map(([, label]) => label)
console.log(`\non disk now: ${diskLabel.length > 0 ? diskLabel.join(' / ') : '(no marker found)'}`)
