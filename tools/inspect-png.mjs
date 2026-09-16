/**
 * Minimal PNG inspector — no dependencies (node:zlib only).
 *
 * Written because neither the session model nor the describe-image plugin can
 * look at these files, and the pet needs layout-critical facts: is the
 * background transparent, where does the subject actually sit in the frame,
 * what are the dominant colours, and what does the silhouette look like.
 *
 * Usage: node tools/inspect-png.mjs <file.png> [--cols 48]
 */

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { basename } from 'node:path'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Decode a non-interlaced 8-bit PNG into { width, height, rgba }. */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG')
  let offset = 8
  let header
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (header === undefined) throw new Error('no IHDR')
  if (header.bitDepth !== 8) throw new Error(`unsupported bit depth ${header.bitDepth}`)
  if (header.interlace !== 0) throw new Error('interlaced PNG unsupported')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType]
  if (channels === undefined) throw new Error(`unsupported colour type ${header.colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const { width, height } = header
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const current = Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? current[i - channels] : 0
      const b = previous[i]
      const c = i >= channels ? previous[i - channels] : 0
      const x = line[i]
      let value
      switch (filter) {
        case 0: value = x; break
        case 1: value = x + a; break
        case 2: value = x + b; break
        case 3: value = x + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value = x + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))
          break
        }
        default: throw new Error(`bad filter ${filter}`)
      }
      current[i] = value & 0xff
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels
      const d = (y * width + x) * 4
      if (channels === 4) {
        out[d] = current[s]; out[d + 1] = current[s + 1]; out[d + 2] = current[s + 2]; out[d + 3] = current[s + 3]
      } else if (channels === 3) {
        out[d] = current[s]; out[d + 1] = current[s + 1]; out[d + 2] = current[s + 2]; out[d + 3] = 255
      } else if (channels === 2) {
        out[d] = current[s]; out[d + 1] = current[s]; out[d + 2] = current[s]; out[d + 3] = current[s + 1]
      } else {
        out[d] = current[s]; out[d + 1] = current[s]; out[d + 2] = current[s]; out[d + 3] = 255
      }
    }
    previous = current
  }
  return { width, height, rgba: out }
}

const file = process.argv[2]
const colsArg = process.argv.indexOf('--cols')
const COLS = colsArg === -1 ? 48 : Number(process.argv[colsArg + 1])

const { width, height, rgba } = decodePng(readFileSync(file))

console.log(`FILE      ${basename(file)}`)
console.log(`SIZE      ${width} x ${height}  (aspect ${(width / height).toFixed(3)})`)

// --- alpha statistics ------------------------------------------------------
let transparent = 0
let opaque = 0
let minX = width, minY = height, maxX = -1, maxY = -1
let softMinX = width, softMinY = height, softMaxX = -1, softMaxY = -1
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const alpha = rgba[(y * width + x) * 4 + 3]
    if (alpha === 0) transparent += 1
    if (alpha === 255) opaque += 1
    if (alpha > 8) {
      if (x < softMinX) softMinX = x
      if (y < softMinY) softMinY = y
      if (x > softMaxX) softMaxX = x
      if (y > softMaxY) softMaxY = y
    }
    if (alpha > 200) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
}
const total = width * height
console.log(`ALPHA     transparent ${(transparent / total * 100).toFixed(1)}%  opaque ${(opaque / total * 100).toFixed(1)}%`)
console.log(`BBOX(a>200) x ${minX}..${maxX}  y ${minY}..${maxY}  -> ${maxX - minX + 1} x ${maxY - minY + 1}`)
console.log(`BBOX(a>8)   x ${softMinX}..${softMaxX}  y ${softMinY}..${softMaxY}`)
console.log(`SUBJECT   occupies ${((maxX - minX + 1) / width * 100).toFixed(1)}% width, ${((maxY - minY + 1) / height * 100).toFixed(1)}% height`)
console.log(`MARGINS   left ${((minX / width) * 100).toFixed(1)}%  top ${((minY / height) * 100).toFixed(1)}%  right ${(((width - maxX) / width) * 100).toFixed(1)}%  bottom ${(((height - maxY) / height) * 100).toFixed(1)}%`)

// --- corner colours (is there a background?) -------------------------------
const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
console.log('CORNERS   ' + corners.map(([x, y]) => {
  const i = (y * width + x) * 4
  return `(${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},a${rgba[i + 3]})`
}).join('  '))

// --- dominant subject colours ---------------------------------------------
const counts = new Map()
let sampleCount = 0
for (let y = 0; y < height; y += 2) {
  for (let x = 0; x < width; x += 2) {
    const i = (y * width + x) * 4
    if (rgba[i + 3] < 200) continue
    const key = `${rgba[i] >> 4},${rgba[i + 1] >> 4},${rgba[i + 2] >> 4}`
    const entry = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    entry.n += 1
    entry.r += rgba[i]; entry.g += rgba[i + 1]; entry.b += rgba[i + 2]
    counts.set(key, entry)
    sampleCount += 1
  }
}
const dominant = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 8)
console.log('PALETTE   (share of opaque pixels)')
for (const entry of dominant) {
  const r = Math.round(entry.r / entry.n), g = Math.round(entry.g / entry.n), b = Math.round(entry.b / entry.n)
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
  console.log(`          ${hex}  rgb(${r},${g},${b})  ${(entry.n / sampleCount * 100).toFixed(1)}%`)
}

// --- ASCII silhouette (alpha) + tone (luminance) ---------------------------
const ROWS = Math.max(1, Math.round(COLS * (height / width) * 0.5))
const RAMP = ' .:-=+*#%@'
function grid(pick) {
  const lines = []
  for (let row = 0; row < ROWS; row += 1) {
    let line = ''
    for (let col = 0; col < COLS; col += 1) {
      const x0 = Math.floor(col * width / COLS), x1 = Math.max(x0 + 1, Math.floor((col + 1) * width / COLS))
      const y0 = Math.floor(row * height / ROWS), y1 = Math.max(y0 + 1, Math.floor((row + 1) * height / ROWS))
      let sum = 0, n = 0
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { sum += pick(x, y); n += 1 }
      line += RAMP[Math.min(RAMP.length - 1, Math.round((n === 0 ? 0 : sum / n) * (RAMP.length - 1)))]
    }
    lines.push(line)
  }
  return lines
}
const alphaGrid = grid((x, y) => rgba[(y * width + x) * 4 + 3] / 255)
const toneGrid = grid((x, y) => {
  const i = (y * width + x) * 4
  if (rgba[i + 3] < 128) return 0
  const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255
  // Invert so ink = dark subject on a light page.
  return 1 - lum
})
console.log('\nSILHOUETTE (alpha: "@" = fully opaque)')
console.log(alphaGrid.join('\n'))
console.log('\nTONE (subject luminance, inverted: "@" = darkest)')
console.log(toneGrid.join('\n'))
