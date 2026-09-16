/**
 * Render the pet sprite with a 10% grid and the candidate part regions drawn
 * on top, so the rig can be tuned by eye instead of by guesswork.
 *
 * Usage: node tools/markup.mjs [--out assets/markup.png]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, gridLines, rectFill, rectOutline } from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const image = decodePng(readFileSync(join(root, 'assets/pet.png')))
const { width, height } = image
console.log(`sprite ${width} x ${height}`)

// Candidate rig, in fractions of the sprite. Each part: {x, y, w, h}.
const RIG = {
  ahoge:     { x: 0.44, y: 0.000, w: 0.18, h: 0.062 },
  eyeLeft:   { x: 0.263, y: 0.298, w: 0.138, h: 0.078 },
  eyeRight:  { x: 0.468, y: 0.298, w: 0.140, h: 0.078 },
  hairLeft:  { x: 0.00, y: 0.360, w: 0.30, h: 0.540 },
  hairRight: { x: 0.66, y: 0.360, w: 0.26, h: 0.540 },
  tail:      { x: 0.82, y: 0.520, w: 0.18, h: 0.400 },
}

const COLORS = {
  ahoge: [255, 210, 0, 90],
  eyeLeft: [255, 60, 60, 80],
  eyeRight: [255, 60, 60, 80],
  hairLeft: [0, 220, 120, 70],
  hairRight: [0, 220, 120, 70],
  tail: [0, 200, 255, 90],
}

gridLines(image, [255, 255, 255, 70], 1)
for (const [name, box] of Object.entries(RIG)) {
  const x = box.x * width, y = box.y * height, w = box.w * width, h = box.h * height
  rectFill(image, x, y, w, h, COLORS[name])
  rectOutline(image, x, y, w, h, [...COLORS[name].slice(0, 3), 255], 1)
  console.log(`${name.padEnd(10)} x=${box.x.toFixed(3)} y=${box.y.toFixed(3)} w=${box.w.toFixed(3)} h=${box.h.toFixed(3)}  -> px (${Math.round(x)},${Math.round(y)}) ${Math.round(w)}x${Math.round(h)}`)
}

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'assets/markup.png'
const png = encodePng(image)
writeFileSync(join(root, out), png)
console.log(`\nwrote ${basename(out)}  ${(png.length / 1024).toFixed(1)} KB`)
