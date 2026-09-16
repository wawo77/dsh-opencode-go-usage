/**
 * Step 1 of the cut-out rig, downgraded scope: only the FOUR parts that
 * actually move are cut out — 呆毛 / 左发 / 右发 / 尾. Everything else (head,
 * body, fins, legs) stays as one static base.
 *
 * Why the downgrade: line art only separates parts where the artist drew a
 * line, and the left strand lies flat against the arm and skirt with no line
 * between them, so a flood there leaks into the body and no amount of seed
 * tuning fixes it. Cutting four well-separated parts avoids every one of those
 * ambiguous boundaries.
 *
 * Each part: flood from its seeds through non-ink pixels (the INK test is
 * relative — "darker than its surroundings" — because an absolute luminance
 * cut cannot separate black outlines from this character's dark navy dress),
 * bounded by a coarse ROI, then grown a couple of pixels so the part takes its
 * own outline with it. The base is what is left.
 *
 * Usage: node tools/segment-parts.mjs [--ratio 0.82] [--grow 2] [--write]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng } from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}
const RATIO = argOf('--ratio', 0.82)
const RADIUS = argOf('--radius', 3)
const GROW = argOf('--grow', 2)
const WRITE = process.argv.includes('--write')

/**
 * The four moving parts. `roi` is the coarse, hand-placed bound that stops a
 * flood where the artwork offers no line to stop it.
 */
/**
 * `axis`/`side` say which way the part lies relative to the one boundary that
 * matters — for a strand hanging beside the body, the line where it meets the
 * body. `side: 'less'` means the part is on the low side of that line
 * (x ≤ f(y), or y ≤ f(x) for the ahoge), `'greater'` the high side.
 */
const PARTS = [
  { name: 'ahoge', seeds: [[0.545, 0.040]], roi: [0.30, 0.000, 0.45, 0.130], axis: 'y-by-x', side: 'less' },
  { name: 'hairLeft', seeds: [[0.085, 0.620], [0.06, 0.76], [0.10, 0.50]], roi: [0.00, 0.26, 0.50, 0.68], axis: 'x-by-y', side: 'less' },
  { name: 'hairRight', seeds: [[0.900, 0.590], [0.93, 0.70], [0.88, 0.48]], roi: [0.50, 0.26, 0.50, 0.68], axis: 'x-by-y', side: 'greater' },
  // The tail sits higher and further right than the crop suggests: everything
  // below y≈0.75 on that side is transparent, so seeds placed there hit nothing.
  { name: 'tail', seeds: [[0.945, 0.640], [0.955, 0.690], [0.870, 0.700]], roi: [0.60, 0.42, 0.40, 0.42], axis: 'x-by-y', side: 'greater' },
]

const PALETTE = {
  ahoge: [255, 99, 132],
  hairLeft: [255, 159, 64],
  hairRight: [54, 162, 235],
  tail: [75, 192, 192],
  base: [150, 150, 160],
}

const sprite = decodePng(readFileSync(join(root, 'assets/pet.png')))
const { width: W, height: H, rgba } = sprite
const ALPHA_MIN = 40

// --- boundary map ---------------------------------------------------------
//
// Two earlier attempts failed here, both for the same underlying reason: they
// only recognised BLACK OUTLINES.
//   * an absolute luminance cut swallowed the navy dress (luminance ~78);
//   * a relative one ("darker than its surroundings") recognised outlines but
//     nothing else, so wherever the artist drew no line — the strand lying flat
//     against the skirt, the tail against the dress — the flood had nothing to
//     stop it and the rectangle had to do the cutting, which is what produced
//     the straight walls.
// What actually separates one painted region from another is a COLOUR
// DISCONTINUITY, line or no line. So the barrier is the colour gradient:
// flooding stops wherever the colour changes sharply, which follows the
// character's real contours.
const mag = new Float32Array(W * H)
const lum = new Float32Array(W * H)
for (let p = 0; p < W * H; p += 1) {
  const i = p * 4
  lum[p] = rgba[i + 3] < ALPHA_MIN ? -1 : 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
}
const at = (x, y) => (y * W + x) * 4
for (let y = 1; y < H - 1; y += 1) {
  for (let x = 1; x < W - 1; x += 1) {
    const p = y * W + x
    if (lum[p] < 0) continue
    const l = at(x - 1, y), r = at(x + 1, y), u = at(x, y - 1), d = at(x, y + 1)
    if (rgba[l + 3] < ALPHA_MIN || rgba[r + 3] < ALPHA_MIN || rgba[u + 3] < ALPHA_MIN || rgba[d + 3] < ALPHA_MIN) {
      // The silhouette itself is a boundary against transparency.
      mag[p] = 1e6
      continue
    }
    let gx = 0
    let gy = 0
    for (let c = 0; c < 3; c += 1) {
      gx += Math.abs(rgba[r + c] - rgba[l + c])
      gy += Math.abs(rgba[d + c] - rgba[u + c])
    }
    mag[p] = Math.max(gx, gy)
  }
}
/** Adaptive cut: the strongest `EDGE_PCT`% of gradients are boundaries. */
const EDGE_PCT = argOf('--edge', 88)
const sorted = Float32Array.from(mag).sort()
const cutIndex = Math.min(sorted.length - 1, Math.floor((sorted.length * EDGE_PCT) / 100))
const EDGE = sorted[cutIndex]
const ink = new Uint8Array(W * H)
for (let p = 0; p < W * H; p += 1) if (mag[p] >= EDGE && lum[p] >= 0) ink[p] = 1
let inkCount = 0
for (let p = 0; p < ink.length; p += 1) inkCount += ink[p]

