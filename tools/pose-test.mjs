/**
 * Pose the split rig by hand and look at the result.
 *
 * This is the test that actually decides whether the split is good enough: a
 * straight-walled cut only matters if it OPENS when the part moves. Each part
 * is rotated about its pivot (the motion a sway would produce) and composited
 * back over the base, so the seam, the gap, and any dragged-along body pixels
 * are all visible in one frame.
 *
 * Usage: node tools/pose-test.mjs [--angle 1.0] [--zoom 2]
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
const SCALE = argOf('--angle', 1.0)
const ZOOM = argOf('--zoom', 2)

/** Pivots in sprite pixels (fractions of the 322x420 artwork). */
const PARTS = [
  { name: 'ahoge', pivot: [0.530, 0.055], angle: 0.16 },
  { name: 'hairLeft', pivot: [0.220, 0.395], angle: 0.075 },
  { name: 'hairRight', pivot: [0.735, 0.395], angle: -0.075 },
  { name: 'tail', pivot: [0.845, 0.635], angle: -0.17 },
]

const sprite = decodePng(readFileSync(join(root, 'assets/pet.png')))
const W = sprite.width
const H = sprite.height
const base = decodePng(readFileSync(join(root, 'assets/parts/base.png')))

const blank = () => ({ width: W, height: H, rgba: Buffer.alloc(W * H * 4) })

/** Rotate a layer about a pivot by `theta`, into a new image (inverse map). */
function rotateLayer(image, pivotX, pivotY, theta) {
  const out = blank()
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const dx = x - pivotX
      const dy = y - pivotY
      // Inverse rotation: where this destination pixel came from.
      const sx = Math.round(pivotX + dx * cos + dy * sin)
      const sy = Math.round(pivotY - dx * sin + dy * cos)
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
      const s = (sy * W + sx) * 4
      if (image.rgba[s + 3] === 0) continue
      const d = (y * W + x) * 4
      out.rgba[d] = image.rgba[s]
      out.rgba[d + 1] = image.rgba[s + 1]
      out.rgba[d + 2] = image.rgba[s + 2]
      out.rgba[d + 3] = image.rgba[s + 3]
    }
  }
  return out
}

/** Alpha-composite src onto dst at an offset. Uses the DESTINATION's stride —
 *  the sheet is wider than one cell, so a shared W*H loop would smear. */
function over(dst, src, ox = 0, oy = 0) {
  for (let y = 0; y < src.height; y += 1) {
    const ty = y + oy
    if (ty < 0 || ty >= dst.height) continue
    for (let x = 0; x < src.width; x += 1) {
      const tx = x + ox
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

const posed = { width: W, height: H, rgba: Buffer.from(base.rgba) }
const report = []
for (const part of PARTS) {
  const image = decodePng(readFileSync(join(root, `assets/parts/${part.name}.png`)))
  const theta = part.angle * SCALE
  const moved = rotateLayer(image, part.pivot[0] * W, part.pivot[1] * H, theta)
  over(posed, moved)
  // How many pixels the rotation actually displaced the part by, at its tip.
  report.push(`${part.name.padEnd(10)} ${(theta * 180 / Math.PI).toFixed(1)}° about (${Math.round(part.pivot[0] * W)},${Math.round(part.pivot[1] * H)})`)
}

// --- sheet: [ original | posed ] over a neutral backdrop ------------------
const panels = [sprite, posed].map((panel) => {
  const cell = blank()
  for (let p = 0; p < W * H; p += 1) {
    const i = p * 4
    const a = panel.rgba[i + 3] / 255
    for (let c = 0; c < 3; c += 1) cell.rgba[i + c] = Math.round(panel.rgba[i + c] * a + 120 * (1 - a))
    cell.rgba[i + 3] = 255
  }
  return resizeRgba(cell, W * ZOOM, H * ZOOM)
})
const GAP = 8
const outW = panels.length * W * ZOOM + GAP
const sheet = { width: outW, height: H * ZOOM, rgba: Buffer.alloc(outW * H * ZOOM * 4) }
for (let p = 0; p < outW * H * ZOOM; p += 1) {
  sheet.rgba[p * 4] = 96
  sheet.rgba[p * 4 + 1] = 96
  sheet.rgba[p * 4 + 2] = 102
  sheet.rgba[p * 4 + 3] = 255
}
over(sheet, panels[0])
for (let y = 0; y < H * ZOOM; y += 1) {
  panels[1].rgba.copy(sheet.rgba, (y * outW + W * ZOOM + GAP) * 4, y * W * ZOOM * 4, (y + 1) * W * ZOOM * 4)
}

const png = encodePng(sheet)
writeFileSync(join(root, 'assets/pose-test.png'), png)
console.log(`angle scale ${SCALE}`)
for (const line of report) console.log('  ' + line)
console.log(`\nwrote assets/pose-test.png  ${(png.length / 1024).toFixed(0)} KB  (${outW}x${H * ZOOM})`)
console.log('panels: [ 原图 | 摆姿（部件绕轴心旋转后叠回底图）]')
