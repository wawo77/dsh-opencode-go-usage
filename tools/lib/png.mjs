/**
 * Dependency-free PNG codec + RGBA helpers (node:zlib only).
 *
 * Exists because this machine has no image toolchain available offline and the
 * pet assets need decoding, background removal, downscaling and re-encoding.
 * Everything here is deliberately small and only supports what the build
 * actually produces and consumes: 8-bit, non-interlaced, greyscale / RGB /
 * grey+alpha / RGBA PNGs.
 *
 * @module tools/lib/png
 */

import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC32 table (PNG chunk checksums). */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** CRC32 of a buffer. */
export function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Decode a PNG into { width, height, rgba }.
 * @throws on interlaced, 16-bit, or palette images.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG')
  let offset = 8
  let header
  const idat = []
  while (offset + 8 <= buffer.length) {
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
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (header === undefined) throw new Error('no IHDR')
  if (header.bitDepth !== 8) throw new Error(`unsupported bit depth ${header.bitDepth}`)
  if (header.interlace !== 0) throw new Error('interlaced PNG unsupported')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType]
  if (channels === undefined) throw new Error(`unsupported colour type ${header.colorType} (palette needs PLTE)`)

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
      if (filter === 0) value = x
      else if (filter === 1) value = x + a
      else if (filter === 2) value = x + b
      else if (filter === 3) value = x + ((a + b) >> 1)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value = x + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))
      } else throw new Error(`bad filter ${filter}`)
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

/** Encode an RGBA buffer as an 8-bit RGBA PNG. */
export function encodePng({ width, height, rgba }, level = 9) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  ihdr[10] = 0  // deflate
  ihdr[11] = 0  // adaptive filtering
  ihdr[12] = 0  // no interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Box-filter downscale in premultiplied alpha, so transparent regions never
 * bleed their (meaningless) colour into the visible edge pixels.
 */
export function resizeRgba(image, newWidth, newHeight) {
  const { width, height, rgba } = image
  const out = Buffer.alloc(newWidth * newHeight * 4)
  const xRatio = width / newWidth
  const yRatio = height / newHeight
  for (let y = 0; y < newHeight; y += 1) {
    const y0 = Math.floor(y * yRatio)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio))
    for (let x = 0; x < newWidth; x += 1) {
      const x0 = Math.floor(x * xRatio)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * width + sx) * 4
          const alpha = rgba[i + 3] / 255
          r += rgba[i] * alpha
          g += rgba[i + 1] * alpha
          b += rgba[i + 2] * alpha
          a += alpha
          n += 1
        }
      }
      const d = (y * newWidth + x) * 4
      if (a === 0) continue
      out[d] = Math.round(r / a)
      out[d + 1] = Math.round(g / a)
      out[d + 2] = Math.round(b / a)
      out[d + 3] = Math.round((a / n) * 255)
    }
  }
  return { width: newWidth, height: newHeight, rgba: out }
}

/** Crop an RGBA image to a rectangle. */
export function cropRgba(image, left, top, width, height) {
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const src = ((top + y) * image.width + left) * 4
    image.rgba.copy(out, y * width * 4, src, src + width * 4)
  }
  return { width, height, rgba: out }
}

/**
 * Isolate the subject from a light, possibly gradient, background.
 *
 * A global colour key would punch holes through white areas *inside* the
 * character (highlights, eyes, clothing), so this walks inward from the border
 * instead: a pixel joins the background only when it is both close to the
 * neighbour that reached it (which tracks a smooth gradient) and still within
 * a looser bound of the seed colour (which stops the fill from leaking into
 * the artwork). The resulting hard mask is then feathered one pixel so the
 * cutout does not look like scissors work.
 *
 * @returns {{ alpha: Uint8Array, backgroundShare: number }}
 */
