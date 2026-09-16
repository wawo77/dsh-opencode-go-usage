/**
 * "这个插件包在别的机器上能不能独立跑" 的纯检查逻辑。
 *
 * 单独成文件是为了没有副作用：tools/pack.mjs 顶层会 process.exit，
 * 被 test/selftest.mjs import 时会误触发；这里只导出函数与常量。
 */
import { PART_NAMES } from '../../lib/rig-geometry.js';

/**
 * 运行时真正会被读取的文件。改 lib/ 或 assets/ 布局时这里要同步 ——
 * 漏掉一个的症状是"界面正常、角色退回静态整图"，在别人的机器上极难排查。
 */
export const RUNTIME_FILES = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/rig-geometry.js',
  // 各套餐的适配器（端点、字段解析都在里面）—— 漏了它插件整个起不来
  'lib/providers.js',
  'assets/pet.png',
  'assets/rig/rig.json',
  'assets/rig/parts/manifest.json',
  'assets/rig/parts/body.png',
  ...PART_NAMES.map((name) => `assets/rig/parts/${name}.png`),
];

/** npm 的 files 语义：目录前缀算覆盖，其余要精确匹配。 */
export function coveredBy(files, file) {
  return files.some((entry) => {
    const clean = entry.replace(/^\.\//, '').replace(/\/$/, '');
    return file === clean || file.startsWith(`${clean}/`);
  });
}

/** 找出 files 字段漏掉的运行时文件。 */
export function checkFilesField(pkg) {
  const missing = RUNTIME_FILES.filter(
    (file) => file !== 'package.json' && !coveredBy(pkg.files ?? [], file),
  );
  return { missing, ok: missing.length === 0 };
}

/**
 * 扫出 lib/ 里指向包外的 import —— 装到别的机器后包目录就是全部，
 * `../../tools/...` 这类引用会直接崩。
 */
export function externalImports(sources) {
  const offenders = [];
  for (const [file, text] of Object.entries(sources)) {
    const specs = [
      ...[...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      const isBuiltin = spec.startsWith('node:');
      const escapesPackage = spec.startsWith('../');
      if (!isBuiltin && (!spec.startsWith('./') || escapesPackage)) {
        offenders.push(`${file} → ${spec}`);
      }
    }
  }
  return offenders;
}
