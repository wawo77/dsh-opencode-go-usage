/**
 * 耳朵层级对照：把原画与装配图在「耳朵所在的那块解剖区域」放大并排，
 * 用来看清耳朵是压在头发之上还是之下。
 *
 *   node tools/compare-ears.mjs
 *
 * 输出 assets/rig/anim/ears.png：上排原画（左右耳），下排装配图（同框同比例）。
 * 包围盒轮廓对比看不出遮挡关系，只能这样放大看。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng, resizeRgba, cropRgba, isolateSubject, alphaBounds } from './lib/png.mjs';
import { createRig, newCanvas, blit, ROOT_OF, bodyBoxOf } from './lib/rig-render.mjs';

const ROOT = ROOT_OF(import.meta.url);
const OUT = join(ROOT, 'assets', 'rig', 'anim');
const ORIGINAL = 'D:/图片素材/deepseek形象主人物图.png';
const BODY_H = 720;

// ---------- 原画 ----------
const orig = decodePng(readFileSync(ORIGINAL));
isolateSubject(orig.rgba, orig.width, orig.height, { stepTolerance: 26, seedTolerance: 104 });
for (let y = 0; y < Math.ceil(0.1 * orig.height); y += 1) {
  for (let x = Math.floor(0.83 * orig.width); x < orig.width; x += 1) orig.rgba[(y * orig.width + x) * 4 + 3] = 0;
}
const ob = alphaBounds(orig.rgba, orig.width, orig.height);
const rows = [];
for (let y = ob.minY; y <= ob.maxY; y += 1) {
  let lo = orig.width, hi = -1;
  for (let x = 0; x < orig.width; x += 1) {
    if (orig.rgba[(y * orig.width + x) * 4 + 3] <= 8) continue;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (hi >= 0) rows.push({ y, lo, hi, w: hi - lo + 1 });
}
const widest = Math.max(...rows.map((r) => r.w));
const bodyTop = rows.find((r) => r.w > 0.2 * widest).y;
const band = rows.filter((r) => r.y < bodyTop + 0.28 * (ob.maxY - bodyTop));
const faceCenter = (Math.min(...band.map((r) => r.lo)) + Math.max(...band.map((r) => r.hi))) / 2;
const bodyLeft = Math.min(...rows.filter((r) => r.y >= bodyTop).map((r) => r.lo));
// 主体框宽度 = 右缘 - 左缘；右缘由脸心镜像得到（排除右侧的尾巴）
const origBody = { x: bodyLeft, y: bodyTop, w: Math.round(2 * faceCenter) - 2 * bodyLeft, h: ob.maxY - bodyTop };

const sOrig = BODY_H / origBody.h;
const origScaled = resizeRgba(orig, Math.round(orig.width * sOrig), Math.round(orig.height * sOrig));
const origBodyPx = { x: origBody.x * sOrig, y: origBody.y * sOrig, w: origBody.w * sOrig, h: BODY_H };

console.log('--- 原画 ---');
console.log(`含配件包围盒 x${ob.minX}-${ob.maxX} y${ob.minY}-${ob.maxY}  最宽行 ${widest}`);
console.log(`bodyTop=${bodyTop} bodyLeft=${bodyLeft} faceCenter=${faceCenter.toFixed(1)}`);
console.log(`推算主体框 x${origBody.x}-${origBody.x + origBody.w} y${origBody.y}-${origBody.y + origBody.h} = ${origBody.w}x${origBody.h}`);
console.log(`缩放 ${sOrig.toFixed(4)} → 主体框像素 ${origBodyPx.w.toFixed(1)}x${BODY_H}，缩放后整图 ${origScaled.width}x${origScaled.height}`);
// 水印是否真的被抹掉了
let wmLeft = 0;
for (let y = 0; y < origScaled.height; y += 1) {
  for (let x = Math.floor(origScaled.width * 0.83); x < origScaled.width; x += 1) {
    if (origScaled.rgba[(y * origScaled.width + x) * 4 + 3] > 8) wmLeft += 1;
  }
}
console.log(`缩放后右上角仍有内容的不透明像素: ${wmLeft}（应为 0 —— 不为 0 说明水印没抹干净）`);

// ---------- 装配图 ----------
const rig = createRig({ root: ROOT });
const body = bodyBoxOf(rig.geometry);
const sMine = BODY_H / body.h;
const mineScaled = rig.render(0, sMine);
const mineBodyPx = { x: body.x * sMine, y: body.y * sMine, w: body.w * sMine, h: BODY_H };

// ---------- 裁切（同框同比例，越界补透明）----------
function cropByFraction(sheet, bodyPx, frac) {
  const x = Math.round(bodyPx.x + frac.fx0 * bodyPx.w);
  const y = Math.round(bodyPx.y + frac.fy0 * bodyPx.h);
  const w = Math.round((frac.fx1 - frac.fx0) * bodyPx.w);
  const h = Math.round((frac.fy1 - frac.fy0) * bodyPx.h);
  const out = newCanvas(w, h, [0, 0, 0, 0]);
  const sx = Math.max(0, -x), sy = Math.max(0, -y);
  const ex = Math.min(w, sheet.width - x), ey = Math.min(h, sheet.height - y);
  if (ex > sx && ey > sy) blit(out, cropRgba(sheet, x + sx, y + sy, ex - sx, ey - sy), sx, sy);
  return out;
}

// 耳朵所在的高度带：原画实测在 fy 0.28~0.42
const REGIONS = {
  left: { fx0: -0.16, fx1: 0.34, fy0: 0.22, fy1: 0.46 },
  right: { fx0: 0.66, fx1: 1.16, fy0: 0.22, fy1: 0.46 },
};
const ZOOM = 3.0;
const panels = [];
for (const side of ['left', 'right']) {
  const frac = REGIONS[side];
  panels.push({
    label: `原画 ${side}`,
    img: cropByFraction(origScaled, origBodyPx, frac),
  });
  panels.push({
    label: `装配 ${side}`,
    img: cropByFraction(mineScaled, mineBodyPx, frac),
  });
}
const TW = Math.round(panels[0].img.width * ZOOM);
const TH = Math.round(panels[0].img.height * ZOOM);
const GAP = 14;
const sheet = newCanvas(TW * 2 + GAP * 3, TH * 2 + GAP * 3, [250, 250, 252, 255]);
panels.forEach((panel, i) => {
  const cx = GAP + (i % 2) * (TW + GAP);
  const cy = GAP + Math.floor(i / 2) * (TH + GAP);
  blit(sheet, resizeRgba(panel.img, TW, TH), cx, cy);
});

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'ears.png'), encodePng(sheet));
console.log(`写出 assets/rig/anim/ears.png  ${sheet.width}x${sheet.height}`);
console.log(`区域（主体框比例）：左耳 x -0.16~0.34，右耳 x 0.66~1.16，两者 y 0.22~0.46；放大 ${ZOOM}x`);
console.log('排布：左上=原画左耳  右上=装配左耳  左下=原画右耳  右下=装配右耳');
console.log('（panels 顺序是 [原画左,装配左,原画右,装配右]，按 i%2 排两列 ⇒ 实际交错，别按"上排原画"读）');
