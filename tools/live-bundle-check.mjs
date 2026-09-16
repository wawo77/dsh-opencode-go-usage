/**
 * 直接从运行中的 dsh web 取下浏览器真正会拿到的插件 bundle，检查关键代码在不在。
 *
 *   node tools/live-bundle-check.mjs [--token <token>]
 *
 * 校验脚本（test/verify-installed.mjs）只检查 bundle 里有没有某个标记；
 * 这个工具更进一步：把 bundle 里几处**具体行**打出来，用来确认某次修复
 * 真的已经服务到浏览器，而不是"改了文件但没生效"。
 */
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};
const PORT = Number(argOf('--port', 3080));
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = argOf('--token', process.env.DSH_WEB_TOKEN);

if (typeof TOKEN !== 'string' || TOKEN === '') {
  console.error('需要一个 token：--token <token>，或设置 DSH_WEB_TOKEN');
  process.exit(1);
}

/** 要确认存在的片段：[标签, 正则]。 */
const PROBES = [
  ['骨骼渲染器入口', /class="oguw-sprite oguw-rigcanvas"/],
  ['rig 模式 CSS', /\[data-mode="rig"\] \.oguw-breathe\{animation:none\}/],
  ['逐帧绘制函数', /function paintRig\(t\)/],
  ['内联动画块', /const LOOP_SECONDS = \d+/],
  ['rig 描述读取', /function rigDescriptor\(\)/],
  ['启动挂在首次拿文档的分支', /if \(first\) \{[\s\S]{0,400}?startRig\(\)/],
  ['点击弹动压过 hover', /\[data-popping="1"\] \.oguw-pet \.oguw-sprite\{animation:oguw-pop/],
  ['反馈由根节点属性驱动', /ui\.root\.dataset\.popping = '1'/],
  ['朝向镜像层', /class="oguw-breathe"><div class="oguw-facing">/],
  ['朝向按屏幕中线判定', /var onLeft = centerX < window\.innerWidth \/ 2/],
  ['token 格式化', /function formatTokens\(value\)/],
  ['今日 token 口径', /'今日 ' \+ formatTokens\(local\.todayTokens\)/],
  ['气泡里的今日 token', /class="oguw-today"/],
  ['弹动时长由 POP_MS 统一换算', /var popSeconds = \(POP_MS \/ 1000\)/],
  ['没有左右晃动', /^(?![\s\S]*oguw-sway)[\s\S]*$/],
];

const first = await fetch(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' });
const raw = typeof first.headers.getSetCookie === 'function'
  ? first.headers.getSetCookie()
  : [first.headers.get('set-cookie')].filter(Boolean);
const jar = raw.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
console.log(`token 换 cookie: HTTP ${first.status}, cookie ${jar ? '已拿到' : '未拿到'}`);
if (!jar) process.exit(1);

const shell = await fetch(`${BASE}/`, { headers: { cookie: jar } });
const html = await shell.text();
console.log(`shell: HTTP ${shell.status}, ${html.length} 字节`);

const combos = [...new Set(html.match(/\/plugins\/\?\?[^"']*/g) ?? [])];
console.log(`发现 ${combos.length} 个 plugin combo`);

let bundle = null;
let bundleUrl = null;
for (const combo of combos) {
  const url = BASE + combo.replace(/&amp;/g, '&');
  const response = await fetch(url, { headers: { cookie: jar } });
  if (response.status !== 200) continue;
  const text = await response.text();
  if (!text.includes('dsh-opencode-go-usage')) continue;
  bundle = text;
  bundleUrl = url;
  break;
}

if (bundle === null) {
  console.error('没有 combo 含本插件的 bundle —— 插件可能没被 shell 加载');
  process.exit(1);
}
console.log(`bundle: ${bundle.length} 字节  ${bundleUrl.slice(0, 90)}…\n`);

let missing = 0;
for (const [label, pattern] of PROBES) {
  const hit = pattern.test(bundle);
  if (!hit) missing += 1;
  console.log(`  ${hit ? 'ok  ' : 'FAIL'} ${label}`);
}

// 把关键那几行原文打出来，肉眼可核对
console.log('\n--- bundle 里的关键片段 ---');
for (const line of bundle.split('\n')) {
  const t = line.trim();
  if (/^startRig\(\)$/.test(t) || /^if \(first\) \{/.test(t) || /^adoptSprite\(\)$/.test(t)
    || /const LOOP_SECONDS = /.test(t) || /class="oguw-sprite oguw-rigcanvas"/.test(t)) {
    console.log('  ' + t.slice(0, 100));
  }
}

console.log(missing === 0
  ? '\n全部关键片段都在服务出去的 bundle 里。'
  : `\n有 ${missing} 处缺失 —— 服务的是旧客户端，或改动没落盘。`);
process.exit(missing === 0 ? 0 : 1);
