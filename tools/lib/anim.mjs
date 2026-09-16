/**
 * 桌宠骨骼动画（纯数学，无 IO）。
 *
 * 设计要求：高帧率循环、第一帧与最后一帧 100% 相同。
 * 做法不是"对齐关键帧"，而是让全部运动都由 **周期为 T 的函数** 驱动：
 *   - 呼吸/摆动   → sin(2π·k·t/T)，k 为整数 ⇒ 周期恰为 T
 *   - 蹦一下/抖一下 → 紧支撑升余弦脉冲 bump()，支撑区间严格落在 (0,T) 内部，
 *                     区间外恒等于 0，且两端一阶导为 0
 * 于是 t=0 与 t=T 处每个通道的取值恒等，接缝在数学上不存在。
 * 滞后用 squashAt(t-lag) 实现——周期函数的时间平移仍然是周期函数。
 */

// ---8<--- 以下整块会被 tools/sync-anim.mjs 原样内联进 lib/client.js，勿手改 ---

/** 一个完整循环的时长（秒）。客户端对时间取模靠它，必须一起内联。 */
const LOOP_SECONDS = 6;

const TAU = Math.PI * 2;

/** 紧支撑平滑脉冲：|t-c| >= hw 时严格为 0。 */
function bump(t, c, hw) {
  const d = Math.abs(t - c);
  if (d >= hw) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / hw));
}

/** 呼吸：每循环 2 个周期。 */
function breath(t) {
  return Math.sin((TAU * 2 * t) / LOOP_SECONDS);
}

/**
 * 蹦一下的压缩量：先压（t≈3.00）再弹（t≈3.46）。
 * 两个脉冲都紧支撑 ⇒ t=0 与 t=T 处恒为 0。
 */
export function squashAt(t) {
  return 0.62 * bump(t, 3.0, 0.3) - 0.4 * bump(t, 3.46, 0.34);
}

/** 弹起时整只离地一点点。 */
function liftAt(t) {
  return bump(t, 3.5, 0.3);
}

/** 主体：绕脚下锚点做近似体积守恒的压扁/拉伸。 */
export function bodyTransform(t) {
  const s = squashAt(t);
  const sy = 1 - 0.078 * s + 0.011 * breath(t);
  const sx = 1 - 0.55 * (sy - 1);
  return { sx, sy, dy: -7 * liftAt(t) };
}

/** 呆毛：轴心在根部，跟随主体压缩弹动（滞后一帧量 ⇒ 甩尾）。 */
export function ahogeAngle(t) {
  const lag = 0.17;
  const whip = 30 * (squashAt(t - lag) - squashAt(t));
  const idle = 3.4 * Math.sin((TAU * 2 * t) / LOOP_SECONDS + 0.7);
  return idle + whip;
}

/** 耳朵：持续微摆 + 各自一次干脆的抖动。 */
export function earAngle(t, side) {
  const isLeft = side === 'left';
  const dir = isLeft ? -1 : 1;
  const sway = 2.2 * Math.sin((TAU * 3 * t) / LOOP_SECONDS + (isLeft ? 0 : 1.1));
  const twitch = isLeft
    ? bump(t, 1.5, 0.17) - 0.5 * bump(t, 1.7, 0.19)
    : bump(t, 4.3, 0.17) - 0.5 * bump(t, 4.5, 0.19);
  return sway + dir * 14 * twitch + 3.0 * dir * squashAt(t);
}

/** 尾巴：慢摆 + 二次谐波 + 蹦跳时的甩动。 */
export function tailAngle(t) {
  const sway = 8 * Math.sin((TAU * 2 * t) / LOOP_SECONDS + 1.2);
  const second = 3 * Math.sin((TAU * 4 * t) / LOOP_SECONDS + 0.4);
  const flick = 18 * (squashAt(t - 0.12) - squashAt(t));
  return sway + second + flick;
}

// ---8<--- 内联块结束（下面只给离线校验用，不进客户端）---

export { LOOP_SECONDS };

/** 自检：把整条运动学链在 [0,T] 上采样，确认 t=0 与 t=T 的取值逐项相等。 */
export function verifyLoop(samples = 400) {
  const at = (t) => ({
    body: bodyTransform(t),
    ahoge: ahogeAngle(t),
    earLeft: earAngle(t, 'left'),
    earRight: earAngle(t, 'right'),
    tail: tailAngle(t),
  });
  const a = at(0);
  const b = at(LOOP_SECONDS);
  const diffs = [];
  const cmp = (label, x, y) => {
    const d = Math.abs(x - y);
    if (d > 1e-12) diffs.push(`${label}: |${x} - ${y}| = ${d}`);
  };
  for (const k of ['sx', 'sy', 'dy']) cmp(`body.${k}`, a.body[k], b.body[k]);
  for (const k of ['ahoge', 'earLeft', 'earRight', 'tail']) cmp(k, a[k], b[k]);
  // 顺带确认函数确实在动（否则"首尾相等"是废话）
  let span = { body: 0, ahoge: 0, earLeft: 0, earRight: 0, tail: 0 };
  for (let i = 0; i <= samples; i += 1) {
    const s = at((i * LOOP_SECONDS) / samples);
    span.ahoge = Math.max(span.ahoge, Math.abs(s.ahoge));
    span.earLeft = Math.max(span.earLeft, Math.abs(s.earLeft));
    span.earRight = Math.max(span.earRight, Math.abs(s.earRight));
    span.tail = Math.max(span.tail, Math.abs(s.tail));
    span.body = Math.max(span.body, Math.abs(s.body.sy - 1));
  }
  return { closed: diffs.length === 0, diffs, amplitude: span };
}
