/**
 * Render the rigged idle animation as a FILMSTRIP — several frames of the
 * deformation laid out side by side in one PNG — so the motion can be judged
 * from a single image without running the browser.
 *
 * Usage: node tools/render-frames.mjs [--frames 6] [--step 0.42] [--blink 1|0] [--zoom 2]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, resizeRgba } from './lib/png.mjs'
import { warpSprite } from './lib/warp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}

const FRAMES = argOf('--frames', 6)
const STEP = argOf('--step', 0.42)
const BLINK = argOf('--blink', 0)
const ZOOM = argOf('--zoom', 2)
const GAP = 4
// Optional crop (fractions of the sprite) so a close-up filmstrip can be made.
const CX = argOf('--cx', 0), CY = argOf('--cy', 0)
const CW = argOf('--cw', 1), CH = argOf('--ch', 1)

const sprite = decodePng(readFileSync(join(root, 'assets/pet.png')))
const full = warpSprite(sprite, 0, 0)
void full
// Crop first, then warp: the rig's coordinates are fractions of the SPRITE, so
// warping runs on the full image and the crop is applied to the warped result.
const cropW = Math.round(CW * sprite.width), cropH = Math.round(CH * sprite.height)
const cropX = Math.round(CX * sprite.width), cropY = Math.round(CY * sprite.height)
const cellW = Math.round(cropW * ZOOM)
const cellH = Math.round(cropH * ZOOM)
const outW = FRAMES * cellW + (FRAMES - 1) * GAP
const outH = cellH
const sheet = { width: outW, height: outH, rgba: Buffer.alloc(outW * outH * 4) }

console.log(`sprite ${sprite.width}x${sprite.height}  frames=${FRAMES} step=${STEP}s blink=${BLINK}`)

for (let i = 0; i < FRAMES; i += 1) {
  const t = i * STEP
  const warped = warpSprite(sprite, t, BLINK)
  // Crop the warped sprite so the filmstrip can zoom in on one region.
  const cell = resizeRgba(cropOf(warped), cellW, cellH)
  const ox = i * (cellW + GAP)
  for (let y = 0; y < cellH; y += 1) {
    for (let x = 0; x < cellW; x += 1) {
      const s = (y * cellW + x) * 4
      const d = (y * outW + ox + x) * 4
      const a = cell.rgba[s + 3] / 255
      if (a <= 0.001) continue
      for (let c = 0; c < 3; c += 1) {
        sheet.rgba[d + c] = Math.round(cell.rgba[s + c] * a + sheet.rgba[d + c] * (1 - a))
      }
      sheet.rgba[d + 3] = 255
    }
  }
  console.log(`  frame ${i}  t=${t.toFixed(2)}s`)
}

const png = encodePng(sheet)
writeFileSync(join(root, 'assets/frames.png'), png)
console.log(`\nwrote assets/frames.png  ${(png.length / 1024).toFixed(1)} KB  (${outW}x${outH})`)

/** Crop a region out of a warped sprite. */
function cropOf(image) {
  const out = Buffer.alloc(cropW * cropH * 4)
  for (let y = 0; y < cropH; y += 1) {
    const sy = cropY + y
    if (sy < 0 || sy >= image.height) continue
    for (let x = 0; x < cropW; x += 1) {
      const sx = cropX + x
      if (sx < 0 || sx >= image.width) continue
      const s = (sy * image.width + sx) * 4
      image.rgba.copy(out, (y * cropW + x) * 4, s, s + 4)
    }
  }
  return { width: cropW, height: cropH, rgba: out }
}