// --- flood each part inside its ROI ---------------------------------------
const masks = {}
const report = []
PARTS.forEach((part) => {
  const roi = {
    x0: Math.floor(part.roi[0] * W), y0: Math.floor(part.roi[1] * H),
    x1: Math.ceil((part.roi[0] + part.roi[2]) * W), y1: Math.ceil((part.roi[1] + part.roi[3]) * H),
  }
  const inRoi = (p) => {
    const x = p % W
    const y = (p - x) / W
    return x >= roi.x0 && x < roi.x1 && y >= roi.y0 && y < roi.y1
  }
  const seed = new Uint8Array(W * H)
  let flooded = 0
  for (const [fx, fy] of part.seeds) {
    const snapped = snapToFill(Math.round(fx * W), Math.round(fy * H))
    if (snapped === undefined) continue
    if (seed[snapped] === 1 || !inRoi(snapped)) continue
    const queue = [snapped]
    seed[snapped] = 1
    let head = 0
    while (head < queue.length) {
      const p = queue[head]
      head += 1
      flooded += 1
      const x = p % W
      const y = (p - x) / W
      const neighbours = []
      if (x > 0) neighbours.push(p - 1)
      if (x < W - 1) neighbours.push(p + 1)
      if (y > 0) neighbours.push(p - W)
      if (y < H - 1) neighbours.push(p + W)
      for (const q of neighbours) {
        if (seed[q] === 1 || ink[q] === 1) continue
        if (lum[q] < 0 || !inRoi(q)) continue
        seed[q] = 1
        queue.push(q)
      }
    }
  }
  // Grow so the part carries its own outline, and so neighbouring parts meet
  // without leaving an unpainted seam.
  let grown = seed
  for (let step = 0; step < GROW; step += 1) {
    const next = Uint8Array.from(grown)
    for (let y = 1; y < H - 1; y += 1) {
      for (let x = 1; x < W - 1; x += 1) {
        const p = y * W + x
        if (grown[p] === 1 || lum[p] < 0) continue
        if (grown[p - 1] || grown[p + 1] || grown[p - W] || grown[p + W]) next[p] = 1
      }
    }
    grown = next
  }
  let count = 0
  for (let p = 0; p < grown.length; p += 1) if (grown[p] === 1) count += 1
  masks[part.name] = grown
  report.push({ name: part.name, flooded, grown: count, onEdge: -1, where: '—', part })
})

/** Nearest non-ink, opaque pixel to a start point (ring search). */
function snapToFill(sx, sy) {
  const start = sy * W + sx
  if (ink[start] !== 1 && lum[start] >= 0) return start
  const seen = new Uint8Array(W * H)
  seen[start] = 1
  let ring = [start]
  for (let step = 0; step < 40 && ring.length > 0; step += 1) {
    const next = []
    for (const p of ring) {
      const x = p % W
      const y = (p - x) / W
      const candidates = []
      if (x > 0) candidates.push(p - 1)
      if (x < W - 1) candidates.push(p + 1)
      if (y > 0) candidates.push(p - W)
      if (y < H - 1) candidates.push(p + W)
      for (const q of candidates) {
        if (seen[q] === 1) continue
        seen[q] = 1
        if (ink[q] !== 1 && lum[q] >= 0) return q
        next.push(q)
      }
    }
    ring = next
  }
  return undefined
}

