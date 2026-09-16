/**
 * Live end-to-end check of the host half against the real OpenCode Go usage
 * endpoint. Run with `node test/live-probe.mjs`.
 *
 * It exercises the throwaway path the plugin takes when the credentials
 * service is unavailable (the credential-file fallback), performs the real
 * HTTP probe, and parses the response with the plugin's own parser. The API
 * key is never printed — only whether one was found and how long it is.
 *
 * Read-only: this script makes exactly one GET and writes nothing anywhere.
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const host = await import(pathToFileURL(join(pkgRoot, 'lib/index.js')).href)

// The service reads settings through ctx.get('settings'); feed it the shape
// this profile actually has so activeRoute() picks the live Go route.
const settingsValues = {
  'llm-pi-ai': {
    providers: {
      'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
      'opencode-go-v41': { apiKeyEnv: 'OPENCODE_GO_API_KEY', baseURL: 'https://opencode.ai/zen/go/v1' },
    },
  },
  'agent-default-model': { provider: 'opencode-go-v41', model: 'deepseek-v4.1-flash' },
}
const fakeCtx = {
  get: (name) => (name === 'settings' ? { get: (ns) => settingsValues[ns] } : undefined),
}

const service = new host.GoUsageService(fakeCtx)

const active = service.activeRoute()
console.log('active route      :', active?.route?.id, '/', active?.model ?? '(no default model)')

const key = await service.resolveApiKey(active?.route?.id ?? 'opencode-go')
console.log('credential found  :', typeof key === 'string' && key !== '' ? `yes (len=${key.length})` : 'NO — every source came back empty')

const started = Date.now()
await service.probeNow()
console.log('probe elapsed     :', Date.now() - started, 'ms')
console.log('probe error       :', service.probeError ?? '(none)')

if (service.probe === undefined) {
  console.log('\nRESULT: the endpoint did not answer with a recognizable body.')
  process.exit(1)
}

const view = service.view()
console.log('\nplan name         :', view.plan.name, '/', view.plan.price)
console.log('probe.ok          :', view.probe.ok, ' stale:', view.probe.stale)
for (const window of view.windows) {
  const reset = window.resetsAt === null ? 'no reset instant (percent 0 placeholder)' : window.resetsAt
  console.log(`  ${window.key.padEnd(6)} ${String(window.percent).padStart(3)}%   resets ${reset}`)
}
console.log('\nlocal estimate    :', JSON.stringify(view.local))
console.log('console url       :', view.plan.consoleUrl)
console.log('\nRESULT: live probe OK — the host half reached the real endpoint and parsed it.')
