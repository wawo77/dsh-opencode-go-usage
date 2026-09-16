/**
 * The pet's deformation rig — shared by the browser half and the offline frame
 * renderer, so the frames I verify are exactly what animates in the browser.
 *
 * Coordinates are fractions of the sprite (fx ∈ [0,1] left→right, fy ∈ [0,1]
 * top→bottom). Rotations are computed in PIXEL space and converted back, so a
 * rotation stays a rotation instead of turning into a sheared ellipse.
 *
 * @module tools/lib/warp
 */

/**
 * Part geometry. `pivot` is the rotation anchor; `angle`/`angle2` are two
 * superposed sway amplitudes (radians) at `speed`/`speed2`, staggered by
 * `phase` so parts never move in lockstep; `ramp` is how far from the
 * attachment a part becomes fully mobile; `bias` says which edge is attached.
 */
export const RIG = {
  ahoge: {
    box: { x: 0.43, y: 0.000, w: 0.21, h: 0.062 },
    pivot: { x: 0.530, y: 0.055 },
    angle: 0.16, angle2: 0.05, speed: 2.3, speed2: 3.9, phase: 0.4, ramp: 0.55,
    bias: 'fromBottom',
  },
  hairLeft: {
    box: { x: 0.00, y: 0.360, w: 0.30, h: 0.540 },
    pivot: { x: 0.220, y: 0.395 },
    angle: 0.055, angle2: 0.018, speed: 0.95, speed2: 1.62, phase: 0.0, ramp: 0.30,
    bias: 'fromTop',
  },
  hairRight: {
    box: { x: 0.66, y: 0.360, w: 0.26, h: 0.540 },
    pivot: { x: 0.735, y: 0.395 },
    angle: 0.050, angle2: 0.016, speed: 0.88, speed2: 1.50, phase: 1.6, ramp: 0.30,
    bias: 'fromTop',
  },
  tail: {
    box: { x: 0.82, y: 0.520, w: 0.18, h: 0.420 },
    pivot: { x: 0.845, y: 0.635 },
    angle: 0.16, angle2: 0.05, speed: 0.62, speed2: 1.05, phase: 2.9, ramp: 0.45,
    bias: 'fromLeft',
  },
  eyeLeft: { box: { x: 0.263, y: 0.298, w: 0.138, h: 0.078 } },
  eyeRight: { box: { x: 0.468, y: 0.298, w: 0.140, h: 0.078 } },
  breathe: { amount: 0.011, speed: 0.42, tilt: 0.0065 },
}

/** Whole-body sway periods, deliberately not multiples of each other. */
export const BODY = {
  tiltSpeed: 0.23,
  tiltPhase: 1.1,
}

/**
 * The transparent margin the sprite builder leaves on every side, in output
 * pixels. The rig below is measured in CHARACTER fractions (the artwork
 * without margins); these convert between the two so a swung part always has
 * room to move into, instead of smearing the frame edge.
 */
export const PAD = { x: 26, y: 14 }

/** Convert a sprite fraction into a character fraction. */
function toChar(fx, fy, spriteW, spriteH) {
  const charW = spriteW - PAD.x * 2
  const charH = spriteH - PAD.y * 2
  return {
    fx: (fx * spriteW - PAD.x) / charW,
    fy: (fy * spriteH - PAD.y) / charH,
    charW,
    charH,
  }
}

/** Smooth 0→1 ramp. */
export function smooth(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}

/**
 * Soft membership of a point in a box: 1 inside, feathered to 0 over
 * `feather` px at every edge, then shaped by the attachment bias so the edge
 * that is attached to the body barely moves.
 */
function membership(box, fx, fy, spriteW, spriteH, feather, ramp, bias) {
  const dl = (fx - box.x) * spriteW
  const dr = (box.x + box.w - fx) * spriteW
  const dt = (fy - box.y) * spriteH
  const db = (box.y + box.h - fy) * spriteH
  const edge = Math.min(1, dl / feather, dr / feather, dt / feather, db / feather)
  if (edge <= 0) return 0
  let b = 1
  if (bias === 'fromTop') b = smooth(((fy - box.y) / box.h) / ramp)
  else if (bias === 'fromBottom') b = smooth((1 - (fy - box.y) / box.h) / ramp)
  else if (bias === 'fromLeft') b = smooth(((fx - box.x) / box.w) / ramp)
  return edge * b
}

/**
 * One part's weight at a point, with any region another layer owns carved out
 * (feathered) so two layers never fight over the same pixels.
 */
export function partWeight(id, fx, fy, spriteW, spriteH) {
  const part = RIG[id]
  const feather = 0.22 * Math.min(part.box.w * spriteW, part.box.h * spriteH)
  let w = membership(part.box, fx, fy, spriteW, spriteH, feather, part.ramp, part.bias)
  if (w <= 0) return 0
  if (part.bias !== undefined && (id === 'hairLeft' || id === 'hairRight')) {
    const tail = RIG.tail
    const featherT = 0.22 * Math.min(tail.box.w * spriteW, tail.box.h * spriteH)
    const inTail = membership(tail.box, fx, fy, spriteW, spriteH, featherT, 1, undefined)
    if (inTail > 0) w *= 1 - inTail
  }
  return w
}