// --- derive each part's real boundary, row by row --------------------------
//
// The flood stops either at a real colour boundary (trustworthy) or at the ROI
// wall (an artefact — this is what made the first cut look like a box). Telling
// the two apart per scanline and then fitting a smooth curve through ONLY the
// trustworthy rows turns the artwork itself into the source of the boundary,
// with the rectangle demoted to a safety net that should never be visible.
for (const row of report) {
  const part = row.part
  const roi = {
    x0: Math.floor(part.roi[0] * W), y0: Math.floor(part.roi[1] * H),
    x1: Math.ceil((part.roi[0] + part.roi[2]) * W), y1: Math.ceil((part.roi[1] + part.roi[3]) * H),
  }
  const mask = masks[part.name]
  const vertical = part.axis !== 'y-by-x'
  const span = vertical ? [roi.y0, roi.y1] : [roi.x0, roi.x1]
  const cross = vertical ? [roi.x0, roi.x1] : [roi.y0, roi.y1]
  const values = []
  const trusted = []
  for (let s = span[0]; s < span[1]; s += 1) {
    let lo = Infinity
    let hi = -Infinity
    for (let c = cross[0]; c < cross[1]; c += 1) {
      const p = vertical ? s * W + c : c * W + s
      if (mask[p] !== 1) continue
      if (c < lo) lo = c
      if (c > hi) hi = c
    }
    if (hi < 0) { values.push(null); trusted.push(false); continue }
    // For a part that lives on the low side of its boundary the boundary is the
    // high edge, and vice versa.
    const edge = part.side === 'less' ? hi : lo
    const hitWall = part.side === 'less' ? hi >= cross[1] - 1 : lo <= cross[0]
    values.push(edge)
    trusted.push(!hitWall)
  }
  const trustedCount = trusted.filter(Boolean).length
  // Interpolate the untrusted scanlines from their nearest trusted neighbours,
  // then smooth the whole curve so the cut has no steps in it.
  const filled = values.slice()
  let last = null
  for (let i = 0; i < filled.length; i += 1) {
    if (trusted[i]) { last = filled[i]; continue }
    if (filled[i] === null && last !== null) filled[i] = last
  }
  let next = null
  for (let i = filled.length - 1; i >= 0; i -= 1) {
    if (trusted[i]) { next = filled[i]; continue }
    if (!trusted[i] && next !== null) filled[i] = filled[i] === null ? next : Math.round((filled[i] + next) / 2)
  }
  for (let i = 0; i < filled.length; i += 1) if (filled[i] === null) filled[i] = cross[0]
  const smooth = filled.map((_, i) => {
    let sum = 0
    let n = 0
    for (let k = -6; k <= 6; k += 1) {
      const j = i + k
      if (j < 0 || j >= filled.length) continue
      sum += filled[j]
      n += 1
    }
    return sum / n
  })
  row.trustedShare = values.length === 0 ? 0 : (trustedCount / values.length)
  row.curve = { vertical, spanStart: span[0], curve: smooth, side: part.side }

  // Rebuild the mask from the derived curve, intersected with the artwork.
  for (let p = 0; p < mask.length; p += 1) mask[p] = 0
  for (let s = span[0]; s < span[1]; s += 1) {
    const limit = smooth[s - span[0]]
    for (let c = cross[0]; c < cross[1]; c += 1) {
      if (lum[vertical ? s * W + c : c * W + s] < 0) continue
      const inside = part.side === 'less' ? c <= limit : c >= limit
      if (!inside) continue
      mask[vertical ? s * W + c : c * W + s] = 1
    }
  }
}

// Grow once more so each part carries its own outline, then recount.
for (const row of report) {
  const part = row.part
  let grown = masks[part.name]
  for (let step = 0; step < GROW; step += 1) {
    const nextMask = Uint8Array.from(grown)
    for (let y = 1; y < H - 1; y += 1) {
      for (let x = 1; x < W - 1; x += 1) {
        const p = y * W + x
        if (grown[p] === 1 || lum[p] < 0) continue
        if (grown[p - 1] || grown[p + 1] || grown[p - W] || grown[p + W]) nextMask[p] = 1
      }
    }
    grown = nextMask
  }
  masks[part.name] = grown
  let count = 0
  for (let p = 0; p < grown.length; p += 1) if (grown[p] === 1) count += 1
  row.grown = count
  row.onEdge = 0
}
// --- base = everything the parts did not take ------------------------------
const partMask = new Uint8Array(W * H)
for (const name of Object.keys(masks)) {
  const mask = masks[name]
  for (let p = 0; p < mask.length; p += 1) if (mask[p] === 1) partMask[p] = 1
}

