/**
 * 上传前的隐私扫描。
 *
 *   node tools/privacy-scan.mjs                    扫 dist/github-upload
 *   node tools/privacy-scan.mjs --dir <路径>        扫别的目录
 *   node tools/privacy-scan.mjs --dir . --all      扫整个工作区（含未被 .gitignore 排除的）
 *
 * 思路：**正则匹配是不可靠的**，漏一个字符就失效。所以这里做三层：
 *   1. 拿本机**真实的**密钥值去逐字节比对 —— 真漏了必然抓到（最强的一层）
 *   2. 常规密钥形态（sk-/ghp_/Bearer 长串等），兜住"不是我自己的 key"
 *   3. 隐私上下文：个人目录路径、工作区 id、以及 PNG 里可能嵌的生成元数据
 *
 * 输出一律**打码**：本工具会把命中的密钥原文隐去，只留前后几位。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { ROOT_OF } from './lib/rig-render.mjs';

const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};

const ROOT = ROOT_OF(import.meta.url);
const TARGET = join(ROOT, argOf('--dir', join('dist', 'github-upload')));
const DSH_HOME = join(homedir(), '.dsh');

/** 收集本机真实密钥：这些值一旦出现在待发布的文件里就是事故。 */
function knownSecrets() {
  const found = [];
  const add = (label, value) => {
    const v = typeof value === 'string' ? value.trim().replace(/^['"]|['"]$/g, '') : '';
    // 太短的字符串（如 "true"）会满篇误报，跳过
    if (v.length >= 12) found.push({ label, value: v });
  };

  // .credentials.yaml：一行一个 KEY: value
  const credPath = join(DSH_HOME, '.credentials.yaml');
  if (existsSync(credPath)) {
    for (const line of readFileSync(credPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*:\s*(.+)$/.exec(line);
      if (m !== null) add(`~/.dsh/.credentials.yaml → ${m[1]}`, m[2]);
    }
  }
  // settings.yaml 里可能内联了 key
  const settingsPath = join(DSH_HOME, 'settings.yaml');
  if (existsSync(settingsPath)) {
    for (const line of readFileSync(settingsPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:apiKey|api_key|token|secret)\s*:\s*(.+)$/i.exec(line);
      if (m !== null) add('~/.dsh/settings.yaml → 内联密钥', m[1]);
    }
  }
  // 宿主的访问 token
  const hostLog = join(DSH_HOME, 'web-host.log');
  if (existsSync(hostLog)) {
    const m = /token=([A-Za-z0-9._-]{16,})/.exec(readFileSync(hostLog, 'utf8'));
    if (m !== null) add('~/.dsh/web-host.log → dsh web 访问 token', m[1]);
  }
  // 工作区里的 .env
  for (const name of ['.env', '.env.local']) {
    const p = join(ROOT, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
      if (m !== null) add(`${name} → ${m[1]}`, m[2]);
    }
  }
  // **本机身份**：用户名、家目录、源码根路径。
  // 这些不是"密钥"，但一样不该出现在公开仓库里；而且它们是从系统读来的，
  // 不需要手打 —— 手打标识符正是上次漏掉工作区 id 的原因。
  const user = process.env.USERNAME ?? process.env.USER ?? '';
  if (user.length >= 3) add('本机用户名', user);
  add('本机家目录', homedir());
  add('源码根路径', ROOT);
  // 去重
  const seen = new Set();
  return found.filter(({ value }) => (seen.has(value) ? false : seen.add(value)));
}

/** 通用密钥形态。这些不是"我的 key"，但同样不该出现在公开仓库里。 */
const SECRET_PATTERNS = [
  ['OpenAI/DeepSeek 风格 key', /\bsk-[A-Za-z0-9_-]{16,}/g],
  ['GitHub classic token', /\bghp_[A-Za-z0-9]{20,}/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ['GitHub OAuth token', /\bgho_[A-Za-z0-9]{20,}/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['私钥文件头', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['Bearer 长串', /\bBearer\s+[A-Za-z0-9._-]{24,}/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  // 不是密钥，但是**账号相关标识** —— 公开后能把仓库和某个账号关联起来。
  // 本机就是这么漏出去过一次（OpenCode 工作区 id 写死在控制台深链里）。
  ['OpenCode 工作区 id', /\bwrk_[A-Za-z0-9]{16,}/g],
  ['Stripe key', /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}/g],
];

/** 个人上下文。不是密钥，但会泄漏"这是谁的机器"。 */
const PRIVACY_PATTERNS = [
  ['Windows 用户目录', /[A-Za-z]:\\Users\\[^\\\s"']+/g],
  ['macOS 用户目录', /\/Users\/[^/\s"']+/g],
  ['Linux 家目录', /\/home\/[^/\s"']+/g],
  ['邮箱地址', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
];

const redact = (value) => {
  const v = String(value);
  if (v.length <= 10) return v[0] + '***';
  return `${v.slice(0, 4)}***${v.slice(-3)} (长度 ${v.length})`;
};

/** PNG 的 tEXt / iTXt / zTXt 块可能嵌着生成服务写入的提示词或账号信息。 */
function pngTextChunks(buf) {
  const out = [];
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return out;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (offset + 12 + length > buf.length) break;
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const body = buf.subarray(offset + 8, offset + 8 + Math.min(length, 400));
      out.push(`${type}: ${body.toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, ' ').trim().slice(0, 160)}`);
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

const secrets = knownSecrets();
console.log(`扫描目录: ${relative(ROOT, TARGET) || TARGET}`);
console.log(`本机已知密钥: ${secrets.length} 条（${secrets.map((s) => s.label).join('、') || '无'}）`);
console.log('命中时只显示打码后的片段。\n');

const findings = [];
let scanned = 0;
let bytes = 0;

for (const abs of walk(TARGET)) {
  const rel = relative(TARGET, abs).replace(/\\/g, '/');
  const size = statSync(abs).size;
  scanned += 1;
  bytes += size;

  const buf = readFileSync(abs);
  // 只把看起来是文本的文件按 utf8 解释，避免把二进制当文本搜出一堆垃圾
  const isText = /\.(js|mjs|cjs|json|md|yml|yaml|txt|html|css|gitignore|ps1)$/i.test(rel)
    || rel === '.gitignore';
  const text = isText ? buf.toString('utf8') : '';

  // 第 1 层：真实密钥逐字节比对（二进制也要查 —— 密钥可能被嵌进图里）
  for (const secret of secrets) {
    const needle = Buffer.from(secret.value, 'utf8');
    const at = buf.indexOf(needle);
    if (at >= 0) {
      findings.push({ level: '严重', rel, what: `本机真实密钥：${secret.label}`, sample: redact(secret.value), at });
    }
  }

  // 第 2、3 层：只在文本文件里跑
  if (isText) {
    for (const [label, re] of SECRET_PATTERNS) {
      for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
        findings.push({ level: '严重', rel, what: `疑似密钥（${label}）`, sample: redact(m[0]) });
      }
    }
    for (const [label, re] of PRIVACY_PATTERNS) {
      for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
        findings.push({ level: '注意', rel, what: label, sample: m[0].slice(0, 80) });
      }
    }
  }

  // PNG 元数据
  if (rel.toLowerCase().endsWith('.png')) {
    for (const chunk of pngTextChunks(buf)) {
      findings.push({ level: '注意', rel, what: 'PNG 内嵌文本块', sample: chunk });
    }
  }
}

console.log(`--- 结果 ---`);
console.log(`扫描 ${scanned} 个文件 / ${(bytes / 1048576).toFixed(1)} MB`);
if (findings.length === 0) {
  console.log('\n未发现密钥、个人路径或图片元数据 ✓');
} else {
  console.log('');
  // 同一条问题在多个文件命中时合并展示，避免刷屏
  const grouped = new Map();
  for (const f of findings) {
    const key = `${f.level}|${f.what}|${f.sample}`;
    if (!grouped.has(key)) grouped.set(key, { ...f, files: [f.rel] });
    else grouped.get(key).files.push(f.rel);
  }
  for (const f of grouped.values()) {
    console.log(`[${f.level}] ${f.what}`);
    console.log(`   命中: ${f.sample}`);
    console.log(`   文件: ${f.files.slice(0, 6).join(', ')}${f.files.length > 6 ? ` 等 ${f.files.length} 个` : ''}`);
  }
  const severe = [...grouped.values()].filter((f) => f.level === '严重').length;
  console.log(severe > 0
    ? `\n有 ${severe} 类**严重**问题，先处理再上传。`
    : '\n只有"注意"级别的项（多为本机路径或图片元数据），按需处理。');
}
process.exitCode = findings.some((f) => f.level === '严重') ? 1 : 0;