/**
 * Evaluate the whole displacement field at one point.
 *
 * @param {number} fx - horizontal fraction of the sprite.
 * @param {number} fy - vertical fraction of the sprite.
 * @param {number} t - seconds.
 * @param {number} blink - 0..1 eyelid closure.
 * @param {object} [pose] - extra per-part angle offsets in radians, keyed by
 *   part id; this is how a click injects an impulse the springs then settle.
 * @param {number} [spriteW] - PADDED sprite width in px (default 374).
 * @param {number} [spriteH] - PADDED sprite height in px (default 448).
 * @returns {{dx: number, dy: number}} displacement as FRACTIONS of the sprite.
 */
export function displacementAt(fx, fy, t, blink, pose, spriteW = 374, spriteH = 448) {
  const pose2 = pose || {}
  const c = toChar(fx, fy, spriteW, spriteH)
  fx = c.fx
  fy = c.fy
  spriteW = c.charW
  spriteH = c.charH
  let dx = 0
  let dy = 0

  // --- breathing: the body stretches from its feet and tilts a hair -------
  const s = 1 + RIG.breathe.amount * Math.sin(breathePhase(t))
  dy += (fy - 1) * (s - 1)
  const tilt = RIG.breathe.tilt * Math.sin(2 * Math.PI * BODY.tiltSpeed * t + BODY.tiltPhase)
  {
    const px = (fx - 0.5) * spriteW
    const py = (fy - 1) * spriteH
    dx += ((Math.cos(tilt) - 1) * px - Math.sin(tilt) * py) / spriteW
    dy += (Math.sin(tilt) * px + (Math.cos(tilt) - 1) * py) / spriteH
  }

  // --- parts: a twist about each pivot, weighted by membership ------------
  for (const id of ['ahoge', 'hairLeft', 'hairRight', 'tail']) {
    const part = RIG[id]
    const w = partWeight(id, fx, fy, spriteW, spriteH)
    if (w <= 0.001) continue
    const theta = (part.angle * Math.sin(2 * Math.PI * part.speed * t + part.phase)
      + part.angle2 * Math.sin(2 * Math.PI * part.speed2 * t + part.phase * 1.3)
      + (pose2[id] || 0)) * w
    if (Math.abs(theta) < 1e-6) continue
    const px = (fx - part.pivot.x) * spriteW
    const py = (fy - part.pivot.y) * spriteH
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    dx += ((cos - 1) * px - sin * py) / spriteW
    dy += (sin * px + (cos - 1) * py) / spriteH
  }

  // --- blink: the upper lid comes DOWN, so the eye squashes toward its
  //     LOWER lid (the lash line travels with it), which is what a real
  //     blink looks like rather than a squint.
  if (blink > 0.001) {
    for (const id of ['eyeLeft', 'eyeRight']) {
      const box = RIG[id].box
      const feather = 0.30 * Math.min(box.w * spriteW, box.h * spriteH)
      const w = membership(box, fx, fy, spriteW, spriteH, feather, 1, undefined)
      if (w <= 0.001) continue
      const bottom = box.y + box.h
      const distFromBottom = bottom - fy
      const k = 1 - 0.90 * blink
      dy += (bottom - distFromBottom * k - fy) * w
      dx += (fx - (box.x + box.w / 2)) * 0.12 * blink * w
    }
  }

  // Everything above was accumulated in CHARACTER fractions; hand the caller
  // back PADDED-sprite fractions.
  return {
    dx: (dx * c.charW) / (c.charW + PAD.x * 2),
    dy: (dy * c.charH) / (c.charH + PAD.y * 2),
  }
}

/** Breathing phase, kept here so the browser and Node agree exactly. */
function breathePhase(t) {
  return 2 * Math.PI * RIG.breathe.speed * t
}

/**
 * Warp a sprite image by the field — the offline renderer's inverse map.
 * For each DESTINATION pixel we sample the source at (p - d(p)), bilinearly.
 * @returns {{width, height, rgba}} a new image.
 */
export function warpSprite(sprite, t, blink, pose) {
  const { width: W, height: H, rgba } = sprite
  const out = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y += 1) {
    const fy = (y + 0.5) / H
    for (let x = 0; x < W; x += 1) {
      const fx = (x + 0.5) / W
      const d = displacementAt(fx, fy, t, blink, pose, W, H)
      // Nearest sample at the displaced source point; the field is smooth and
      // the displacements are a few pixels, so this stays artifact-free.
      const sx = Math.max(0, Math.min(W - 1, Math.round(fx * W - 0.5 - d.dx * W)))
      const sy = Math.max(0, Math.min(H - 1, Math.round(fy * H - 0.5 - d.dy * H)))
      const s = (sy * W + sx) * 4
      const o = (y * W + x) * 4
      out[o] = rgba[s]
      out[o + 1] = rgba[s + 1]
      out[o + 2] = rgba[s + 2]
      out[o + 3] = rgba[s + 3]
    }
  }
  return { width: W, height: H, rgba: out }
}
