/**
 * 缩放音效：啵。
 *
 * 与小黄鸭刻意做出区别 —— 鸭子是"吱"（谐波堆叠 + 带通 → 尖、鼻音、有攻击性），
 * 啵是"啵"（正弦为主 + 温和低通 → 圆、闷、没棱角），因为缩放是**连续动作**
 * （滚轮会连着触发好几次），刺耳的音色连着响会很难受。
 *
 * "q 弹"来自音高曲线：起手一下快速上滑（像气泡顶破水面），然后轻轻回落。
 * 上滑要快（35ms 内走完大半），慢了就不弹了。
 *
 * 与 duck 一样是纯采样函数：客户端灌进 AudioBuffer，离线工具写 WAV，
 * 两边是同一串样本。
 */

// ---8<--- 以下整块会被 tools/sync-anim.mjs 内联进 lib/client.js，勿手改 ---

/** 时长（秒）。比鸭子更短 —— 缩放是高频动作，声音要"点一下就收"。 */
const BOOP_SECONDS = 0.115;

const BOOP_RATE = 48000;

/** 音高曲线：快速上滑 → 轻回落。 */
function boopPitch(u) {
  const points = [
    [0.0, 330],
    [0.09, 560],
    [0.32, 880],
    [0.58, 800],
    [1.0, 690],
  ];
  for (let i = 1; i < points.length; i += 1) {
    if (u <= points[i][0]) {
      const [u0, f0] = points[i - 1];
      const [u1, f1] = points[i];
      const k = (u - u0) / (u1 - u0);
      const s = k * k * (3 - 2 * k);
      return f0 + (f1 - f0) * s;
    }
  }
  return points[points.length - 1][1];
}

/** 包络：比鸭子稍慢的起音（去掉"啪"的爆音感），然后干净收尾。 */
function boopEnvelope(u) {
  const attack = 0.11;
  if (u < attack) {
    const k = u / attack;
    return k * k * (3 - 2 * k);
  }
  const decay = (u - attack) / (1 - attack);
  return Math.pow(1 - decay, 2.6);
}

/**
 * 一阶低通。啵的圆润来自"几乎没有高频" —— 鸭子靠带通做出鼻音，
 * 这里反过来，把高频削掉，留下一个软乎乎的团。
 */
function boopLowpass(samples, rate, cutoffHz) {
  const dt = 1 / rate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);
  const out = new Float32Array(samples.length);
  let previous = 0;
  for (let i = 0; i < samples.length; i += 1) {
    previous += alpha * (samples[i] - previous);
    out[i] = previous;
  }
  return out;
}

/**
 * 生成"啵"的采样。纯函数，同样的 rate 得到同样的样本。
 */
function renderBoop(rate) {
  const sampleRate = Number.isFinite(rate) && rate > 0 ? rate : BOOP_RATE;
  const total = Math.max(1, Math.floor(sampleRate * BOOP_SECONDS));
  const raw = new Float32Array(total);
  let phase = 0;
  for (let i = 0; i < total; i += 1) {
    const u = i / (total - 1);
    phase += (2 * Math.PI * boopPitch(u)) / sampleRate;
    // 以正弦为主，只加一点二次谐波：全是正弦会像测试音，加太多就变鸭子
    const tone = Math.sin(phase) * 0.78 + Math.sin(phase * 2) * 0.22;
    raw[i] = tone * boopEnvelope(u);
  }
  const filtered = boopLowpass(raw, sampleRate, 2300);
  let peak = 0;
  for (let i = 0; i < total; i += 1) peak = Math.max(peak, Math.abs(filtered[i]));
  const gain = peak > 0 ? 0.9 / peak : 1;
  const out = new Float32Array(total);
  for (let i = 0; i < total; i += 1) out[i] = filtered[i] * gain;
  return out;
}

// ---8<--- 内联块结束（下面只给离线试听与测试用，不进客户端）---

export { BOOP_SECONDS, BOOP_RATE, renderBoop, boopPitch, boopEnvelope };
