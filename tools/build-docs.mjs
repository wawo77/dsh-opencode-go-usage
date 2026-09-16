/**
 * 生成 README 用的配图。
 *
 *   node tools/build-docs.mjs
 *
 * 产出 docs/ 下的两张图：
 *   pet.png        角色本体（透明底），README 顶部的门面图
 *   animation.png  一个循环 8 帧，说明"它真的会动"
 *
 * 为什么要单独生成而不是直接引用 assets/rig/anim/ 里的图：那个目录被 .gitignore
 * 排除了（是素材管线的中间产物），README 引用它的话，读者在 GitHub 上看到的
 * 就是坏图。docs/ 是专门给仓库看的、会被提交的目录。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng, resizeRgba } from './lib/png.mjs';
import { createRig, newCanvas, blit, ROOT_OF } from './lib/rig-render.mjs';
import * as A from './lib/anim.mjs';

const ROOT = ROOT_OF(import.meta.url);
const OUT = join(ROOT, 'docs');
mkdirSync(OUT, { recursive: true });

const rig = createRig({ root: ROOT });

// ---- 门面图：静止帧，缩到 520px 高（GitHub 会按容器宽度再缩，太大没必要）----
const rest = rig.render(0, 1);
const PORTRAIT_H = 520;
const portrait = resizeRgba(rest, Math.round(rest.width * (PORTRAIT_H / rest.height)), PORTRAIT_H);
writeFileSync(join(OUT, 'pet.png'), encodePng(portrait));
console.log(`docs/pet.png        ${portrait.width}x${portrait.height}  ${(encodePng(portrait).length / 1024).toFixed(0)} KB`);

// ---- 动画示意：一个循环 8 帧，2 行 4 列 ----
const COLS = 4, ROWS = 2, GAP = 8;
const tile = rig.render(0, 0.19);
const strip = newCanvas(
  COLS * tile.width + (COLS + 1) * GAP,
  ROWS * tile.height + (ROWS + 1) * GAP,
  [246, 248, 251, 255],
);
for (let i = 0; i < COLS * ROWS; i += 1) {
  const frame = rig.render((i * A.LOOP_SECONDS) / (COLS * ROWS), 0.19);
  blit(strip, frame, GAP + (i % COLS) * (tile.width + GAP), GAP + Math.floor(i / COLS) * (tile.height + GAP));
}
writeFileSync(join(OUT, 'animation.png'), encodePng(strip));
console.log(`docs/animation.png  ${strip.width}x${strip.height}  ${(encodePng(strip).length / 1024).toFixed(0)} KB`);
console.log('\n这两张图会被提交进仓库（tools/prepare-repo.mjs 不排除 docs/）。');
