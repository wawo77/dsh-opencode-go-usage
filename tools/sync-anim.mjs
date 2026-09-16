/**
 * 把 tools/lib/ 下的纯逻辑块同步进 lib/client.js。
 *
 *   node tools/sync-anim.mjs          写入（只在有差异时改动）
 *   node tools/sync-anim.mjs --check  只检查，不写；有差异则退出码 1
 *
 * 客户端 bundle 是手写的纯 DOM 脚本、不能 import，所以动画数学与音效合成
 * 必须各内联一份。内联是**生成**的，不是手抄的：唯一真值在 tools/lib/ 里，
 * 这里负责搬运，selftest 用 --check 防止两边走样。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'lib', 'client.js');
const INDENT = '    ';

/** 每个块：源文件 + 源里的起止标记 + 客户端里的标记 + 生成说明。 */
export const BLOCKS = [
  {
    name: 'anim',
    source: join(ROOT, 'tools', 'lib', 'anim.mjs'),
    open: '// ---8<--- 以下整块会被 tools/sync-anim.mjs 原样内联进 lib/client.js，勿手改 ---',
    close: '// ---8<--- 内联块结束（下面只给离线校验用，不进客户端）---',
    mark: '@oguw-anim',
    comment: '桌宠动画运动学',
  },
  {
    name: 'duck',
    source: join(ROOT, 'tools', 'lib', 'duck.mjs'),
    open: '// ---8<--- 以下整块会被 tools/sync-anim.mjs 内联进 lib/client.js，勿手改 ---',
    close: '// ---8<--- 内联块结束（下面只给离线试听与测试用，不进客户端）---',
    mark: '@oguw-duck',
    comment: '点击音效合成',
  },
  {
    name: 'boop',
    source: join(ROOT, 'tools', 'lib', 'boop.mjs'),
    open: '// ---8<--- 以下整块会被 tools/sync-anim.mjs 内联进 lib/client.js，勿手改 ---',
    close: '// ---8<--- 内联块结束（下面只给离线试听与测试用，不进客户端）---',
    mark: '@oguw-boop',
    comment: '缩放音效合成',
  },
];

/** 抽出某个源文件的内联块，并去掉 ESM 的 export 关键字。 */
export function buildBlock(block) {
  const text = readFileSync(block.source, 'utf8');
  const from = text.indexOf(block.open);
  const to = text.indexOf(block.close);
  if (from < 0 || to < 0 || to <= from) {
    throw new Error(`${block.source} 里找不到内联块标记`);
  }
  const body = text.slice(from + block.open.length, to).trim();
  const plain = body.replace(/^export /gm, '').replace(/\bexport /g, '');
  const lines = plain.split('\n').map((line) => (line.trim() ? INDENT + line : ''));
  const rel = block.source.slice(ROOT.length + 1).replace(/\\/g, '/');
  return [
    `${INDENT}// ${block.mark}:start 由 tools/sync-anim.mjs 从 ${rel} 生成（${block.comment}），请勿手改`,
    ...lines,
    `${INDENT}// ${block.mark}:end`,
  ].join('\n');
}

/** 把客户端里的某个内联块换成最新生成的版本。 */
export function splice(clientText, block, generated) {
  const startMark = `${INDENT}// ${block.mark}:start`;
  const endMark = `${INDENT}// ${block.mark}:end`;
  const start = clientText.indexOf(startMark);
  const end = clientText.indexOf(endMark);
  if (start < 0 || end < 0) throw new Error(`client.js 里找不到 ${block.mark} 标记`);
  return clientText.slice(0, start) + generated + clientText.slice(end + endMark.length);
}

/** 按顺序把所有块同步进客户端源码，返回新文本。 */
export function syncAll(clientText) {
  let next = clientText;
  for (const block of BLOCKS) next = splice(next, block, buildBlock(block));
  return next;
}

const check = process.argv.includes('--check');
const client = readFileSync(TARGET, 'utf8');
const next = syncAll(client);
const inSync = next === client;

if (check) {
  console.log(inSync
    ? `内联块（${BLOCKS.map((b) => b.name).join(' / ')}）与 tools/lib/ 下的源文件一致`
    : '内联块与源文件不一致 —— 运行 node tools/sync-anim.mjs 重新生成');
  if (!inSync) process.exitCode = 1;
} else if (inSync) {
  console.log('内联块已是最新，无需改动');
} else {
  writeFileSync(TARGET, next);
  for (const block of BLOCKS) {
    const rel = block.source.slice(ROOT.length + 1).replace(/\\/g, '/');
    console.log(`已同步 ${block.mark} ← ${rel}（${buildBlock(block).split('\n').length} 行）`);
  }
}
