/**
 * 进度存档 / 回退。
 *
 *   node tools/snapshot.mjs save <标签>     存一份带 sha256 的存档
 *   node tools/snapshot.mjs list            列出所有存档
 *   node tools/snapshot.mjs verify <标签>    校验存档自身是否完好
 *   node tools/snapshot.mjs diff <标签>      对比存档与当前工作区（改了什么）
 *   node tools/snapshot.mjs restore <标签>   还原（先校验存档，再逐文件覆盖）
 *
 * 存档放在 .snapshots/<标签>/，内容是文件原文 + manifest.json（含 sha256 与大小）。
 * 还原前会校验存档哈希：存档一旦损坏就拒绝还原，避免把坏档写回去。
 * 还原只覆盖存档里记录过的文件，不会删除存档之后新增的文件。
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, '.snapshots');

/** 纳入存档的文件：改这些东西就会改变桌宠的行为或外观。 */
const TRACKED = [
  'lib/client.js',
  'lib/index.js',
  // 运行时共享的几何解析 —— 漏了它回退会回不干净（部件会全画错位置）
  'lib/rig-geometry.js',
  // 套餐适配器 —— 漏了它回退后插件直接起不来
  'lib/providers.js',
  'package.json',
  'assets/rig/rig.json',
  'assets/rig/parts/manifest.json',
  'tools/lib/anim.mjs',
  'tools/lib/rig-render.mjs',
  'tools/sync-anim.mjs',
  // 这两个是"回退时最容易忘"的检查器：漏了它们，坏档也能通过校验
  'tools/lib/runtime-files.mjs',
  'tools/ear-balance.mjs',
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const abs = (rel) => join(ROOT, rel);
const label = process.argv[3];

function snapshotDir(name) { return join(STORE, name); }

function save(name) {
  if (!name) throw new Error('用法: node tools/snapshot.mjs save <标签>');
  const dir = snapshotDir(name);
  if (existsSync(dir)) throw new Error(`存档 ${name} 已存在，换个标签或先删掉它`);
  const files = {};
  for (const rel of TRACKED) {
    if (!existsSync(abs(rel))) continue;
    const buf = readFileSync(abs(rel));
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    files[rel] = { sha256: sha(buf), bytes: buf.length };
  }
  const manifest = {
    label: name,
    savedAt: new Date().toISOString(),
    note: process.argv.slice(4).join(' ') || undefined,
    files,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
  console.log(`已存档 ${name}  (${Object.keys(files).length} 个文件)`);
  for (const [rel, info] of Object.entries(files)) {
    console.log(`  ${rel.padEnd(34)} ${String(info.bytes).padStart(8)} B  ${info.sha256.slice(0, 12)}`);
  }
  return manifest;
}

function loadManifest(name) {
  const p = join(snapshotDir(name), 'manifest.json');
  if (!existsSync(p)) throw new Error(`没有存档 ${name}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function verify(name) {
  const manifest = loadManifest(name);
  let bad = 0;
  for (const [rel, info] of Object.entries(manifest.files)) {
    const p = join(snapshotDir(name), rel);
    if (!existsSync(p)) { console.log(`  缺失 ${rel}`); bad += 1; continue; }
    const got = sha(readFileSync(p));
    if (got !== info.sha256) { console.log(`  损坏 ${rel}  期望 ${info.sha256.slice(0,12)} 实得 ${got.slice(0,12)}`); bad += 1; }
  }
  console.log(bad === 0 ? `存档 ${name} 完好（${Object.keys(manifest.files).length} 个文件）` : `存档 ${name} 有 ${bad} 处问题`);
  return bad === 0;
}

function diff(name) {
  const manifest = loadManifest(name);
  let changed = 0;
  for (const [rel, info] of Object.entries(manifest.files)) {
    const p = abs(rel);
    if (!existsSync(p)) { console.log(`  已删除  ${rel}`); changed += 1; continue; }
    const got = sha(readFileSync(p));
    if (got !== info.sha256) {
      console.log(`  已修改  ${rel}  (${info.bytes} B -> ${statSync(p).size} B)`);
      changed += 1;
    }
  }
  // 存档之后**新增**的受管文件也必须报出来：只遍历存档内的文件会漏掉它们，
  // 而回退时"多出来的文件"恰恰是最容易被忘记处理的一类（例如新加的运行时模块）。
  for (const rel of TRACKED) {
    if (manifest.files[rel] === undefined && existsSync(abs(rel))) {
      console.log(`  新增    ${rel}  (存档里没有；restore 不会删它，需要手工处理)`);
      changed += 1;
    }
  }
  console.log(changed === 0 ? `工作区与存档 ${name} 一致` : `相对存档 ${name} 有 ${changed} 个文件不同`);
  return changed;
}

function restore(name) {
  if (!verify(name)) throw new Error('存档校验未通过，拒绝还原');
  const manifest = loadManifest(name);
  for (const rel of Object.keys(manifest.files)) {
    // 备份当前版本，万一还原后又想反悔
    const cur = abs(rel);
    if (existsSync(cur)) {
      const keep = join(snapshotDir(name), '_replaced', rel);
      mkdirSync(dirname(keep), { recursive: true });
      cpSync(cur, keep);
    }
    cpSync(join(snapshotDir(name), rel), cur);
  }
  console.log(`已从存档 ${name} 还原 ${Object.keys(manifest.files).length} 个文件`);
  console.log('（被覆盖的旧版本留在该存档的 _replaced/ 下）');
}

function list() {
  if (!existsSync(STORE)) { console.log('还没有任何存档'); return; }
  const names = readdirSync(STORE).filter((n) => existsSync(join(STORE, n, 'manifest.json')));
  if (!names.length) { console.log('还没有任何存档'); return; }
  for (const n of names.sort()) {
    const m = JSON.parse(readFileSync(join(STORE, n, 'manifest.json'), 'utf8'));
    console.log(`${n.padEnd(22)} ${m.savedAt}  ${Object.keys(m.files).length} 个文件  ${m.note ?? ''}`);
  }
}

const cmd = process.argv[2];
try {
  if (cmd === 'save') save(label);
  else if (cmd === 'list') list();
  else if (cmd === 'verify') verify(label);
  else if (cmd === 'diff') diff(label);
  else if (cmd === 'restore') restore(label);
  else {
    console.log('用法:');
    console.log('  node tools/snapshot.mjs save <标签> [备注]');
    console.log('  node tools/snapshot.mjs list');
    console.log('  node tools/snapshot.mjs verify <标签>');
    console.log('  node tools/snapshot.mjs diff <标签>');
    console.log('  node tools/snapshot.mjs restore <标签>');
  }
} catch (err) {
  console.error(`错误: ${err.message}`);
  process.exitCode = 1;
}

export { save, restore, verify, diff, list };
