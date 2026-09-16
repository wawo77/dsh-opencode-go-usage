/**
 * Build the pet sprite from the source illustration.
 *
 * The source is opaque artwork on a white background, so the sprite is:
 * background-isolated by a border flood fill, cropped to its LARGEST connected
 * component (the figure — the source also carries a few small stray marks that
 * a plain bounding-box crop would drag in), downscaled in premultiplied alpha,
 * and re-encoded as an RGBA PNG.
 *
 * The script prints an ASCII view of the result, which is how the cutout gets
 * checked on a machine with no image viewer.
 *
 * Usage: node tools/build-assets.mjs [--dry] [--height 420]
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  asciiPreview, cropRgba, decodePng, encodePng, isolateSubject, labelComponents, resizeRgba,
} from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dryRun = process.argv.includes('--dry')
const heightArg = process.argv.indexOf('--height')
const TARGET_HEIGHT = heightArg === -1 ? 420 : Number(process.argv[heightArg + 1])

const JOB = {
  src: 'assets/source/deepseek形象主人物图.png',
  out: 'assets/pet.png',
  stepTolerance: 26,
  seedTolerance: 96,
  pad: 4,
}

const source = join(root, JOB.src)
console.log(`source    ${JOB.src}  ${(statSync(source).size / 1024 / 1024).toFixed(2)} MB`)
const image = decodePng(readFileSync(source))
console.log(`decoded   ${image.width} x ${image.height}`)

const started = Date.now()
const { backgroundShare } = isolateSubject(image.rgba, image.width, image.height, {
  stepTolerance: JOB.stepTolerance,
  seedTolerance: JOB.seedTolerance,
})
console.log(`isolated  background ${(backgroundShare * 100).toFixed(1)}% removed in ${Date.now() - started} ms`)

// Crop to the figure itself, not to the union of everything that survived the
// fill — the source has a few detached marks that would otherwise inflate the
// canvas and shrink the character inside it.
const components = labelComponents(image.rgba, image.width, image.height, 1000)
if (components.length === 0) {
  console.error('!! nothing survived isolation')
  process.exit(1)
}
const figure = components[0]
console.log(`regions   ${components.length} found; using the largest`)
for (const component of components.slice(0, 5)) {
  console.log(`          #${component.rank}  ${component.width} x ${component.height}  at (${component.minX},${component.minY})  area ${component.count}px`)
}

const left = Math.max(0, figure.minX - JOB.pad)
const top = Math.max(0, figure.minY - JOB.pad)
const width = Math.min(image.width - left, figure.width + JOB.pad * 2)
const height = Math.min(image.height - top, figure.height + JOB.pad * 2)
let sprite = cropRgba(image, left, top, width, height)

const scale = TARGET_HEIGHT / sprite.height
sprite = resizeRgba(sprite, Math.max(1, Math.round(sprite.width * scale)), TARGET_HEIGHT)

// Margins, in output pixels. The mesh-warp rig (tools/lib/warp.mjs and the
// now-dormant client copy) swings parts by up to ~20 px, and the artwork sits
// flush against the edge on both sides, so a swinging part needs somewhere to
// go. Zero here means the sprite is exactly the artwork — the padding is only
// needed when the warp renderer is switched back on.
const PAD_X = Number(process.env.OGUW_PAD_X ?? 0)
const PAD_Y = Number(process.env.OGUW_PAD_Y ?? 0)
if (PAD_X !== 0 || PAD_Y !== 0) {
  const padded = {
    width: sprite.width + PAD_X * 2,
    height: sprite.height + PAD_Y * 2,
    rgba: Buffer.alloc((sprite.width + PAD_X * 2) * (sprite.height + PAD_Y * 2) * 4),
  }
  for (let y = 0; y < sprite.height; y += 1) {
    sprite.rgba.copy(padded.rgba, ((y + PAD_Y) * padded.width + PAD_X) * 4, y * sprite.width * 4, (y + 1) * sprite.width * 4)
  }
  sprite = padded
}

const view = asciiPreview(sprite.rgba, sprite.width, sprite.height, 44)
console.log(`\nSPRITE    ${sprite.width} x ${sprite.height}   (scale ${scale.toFixed(3)}x, cropped ${width} x ${height})`)
console.log('ALPHA:')
console.log(view.alpha)
console.log('TONE (cutout, "@" = darkest):')
console.log(view.tone)

if (dryRun) {
  console.log('\n(dry run — nothing written)')
} else {
  const png = encodePng(sprite)
  const outPath = join(root, JOB.out)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, png)
  console.log(`\nwrote     ${relative(root, outPath)}  ${(png.length / 1024).toFixed(1)} KB`)
}
