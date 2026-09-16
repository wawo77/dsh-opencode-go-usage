/**
 * 配平两只耳朵"露出来的量"。
 *
 *   node tools/ear-balance.mjs            报告当前露出面积
 *   node tools/ear-balance.mjs --sweep    扫一遍右耳 x，给出与左耳配平的取值
 *
 * 为什么要这个工具：两只耳朵都画在主体之后（藏在头发后面），但**右侧头发与
 * 蝴蝶结体积更大**，于是同一个落点下右耳被挡掉的更多，看起来"一边露得多、
 * 一边露一点点"。靠肉眼在缩略图上判断不可靠（本会话已经栽过两次），
 * 所以这里直接数像素：耳朵覆盖、但主体没覆盖的像素数 = 真正露出来的量。
 *
 * 测量函数是导出的，test/selftest.mjs 用它把"两侧露出量相当"锁成断言。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './lib/png.mjs';
import { ROOT_OF, invert, apply } from './lib/rig-render.mjs';
import { resolveRig, rotationAbout, mulAffine, applyAffine, effectiveBox } from '../lib/rig-geometry.js';

export const RIG_DIR = join(ROOT_OF(import.meta.url), 'assets', 'rig');

let cache = null;
/** 载入部件图（只做一次）。 */
export function loadParts(dir = RIG_DIR) {
  if (cache !== null) return cache;
  cache = {
    manifest: JSON.parse(readFileSync(join(dir, 'parts', 'manifest.json'), 'utf8')),
    images: {
      body: decodePng(readFileSync(join(dir, 'parts', 'body.png'))),
      earLeft: decodePng(readFileSync(join(dir, 'parts', 'earLeft.png'))),
      earRight: decodePng(readFileSync(join(dir, 'parts', 'earRight.png'))),
    },
  };
  return cache;
}

/** 把部件的局部像素按仿射铺到画布上，返回覆盖率掩码。 */
function coverage(img, matrix, W, H, threshold = 128) {
  const inv = invert(matrix);
  const corners = [[0, 0], [img.width, 0], [0, img.height], [img.width, img.height]]
    .map(([x, y]) => apply(matrix, x, y));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1);
  const x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)) + 1);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1);
  const y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)) + 1);
  const mask = new Uint8Array(W * H);
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const s = apply(inv, x + 0.5, y + 0.5);
      const px = Math.round(s[0] - 0.5), py = Math.round(s[1] - 0.5);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      if (img.rgba[(py * img.width + px) * 4 + 3] <= threshold) continue;
      mask[y * W + x] = 1;
      count += 1;
    }
  }
  return { mask, count };
}

/**
 * 计算某个 rig 配置下两侧耳朵各自露出的像素数，以及耳根是否仍被主体盖住。
 * 静止帧（t=0）下主体变换是恒等，所以部件矩阵 = 绕轴心旋转 × 落点矩阵。
 */
export function measureEars(rig, dir = RIG_DIR) {
  const { manifest, images } = loadParts(dir);
  const geometry = resolveRig(rig, manifest);
  const W = geometry.canvas.width, H = geometry.canvas.height;
  const body = coverage(images.body, [1, 0, geometry.body.originX, 0, 1, geometry.body.originY], W, H);
  const out = { canvas: { W, H }, bodyArea: body.count, sides: {} };
  const inside = (x, y) => {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || py < 0 || px >= W || py >= H) return false;
    return body.mask[py * W + px] === 1;
  };
  for (const name of ['earLeft', 'earRight']) {
    const p = geometry.parts[name];
    // t=0 时左耳旋转角为 0；右耳约 2°，量级很小，统一按 0 处理
    const full = mulAffine(rotationAbout(0, p.pivotCanvasX, p.pivotCanvasY), p.place);
    const ear = coverage(images[name], full, W, H);
    let visible = 0;
    for (let i = 0; i < W * H; i += 1) {
      if (ear.mask[i] === 1 && body.mask[i] === 0) visible += 1;
    }
    // 耳根是否仍被盖住：挪得太靠外，接缝会从头发后露出来变成"漂浮的鳍"
    let innerCovered = 0;
    const samples = 12;
    for (let i = 0; i <= samples; i += 1) {
      const u = (p.pivotX * i) / samples;
      const pt = applyAffine(full, u, p.pivotY);
      if (inside(pt[0], pt[1])) innerCovered += 1;
    }
    out.sides[name] = {
      total: ear.count,
      visible,
      hidden: ear.count - visible,
      rootCovered: inside(p.pivotCanvasX, p.pivotCanvasY),
      innerCovered: innerCovered / (samples + 1),
    };
  }
  return out;
}

