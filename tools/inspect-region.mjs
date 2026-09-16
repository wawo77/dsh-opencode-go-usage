/**
 * Crop a region of the pet sprite, upscale it, and draw a grid whose lines are
 * every `step` fraction OF THE WHOLE SPRITE — so a coordinate read off this
 * close-up is already in sprite fractions.
 *
 * Usage:
 *   node tools/inspect-region.mjs --x .1 --y .24 --w .7 --h .2 [--zoom 3] [--step .02]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cropRgba, decodePng, encodePng, gridLines, rectFill, rectOutline, resizeRgba, paint } from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}

const fx = argOf('--x', 0.1), fy = argOf('--y', 0.24)
const fw = argOf('--w', 0.7), fh = argOf('--h', 0.2)
const zoom = argOf('--zoom', 3)
const step = argOf('--step', 0.02)
const inputAt = process.argv.indexOf('--in')
const input = inputAt === -1 ? 'assets/pet.png' : process.argv[inputAt + 1]

const sprite = decodePng(readFileSync(join(root, input)))
const W = sprite.width, H = sprite.height
const x = Math.round(fx * W), y = Math.round(fy * H)
const w = Math.round(fw * W), h = Math.round(fh * H)
let region = cropRgba(sprite, x, y, w, h)
region = resizeRgba(region, w * zoom, h * zoom)

// Grid every `step` of the SPRITE, labelled by fraction.
const color = [255, 255, 0, 110]
gridLines(region, color, 1)
paint(region, (set) => {
  // Thicken the 10% lines so they read at a glance among the fine ones.
  for (let i = 1; i < 10; i += 1) {
    const xi = Math.round(((fx + (i / 10) * fw) - fx) * W * zoom)
    for (let t = 0; t < 3; t += 1) {
      for (let yy = 0; yy < region.height; yy += 1) set(Math.min(region.width - 1, xi + t), yy, [255, 60, 60, 160])
    }
    const yi = Math.round(((fy + (i / 10) * fh) - fy) * H * zoom)
    for (let t = 0; t < 3; t += 1) {
      for (let xx = 0; xx < region.width; xx += 1) set(xx, Math.min(region.height - 1, yi + t), [255, 60, 60, 160])
    }
  }
})

const png = encodePng(region)
const out = `assets/inspect.png`
writeFileSync(join(root, out), png)
console.log(`region fx=${fx} fy=${fy} fw=${fw} fh=${fh}  -> sprite px (${x},${y}) ${w}x${h}, zoom ${zoom}x`)
console.log(`wrote ${out}  ${(png.length / 1024).toFixed(1)} KB  (${region.width}x${region.height})`)