export function isolateSubject(rgba, width, height, options = {}) {
  const stepTolerance = options.stepTolerance ?? 26
  const seedTolerance = options.seedTolerance ?? 92
  const feather = options.feather ?? true

  const distance = (i, j) => {
    const dr = rgba[i] - rgba[j]
    const dg = rgba[i + 1] - rgba[j + 1]
    const db = rgba[i + 2] - rgba[j + 2]
    return Math.sqrt(dr * dr + dg * dg + db * db)
  }

  // Seed colour: the median-ish of the border ring, sampled sparsely.
  const samples = []
  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 64))) {
    samples.push((0 * width + x) * 4, ((height - 1) * width + x) * 4)
  }
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 64))) {
    samples.push((y * width + 0) * 4, (y * width + width - 1) * 4)
  }
  const mean = samples.reduce((acc, i) => {
    acc[0] += rgba[i]; acc[1] += rgba[i + 1]; acc[2] += rgba[i + 2]
    return acc
  }, [0, 0, 0]).map((v) => v / samples.length)
  const seed = Buffer.from([mean[0], mean[1], mean[2], 255])

  const isBackground = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0

  /** Euclidean distance from a pixel to the background seed colour. */
  const seedDistance = (i) => Math.sqrt(
    (rgba[i] - seed[0]) ** 2 + (rgba[i + 1] - seed[1]) ** 2 + (rgba[i + 2] - seed[2]) ** 2,
  )

  const push = (x, y) => {
    const p = y * width + x
    if (isBackground[p] === 1) return
    if (seedDistance(p * 4) > seedTolerance) return
    isBackground[p] = 1
    queue[tail] = p
    tail += 1
  }

  for (let x = 0; x < width; x += 1) { push(x, 0); push(x, height - 1) }
  for (let y = 0; y < height; y += 1) { push(0, y); push(width - 1, y) }

  while (head < tail) {
    const p = queue[head]
    head += 1
    const x = p % width
    const y = (p - x) / width
    const pi = p * 4
    const neighbours = []
    if (x > 0) neighbours.push(p - 1)
    if (x < width - 1) neighbours.push(p + 1)
    if (y > 0) neighbours.push(p - width)
    if (y < height - 1) neighbours.push(p + width)
    for (const q of neighbours) {
      if (isBackground[q] === 1) continue
      const qi = q * 4
      if (distance(qi, pi) > stepTolerance) continue
      if (seedDistance(qi) > seedTolerance) continue
      isBackground[q] = 1
      queue[tail] = q
      tail += 1
    }
  }

  let backgroundCount = 0
  for (let p = 0; p < isBackground.length; p += 1) if (isBackground[p] === 1) backgroundCount += 1

  let alpha = new Uint8Array(width * height)
  for (let p = 0; p < alpha.length; p += 1) alpha[p] = isBackground[p] === 1 ? 0 : 255

  if (feather) {
    // One 3x3 box pass over the boundary band only: softens the cut edge
    // without hazing the interior.
    const softened = Uint8Array.from(alpha)
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const p = y * width + x
        const around = alpha[p - width - 1] + alpha[p - width] + alpha[p - width + 1]
          + alpha[p - 1] + alpha[p] + alpha[p + 1]
          + alpha[p + width - 1] + alpha[p + width] + alpha[p + width + 1]
        const avg = around / 9
        if (avg > 0 && avg < 255) softened[p] = Math.round(avg)
      }
    }
    alpha = softened
  }

  // Apply the mask, and un-premultiply against the background colour so the
  // semi-transparent edge band keeps the artwork's colour instead of a white
  // halo (C = a*F + (1-a)*B  ->  F = (C - (1-a)*B) / a).
  for (let p = 0; p < alpha.length; p += 1) {
    const i = p * 4
    const a = alpha[p] / 255
    if (a >= 0.999) { rgba[i + 3] = 255; continue }
    if (a <= 0.001) { rgba[i + 3] = 0; continue }
    for (let channel = 0; channel < 3; channel += 1) {
      const value = (rgba[i + channel] - (1 - a) * seed[channel]) / a
      rgba[i + channel] = Math.max(0, Math.min(255, Math.round(value)))
    }
    rgba[i + 3] = alpha[p]
  }

  return { backgroundShare: backgroundCount / alpha.length }
}

/** Bounding box of pixels whose alpha exceeds `threshold`. */
export function alphaBounds(rgba, width, height, threshold = 8) {
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] <= threshold) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return undefined
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * Label connected opaque regions (8-connectivity) and return them largest
 * first. Used to discover that a source illustration contains several separate
 * figures rather than one subject.
 */
export function labelComponents(rgba, width, height, minArea = 400, alphaThreshold = 128) {
  const label = new Int32Array(width * height).fill(-1)
  const queue = new Int32Array(width * height)
  const components = []
  for (let start = 0; start < width * height; start += 1) {
    if (label[start] !== -1) continue
    if (rgba[start * 4 + 3] < alphaThreshold) continue
    let head = 0
    let tail = 0
    queue[tail] = start
    tail += 1
    label[start] = components.length
    let count = 0
    let minX = width, minY = height, maxX = -1, maxY = -1
    while (head < tail) {
      const p = queue[head]
      head += 1
      count += 1
      const x = p % width
      const y = (p - x) / width
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const q = ny * width + nx
          if (label[q] !== -1) continue
          if (rgba[q * 4 + 3] < alphaThreshold) continue
          label[q] = components.length
          queue[tail] = q
          tail += 1
        }
      }
    }
    components.push({ index: components.length, count, minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 })
  }
  return components
    .filter((component) => component.count >= minArea)
    .sort((a, b) => b.count - a.count)
    .map((component, index) => ({ ...component, rank: index }))
}

/**
 * Render one connected component's own bounding box as ASCII, so a slice taken
 * out of a multi-figure sheet can be identified without an image viewer.
 */
