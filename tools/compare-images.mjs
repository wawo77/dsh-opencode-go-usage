/**
 * Lay several images out side by side at a common height, so one look compares
 * them. Used to judge generated fills against the untouched original.
 *
 * Usage: node tools/compare-images.mjs --height 420 --out assets/compare.png a.png b.png c.png
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, resizeRgba } from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : process.argv[at + 1]
}

const height = Number(argOf('--height', 420))
const out = argOf('--out', 'assets/compare.png')
const inputs = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^\d+$/.test(a) && a !== out)
const paths = inputs.filter((a) => /\.(png|jpg|jpeg|webp)$/i.test(a))

if (paths.length === 0) {
  console.error('usage: node tools/compare-images.mjs --height 420 --out assets/compare.png <images...>')
  process.exit(2)
}

const GAP = 6
const cells = paths.map((p) => {
  const image = decodePng(readFileSync(isAbsolute(p) ? p : join(root, p)))
  const w = Math.max(1, Math.round((image.width / image.height) * height))
  return { name: p, cell: resizeRgba(image, w, height), w }
})
const outW = cells.reduce((sum, c) => sum + c.w, 0) + GAP * (cells.length - 1)
const sheet = { width: outW, height, rgba: Buffer.alloc(outW * height * 4) }

let ox = 0
for (const { cell, w, name } of cells) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const s = (y * w + x) * 4
      const d = (y * outW + ox + x) * 4
      const a = cell.rgba[s + 3] / 255
      if (a <= 0.001) continue
      // Composite over mid grey so transparency is visible rather than white.
      for (let c = 0; c < 3; c += 1) {
        sheet.rgba[d + c] = Math.round(cell.rgba[s + c] * a + 128 * (1 - a))
      }
      sheet.rgba[d + 3] = 255
    }
  }
  console.log(`  + ${name}  (${w}x${height})`)
  ox += w + GAP
}

const png = encodePng(sheet)
writeFileSync(join(root, out), png)
console.log(`\nwrote ${out}  ${(png.length / 1024).toFixed(1)} KB  (${outW}x${height})`)
