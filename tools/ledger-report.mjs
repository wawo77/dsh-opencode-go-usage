/**
 * 直接从本地账本文件算 token / 金额，不经过运行中的宿主。
 *
 *   node tools/ledger-report.mjs
 *
 * 用途：宿主改动要重启才生效，但账本一直都在 —— 这个工具能在重启之前
 * 就把"今日到底用了多少 token"算出来，用来核对界面将来会显示的数字，
 * 也用来判断某个字段是不是真的没数据（而不是显示成了 0）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 账本是独立的 ledger.json（state.json 只存位置与尺寸，没有桶）
const STATE = process.env.OGUW_LEDGER
  ?? join(homedir(), '.dsh', 'opencode-go-usage', 'ledger.json');

if (!existsSync(STATE)) {
  console.error(`找不到账本：${STATE}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(STATE, 'utf8'));
const buckets = Array.isArray(raw.buckets) ? raw.buckets : Object.values(raw.buckets ?? {});
console.log(`账本 ${STATE}`);
console.log(`桶数 ${buckets.length}`);

if (buckets.length === 0) process.exit(0);

/** 桶的时间单位：存的是分钟序号（t * 60000 = 毫秒）。 */
const BUCKET_MS = 60_000;
const at = (b) => Number(b.t) * BUCKET_MS;
const sorted = [...buckets].sort((a, b) => at(a) - at(b));
console.log(`最早 ${new Date(at(sorted[0])).toLocaleString()}`);
console.log(`最新 ${new Date(at(sorted[sorted.length - 1])).toLocaleString()}`);

const now = Date.now();
const midnight = new Date(now);
midnight.setHours(0, 0, 0, 0);

function sum(startMs, endMs) {
  let tokens = 0, inTok = 0, outTok = 0, cached = 0, calls = 0;
  for (const b of buckets) {
    const t = at(b);
    if (t < startMs || t > endMs) continue;
    const n = (v) => Number(v) || 0;
    inTok += n(b.i);
    outTok += n(b.o);
    cached += n(b.cr) + n(b.cw);
    calls += n(b.n);
  }
  tokens = inTok + outTok + cached;
  return { tokens, inTok, outTok, cached, calls };
}

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
const show = (label, s) => {
  console.log(`  ${label.padEnd(10)} ${fmt(s.tokens).padStart(9)} tok`
    + `  (入 ${fmt(s.inTok)} / 出 ${fmt(s.outTok)} / 缓存 ${fmt(s.cached)})`
    + `  ${String(s.calls).padStart(5)} 次调用`);
};

console.log('\n--- 各口径 token ---');
show('今日', sum(midnight.getTime(), now));
show('近 24 小时', sum(now - 86_400_000, now));
show('近 7 天', sum(now - 7 * 86_400_000, now));
show('近 30 天', sum(now - 30 * 86_400_000, now));
console.log(`\n今日起点（本机零点）: ${midnight.toLocaleString()}`);
