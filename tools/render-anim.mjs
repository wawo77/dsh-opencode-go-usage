/**
 * 离屏渲染桌宠动画：把骨骼运动学（tools/lib/anim.mjs）作用到抠好的部件上。
 *
 *   node tools/render-anim.mjs
 *
 * 产出：
 *   assets/rig/anim/filmstrip.png   —— 一个循环内 12 帧
 *   assets/rig/anim/diff.png        —— 压缩峰值帧 vs 静止帧的差异图（看清动的是哪里）
 *   assets/rig/anim/frame-000.png   —— 静止帧整图
 * 并逐字节比对 t=0 与 t=T 的渲染结果，证明首尾帧 100% 相同。
 *
 * 渲染走 tools/lib/rig-render.mjs —— 与网页 canvas 同一套数学，避免两条路径分叉。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from './lib/png.mjs';
import { createRig, newCanvas, blit, ROOT_OF } from './lib/rig-render.mjs';
import * as A from './lib/anim.mjs';

const ROOT = ROOT_OF(import.meta.url);
const OUT = join(ROOT, 'assets', 'rig', 'anim');
const rig = createRig({ root: ROOT });

function countDiff(a, b) {
  let pixels = 0, max = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    if (d) { pixels += 1; max = Math.max(max, d); }
  }
  return { pixels, max };
}
function fill(canvas, color) {
  for (let i = 0; i < canvas.width * canvas.height; i += 1) {
    canvas.rgba[i * 4] = color[0]; canvas.rgba[i * 4 + 1] = color[1];
    canvas.rgba[i * 4 + 2] = color[2]; canvas.rgba[i * 4 + 3] = 255;
  }
}

mkdirSync(OUT, { recursive: true });

// ---------- 1. 运动学自检 ----------
const check = A.verifyLoop();
console.log('--- 运动学自检 ---');
console.log('t=0 与 t=T 逐通道相等:', check.closed ? '是' : '否');
if (!check.closed) for (const d of check.diffs) console.log('  !', d);
console.log('运动幅度(度): 呆毛', check.amplitude.ahoge.toFixed(2),
  '| 左耳', check.amplitude.earLeft.toFixed(2),
  '| 右耳', check.amplitude.earRight.toFixed(2),
  '| 尾巴', check.amplitude.tail.toFixed(2),
  '| 主体压缩', (check.amplitude.body * 100).toFixed(2) + '%');

// ---------- 2. 循环闭合：逐字节比对首尾帧 ----------
const FPS = 60;
const CHECK_SCALE = 0.25;
const first = rig.render(0, CHECK_SCALE);
const last = rig.render(A.LOOP_SECONDS, CHECK_SCALE);
const cmp = countDiff(first.rgba, last.rgba);
console.log(`\n--- 首尾帧渲染比对 (scale=${CHECK_SCALE}, ${first.width}x${first.height}) ---`);
console.log(`帧步进按 ${FPS}fps 切分：一循环 ${A.LOOP_SECONDS * FPS} 帧，最后一帧即 t=T`);
console.log('逐字节完全相同:', cmp.pixels === 0 ? '是' : `否（${cmp.pixels} 个子像素不同，最大差 ${cmp.max}）`);

// 中间帧必须"确实在动"，否则"静止 = 首尾相同"是假阳性
let changed = 0;
for (let i = 1; i < FPS; i += 1) {
  const f = rig.render((i * A.LOOP_SECONDS) / FPS, CHECK_SCALE);
  if (!f.rgba.equals(first.rgba)) changed += 1;
}
console.log(`循环内 ${FPS - 1} 个中间帧中，与首帧不同者: ${changed}（应远大于 0）`);

// ---------- 3. 关键帧数据表 ----------
console.log('\n--- 关键帧运动学 ---');
console.log('   t     sy     呆毛°   左耳°   右耳°   尾巴°');
for (let i = 0; i <= 12; i += 1) {
  const t = (i * A.LOOP_SECONDS) / 12;
  console.log(
    `  ${t.toFixed(2)}  ${A.bodyTransform(t).sy.toFixed(4)}  ${A.ahogeAngle(t).toFixed(2).padStart(6)}  ` +
    `${A.earAngle(t, 'left').toFixed(2).padStart(6)}  ${A.earAngle(t, 'right').toFixed(2).padStart(6)}  ` +
    `${A.tailAngle(t).toFixed(2).padStart(6)}`,
  );
}

// ---------- 4. 胶片图：一个循环 12 帧 ----------
const COLS = 4, ROWS = 3, GAP = 10, TILE_SCALE = 0.26;
const tile = rig.render(0, TILE_SCALE);
const strip = newCanvas(COLS * tile.width + (COLS + 1) * GAP, ROWS * tile.height + (ROWS + 1) * GAP, [236, 240, 246, 255]);
for (let i = 0; i < COLS * ROWS; i += 1) {
  const f = rig.render((i * A.LOOP_SECONDS) / (COLS * ROWS), TILE_SCALE);
  blit(strip, f, GAP + (i % COLS) * (tile.width + GAP), GAP + Math.floor(i / COLS) * (tile.height + GAP));
}
writeFileSync(join(OUT, 'filmstrip.png'), encodePng(strip));
console.log(`\n写出 assets/rig/anim/filmstrip.png  ${strip.width}x${strip.height}  (${COLS * ROWS} 帧，覆盖整循环)`);

// ---------- 5. 差异图：压缩峰值 vs 静止 ----------
let peakT = 0, peak = -Infinity;
for (let i = 0; i <= 600; i += 1) {
  const t = (i * A.LOOP_SECONDS) / 600;
  if (A.squashAt(t) > peak) { peak = A.squashAt(t); peakT = t; }
}
const restF = rig.render(0, CHECK_SCALE);
const peakF = rig.render(peakT, CHECK_SCALE);
const diffImg = { width: restF.width, height: restF.height, rgba: Buffer.alloc(restF.rgba.length) };
for (let i = 0; i < diffImg.rgba.length; i += 4) {
  const d = Math.min(255, (Math.abs(restF.rgba[i] - peakF.rgba[i])
    + Math.abs(restF.rgba[i + 1] - peakF.rgba[i + 1])
    + Math.abs(restF.rgba[i + 2] - peakF.rgba[i + 2])) * 1.4);
  diffImg.rgba[i] = d > 8 ? 255 : 40;
  diffImg.rgba[i + 1] = Math.round(d * 0.35);
  diffImg.rgba[i + 2] = Math.round(255 - d * 0.5);
  diffImg.rgba[i + 3] = 255;
}
writeFileSync(join(OUT, 'diff.png'), encodePng(diffImg));
console.log(`写出 assets/rig/anim/diff.png  压缩峰值 t=${peakT.toFixed(2)}s (squash=${peak.toFixed(3)}) vs 静止帧`);

writeFileSync(join(OUT, 'frame-000.png'), encodePng(rig.render(0, 0.5)));
console.log('写出 assets/rig/anim/frame-000.png (静止帧, 50%)');