export function readRig(dir = RIG_DIR) {
  return JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// CLI：只有直接运行本文件时才执行，被 import 时不跑
// ---------------------------------------------------------------------------

const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`));

if (isMain) {
  const ref = readRig();
  const base = measureEars(ref);
  const pct = (n) => ((n / (base.canvas.W * base.canvas.H)) * 100).toFixed(2) + '%';
  const share = (n, total) => ((n / total) * 100).toFixed(1) + '%';

  console.log('--- 当前配置 ---');
  console.log(`画布 ${base.canvas.W}x${base.canvas.H}   主体覆盖 ${base.bodyArea} px`);
  for (const name of ['earLeft', 'earRight']) {
    const s = base.sides[name];
    console.log(`  ${name.padEnd(9)} 落点 x=${ref[name].x.toFixed(3)}  部件 ${String(s.total).padStart(6)} px`
      + `  露出 ${String(s.visible).padStart(6)} px (${share(s.visible, s.total)})  被挡 ${String(s.hidden).padStart(6)} px`
      + `  耳根${s.rootCovered ? '被盖住' : '*** 露在外面 ***'}`
      + `  内侧盖住 ${(s.innerCovered * 100).toFixed(0)}%`);
  }
  const ratio = base.sides.earLeft.visible / Math.max(1, base.sides.earRight.visible);
  console.log(`\n左右露出比 = ${ratio.toFixed(2)} : 1  ${ratio > 1.15 || ratio < 0.87 ? '← 明显不对称' : '← 已配平'}`);
  console.log(`（露出面积占画布 ${pct(base.sides.earLeft.visible)} / ${pct(base.sides.earRight.visible)}）`);

  if (process.argv.includes('--sweep')) {
    console.log('\n--- 扫描右耳落点 x（左耳不动，以其露出量为目标）---');
    const target = base.sides.earLeft.visible;
    console.log(`目标：右耳露出 ≈ ${target} px（= 左耳）`);
    console.log('   x      露出 px   与目标差  耳根');
    let best = null;
    for (let x = 0.70; x <= 1.02; x += 0.02) {
      const probe = JSON.parse(JSON.stringify(ref));
      probe.earRight.x = Number(x.toFixed(3));
      const side = measureEars(probe).sides.earRight;
      const d = side.visible - target;
      if ((best === null || Math.abs(d) < Math.abs(best.d)) && side.rootCovered) {
        best = { x: Number(x.toFixed(3)), got: side.visible, d };
      }
      console.log(`  ${x.toFixed(3)}  ${String(side.visible).padStart(7)}   ${d >= 0 ? '+' : ''}${d}`
        + `      ${side.rootCovered ? 'ok' : '露在外面!'}`);
    }
    console.log(`\n最接近且耳根仍被盖住的取值：earRight.x = ${best.x}（露出 ${best.got} px，差 ${best.d >= 0 ? '+' : ''}${best.d}）`);
    const tuned = JSON.parse(JSON.stringify(ref));
    tuned.earRight.x = best.x;
    const box = effectiveBox(resolveRig(tuned, loadParts().manifest).parts.earRight);
    console.log(`配平后右耳有效包围盒右缘 = ${(box.x + box.width).toFixed(0)} px`
      + `（主体宽 ${loadParts().manifest.body.width}，画布宽 ${resolveRig(tuned, loadParts().manifest).canvas.width}）`);
  }
}
