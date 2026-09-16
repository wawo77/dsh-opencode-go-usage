/**
 * 打包：产出一个可以拷到别的机器上安装的插件包。
 *
 *   node tools/pack.mjs              校验 files 清单 + 生成 dist/INSTALL.md
 *   node tools/pack.mjs --verify     额外核对 dist/pack-manifest.json（npm pack 的产物清单）
 *
 * 为什么单独的打包步骤值得存在：这个插件**静默降级**。少了 assets/rig/parts 里的
 * 任何一张部件图，宿主照常启动、界面照常显示，只是角色退回静态整图 ——
 * 在另一台机器上极难排查。所以这里在打包前就把"运行时必需文件是否都被 files
 * 覆盖"和"打出来的包里是否真的含有它们"都验一遍。
 *
 * npm pack 由外部命令执行（Node 在沙箱里捕获子进程管道会 EPERM），流程：
 *   npm pack --json --pack-destination dist > dist/pack-manifest.json
 *   node tools/pack.mjs --verify
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_OF } from './lib/rig-render.mjs';
import { PART_NAMES } from '../lib/rig-geometry.js';
import { RUNTIME_FILES, coveredBy, checkFilesField, externalImports } from './lib/runtime-files.mjs';

const ROOT = ROOT_OF(import.meta.url);
const DIST = join(ROOT, 'dist');

export { RUNTIME_FILES, coveredBy, checkFilesField };

function human(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const { missing, ok } = checkFilesField(pkg);

console.log(`插件 ${pkg.name} v${pkg.version}`);
console.log('\n--- 运行时必需文件 ---');
let total = 0;
for (const file of RUNTIME_FILES) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) {
    console.log(`  缺失!  ${file}`);
    continue;
  }
  const size = statSync(abs).size;
  total += size;
  const covered = file === 'package.json' || coveredBy(pkg.files, file);
  console.log(`  ${covered ? 'ok  ' : '漏! '} ${String(size).padStart(9)}  ${file}`);
}
console.log(`  合计 ${human(total)}`);

if (!ok) {
  console.error(`\npackage.json 的 files 漏了 ${missing.length} 个文件：`);
  for (const file of missing) console.error(`  ${file}`);
  console.error('照这样打包，对面机器上的角色会静默退回静态整图。');
  process.exit(1);
}
console.log('\nfiles 清单覆盖了全部运行时文件。');

// ---------- 自包含检查：lib/ 不能引用包外的东西 ----------
// 安装到别的机器后，包目录就是全部 —— 引用 ../../tools 之类的相对路径会直接崩。
const libSources = {};
for (const file of RUNTIME_FILES.filter((f) => f.startsWith('lib/') && f.endsWith('.js'))) {
  libSources[file] = readFileSync(join(ROOT, file), 'utf8');
}
const offenders = externalImports(libSources);
console.log('\n--- 自包含检查（lib/ 的外部依赖）---');
if (offenders.length === 0) {
  console.log('  只依赖 node: 内置模块与 lib/ 内的同级文件，无外部依赖 ✓');
} else {
  console.log('  发现包外引用（装到别的机器会崩）：');
  for (const line of offenders) console.log(`    ${line}`);
  process.exit(1);
}

// ---------- 核对 npm pack 的实际产物 ----------
const manifestPath = join(DIST, 'pack-manifest.json');
if (process.argv.includes('--verify')) {
  if (!existsSync(manifestPath)) {
    console.error(`\n找不到 ${manifestPath} —— 先跑：npm pack --json --pack-destination dist > dist/pack-manifest.json`);
    process.exit(1);
  }
  const raw = readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw.slice(raw.indexOf('[')));
  const entry = parsed[0];
  const packed = new Set(entry.files.map((f) => f.path.replace(/^package\//, '')));
  console.log(`\n--- npm pack 产物 ${entry.filename}（${human(entry.size)}，${entry.files.length} 个文件）---`);
  let bad = 0;
  for (const file of RUNTIME_FILES) {
    if (file === 'package.json') continue;
    if (!packed.has(file)) {
      console.log(`  不在包里!  ${file}`);
      bad += 1;
    }
  }
  for (const name of ['rig.json', 'parts/manifest.json', ...PART_NAMES.map((n) => `parts/${n}.png`), 'parts/body.png']) {
    if (![...packed].some((p) => p.startsWith(`assets/rig/`))) break;
  }
  // 顺便报告包里有哪些多余的东西，避免把开发素材一起发出去
  const extra = [...packed].filter((p) => !RUNTIME_FILES.includes(p) && p !== 'README.md');
  if (extra.length > 0) {
    console.log(`  包里另有 ${extra.length} 个非运行时文件（README 等，正常）：`);
    for (const p of extra.slice(0, 12)) console.log(`    ${p}`);
  }
  console.log(bad === 0
    ? '  全部运行时文件都在包里 ✓'
    : `  有 ${bad} 个运行时文件没进包 ✗`);
  if (bad > 0) process.exit(1);
}

// ---------- 生成安装说明 ----------
const tarball = `${pkg.name}-${pkg.version}.tgz`;
const install = `# ${pkg.name} v${pkg.version} —— 安装到另一台机器的 DSH

## 需要什么

- 目标机器上已经装好 **DSH**，并且能正常使用 **OpenCode Go**（本插件读的是
  DSH 已配置的凭据：credentials 服务 → \`~/.dsh/.credentials.yaml\` → 环境变量
  \`OPENCODE_GO_API_KEY\`。能正常用 Go 就已经配好了，无需额外设置）。
- 包本体：\`${tarball}\`（约 ${human(total)}）。

## 安装

1. 把 \`${tarball}\` 拷到目标机器，放到一个**路径不含空格**的目录里。

   > 路径含空格会让 pnpm 解析 \`link:\` 时把路径拆断（\`ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST\`）。
   > 装 tarball 通常不受影响，但放在无空格目录最省事。

2. 安装（\`dsh plugin\` 会转发给 profile 目录里的 pnpm）：

   \`\`\`powershell
   dsh plugin --profile web add "C:/path/to/${tarball}"
   \`\`\`

3. 确认它进了 profile 的 bundle 列表：

   \`\`\`powershell
   dsh --profile web --dump-config | Select-String ${pkg.name}
   \`\`\`

   应当能看到一行 \`{ id: opencode-go-usage, name: ${pkg.name} }\`。
   若没有，在 \`~/.dsh/profiles/web/package.json\` 的 \`dsh.profile.bundles\`
   数组里补上 \`"${pkg.name}"\`。

4. 重启 DSH Web：

   \`\`\`powershell
   # 关掉当前 dsh web，然后重新启动
   dsh web
   \`\`\`

5. 打开页面，左下角应当出现桌宠。点它会展开用量卡片。

## 自检

包内自带测试（需要 \`tools/\`，安装包里没有；只有源码目录才有）：

\`\`\`powershell
node test/selftest.mjs            # 42 项静态检查，不需要运行中的宿主
node test/verify-installed.mjs    # 实机检查，需要 dsh web 在跑
\`\`\`

## 卸载

\`\`\`powershell
dsh plugin --profile web remove ${pkg.name}
\`\`\`

然后在 \`~/.dsh/profiles/web/package.json\` 的 \`dsh.profile.bundles\` 里删掉对应项，重启。

## 数据放在哪

插件自身不写任何文件到包目录。运行期数据在目标机器的：

- \`~/.dsh/opencode-go-usage/state.json\` —— 宠物位置与大小
- \`~/.dsh/opencode-go-usage/ledger.json\` —— 本地 token 账本（保留 32 天）

**这两份不会随包带走**，所以新机器上"今日 token"从 0 开始累积，宠物位置是默认值。
这是有意的：账本记的是本机经 DSH 的调用。

## 从源码安装（想在另一台机器上继续改）

把整个源码目录拷过去（注意排除 \`dist/\`、\`.snapshots/\`、\`node_modules/\`），然后：

\`\`\`powershell
# 放到无空格路径，再用 link: 安装
dsh plugin --profile web add "link:C:/path/to/dsh-opencode-go-usage"
\`\`\`

源码目录还需要 \`assets/source/\` 与 \`assets/rig/\` 里的原图，重建素材的工具
（\`tools/build-rig.mjs\` 等）才能用；只安装使用则不需要。
`;

mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'INSTALL.md'), install, 'utf8');
console.log(`\n写出 dist/INSTALL.md`);
console.log('\n下一步：');
console.log(`  npm pack --json --pack-destination dist > dist/pack-manifest.json`);
console.log(`  node tools/pack.mjs --verify`);
