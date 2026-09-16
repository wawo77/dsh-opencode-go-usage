/**
 * Rig 渲染器：把 tools/lib/anim.mjs 的运动学作用到抠好的部件上。
 *
 * 几何来自 lib/rig-geometry.js（宿主、离线、网页共用同一份），
 * 变换顺序与网页 canvas 完全一致，因此离线渲染出的画面就是网页该有的画面。
 * 这个文件是「验证用」的——网页用自己的 canvas 路径，但两者共享几何与动画数学。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';
import * as A from './anim.mjs';
import {
  PART_NAMES, resolveRig, mulAffine, applyAffine, rotationAbout,
} from '../../lib/rig-geometry.js';

export { mulAffine as mul, applyAffine as apply, rotationAbout as rotAbout };

export const invert = (m) => {
  const det = m[0] * m[4] - m[1] * m[3];
  const a = m[4] / det, b = -m[1] / det, c = -m[3] / det, d = m[0] / det;
  return [a, b, -(a * m[2] + b * m[5]), c, d, -(c * m[2] + d * m[5])];
};

function sampleBilinear(img, x, y) {
  const w = img.width, h = img.height, rgba = img.rgba;
  if (x < -1 || y < -1 || x > w || y > h) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (let dy = 0; dy <= 1; dy += 1) {
    for (let dx = 0; dx <= 1; dx += 1) {
      const wt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (wt <= 0) continue;
      const px = x0 + dx, py = y0 + dy;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const o = (py * w + px) * 4;
      const al = rgba[o + 3] / 255;
      r += rgba[o] * al * wt;
      g += rgba[o + 1] * al * wt;
      b += rgba[o + 2] * al * wt;
      a += al * wt;
    }
  }
  if (a <= 0) return null;
  return [r / 255, g / 255, b / 255, a];
}

function drawPart(canvas, W, H, img, full) {
  const inv = invert(full);
  const corners = [[0, 0], [img.width, 0], [0, img.height], [img.width, img.height]]
    .map(([x, y]) => applyAffine(full, x, y));
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
  const x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)) + 2);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)) + 2);
  if (x1 < x0 || y1 < y0) return;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const s = applyAffine(inv, x + 0.5, y + 0.5);
      const c = sampleBilinear(img, s[0] - 0.5, s[1] - 0.5);
      if (!c || c[3] <= 0) continue;
      const o = (y * W + x) * 4;
      const ia = 1 - c[3];
      canvas[o] = c[0] + canvas[o] * ia;
      canvas[o + 1] = c[1] + canvas[o + 1] * ia;
      canvas[o + 2] = c[2] + canvas[o + 2] * ia;
      canvas[o + 3] = c[3] + canvas[o + 3] * ia;
    }
  }
}

/** 载入 rig（部件图 + 几何），返回一个可复用的渲染器。 */
export function createRig({ root } = {}) {
  const RIG = join(root, 'assets', 'rig');
  const geometry = resolveRig(
    JSON.parse(readFileSync(join(RIG, 'rig.json'), 'utf8')),
    JSON.parse(readFileSync(join(RIG, 'parts', 'manifest.json'), 'utf8')),
  );
  const images = { body: decodePng(readFileSync(join(RIG, 'parts', 'body.png'))) };
  for (const name of PART_NAMES) {
    images[name] = decodePng(readFileSync(join(RIG, 'parts', `${name}.png`)));
  }

  /** t 时刻各部件的画布矩阵（含整体缩放 scale）。 */
  function matrices(t, scale) {
    const S = [scale, 0, 0, 0, scale, 0];
    const { sx, sy, dy } = A.bodyTransform(t);
    const a = geometry.anchor;
    const B = [sx, 0, a.x * (1 - sx), 0, sy, a.y * (1 - sy) + dy];
    const out = {
      body: mulAffine(mulAffine(S, B),
        [1, 0, geometry.body.originX, 0, 1, geometry.body.originY]),
    };
    const angles = {
      tail: A.tailAngle(t),
      earLeft: A.earAngle(t, 'left'),
      earRight: A.earAngle(t, 'right'),
      ahoge: A.ahogeAngle(t),
    };
    for (const name of PART_NAMES) {
      const p = geometry.parts[name];
      // 轴心随主体变换移动，再绕移动后的轴心旋转
      const q = applyAffine(B, p.pivotCanvasX, p.pivotCanvasY);
      out[name] = mulAffine(
        mulAffine(mulAffine(S, rotationAbout((angles[name] * Math.PI) / 180, q[0], q[1])), B),
        p.place,
      );
    }
    return out;
  }

  function render(t, scale = 1) {
    const W = Math.max(1, Math.round(geometry.canvas.width * scale));
    const H = Math.max(1, Math.round(geometry.canvas.height * scale));
    const canvas = new Float32Array(W * H * 4);
    const m = matrices(t, scale);
    for (const name of geometry.order) drawPart(canvas, W, H, images[name], m[name]);
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i += 1) {
      const a = canvas[i * 4 + 3];
      if (a <= 0) continue;
      const inv = 1 / Math.max(a, 1e-6);
      rgba[i * 4] = Math.max(0, Math.min(255, Math.round(canvas[i * 4] * inv * 255)));
      rgba[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(canvas[i * 4 + 1] * inv * 255)));
      rgba[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(canvas[i * 4 + 2] * inv * 255)));
      rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
    return { width: W, height: H, rgba };
  }

  return { render, matrices, geometry, canvasW: geometry.canvas.width, canvasH: geometry.canvas.height };
}

/** 兼容旧调用：主体框等价于 geometry.body。 */
export function bodyBoxOf(geometry) {
  return { x: geometry.body.originX, y: geometry.body.originY, w: geometry.body.width, h: geometry.body.height };
}

export function newCanvas(w, h, color) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = color[0]; rgba[i * 4 + 1] = color[1];
    rgba[i * 4 + 2] = color[2]; rgba[i * 4 + 3] = color[3] ?? 255;
  }
  return { width: w, height: h, rgba };
}

export function blit(dst, src, ox, oy, opacity = 1) {
  for (let y = 0; y < src.height; y += 1) {
    const ty = oy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x += 1) {
      const tx = ox + x;
      if (tx < 0 || tx >= dst.width) continue;
      const so = (y * src.width + x) * 4;
      const a = (src.rgba[so + 3] / 255) * opacity;
      if (a <= 0) continue;
      const dofs = (ty * dst.width + tx) * 4;
      const ia = 1 - a;
      dst.rgba[dofs] = Math.round(src.rgba[so] * a + dst.rgba[dofs] * ia);
      dst.rgba[dofs + 1] = Math.round(src.rgba[so + 1] * a + dst.rgba[dofs + 1] * ia);
      dst.rgba[dofs + 2] = Math.round(src.rgba[so + 2] * a + dst.rgba[dofs + 2] * ia);
      dst.rgba[dofs + 3] = 255;
    }
  }
}

export const ROOT_OF = (url) => join(dirname(fileURLToPath(url)), '..');
