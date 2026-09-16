/**
 * Review sheet for the part split.
 *
 * Four panels, so the cut can be judged rather than trusted:
 *   1. the sprite as-is
 *   2. which pixels went to which part (the base is dimmed to grey, the parts
 *      keep their real colours, so a wrong boundary is visible as artwork that
 *      moved to the wrong side)
 *   3. EXPLODED — each part pushed outward from its home position. A leak or a
 *      straight-cut edge shows up immediately as a chunk travelling with the
 *      wrong piece.
 *   4. the base with its holes, over a checkerboard, so the missing area is
 *      unmistakable.
 *
 * Usage: node tools/review-parts.mjs [--zoom 2] [--spread 16]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, resizeRgba } from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}
const ZOOM = argOf('--zoom', 2)
const SPREAD = argOf('--spread', 16)

const sprite = decodePng(readFileSync(join(root, 'assets/pet.png')))
const W = sprite.width
const H = sprite.height
const names = ['ahoge', 'hairLeft', 'hairRight', 'tail']
const parts = names.map((name) => ({ name, image: decodePng(readFileSync(join(root, `assets/parts/${name}.png`))) }))
const base = decodePng(readFileSync(join(root, 'assets/parts/base.png')))

/** Explosion directions: outward from the figure's centre. */
const SHIFT = {
  ahoge: [0, -SPREAD],
  hairLeft: [-SPREAD, Math.round(SPREAD * 0.3)],
  hairRight: [SPREAD, Math.round(SPREAD * 0.3)],
  tail: [Math.round(SPREAD * 1.1), Math.round(SPREAD * 0.2)],
}

/** Alpha-composite src onto dst at an offset. */
function over(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y += 1) {
    const ty = y + dy
    if (ty < 0 || ty >= dst.height) continue
    for (let x = 0; x < src.width; x += 1) {
      const tx = x + dx
      if (tx < 0 || tx >= dst.width) continue
      const s = (y * src.width + x) * 4
      const a = src.rgba[s + 3] / 255
      if (a <= 0.001) continue
      const d = (ty * dst.width + tx) * 4
      const da = dst.rgba[d + 3] / 255
      const na = a + da * (1 - a)
      for (let c = 0; c < 3; c += 1) {
        dst.rgba[d + c] = Math.round((src.rgba[s + c] * a + dst.rgba[d + c] * da * (1 - a)) / na)
      }
      dst.rgba[d + 3] = Math.round(na * 255)
    }
  }
}

const blank = () => ({ width: W, height: H, rgba: Buffer.alloc(W * H * 4) })

// Panel 1 — as-is.
const panel1 = { width: W, height: H, rgba: Buffer.from(sprite.rgba) }

// Panel 2 — parts in colour, base dimmed to grey.
const panel2 = blank()
over(panel2, {
  width: W,
  height: H,
  rgba: (() => {
    const out = Buffer.alloc(W * H * 4)
    for (let p = 0; p < W * H; p += 1) {
      const i = p * 4
      const grey = Math.round(0.299 * base.rgba[i] + 0.587 * base.rgba[i + 1] + 0.114 * base.rgba[i + 2])
      const dim = 70 + grey * 0.32
      out[i] = dim
      out[i + 1] = dim
      out[i + 2] = dim
      out[i + 3] = base.rgba[i + 3]
    }
    return out
  })(),
}, 0, 0)
for (const part of parts) over(panel2, part.image, 0, 0)

// Panel 3 — exploded.
const panel3 = blank()
over(panel3, base, 0, 0)
for (const part of parts) over(panel3, part.image, SHIFT[part.name][0], SHIFT[part.name][1])

// Panel 4 — the base alone, over a checkerboard.
const panel4 = blank()
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const i = (y * W + x) * 4
    const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 200 : 160
    panel4.rgba[i] = checker
    panel4.rgba[i + 1] = checker
    panel4.rgba[i + 2] = checker
    panel4.rgba[i + 3] = 255
  }
}
over(panel4, base, 0, 0)