export function asciiComponent(rgba, width, component, cols = 40) {
  const rows = Math.max(1, Math.round(cols * (component.height / component.width) * 0.5))
  const ramp = ' .:-=+*#%@'
  const lines = []
  for (let row = 0; row < rows; row += 1) {
    let line = ''
    for (let col = 0; col < cols; col += 1) {
      const x0 = component.minX + Math.floor(col * component.width / cols)
      const x1 = component.minX + Math.max(1, Math.floor((col + 1) * component.width / cols))
      const y0 = component.minY + Math.floor(row * component.height / rows)
      const y1 = component.minY + Math.max(1, Math.floor((row + 1) * component.height / rows))
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * width + x) * 4
          const a = rgba[i + 3] / 255
          if (a > 0.5) sum += 1 - (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255
          n += 1
        }
      }
      line += ramp[Math.min(9, Math.round((sum / Math.max(1, n)) * 9))]
    }
    lines.push(line)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Drawing helpers (markup previews)
// ---------------------------------------------------------------------------

/** Alpha-blend one pixel in place. */
function blendPixel(rgba, index, r, g, b, a) {
  const na = a / 255
  rgba[index] = Math.round(rgba[index] * (1 - na) + r * na)
  rgba[index + 1] = Math.round(rgba[index + 1] * (1 - na) + g * na)
  rgba[index + 2] = Math.round(rgba[index + 2] * (1 - na) + b * na)
}

/**
 * Paint onto an RGBA image. `paint` receives a per-pixel setter so callers can
 * express shapes without touching the blend math. Out-of-bounds writes drop.
 */
export function paint(image, paintFn) {
  const { width, height, rgba } = image
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    blendPixel(rgba, (y * width + x) * 4, r, g, b, a)
  }
  paintFn(set, width, height)
  return image
}

/** Filled rectangle. */
export function rectFill(image, x, y, w, h, color) {
  return paint(image, (set, width, height) => {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y))
    const x1 = Math.min(width - 1, Math.round(x + w)), y1 = Math.min(height - 1, Math.round(y + h))
    for (let yy = y0; yy <= y1; yy += 1) {
      for (let xx = x0; xx <= x1; xx += 1) set(xx, yy, ...color)
    }
  })
}

/** Hollow rectangle outline. */
export function rectOutline(image, x, y, w, h, color, thickness = 1) {
  return paint(image, (set, width, height) => {
    const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h)
    for (let t = 0; t < thickness; t += 1) {
      for (let xx = x0; xx <= x1; xx += 1) { set(xx, y0 + t, ...color); set(xx, y1 - t, ...color) }
      for (let yy = y0; yy <= y1; yy += 1) { set(x0 + t, yy, ...color); set(x1 - t, yy, ...color) }
    }
  })
}

/** Grid lines at every 10% of the canvas, for reading coordinates off a render. */
export function gridLines(image, color, thickness = 1) {
  return paint(image, (set, width, height) => {
    for (let i = 1; i < 10; i += 1) {
      const xi = Math.round((i / 10) * width)
      for (let t = 0; t < thickness; t += 1) {
        for (let y = 0; y < height; y += 1) set(Math.min(width - 1, xi + t), y, ...color)
      }
    }
    for (let i = 1; i < 10; i += 1) {
      const yi = Math.round((i / 10) * height)
      for (let t = 0; t < thickness; t += 1) {
        for (let x = 0; x < width; x += 1) set(x, Math.min(height - 1, yi + t), ...color)
      }
    }
  })
}

/** Print an ASCII view of the alpha channel (and tone) for eyeballing a build. */
export function asciiPreview(rgba, width, height, cols = 46) {
  const rows = Math.max(1, Math.round(cols * (height / width) * 0.5))
  const alphaRamp = ' .:-=+*#%@'
  const alphaLines = []
  const toneLines = []
  for (let row = 0; row < rows; row += 1) {
    let alphaLine = ''
    let toneLine = ''
    for (let col = 0; col < cols; col += 1) {
      const x0 = Math.floor(col * width / cols), x1 = Math.max(x0 + 1, Math.floor((col + 1) * width / cols))
      const y0 = Math.floor(row * height / rows), y1 = Math.max(y0 + 1, Math.floor((row + 1) * height / rows))
      let alphaSum = 0
      let lumSum = 0
      let n = 0
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * width + x) * 4
          const a = rgba[i + 3] / 255
          alphaSum += a
          if (a > 0.5) lumSum += 1 - (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255
          n += 1
        }
      }
      alphaLine += alphaRamp[Math.min(9, Math.round((alphaSum / n) * 9))]
      toneLine += alphaRamp[Math.min(9, Math.round((lumSum / n) * 9))]
    }
    alphaLines.push(alphaLine)
    toneLines.push(toneLine)
  }
  return { alpha: alphaLines.join('\n'), tone: toneLines.join('\n') }
}
