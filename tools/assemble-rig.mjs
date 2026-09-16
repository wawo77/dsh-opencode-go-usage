/**
 * Step 2 of the rig: place the accessories on the body.
 *
 * Z-order is the whole trick. The ahoge sits proud of the headdress, so it is
 * drawn last. The ears and the tail grow out from BEHIND the hair and the
 * skirt, so they are drawn FIRST and the body covers their inner ends — no
 * body splitting, no masks, just order. Each part is placed so a good slice of
 * its root stays under the body, which is why a twitch can never open a gap.
 *
 * Placement is data: assets/rig/rig.json, in fractions of the body box, so a
 * wrong guess is a number to change rather than code to rewrite.
 *
 * Usage: node tools/assemble-rig.mjs [--out assets/rig/assembled.png] [--zoom 1]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, resizeRgba } from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : process.argv[at + 1]
}

/** Draw order, back to front. */
const ORDER = ['tail', 'earLeft', 'earRight', 'body', 'ahoge']

const rig = JSON.parse(readFileSync(join(root, 'assets/rig/rig.json'), 'utf8'))
const body = decodePng(readFileSync(join(root, 'assets/rig/parts/body.png')))
const images = { body }
for (const name of ['ahoge', 'earLeft', 'earRight', 'tail']) {
  images[name] = decodePng(readFileSync(join(root, `assets/rig/parts/${name}.png`)))
}

// Placement is expressed against the body box; the canvas then grows to hold
// whatever hangs off it (the ahoge pokes above the head, the ears out sideways).
const placed = []
for (const name of ORDER) {
  const image = images[name]
  const spec = name === 'body' ? { x: 0, y: 0 } : rig[name]
  if (spec === undefined) throw new Error(`rig.json 缺少 ${name} 的位置`)
  placed.push({
    name,
    image,
    x: Math.round(spec.x * body.width),
    y: Math.round(spec.y * body.height),
  })
}

const minX = Math.min(...placed.map((p) => p.x))
const minY = Math.min(...placed.map((p) => p.y))
const maxX = Math.max(...placed.map((p) => p.x + p.image.width))
const maxY = Math.max(...placed.map((p) => p.y + p.image.height))
const W = maxX - minX
const H = maxY - minY

const canvas = { width: W, height: H, rgba: Buffer.alloc(W * H * 4) }
/** Alpha-composite src onto the canvas at an offset. */
function over(src, ox, oy) {
  for (let y = 0; y < src.height; y += 1) {
    const ty = y + oy - minY
    if (ty < 0 || ty >= H) continue
    for (let x = 0; x < src.width; x += 1) {
      const tx = x + ox - minX
      if (tx < 0 || tx >= W) continue
      const s = (y * src.width + x) * 4
      const a = src.rgba[s + 3] / 255
      if (a <= 0.001) continue
      const d = (ty * W + tx) * 4
      const da = canvas.rgba[d + 3] / 255
      const na = a + da * (1 - a)
      for (let c = 0; c < 3; c += 1) {
        canvas.rgba[d + c] = Math.round((src.rgba[s + c] * a + canvas.rgba[d + c] * da * (1 - a)) / na)
      }
      canvas.rgba[d + 3] = Math.round(na * 255)
    }
  }
}

console.log(`画布 ${W}x${H}（相对主体框扩展 ${-minX},${-minY}）`)
for (const p of placed) {
  console.log(`  ${p.name.padEnd(9)} ${p.image.width}x${p.image.height} at (${p.x},${p.y})  = 主体坐标 ${(p.x / body.width).toFixed(3)},${(p.y / body.height).toFixed(3)}`)
}
for (const p of placed) over(p.image, p.x, p.y)

const zoom = Number(argOf('--zoom', 1))
const out = zoom === 1 ? canvas : resizeRgba(canvas, W * zoom, H * zoom)
const path = argOf('--out', 'assets/rig/assembled.png')
writeFileSync(join(root, path), encodePng(out))
console.log(`\nwrote ${path}  (${out.width}x${out.height})`)
console.log(`画序（后→前）：${ORDER.join(' → ')}`)
