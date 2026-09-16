/**
 * 点击音效：小黄鸭（橡皮鸭）捏一下的"吱"声。
 *
 * 为什么是**合成**而不是音频文件：
 *   1. 网上找的鸭子音效有版权问题，而这个插件是要发给别人用的；
 *   2. 少一个二进制资源就少一处"装到别的机器上丢了"的可能；
 *   3. 参数即代码，你觉得音色不对我改两个数就行，不用换文件。
 *
 * 关键设计：合成写成**纯采样函数**（renderDuck），客户端把它灌进 AudioBuffer 播放，
 * 离线工具把同一份采样写成 WAV。于是"我导出的试听文件"和你实际听到的声音
 * 是同一串样本 —— 我听不到声音，这个一致性就是我唯一能验证的东西。
 *
 * 音色怎么来的：橡皮鸭是一只带气阀的软塑料，挤的时候气流让哨片快速振动，
 * 音高先被挤上去、再随气压回落，同时强烈的高次谐波经口腔共振发出"吱"的鼻音。
 * 所以这里 = 上滑又回落的基频 + 堆叠谐波 + 一个固定带通（模拟共振峰）+ 快起快落包络。
 */

// ---8<--- 以下整块会被 tools/sync-anim.mjs 内联进 lib/client.js，勿手改 ---

/** 音效时长（秒）。比点击反馈动画短得多，要的是"轻快"而不是"余音"。 */
const DUCK_SECONDS = 0.17;

/** 采样率。客户端会用 AudioContext 的真实采样率调用，这里只是默认值。 */
const DUCK_RATE = 48000;

/**
 * 基频曲线：挤下去 → 尖上去 → 回落。
 * 输入是归一化时间 u∈[0,1]，输出频率 Hz。分段之间用平滑插值，避免爆音。
 */
function duckPitch(u) {
  const points = [
    [0.0, 560],
    [0.12, 760],
    [0.38, 1320],
    [0.62, 1180],
    [1.0, 820],
  ];
  for (let i = 1; i < points.length; i += 1) {
    if (u <= points[i][0]) {
      const [u0, f0] = points[i - 1];
      const [u1, f1] = points[i];
      const k = (u - u0) / (u1 - u0);
      // smoothstep：分段的线性插值会有折角，听感上是"咔"的一下
      const s = k * k * (3 - 2 * k);
      return f0 + (f1 - f0) * s;
    }
  }
  return points[points.length - 1][1];
}

/** 音量包络：极快起音 + 指数衰减。捏一下就是"啪"地开始、"吱"地消失。 */
function duckEnvelope(u) {
  const attack = 0.06;
  if (u < attack) return u / attack;
  const decay = (u - attack) / (1 - attack);
  return Math.pow(1 - decay, 2.2);
}

/**
 * 二阶带通（RBJ cookbook），模拟鸭嘴/哨片的共振峰。
 * 固定中心频率而不是跟着音高走 —— 真实的哨片共振是腔体决定的，基本不随音高变，
 * 跟着走反而会听成电子音。
 */
function duckBandpass(samples, rate, centerHz, q) {
  const w0 = (2 * Math.PI * centerHz) / rate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos0 = Math.cos(w0);
  const b0 = alpha, b1 = 0, b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * cos0, a2 = 1 - alpha;
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i];
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2
      - (a1 / a0) * y1 - (a2 / a0) * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

/**
 * 生成鸭子叫的采样。返回 [-1,1] 的 Float32Array，长度 = rate * DUCK_SECONDS。
 * 纯函数：同样的 rate 一定得到同样的样本，这是离线试听能与实机一致的前提。
 */
function renderDuck(rate) {
  const sampleRate = Number.isFinite(rate) && rate > 0 ? rate : DUCK_RATE;
  const total = Math.max(1, Math.floor(sampleRate * DUCK_SECONDS));
  const raw = new Float32Array(total);
  let phase = 0;
  for (let i = 0; i < total; i += 1) {
    const u = i / (total - 1);
    phase += (2 * Math.PI * duckPitch(u)) / sampleRate;
    // 谐波堆叠：基波弱一点，二三次强一点，才有"吱"的鼻音而不是圆润的笛声
    const tone = Math.sin(phase) * 0.45
      + Math.sin(phase * 2) * 0.34
      + Math.sin(phase * 3) * 0.21;
    raw[i] = tone * duckEnvelope(u);
  }
  const filtered = duckBandpass(raw, sampleRate, 1850, 3.2);
  // 带通会吃掉不少能量，归一化到 0.9 峰值，保证不同采样率听感一致
  let peak = 0;
  for (let i = 0; i < total; i += 1) peak = Math.max(peak, Math.abs(filtered[i]));
  const gain = peak > 0 ? 0.9 / peak : 1;
  const out = new Float32Array(total);
  for (let i = 0; i < total; i += 1) out[i] = filtered[i] * gain;
  return out;
}

// ---8<--- 内联块结束（下面只给离线试听与测试用，不进客户端）---

export { DUCK_SECONDS, DUCK_RATE, renderDuck, duckPitch, duckEnvelope };