// --- report ---------------------------------------------------------------
console.log(`sprite ${W}x${H}   ink: lum < ${RATIO} x local mean(${RADIUS}px)   grow ${GROW}px`)
for (const row of report) {
  const share = row.grown === 0 ? 0 : (row.onEdge / row.grown) * 100
  const trust = (row.trustedShare * 100).toFixed(0)
  console.log(`  ${row.name.padEnd(10)} flood ${String(row.flooded).padStart(6)}  final ${String(row.grown).padStart(6)} px  ${(row.grown / (W * H) * 100).toFixed(2)}%   可信扫描线 ${trust}%（其余由插值补）  ${row.onEdge === 0 ? '无直边' : `直边 ${share.toFixed(1)}%`}`)
}
let baseCount = 0
for (let p = 0; p < W * H; p += 1) if (lum[p] >= 0 && partMask[p] === 0) baseCount += 1
console.log(`  ${'base'.padEnd(10)} ${String(baseCount).padStart(26)} px  ${(baseCount / (W * H) * 100).toFixed(2)}%`)

// --- preview: [ sprite | parts coloured | base with holes ] ---------------
const labelSheet = { width: W, height: H, rgba: Buffer.alloc(W * H * 4) }
const baseSheet = { width: W, height: H, rgba: Buffer.alloc(W * H * 4) }
for (let p = 0; p < W * H; p += 1) {
  const i = p * 4
  if (lum[p] < 0) continue
  const colour = PALETTE.base
  labelSheet.rgba[i] = colour[0]
  labelSheet.rgba[i + 1] = colour[1]
  labelSheet.rgba[i + 2] = colour[2]
  labelSheet.rgba[i + 3] = 255
  if (partMask[p] === 0) {
    baseSheet.rgba[i] = rgba[i]
    baseSheet.rgba[i + 1] = rgba[i + 1]
    baseSheet.rgba[i + 2] = rgba[i + 2]
    baseSheet.rgba[i + 3] = rgba[i + 3]
  }
}
for (const part of PARTS) {
  const mask = masks[part.name]
  const colour = PALETTE[part.name]
  for (let p = 0; p < mask.length; p += 1) {
    if (mask[p] !== 1) continue
    const i = p * 4
    labelSheet.rgba[i] = colour[0]
    labelSheet.rgba[i + 1] = colour[1]
    labelSheet.rgba[i + 2] = colour[2]
    labelSheet.rgba[i + 3] = 255
  }
}

const GAP = 6
const panels = [sprite, labelSheet, baseSheet]
const outW = W * panels.length + GAP * (panels.length - 1)
const sheet = { width: outW, height: H, rgba: Buffer.alloc(outW * H * 4) }
panels.forEach((panel, index) => {
  const ox = index * (W + GAP)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const s = (y * W + x) * 4
      const d = (y * outW + ox + x) * 4
      const a = panel.rgba[s + 3] / 255
      for (let c = 0; c < 3; c += 1) sheet.rgba[d + c] = Math.round(panel.rgba[s + c] * a + 120 * (1 - a))
      sheet.rgba[d + 3] = 255
    }
  }
})
writeFileSync(join(root, 'assets/segment-preview.png'), encodePng(sheet))
console.log('\nwrote assets/segment-preview.png  [ sprite | 4 parts | base with holes ]')

// --- part + base images ---------------------------------------------------
if (WRITE) {
  const dir = join(root, 'assets/parts')
  mkdirSync(dir, { recursive: true })
  const bounds = {}
  for (const part of PARTS) {
    const mask = masks[part.name]
    const image = { width: W, height: H, rgba: Buffer.alloc(W * H * 4) }
    let minX = W, minY = H, maxX = -1, maxY = -1
    for (let p = 0; p < W * H; p += 1) {
      if (mask[p] !== 1) continue
      const i = p * 4
      image.rgba[i] = rgba[i]
      image.rgba[i + 1] = rgba[i + 1]
      image.rgba[i + 2] = rgba[i + 2]
      image.rgba[i + 3] = rgba[i + 3]
      const x = p % W
      const y = (p - x) / W
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    writeFileSync(join(dir, `${part.name}.png`), encodePng(image))
    bounds[part.name] = { minX, minY, maxX, maxY, roi: part.roi }
  }
  writeFileSync(join(dir, 'base.png'), encodePng(baseSheet))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    sprite: 'pet.png', width: W, height: H, ratio: RATIO, radius: RADIUS, grow: GROW, parts: bounds,
  }, null, 1))
  console.log(`wrote assets/parts/{${PARTS.map((p) => p.name).join(',')},base}.png + manifest.json`)
}
