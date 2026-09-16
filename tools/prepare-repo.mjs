/**
 * 把仓库内容整理成一个可以直接拖进 GitHub 的文件夹。
 *
 *   node tools/prepare-repo.mjs
 *
 * 产出 dist/github-upload/，同时写出 dist/UPLOAD.md（照抄即可的上传步骤）。
 *
 * 为什么是"文件夹"而不是让用户装 git：这台机器上没有 git、没有 gh、也没有任何
 * GitHub 凭据。GitHub 的网页上传支持直接拖文件夹，所以这条路不需要装任何东西，
 * 也不涉及把 token 交给别人。等哪天装了 git，这个文件夹照样能直接 git init 用。
 *
 * 过滤规则与 .gitignore 保持一致 —— 两边不一致的话，本地提交和网页上传会得到
 * 不同的仓库内容，那种问题很难发现。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT_OF } from './lib/rig-render.mjs';
import { RUNTIME_FILES } from './lib/runtime-files.mjs';

const ROOT = ROOT_OF(import.meta.url);
const OUT = join(ROOT, 'dist', 'github-upload');

/** 目录名或路径片段，命中即跳过。与 .gitignore 一一对应。 */
const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', '.snapshots', '.npm-cache', '.scratch', 'output', 'preview', '.git',
]);
/** 相对路径前缀，命中即跳过（素材管线的中间图）。 */
const EXCLUDE_PREFIXES = [
  'assets/rig/anim/',
];
/** 具体文件名，命中即跳过。 */
const EXCLUDE_FILES = new Set([
  'assets/inspect.png', 'assets/parts-review.png', 'assets/probe-truth.png',
  'assets/probe-in.png', 'assets/segment-preview.png', 'assets/pose-test.png',
  'assets/boundary-zoom.png', 'assets/rig/review.png', 'assets/rig/assembled.png',
  'assets/rig/accessories.png', 'assets/compare.png', 'assets/compare2.png',
  'assets/rig/anim', 'LICENSE.md',
  // 本机专用：引用的是这台机器的路径和重启脚本，对别人没用，还会泄漏路径
  'tools/restart-dsh-and-verify.ps1',
]);

function shouldSkip(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  if (EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) return true;
  if (EXCLUDE_FILES.has(rel)) return true;
  if (/^assets\/(compare|probe)/.test(rel) && rel.endsWith('.png')) return true;
  return false;
}

function collect(dir, rel = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (shouldSkip(childRel)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs, childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
}

// ---------- 重建输出目录 ----------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const files = collect(ROOT);
for (const rel of files) {
  const dest = join(OUT, rel);
  mkdirSync(join(dest, '..'), { recursive: true });
  cpSync(join(ROOT, rel), dest);
}

// ---------- LICENSE ----------
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const year = new Date().getFullYear();
const license = `MIT License

Copyright (c) ${year} ${pkg.name} contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
writeFileSync(join(OUT, 'LICENSE'), license, 'utf8');

// ---------- 核对：运行时文件一个都不能少 ----------
const missing = RUNTIME_FILES.filter((rel) => rel !== 'package.json' && !existsSync(join(OUT, rel)));
if (missing.length > 0) {
  console.error('运行时文件没被复制进去：');
  for (const rel of missing) console.error(`  ${rel}`);
  process.exit(1);
}

// ---------- 统计 ----------
let total = 0;
const all = collect(OUT);
for (const rel of all) total += statSync(join(OUT, rel)).size;

const UPLOAD = `# 上传到 GitHub（不需要装 git）

准备好的内容在 **\`dist/github-upload/\`**，共 ${all.length} 个文件、${(total / 1048576).toFixed(1)} MB。

## 步骤

1. 打开 https://github.com/new
2. **Repository name** 填 \`${pkg.name}\`
3. 选 **Public**（要给别人下载就必须是公开的）
4. **不要**勾 "Add a README file"（我们已经有了，勾了会冲突）
5. 点 **Create repository**
6. 在新仓库页面点 **uploading an existing file**（或直接访问
   \`https://github.com/<你的用户名>/${pkg.name}/upload/main\`）
7. 打开 \`dist\\github-upload\`，**全选里面的内容**（Ctrl+A），拖进网页的上传区
   - 注意是拖**文件夹里面的东西**，不是把 \`github-upload\` 这个文件夹本身拖进去，
     否则仓库里会多一层目录
8. 下面的 Commit changes 写一句说明，点 **Commit changes**

## 别人怎么装

\`\`\`powershell
dsh plugin --profile web add "github:<你的用户名>/${pkg.name}"
\`\`\`

装完在 \`~/.dsh/profiles/web/package.json\` 的 \`dsh.profile.bundles\` 里确认有
\`"${pkg.name}"\`，然后重启 \`dsh web\`。

> 这就是你 profile 里 \`@loserfox/distill\` 用的同一种方式
> (\`github:LoserFox/distill#<sha>\`)，所以这条路是验证过的。

## 以后想用 git 管理

装了 git 之后，在 \`dist/github-upload\` 里：

\`\`\`powershell
git init
git add .
git commit -m "初始提交"
git branch -M main
git remote add origin https://github.com/<你的用户名>/${pkg.name}.git
git push -u origin main
\`\`\`

推送时浏览器会弹登录窗口，凭据由 Windows 凭据管理器保存。
`;

writeFileSync(join(ROOT, 'dist', 'UPLOAD.md'), UPLOAD, 'utf8');

console.log(`准备完成：dist/github-upload/  ${all.length} 个文件  ${(total / 1048576).toFixed(1)} MB`);
console.log(`上传步骤：dist/UPLOAD.md`);
console.log('\n最大的几个文件：');
const big = all.map((rel) => ({ rel, size: statSync(join(OUT, rel)).size }))
  .sort((a, b) => b.size - a.size).slice(0, 8);
for (const { rel, size } of big) console.log(`  ${(size / 1048576).toFixed(2).padStart(6)} MB  ${rel}`);
console.log('\n运行时必需文件已全部就位 ✓');