// --- optional boundary close-up -------------------------------------------
// A straight-walled cut is the failure mode worth checking, and it is invisible
// at 1x. `--crop x,y,w,h` (fractions) renders [original | base] of one region
// at high zoom instead of the four-panel sheet.
const CROP = (() => {
  const at = process.argv.indexOf('--crop')
  if (at === -1) return undefined
  const [cx, cy, cw, ch] = process.argv[at + 1].split(',').map(Number)
  return {
    x: Math.round(cx * W), y: Math.round(cy * H),
    w: Math.round(cw * W), h: Math.round(ch * H),
  }
})()

if (CROP !== undefined) {
  const cropOf = (image) => {
    const out = Buffer.alloc(CROP.w * CROP.h * 4)
    for (let y = 0; y < CROP.h; y += 1) {
      const sy = CROP.y + y
      if (sy < 0 || sy >= H) continue
      image.rgba.copy(out, y * CROP.w * 4, (sy * W + CROP.x) * 4, (sy * W + CROP.x + CROP.w) * 4)
    }
    return { width: CROP.w, height: CROP.h, rgba: out }
  }
  const zoom = argOf('--zoom', 4)
  const panels = [cropOf(sprite), cropOf(base)].map((panel) => resizeRgba(panel, CROP.w * zoom, CROP.h * zoom))
  const gap = 10
  const outW = panels.length * CROP.w * zoom + gap
  const outH = CROP.h * zoom
  const sheet = { width: outW, height: outH, rgba: Buffer.alloc(outW * outH * 4) }
  for (let p = 0; p < outW * outH; p += 1) {
    sheet.rgba[p * 4] = 96
    sheet.rgba[p * 4 + 1] = 96
    sheet.rgba[p * 4 + 2] = 102
    sheet.rgba[p * 4 + 3] = 255
  }
  over(sheet, panels[0], 0, 0)
  over(sheet, panels[1], CROP.w * zoom + gap, 0)
  const png = encodePng(sheet)
  writeFileSync(join(root, 'assets/boundary-zoom.png'), png)
  console.log(`wrote assets/boundary-zoom.png  ${(png.length / 1024).toFixed(0)} KB  (${outW}x${outH})`)
  console.log(`crop x ${CROP.x}..${CROP.x + CROP.w}  y ${CROP.y}..${CROP.y + CROP.h}  zoom ${zoom}x`)
  console.log('panels: [ 原图 | 挖空底图 ]')
  process.exit(0)
}

const panels = [panel1, panel2, panel3, panel4].map((panel) => resizeRgba(panel, W * ZOOM, H * ZOOM))
const GAP = 8
const outW = panels.length * W * ZOOM + (panels.length - 1) * GAP
const outH = H * ZOOM
const sheet = { width: outW, height: outH, rgba: Buffer.alloc(outW * outH * 4) }
for (let p = 0; p < outW * outH; p += 1) {
  // Neutral backdrop so transparent margins read as empty, not as white.
  sheet.rgba[p * 4] = 96
  sheet.rgba[p * 4 + 1] = 96
  sheet.rgba[p * 4 + 2] = 102
  sheet.rgba[p * 4 + 3] = 255
}
panels.forEach((panel, index) => over(sheet, panel, index * (W * ZOOM + GAP), 0))

const png = encodePng(sheet)
writeFileSync(join(root, 'assets/parts-review.png'), png)
console.log(`wrote assets/parts-review.png  ${(png.length / 1024).toFixed(0)} KB  (${outW}x${outH}, zoom ${ZOOM}x, spread ${SPREAD}px)`)
console.log('panels: [ 原图 | 部件归属（底图压暗） | 炸开视图 | 挖空底图 ]')
for (const name of names) console.log(`  ${name.padEnd(10)} shift (${SHIFT[name][0]}, ${SHIFT[name][1]})`)
