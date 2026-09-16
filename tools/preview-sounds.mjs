/**
 * 把所有内置音效渲染成 WAV，好让人在做决定之前先听一遍。
 *
 *   node tools/preview-sounds.mjs                 写出 dist/*.wav（48kHz）
 *   node tools/preview-sounds.mjs --rate 44100    指定采样率
 *
 * 为什么值得单独做一个：写代码的人（我）听不到声音，只能保证"波形是对的"。
 * 而客户端播放的样本正是这些 render*() 的输出 —— 同一个纯函数、同一份采样，
 * 所以这些 WAV 就是实机的声音，不是近似。听完说"太尖/太闷/太长"，我改参数重出。
 *
 * 顺带打印音高与包络的走势：参数错了看数字比听更快。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_OF } from './lib/rig-render.mjs';
import { renderDuck, duckPitch, duckEnvelope, DUCK_SECONDS } from './lib/duck.mjs';
import { renderBoop, boopPitch, boopEnvelope, BOOP_SECONDS } from './lib/boop.mjs';

const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};

const rate = Number(argOf('--rate', 48000));

const SOUNDS = [
  {
    file: 'duck-preview.wav',
    label: '点击角色 —— 小黄鸭"吱"',
    seconds: DUCK_SECONDS,
    render: renderDuck,
    pitch: duckPitch,
    envelope: duckEnvelope,
    tune: 'duckPitch() 音高曲线、duckBandpass 的中心频率与 Q（鼻音程度）、DUCK_SECONDS 时长',
  },
  {
    file: 'boop-preview.wav',
    label: '缩放 —— 啵',
    seconds: BOOP_SECONDS,
    render: renderBoop,
    pitch: boopPitch,
    envelope: boopEnvelope,
    tune: 'boopPitch() 音高曲线、boopLowpass 的截止频率（越低沉越圆）、BOOP_SECONDS 时长',
  },
];

/** 16-bit 单声道 PCM WAV。手写头部 44 字节，不引依赖。 */
function toWav(float32, sampleRate) {
  const dataBytes = float32.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);              // PCM
  buffer.writeUInt16LE(1, 22);              // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);              // block align
  buffer.writeUInt16LE(16, 34);             // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < float32.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

const outDir = join(ROOT_OF(import.meta.url), 'dist');
mkdirSync(outDir, { recursive: true });

for (const sound of SOUNDS) {
  const samples = sound.render(rate);
  const wav = toWav(samples, rate);
  writeFileSync(join(outDir, sound.file), wav);

  let peak = 0;
  let energy = 0;
  for (const value of samples) {
    peak = Math.max(peak, Math.abs(value));
    energy += value * value;
  }
  const rms = Math.sqrt(energy / samples.length);

  console.log(`\n=== ${sound.label} → dist/${sound.file} ===`);
  console.log(`  ${rate} Hz 单声道 16-bit  ${samples.length} 样本  ${(sound.seconds * 1000).toFixed(0)} ms  ${(wav.length / 1024).toFixed(1)} KB`);
  console.log(`  峰值 ${peak.toFixed(3)}  RMS ${rms.toFixed(3)}`);
  console.log('   时刻(ms)   音高(Hz)   音量');
  for (let i = 0; i <= 6; i += 1) {
    const u = i / 6;
    console.log(`  ${(u * sound.seconds * 1000).toFixed(0).padStart(6)}     ${sound.pitch(u).toFixed(0).padStart(6)}     ${sound.envelope(u).toFixed(2)}`);
  }
}

console.log('\n双击 dist 下的 wav 试听。要调音色，改 tools/lib/ 里的对应文件：');
for (const sound of SOUNDS) console.log(`  ${sound.file.padEnd(20)} ${sound.tune}`);
console.log('\n改完重跑本脚本，然后 node tools/sync-anim.mjs 把改动同步进客户端。');
