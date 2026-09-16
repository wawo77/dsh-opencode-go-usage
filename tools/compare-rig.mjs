/**
 * 把装配好的 rig 与原画等高并排 + 叠加对照，用来给每个配件定缩放。
 *
 *   node tools/compare-rig.mjs
 *
 * 三联图（assets/rig/anim/vs-original.png）：
 *   [原画]  [我的装配]  [50% 叠加]
 * 三块面板共用同一套「主体框对齐」——把主体框的左上角放在同一位置、缩放到同一高度，
 * 于是叠加图里任何错位都只可能来自配件本身，与对齐无关。
 * 另打印配件相对主体的外扩比，供直接读数。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng, resizeRgba, cropRgba, isolateSubject, alphaBounds } from './lib/png.mjs';
import { createRig, newCanvas, blit, ROOT_OF, bodyBoxOf } from './lib/rig-render.mjs';
import { effectiveBox } from '../lib/rig-geometry.js';

const ROOT = ROOT_OF(import.meta.url);
const OUT = join(ROOT, 'assets', 'rig', 'anim');
// 原画（含配件的完整角色）—— 部件相对比例的唯一天然真值
const ORIGINAL = 'D:/图片素材/deepseek形象主人物图.png';
const WATERMARK = { x0: 0.83, y0: 0.0, x1: 1.0, y1: 0.1 };

function eraseRect(image, rect) {
  const x0 = Math.floor(rect.x0 * image.width), x1 = Math.ceil(rect.x1 * image.width);
  const y0 = Math.floor(rect.y0 * image.height), y1 = Math.ceil(rect.y1 * image.height);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) image.rgba[(y * image.width + x) * 4 + 3] = 0;
  }
}

// ---------- 原画：去水印 + 去背景 + 找主体框 ----------
const orig = decodePng(readFileSync(ORIGINAL));
// 顺序要紧：isolateSubject 会把非背景像素的 alpha 重置为不透明，
// 所以必须先抠图、再去水印，否则水印会被"救回来"并污染包围盒。
isolateSubject(orig.rgba, orig.width, orig.height, { stepTolerance: 26, seedTolerance: 104 });
eraseRect(orig, WATERMARK);
const ob = alphaBounds(orig.rgba, orig.width, orig.height);

const rows = [];
for (let y = ob.minY; y <= ob.maxY; y += 1) {
  let minX = orig.width, maxX = -1;
  for (let x = 0; x < orig.width; x += 1) {
    if (orig.rgba[(y * orig.width + x) * 4 + 3] <= 8) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  if (maxX >= 0) rows.push({ y, minX, maxX, width: maxX - minX + 1 });
}
const widest = Math.max(...rows.map((r) => r.width));
// 主体顶端：行宽首次超过最宽处 20% 的那一行
// （阈值放宽到 20%：头饰比头部窄，45% 会把头饰整段切掉、主体框偏矮）
const bodyTop = rows.find((r) => r.width > 0.2 * widest).y;
const bodyBottom = ob.maxY;
// 头带内的脸部中心（左右近似对称），用来镜像出主体右缘（排除尾巴）
const headBand = rows.filter((r) => r.y < bodyTop + 0.28 * (bodyBottom - bodyTop));
const headLeft = Math.min(...headBand.map((r) => r.minX));
const headRight = Math.max(...headBand.map((r) => r.maxX));
const faceCenter = (headLeft + headRight) / 2;
const bodyLeft = Math.min(...rows.filter((r) => r.y >= bodyTop).map((r) => r.minX));
const bodyRight = Math.round(2 * faceCenter - bodyLeft);
const origBody = { x: bodyLeft, y: bodyTop, w: bodyRight - bodyLeft, h: bodyBottom - bodyTop };

console.log('--- 原画测量 ---');
console.log(`全图 ${orig.width}x${orig.height}  主体（含配件）包围盒 x${ob.minX}-${ob.maxX} y${ob.minY}-${ob.maxY}`);
console.log(`推算主体框（不含配件） x${origBody.x}-${origBody.x + origBody.w} y${origBody.y}-${origBody.y + origBody.h}` +
  `  = ${origBody.w}x${origBody.h}  aspect ${(origBody.w / origBody.h).toFixed(3)}`);
console.log('关键行宽（y: 左缘-右缘 宽）:');
for (const r of rows.filter((_, i) => i % Math.max(1, Math.floor(rows.length / 14)) === 0)) {
  console.log(`  y=${String(r.y).padStart(4)}  ${String(r.minX).padStart(4)}-${String(r.maxX).padStart(4)}  ${String(r.width).padStart(4)}`);
}

// ---------- 我的 rig ----------
const rig = createRig({ root: ROOT });
const mine = rig.render(0, 1);
const myBody = bodyBoxOf(rig.geometry);
console.log('\n--- 我的 rig ---');
console.log(`画布 ${rig.canvasW}x${rig.canvasH}  主体框 ${myBody.w}x${myBody.h} aspect ${(myBody.w / myBody.h).toFixed(3)}`);
console.log(`主体框在画布内位置 x${myBody.x} y${myBody.y}`);

// ---------- 配件外扩比：相对主体框，各自越界多少 ----------
const overhang = (box, body) => ({
  left: (body.x - box.x) / body.w,
  right: (box.x + box.w - (body.x + body.w)) / body.w,
  top: (body.y - box.y) / body.h,
  bottom: (box.y + box.h - (body.y + body.h)) / body.h,
});
console.log('\n--- 配件相对主体框的外扩（占主体宽/高的比例）---');
console.log('部件        左      右      上      下');
for (const name of ['ahoge', 'earLeft', 'earRight', 'tail']) {
  const o = overhang(effectiveBox(rig.geometry.parts[name]), { x: 0, y: 0, w: myBody.w, h: myBody.h });
  console.log(
    `${name.padEnd(10)} ${o.left.toFixed(3).padStart(6)} ${o.right.toFixed(3).padStart(6)} ` +
    `${o.top.toFixed(3).padStart(6)} ${o.bottom.toFixed(3).padStart(6)}`,
  );
}
// 原画里各配件相对主体框的外扩，作为对照读数
const oOrig = overhang(
  { x: ob.minX, y: ob.minY, w: ob.maxX - ob.minX + 1, h: ob.maxY - ob.minY + 1 },
  { x: origBody.x, y: origBody.y, w: origBody.w, h: origBody.h },
);
console.log(`原画整体   ${oOrig.left.toFixed(3).padStart(6)} ${oOrig.right.toFixed(3).padStart(6)} ` +
  `${oOrig.top.toFixed(3).padStart(6)} ${oOrig.bottom.toFixed(3).padStart(6)}`);

// ---------- 三联图 ----------
const BODY_H = 720;
const BX = 200, BY = 190;
const PANEL_W = 1000, PANEL_H = 940, GAP = 16;
const sOrig = BODY_H / origBody.h;
const sMine = BODY_H / myBody.h;
const origScaled = resizeRgba(orig, Math.round(orig.width * sOrig), Math.round(orig.height * sOrig));
const mineScaled = rig.render(0, sMine);

const imgW = PANEL_W * 3 + GAP * 4;
const imgH = PANEL_H + GAP * 2;
const img = newCanvas(imgW, imgH, [255, 255, 255, 255]);
const panels = [
  { x: GAP + 0 * (PANEL_W + GAP), src: origScaled, ox: Math.round(BX - origBody.x * sOrig), oy: Math.round(BY - origBody.y * sOrig) },
  { x: GAP + 1 * (PANEL_W + GAP), src: mineScaled, ox: Math.round(BX - myBody.x * sMine), oy: Math.round(BY - myBody.y * sMine) },
  { x: GAP + 2 * (PANEL_W + GAP), src: null, ox: 0, oy: 0 },
];
for (const p of panels) {
  if (p.src) blit(img, p.src, p.x + p.ox, GAP + p.oy);
}
// 叠加面板：先原画，再我的 rig 半透明
const overlay = panels[2];
blit(img, origScaled, overlay.x + Math.round(BX - origBody.x * sOrig), GAP + Math.round(BY - origBody.y * sOrig));
blit(img, mineScaled, overlay.x + Math.round(BX - myBody.x * sMine), GAP + Math.round(BY - myBody.y * sMine), 0.5);

// 主体框参考线（三块面板同一位置）
for (const p of panels) {
  const x0 = p.x + BX, x1 = p.x + BX + Math.round(myBody.w * sMine);
  const y0 = GAP + BY, y1 = GAP + BY + BODY_H;
  for (let x = x0; x <= x1; x += 1) {
    for (const y of [y0, y1]) { const o = (y * imgW + x) * 4; img.rgba[o] = 255; img.rgba[o + 1] = 90; img.rgba[o + 2] = 90; }
  }
  for (let y = y0; y <= y1; y += 1) {
    for (const x of [x0, x1]) { const o = (y * imgW + x) * 4; img.rgba[o] = 255; img.rgba[o + 1] = 90; img.rgba[o + 2] = 90; }
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'vs-original.png'), encodePng(img));
console.log(`\n写出 assets/rig/anim/vs-original.png  ${imgW}x${imgH}`);
console.log(`缩放: 原画 ${sOrig.toFixed(4)}  我的 rig ${sMine.toFixed(4)}  （主体框同为 ${BODY_H}px 高）`);
console.log('红框 = 主体框，三块面板位置一致；叠加面板两图各 50%。');

// ---------- 头部等框放大对照 ----------
// 同一套「主体框比例坐标」去裁两张图，于是裁出来的是同一块解剖区域，
// 可以直接比对耳朵/呆毛的大小与接缝位置 —— 缩略图上肉眼判断不可靠。
const HEAD = { fx0: -0.20, fx1: 1.20, fy0: -0.13, fy1: 0.50 };
const ZOOM = 2.2;
function cropByFraction(sheet, bodyPx, frac) {
  const x = Math.round(bodyPx.x + frac.fx0 * bodyPx.w);
  const y = Math.round(bodyPx.y + frac.fy0 * bodyPx.h);
  const w = Math.round((frac.fx1 - frac.fx0) * bodyPx.w);
  const h = Math.round((frac.fy1 - frac.fy0) * bodyPx.h);
  // 头部框会伸到主体框外面（呆毛在上方），裁切区因此可能越界 —— 用透明底补边，
  // 保证两张图裁出的解剖区域严格同框，不会因为各自被截断而错位。
  const out = newCanvas(w, h, [0, 0, 0, 0]);
  const sx = Math.max(0, -x), sy = Math.max(0, -y);
  const ex = Math.min(w, sheet.width - x), ey = Math.min(h, sheet.height - y);
  if (ex > sx && ey > sy) blit(out, cropRgba(sheet, x + sx, y + sy, ex - sx, ey - sy), sx, sy);
  return out;
}
const origBodyPx = { x: origBody.x * sOrig, y: origBody.y * sOrig, w: origBody.w * sOrig, h: BODY_H };
const mineBodyPx = { x: myBody.x * sMine, y: myBody.y * sMine, w: myBody.w * sMine, h: BODY_H };
const headA = cropByFraction(origScaled, origBodyPx, HEAD);
const headB = cropByFraction(mineScaled, mineBodyPx, HEAD);
const ZW = Math.round(headA.width * ZOOM), ZH = Math.round(headA.height * ZOOM);
const zoomImg = newCanvas(ZW * 2 + GAP * 3, ZH + GAP * 2, [255, 255, 255, 255]);
blit(zoomImg, resizeRgba(headA, ZW, ZH), GAP, GAP);
blit(zoomImg, resizeRgba(headB, ZW, ZH), GAP * 2 + ZW, GAP);
writeFileSync(join(OUT, 'head-zoom.png'), encodePng(zoomImg));
const headH = Math.round((HEAD.fy1 - HEAD.fy0) * myBody.h * sMine);
console.log(`写出 assets/rig/anim/head-zoom.png  ${zoomImg.width}x${zoomImg.height}`);
console.log(`头部框（占主体高 ${(HEAD.fy1 - HEAD.fy0).toFixed(2)}）实际 ${headH}px，放大 ${ZOOM}x；左=原画 右=我的 rig`);

// ---------- 逐行轮廓对比 ----------
// 缩略图上靠肉眼读像素坐标不可靠。这里把两张图都归一到「主体框比例坐标」，
// 按行打印左右边缘占主体宽的比例 —— 耳朵在哪一行、比主体外扩多少，直接读数。
// 注意原画的下摆头发比耳朵更宽，所以耳朵只在"自己那一行"外扩，
// 全局包围盒看不出来（这正是先前把耳朵量小的原因）。
function profile(sheet, bodyPx, fy) {
  const y = Math.round(bodyPx.y + fy * bodyPx.h);
  if (y < 0 || y >= sheet.height) return null;
  let lo = Infinity, hi = -Infinity;
  for (let x = 0; x < sheet.width; x += 1) {
    if (sheet.rgba[(y * sheet.width + x) * 4 + 3] <= 8) continue;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (hi < 0) return null;
  return { left: (lo - bodyPx.x) / bodyPx.w, right: (hi - bodyPx.x) / bodyPx.w };
}
console.log('\n--- 逐行轮廓（数值 = 左右边缘占主体宽的比例；0=主体框左缘，1=右缘）---');
console.log('    fy   原画左 原画右 | 我左   我右  |  左右差');
let worst = 0, worstFy = 0;
for (let i = 0; i <= 28; i += 1) {
  const fy = -0.10 + (i / 28) * 0.60;
  const a = profile(origScaled, origBodyPx, fy);
  const b = profile(mineScaled, mineBodyPx, fy);
  if (!a || !b) continue;
  const dl = b.left - a.left, dr = b.right - a.right;
  if (Math.max(Math.abs(dl), Math.abs(dr)) > worst) {
    worst = Math.max(Math.abs(dl), Math.abs(dr));
    worstFy = fy;
  }
  const mark = Math.max(Math.abs(dl), Math.abs(dr)) > 0.06 ? '  <<<' : '';
  console.log(
    `  ${fy.toFixed(2).padStart(5)}  ${a.left.toFixed(3).padStart(6)} ${a.right.toFixed(3).padStart(6)} |` +
    ` ${b.left.toFixed(3).padStart(6)} ${b.right.toFixed(3).padStart(6)} |` +
    ` ${dl >= 0 ? '+' : ''}${dl.toFixed(3)} ${dr >= 0 ? '+' : ''}${dr.toFixed(3)}${mark}`,
  );
}
console.log(`最大偏差 ${worst.toFixed(3)}（占主体宽）出现在 fy=${worstFy.toFixed(2)}；` +
  'fy 为主体重高比例，负值在主体框上方');
