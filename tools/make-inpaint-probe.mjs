/**
 * Build the capability probe for the "cut the character apart" pipeline.
 *
 * The pipeline needs one thing my flat sprite cannot give: what is BEHIND a
 * part. Cutting the left hair away leaves a hole, and that hole has to be
 * filled with the dress edge and background the hair was covering. This script
 * produces that exact hole as an input image, so a real generation call can be
 * measured against the ground truth I already have.
 *
 * Usage: node tools/make-inpaint-probe.mjs
 *   -> assets/probe-in.png   (left hair region erased)
 *   -> assets/probe-truth.png (the untouched sprite, for comparison)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cropRgba, decodePng, encodePng } from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const sprite = decodePng(readFileSync(join(root, 'assets/pet.png')))
const W = sprite.width
const H = sprite.height

/** The region to erase, in character fractions (the sprite is unpadded). */
const HOLE = { x: 0.00, y: 0.400, w: 0.215, h: 0.480 }
/** A matching bbox in pixels for models that take an edit region. */
const bbox = [
  Math.round(HOLE.x * W),
  Math.round(HOLE.y * H),
  Math.round((HOLE.x + HOLE.w) * W),
  Math.round((HOLE.y + HOLE.h) * H),
]

const probe = { width: W, height: H, rgba: Buffer.from(sprite.rgba) }
let erased = 0
for (let y = bbox[1]; y < bbox[3]; y += 1) {
  for (let x = bbox[0]; x < bbox[2]; x += 1) {
    const i = (y * W + x) * 4
    if (probe.rgba[i + 3] === 0) continue
    // Feather the erase edge so the model is not handed a hard cut to copy.
    const dx = Math.min(x - bbox[0], bbox[2] - 1 - x)
    const dy = Math.min(y - bbox[1], bbox[3] - 1 - y)
    const edge = Math.min(1, Math.min(dx, dy) / 6)
    probe.rgba[i + 3] = Math.round(probe.rgba[i + 3] * (1 - edge))
    if (edge > 0.5) erased += 1
  }
}

writeFileSync(join(root, 'assets/probe-in.png'), encodePng(probe))
writeFileSync(join(root, 'assets/probe-truth.png'), encodePng(sprite))
console.log(`erased ${erased} px  bbox [${bbox.join(', ')}]  (x1,y1,x2,y2)`)
console.log('wrote assets/probe-in.png (the hole to fill) and assets/probe-truth.png (ground truth)')
