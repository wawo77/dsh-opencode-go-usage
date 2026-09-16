# 开发文档

面向改这个插件的人。用户向的说明在 [README](../README.md)。

## 目录

- [文件结构](#文件结构)
- [架构：套餐适配器](#架构套餐适配器)
- [两种数字的口径](#两种数字的口径)
- [骨骼动画](#骨骼动画)
- [音效](#音效)
- [HTTP 接口](#http-接口)
- [数据文件](#数据文件)
- [自检](#自检)
- [图片素材管线](#图片素材管线)
- [预览台](#预览台)
- [打包与发布](#打包与发布)
- [已知限制](#已知限制)

## 文件结构

```
package.json            宿主/浏览器双半区声明（dsh.bundle.patch + dsh.client）
cordis.patch.yml        把插件行插进 web 插件名册
lib/index.js            宿主半区：凭证解析、用量探测、本地账本、HTTP 路由、素材路由
lib/providers.js        套餐适配器：各家的端点、字段解析、归一化（唯一真值）
lib/rig-geometry.js     骨骼几何：rig.json + 部件清单 → 画布尺寸、轴心、落点
lib/client.js           浏览器半区：桌宠、气泡、动效、音效、缩放、卡片（纯 DOM，零 import）
assets/pet.png          静态整图（部件加载失败时的兜底）
assets/rig/             骨骼素材：rig.json + parts/（body + 四个可动配件）
assets/source/          两张原始插画（构建输入，随仓库发布以便重建素材）
tools/                  离线工具链：素材管线、渲染器、打包、隐私扫描
test/                   自检与实机验证
docs/                   README 用的配图 + 本文档
```

**`lib/` 零外部依赖**——只 import `node:` 内置模块和 lib 内的同级文件。
`tools/pack.mjs` 会校验这一点：装到别的机器后包目录就是全部，
`../../tools/...` 这类引用会直接崩。

浏览器半区不能 `import`（是手写的纯 DOM bundle），所以动画数学与音效合成
**各内联一份**——但那是 `tools/sync-anim.mjs` **生成**的，不是手抄的，
自检会校验两边一致。

## 架构：套餐适配器

宿主读 DSH settings 里 `agent-default-model` 指向的 provider，按 id 或 baseURL
匹配一个适配器，由它负责取数与归一。**主模块不知道任何一家的 URL。**

```
agent-default-model.provider
   ├─ opencode-go   → /zen/go/v1/usage          → kind: quota   （百分比）
   ├─ command-code  → /alpha/billing/credits…   → kind: credits （百分比 + 余额）
   ├─ deepseek      → /user/balance             → kind: balance （余额）
   └─ 不匹配        → 退回本地统计（**这不是错误**）
```

加一家新套餐 = 在 `lib/providers.js` 里加一个适配器并注册，其余不用改。

两个必须守住的点：

1. **匹配不到不是错误。** 用户在用别家套餐很正常，界面给一句中性说明并退回今日 token，
   不要报红。`probe.note` 承载这句话，`probe.error` 只用于"有适配器但探测失败"。
2. **非 2xx 必须抛错。** `fetchJson` 把 HTTP 失败变成异常；悄悄当成空数据会让界面
   显示成 `0%` 而不是"未授权"。

用 `node tools/probe-providers.mjs --provider <id>` 可以在**有 key 的机器**上直接验证
某家适配器还通不通——未公开接口改字段时这是最快的定位手段。

### 各家接口备注

**OpenCode Go**（`/zen/go/v1/usage`，未公开但稳定）：返回 `rolling` / `weekly` / `monthly`
三个百分比，和控制台一致。`percent` 为 0 时接口给的是占位重置时间，插件会丢弃它，
卡片显示「尚未开始计时」。

**Command Code**（`/alpha/*`，未公开）：`whoami?limits=1` 拿 orgId，再并行取
credits / subscriptions，最后按 `currentPeriodStart` 取 usage summary。
百分比算法**照抄 CLI 的 `projectUsageView()`**——自己另发明一套只会和官方界面不一致。
`windowLimits` 的字段名是从 CLI 用量界面反推的，没有真实响应可对照，所以解析写得宽容
（数组/对象两种形态、`cap`/`limit`/`total` 等别名都接，认不出来返回空数组而不是崩）。

**DeepSeek 官方**（`/user/balance`，有文档）：返回 `balance_infos[]`，按币种给
`total_balance` / `granted_balance` / `topped_up_balance`，外加 `is_available`。
按量计费没有配额，所以这个适配器的 `kind` 是 `balance`，`percent` 为 `null`。

## 两种数字的口径

| | 官方数字 | 本地统计 |
|---|---|---|
| 来源 | 套餐方接口 | `session/event` 折叠 |
| 覆盖 | 整个订阅 | 只统计经过 DSH 的调用 |
| 窗口 | 服务端 `resetsAt` | 用同一个 `resetsAt` 反推 |

**三个窗口都锚定服务端的 `resetsAt` 反推起点**，包括 `rolling`——它是收在 `resetsAt`
的固定 5 小时桶，不是滑动窗口。按「此刻减 5 小时」求和会把服务端早已丢弃的调用算进来，
让本地估算高于官方百分比。只有服务端没给可用时间时才退回滚动口径。

峰谷价：DeepSeek 系列在 UTC 周一至周五 `01:00–04:00` 与 `06:00–10:00` 走峰时价，
其余（含周末）走谷时价。

账本记哪些 provider：**Go 路由，或有适配器认领的**。原来只记 Go，于是给 DeepSeek
官方加适配器之后"今日 token"会是空的——界面显示了余额，却说今天一个 token 都没用。

## 骨骼动画

角色由 5 张部件图组成（主体 + 呆毛 + 左右耳 + 尾巴），按 `rig.json` 的落点与轴心装配。
渲染是每帧对每张部件图做仿射变换后合成（网页用 canvas，离线用 `tools/lib/rig-render.mjs`，
两者共享 `lib/rig-geometry.js` 的几何，自检会逐项比对矩阵）。

**循环闭合不是靠对齐关键帧，而是数学恒等**：所有运动都是周期为 6 秒的函数——
呼吸是 `sin(2π·k·t/T)`（k 为整数），"蹦一下""抖一下"用**紧支撑升余弦脉冲**
（支撑区间严格落在 `(0,T)` 内，区间外恒为 0，两端一阶导也为 0）。滞后用
`squashAt(t-lag)` 实现，周期函数的时间平移仍是周期函数。

因此 `t=0` 与 `t=T` 的渲染结果**逐字节相同**（`tools/render-anim.mjs` 会验证），
而循环内 59/59 个中间帧都不同——这一条是防"因为静止所以首尾相同"的假阳性。

> 客户端把时间对 `LOOP_SECONDS` 取模，**永远取不到 t=T**。它经历的是 `t=T⁻ → t=0`，
> 所以真正的接缝条件是「跨越接缝那一步不能比循环内普通相邻帧的步子更大」，
> 自检检查的就是这个。

z 序是**数据驱动的**（`rig.json` 的 `order`），两只耳朵都画在主体之前（藏在头发后）。
右耳的落点比左耳更靠外——右侧头发与蝴蝶结体积更大，同位置下会被挡得更多。
`tools/ear-balance.mjs` 直接数像素来配平两侧露出的量。

> ⚠️ **桌宠贴屏幕左半边时会被水平镜像**，此时屏幕上左边那只耳朵其实是角色的**右耳**。
> 反馈层级问题前先确认镜像状态，否则很容易把两只耳朵改反（改反过一次）。

### 曾经尝试并回滚的方案

按"灵动度越高越好"做过一版**网格形变（mesh warp）**：整张精灵图铺 30×38 网格，
各部位绕轴心做弹簧摆动、眼睛区域压扁成眨眼。数学在 `tools/lib/warp.mjs`，
可离线渲染胶片帧复核（`node tools/render-frames.mjs`）——正是靠它发现并修正了
"眨眼方向反了"（真实眨眼是上眼皮往下合）。

**但整体观感不达预期，已回滚**，代码不在 `lib/client.js` 里。结论是：形变数学没问题、
离线帧也正常，但收益不抵复杂度。留在仓库里的 `warp.mjs` 与 `render-frames.mjs` 仍自洽可用。

## 音效

**合成，不是音频文件**：网上的音效有版权问题，而这个插件是要发给别人用的；
少一个二进制资源也少一处"装到别处丢了"的可能。

关键设计：合成写成**纯采样函数**（`renderDuck` / `renderBoop`），客户端把它灌进
`AudioBuffer` 播放，离线工具（`tools/preview-sounds.mjs`）把同一份采样写成 WAV。
**两边是同一串样本**——写代码的人听不到声音，这个一致性是唯一能验证的东西。

| 音效 | 触发 | 音色 |
|---|---|---|
| 小黄鸭"吱" | 点击角色 | 谐波堆叠 + 带通 → 尖、鼻音 |
| "啵" | 缩放 | 正弦为主 + 低通 → 圆、闷 |

啵刻意做得比鸭子**圆润**（滚动缩放会连响好几次，刺耳的音色连着响很难受），
所以有**限流 120ms** + **轻微随机变调**，并且只在**尺寸真的变了**时才响
（到上下限还继续滚，角色没动却一直响会很怪）。

`AudioContext` 懒建在用户手势里——浏览器要求如此，提前建会被挂起。

## HTTP 接口

所有路由都做了 loopback 围栏（socket 地址 + Host 头 + 同源标记），账号用量数据不出本机。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/opencode-go-usage/state` | 桌宠数据；数据过期时后台触发探测，不阻塞响应 |
| POST | `/api/opencode-go-usage/refresh` | 强制探测后返回 |
| POST | `/api/opencode-go-usage/position` | 保存位置 `{left, bottom}` |
| POST | `/api/opencode-go-usage/size` | 保存高度 `{size}`，宿主侧钳制到 90–260 |
| POST | `/api/opencode-go-usage/sound` | 保存音效开关 `{sound}` |
| GET | `/opencode-go-usage-assets/pet.png` | 静态整图兜底 |
| GET | `/opencode-go-usage-assets/rig/rig.json` | 骨骼落点定义 |
| GET | `/opencode-go-usage-assets/rig/parts/*.png` | 5 张部件图（白名单，路径不拼接） |

素材路由都是**每次请求实时读盘**：重建图片后刷新页面即可，不必重启宿主。

## 数据文件

```
~/.dsh/opencode-go-usage/state.json    位置 + 缩放高度 + 音效开关
~/.dsh/opencode-go-usage/ledger.json   本地调用账本（保留 32 天）
```

两份都**不随包发布**——账本记的是"本机经过 DSH 的调用"，本来就不该跨机器搬。

## 自检

```powershell
node test/selftest.mjs            # 65 项，无需网络、无需运行中的宿主
node test/verify-installed.mjs    # 针对运行中的实例做端到端验证（只读）
node test/live-probe.mjs          # 打真实接口验证解析（只读）
node tools/live-bundle-check.mjs  # 检查浏览器真正拿到的那份 bundle 里有没有某个修复
node tools/privacy-scan.mjs       # 上传前的隐私扫描（带阳性对照）
```

selftest 覆盖：插件契约、补丁行 id、bundle 的 loader 契约（含「apply 绝不抛异常」）、
素材确实是带透明度的合法 RGBA PNG、素材路由的 200/404/403 与路径穿越、
骨骼几何与**客户端矩阵和离线渲染器逐项相等**、循环闭合与接缝、
内联块与源文件一致、适配器匹配与归一化（三家各一组）、余额字段容错、
账本口径、窗口切分与锚定、尺寸钳制/持久化/载荷透传（写入走临时目录，
**绝不碰真实 state.json**）、心情阈值、文案齐全、转义、
以及**发布内容里不得出现账号标识 / 本机路径 / 密钥**。

## 图片素材管线

原始插画是白底无透明通道的，本机没有可用的图像工具链，所以这条管线是
**自实现的（只用 `node:zlib`）**：

```
tools/lib/png.mjs             PNG 解码/编码/缩放/抠图/连通域标注/ASCII 预览
tools/build-assets.mjs        源图 → assets/pet.png
tools/build-rig.mjs           配件图 + 主体图 → assets/rig/parts/*
tools/lib/rig-render.mjs      骨骼渲染器（离线验证用，与网页共享几何）
tools/assemble-rig.mjs        装配预览
tools/ear-balance.mjs         数像素配平两侧耳朵露出的量
tools/compare-rig.mjs         与原画逐行轮廓对比，量出配件缩放
tools/analyze-components.mjs  连通域分析：判断一张图是单个角色还是角色合集
```

抠图不是全局白色键，而是**从边框向内的洪泛填充**：一个像素只有同时满足
「与把它纳入的前一个像素颜色接近」（跟随渐变背景）和「与背景种子色距离在容差内」
（不渗进画面）才被判为背景。这样角色**内部**的白色（高光、眼白、白衣）会被保留，
全局键控会把它们打穿。硬蒙版再做一次羽化，并按 `F = (C-(1-a)·B)/a` 反预乘，
避免边缘留一圈白毛边。

裁剪取**最大连通域**而不是全部非透明像素的并集——源图带几个游离小墨点，
用并集会把画布撑大、角色缩小。

脚本都会打印 ASCII 缩略图，这是在没有看图工具时验证抠图有没有把角色抠坏的手段。

## 预览台

`preview/preview.html` 加载**真正的 `lib/client.js` 和真正的素材**，只把宿主接口换成
模拟数据，用来在不重启 DSH 的情况下验证外观与交互。顶部可切换心情、明暗主题、模拟图挂掉等。

> 该目录**不随仓库发布**（是本机调试用的）。

## 打包与发布

准备上传到 GitHub 的内容：

```powershell
node tools/prepare-repo.mjs     # → dist/github-upload/（拖进 GitHub 即可）
node tools/privacy-scan.mjs     # 上传前必跑
```

发布用的安装包：

```powershell
npm pack --json --pack-destination dist --cache .npm-cache > dist/pack-manifest.json
node tools/pack.mjs --verify
```

`package.json` 的 `files` **必须逐个列到运行时真正会读的文件**。这个插件会**静默降级**
——少了 `assets/rig/parts` 里任何一张部件图，宿主照常启动、界面照常显示，只是角色退回
静态整图。在别人的机器上极难排查，所以 `pack.mjs` 与自检都会校验这份清单。

> **绝不用 PowerShell 的文本 cmdlet 改 UTF-8 源文件。** `Set-Content -Encoding utf8`
> 在 Windows PowerShell 5.1 下会**加 BOM 并把中文按 GBK 重编码**，直接把 `package.json`
> 写坏。用编辑器或让 Node 写（`writeFileSync(..., 'utf8')`）。

## 已知限制

- **未公开接口**：`/zen/go/v1/usage` 与 Command Code 的 `/alpha/*` 都不是官方文档化的接口，
  官方随时可能改。设计上做了降级——探测失败时卡片底部显示红色错误行，官方数字保留
  最后一次成功读数（状态点变琥珀色），不会静默失败。
- 本地账本只从**安装之后**开始记，所以 30 天窗口的估算在头一个月里偏低。
- 未收录在价目表里的模型按 DeepSeek V4.1 Flash 的价格估算，并在卡片底部列出模型名提示。
- 缩放范围写死 90–260px（默认 150），上下限由宿主随载荷下发。
- `assets/source/` 里那张娘化形象图（含 6 个以上角色）还没用上；要做"用量高时换表情"
  可以从那张合集里切。
