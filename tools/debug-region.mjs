/**
 * Diagnostic: print the ink map over a region as ASCII, with the part's seeds
 * marked, so a seed that lands somewhere useless can be seen instead of
 * guessed at.
 *
 * Usage: node tools/debug-region.mjs --x 0.76 --y 0.44 --w 0.24 --h 0.56 --seed 0.945,0.760 --seed 0.90,0.86
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : process.argv[at + 1]
}

const fx = Number(argOf('--x', 0.76)), fy = Number(argOf('--y', 0.44))
const fw = Number(argOf('--w', 0.24)), fh = Number(argOf('--h', 0.56))
const seeds = []
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] !== '--seed') continue
  const [sx, sy] = process.argv[i + 1].split(',').map(Number)
  seeds.push([sx, sy])
}

const sprite = decodePng(readFileSync(join(root, 'assets/pet.png')))
const { width: W, height: H, rgba } = sprite
const RADIUS = Number(argOf('--radius', 4))
const RATIO = Number(argOf('--ratio', 0.70))

const lum = new Float32Array(W * H)
for (let p = 0; p < W * H; p += 1) {
  const i = p * 4
  lum[p] = rgba[i + 3] < 40 ? -1 : 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
}
const ink = new Uint8Array(W * H)
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const p = y * W + x
    if (lum[p] < 0) continue
    let sum = 0, n = 0
    for (let dy = -RADIUS; dy <= RADIUS; dy += 1) {
      const ny = y + dy
      if (ny < 0 || ny >= H) continue
      for (let dx = -RADIUS; dx <= RADIUS; dx += 1) {
        const nx = x + dx
        if (nx < 0 || nx >= W) continue
        if (lum[ny * W + nx] < 0) continue
        sum += lum[ny * W + nx]
        n += 1
      }
    }
    if (n > 0 && lum[p] < (sum / n) * RATIO) ink[p] = 1
  }
}

const x0 = Math.floor(fx * W), y0 = Math.floor(fy * H)
const x1 = Math.min(W, Math.ceil((fx + fw) * W)), y1 = Math.min(H, Math.ceil((fy + fh) * H))
const COLS = 60
const rows = Math.max(1, Math.round(COLS * ((y1 - y0) / (x1 - x0)) * 0.5))
console.log(`region x ${x0}..${x1}  y ${y0}..${y1}   (# = ink, . = fill, ' ' = transparent, S = seed)`)
const marked = seeds.map(([sx, sy]) => [Math.round(sx * W), Math.round(sy * H)])

for (let row = 0; row < rows; row += 1) {
  let line = ''
  for (let col = 0; col < COLS; col += 1) {
    const px = x0 + Math.floor((col * (x1 - x0)) / COLS)
    const py = y0 + Math.floor((row * (y1 - y0)) / rows)
    const p = py * W + px
    let ch = lum[p] < 0 ? ' ' : ink[p] === 1 ? '#' : '.'
    for (const [mx, my] of marked) {
      if (Math.abs(mx - px) < 3 && Math.abs(my - py) < 4) ch = 'S'
    }
    line += ch
  }
  console.log(String(y0 + Math.floor((row * (y1 - y0)) / rows)).padStart(4) + ' ' + line)
}
console.log(`luminance at seeds: ${marked.map(([mx, my]) => `${mx},${my}=${lum[my * W + mx].toFixed(0)}${ink[my * W + mx] === 1 ? '(ink)' : ''}`).join('  ')}`)
