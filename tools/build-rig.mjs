/**
 * Step 1 of the rig: cut the four accessories and the body out of their sheets.
 *
 * Both sources are fully opaque artwork on white — the accessories even arrive
 * as a JPEG, so there is no alpha anywhere to start from. The accessory sheet
 * also carries its own Chinese labels ("✦ 左耳朵 ✦"), which must NOT end up in
 * the layers, and the body carries a "Flova.ai" watermark in the top-right
 * corner that must not end up in the widget.
 *
 * The cut is the same border flood fill the pet sprite used: walk inward from
 * the frame, taking pixels that stay close to the colour that reached them and
 * within a looser bound of the seed colour, so gradients are followed without
 * leaking into the artwork. Afterwards the alpha is un-premultiplied against
 * the background colour so no white fringe survives on the edges.
 *
 * Usage: node tools/build-rig.mjs [--write]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cropRgba, decodePng, encodePng, isolateSubject, labelComponents, resizeRgba,
} from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const WRITE = process.argv.includes('--write')
const SRC = 'assets/rig'

/** Accessory sheet: which blob is which, keyed by its position in the sheet. */
const LABELS = ['ahoge', 'earLeft', 'earRight', 'tail']

/** The watermark sits in the top-right corner of the body sheet. */
const WATERMARK = { x0: 0.78, y0: 0.00, x1: 1.00, y1: 0.075 }

function load(file) {
  return decodePng(readFileSync(join(root, SRC, file)))
}

/** Border flood-fill background removal, in place. */
function cutOut(image, options) {
  const started = Date.now()
  const { backgroundShare } = isolateSubject(image.rgba, image.width, image.height, options)
  return { backgroundShare, ms: Date.now() - started }
}

/** Erase a rectangle outright (the watermark). */
function eraseRect(image, rect) {
  const x0 = Math.floor(rect.x0 * image.width), x1 = Math.ceil(rect.x1 * image.width)
  const y0 = Math.floor(rect.y0 * image.height), y1 = Math.ceil(rect.y1 * image.height)
  let cleared = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * image.width + x) * 4
      if (image.rgba[i + 3] === 0) continue
      image.rgba[i + 3] = 0
      cleared += 1
    }
  }
  return cleared
}

/** Crop to a bounding box, with a small margin, returning the offset too. */
function cropTo(image, box, pad) {
  const x = Math.max(0, box.minX - pad)
  const y = Math.max(0, box.minY - pad)
  const w = Math.min(image.width - x, box.width + pad * 2)
  const h = Math.min(image.height - y, box.height + pad * 2)
  return { image: cropRgba(image, x, y, w, h), x, y }
}

// --- accessories -----------------------------------------------------------
// The sheet arrives as a JPEG, which the pipeline's decoder cannot read (it is
// PNG-only, deliberately: one format, no dependencies). tools + Windows'
// System.Drawing convert it once to assets/rig/accessories.png.
const sheet = load('accessories.png')
console.log(`配件图 ${sheet.width}x${sheet.height}`)
const sheetCut = cutOut(sheet, { stepTolerance: 26, seedTolerance: 96 })
console.log(`  抠白底：去掉 ${(sheetCut.backgroundShare * 100).toFixed(1)}% 用时 ${sheetCut.ms}ms`)

// The labels are separate blobs; the shapes are far larger, so an area floor
// separates them without having to recognise text.
const blobs = labelComponents(sheet.rgba, sheet.width, sheet.height, 8000)
console.log(`  连通域 ${blobs.length} 个（≥8000px，已滤掉标注文字）`)
for (const blob of blobs) {
  console.log(`    ${String(blob.count).padStart(7)}px  ${blob.width}x${blob.height}  at (${blob.minX},${blob.minY})`)
}
if (blobs.length !== 4) {
  console.error(`!! 期望 4 个组件，实际 ${blobs.length} 个 —— 面积阈值需要调整`)
  process.exit(1)
}

// Name them by layout: the ahoge is the top one; of the rest, left to right.
const byY = [...blobs].sort((a, b) => a.minY - b.minY)
const ahoge = byY[0]
const rest = byY.slice(1).sort((a, b) => a.minX - b.minX)
const ordered = [ahoge, rest[0], rest[1], rest[2]]

const parts = {}
ordered.forEach((blob, index) => {
  const name = LABELS[index]
  const { image, x, y } = cropTo(sheet, blob, 6)
  parts[name] = { image, x, y, box: blob }
  console.log(`  ${name.padEnd(9)} -> ${image.width}x${image.height}  (源图偏移 ${x},${y})`)
})

// --- body ------------------------------------------------------------------
const body = load('人物主体-去掉可动配件.png')
console.log(`\n主体图 ${body.width}x${body.height}`)
const bodyCut = cutOut(body, { stepTolerance: 26, seedTolerance: 104 })
console.log(`  抠白底：去掉 ${(bodyCut.backgroundShare * 100).toFixed(1)}% 用时 ${bodyCut.ms}ms`)
const cleared = eraseRect(body, WATERMARK)
console.log(`  抹掉右上角水印：${cleared}px`)
const bodyBlobs = labelComponents(body.rgba, body.width, body.height, 20000)
const figure = bodyBlobs[0]
console.log(`  主体连通域 ${bodyBlobs.length} 个，最大 ${figure.width}x${figure.height} at (${figure.minX},${figure.minY})`)
const bodyCrop = cropTo(body, figure, 8)

// --- write -----------------------------------------------------------------
if (!WRITE) {
  console.log('\n(dry run — pass --write 才落盘)')
  process.exit(0)
}
const outDir = join(root, 'assets/rig/parts')
mkdirSync(outDir, { recursive: true })
const manifest = { source: { accessories: '可动组件-呆毛-左右耳朵和尾巴.jpg', body: '人物主体-去掉可动配件.png' }, parts: {} }
for (const [name, part] of Object.entries(parts)) {
  writeFileSync(join(outDir, `${name}.png`), encodePng(part.image))
  manifest.parts[name] = { width: part.image.width, height: part.image.height, srcX: part.x, srcY: part.y }
}
writeFileSync(join(outDir, 'body.png'), encodePng(bodyCrop.image))
manifest.body = { width: bodyCrop.image.width, height: bodyCrop.image.height, srcX: bodyCrop.x, srcY: bodyCrop.y }
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1))
console.log(`\nwrote assets/rig/parts/{${Object.keys(parts).join(',')},body}.png + manifest.json`)
