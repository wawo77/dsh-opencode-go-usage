# dsh-opencode-go-usage

DSH Web GUI 的 **桌宠用量小窗**，角色叫 **蓝色大肥鱼**。

左下角常驻一个角色。**不点它的时候**，头顶气泡显示用量（套餐制显示百分比、按量计费显示余额），数字按状态变色。**点一下**：角色 Q 弹地压扁→弹起→回弹，响起小黄鸭的"吱"声，说一句跟当前用量相配的台词，同时展开详情卡片。**在角色上滚轮**可以缩放，每变一档响一声"啵"。可以拖着搬家；贴左半屏时角色会转身朝右，贴右半屏朝左。

## 安装

```powershell
dsh plugin --profile web add "github:wawo77/dsh-opencode-go-usage"
```

装完确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里有
`"dsh-opencode-go-usage"`，然后重启 `dsh web`。

> **不需要本机装 git。** pnpm 会直接取 GitHub 的 tarball —— 实测在没装 git 的
> Windows 上，`github:` 形式的依赖（如 `@loserfox/distill`）能正常装成。
> 安装会把整个仓库拉下来（约 19 MB，含素材与开发工具链）。
>
> 万一取不到，可以点 **Code → Download ZIP**，解压到**路径不含空格**的目录，然后：
>
> ```powershell
> dsh plugin --profile web add "link:C:/path/to/dsh-opencode-go-usage"
> ```
>
> 路径含空格会让 pnpm 把 `link:` 拆断（`ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST`）。

## 它显示什么

按 DSH 里配置的套餐**自动匹配适配器**，气泡第一行是**用量百分比**，
第二行是**今日 token**；适配器失败时降级到本地统计，不会空着也不会报红。

| 套餐 | 主指标（气泡第一行） | 余额 | 额外窗口 |
|---|---|---|---|
| OpenCode Go | ✅ 5 小时 / 1 周 / 1 个月百分比 | — | — |
| Command Code（GOAT / Go / Pro / Max …） | ✅ 本期百分比 | ✅ 月度 / 加购 / 赠送 | ✅ `windowLimits` |
| DeepSeek 官方 API | ✅ **余额**（按量计费，没有配额百分比） | ✅ 充值 / 赠送 | — |

按量计费的钱包**没有"本期用了百分之多少"**这回事，硬算一个只会误导，所以气泡改成直接显示余额。
余额为负或账户不可用时数字染红，余额偏低染琥珀；其余跟随正文色。

## 交互

左下角常驻这个角色。**不点它的时候**，头顶气泡显示**用量百分比**，数字按用量变色（绿 / 琥珀 / 红）。**点一下**：角色 Q 弹地压扁→弹起→回弹，响起小黄鸭的"吱"声，说一句跟当前用量相配的台词，同时展开详情卡片。**在角色上滚轮**可以缩放，每变一档响一声"啵"（圆润的合成音，已限流，连滚不会变成机关枪）。可以拖着搬家。

---

## 交互一览

| 操作 | 反应 |
|---|---|
| 什么都不做 | 角色缓慢呼吸起伏；气泡持续显示 5 小时百分比 |
| 鼠标悬停 | 角色轻轻抬起 |
| 点一下角色 | Q 弹动画（含地面阴影同步缩放）+ 一句台词 + 展开详情卡片 |
| 卡片开着时再点 | 换一句吐槽（「别戳啦，痒！」），卡片保持打开 |
| 点卡片外的空白 | 卡片收起，气泡说一句告别语 |
| 按住拖动 | 角色跟随，松手记住位置；拖动中不会误触发点击 |
| **在角色上滚动滚轮** | **放大 / 缩小（90–260px），松手记住；卡片底部也有 −/＋ 按钮** |
| 跨过 50% / 80% 阈值 | 角色**主动**说一句提醒（不打断你刚触发的台词） |
| 键盘 | Tab 聚焦后 Enter / 空格 = 点一下，Esc = 收起卡片 |

台词的语气跟着用量走（由 5 小时百分比决定），不是纯随机：宽裕时夸自己省、过半时提醒你悠着点、快超限时喊救命。每句都配一个颜文字。

如果精灵图加载失败（文件缺失 / 路由异常），会退化成一颗带颜文字的渐变圆球，功能完全不变。

> **看到渐变圆球而不是角色 = 精灵图没加载出来。** 最常见原因是宿主进程还在跑旧代码（payload 里没有精灵图地址，客户端去请求一个旧宿主没有的路由 → 404 → 兜底占位）。`node test/verify-installed.mjs` 里 `GET the sprite is 200` 那条过了就说明宿主是新的；不过就重启一次 `dsh web` 的事。

---

## 数据从哪来

用量由**套餐适配器**提供（`lib/providers.js`）。宿主读 DSH settings 里
`agent-default-model` 指向的 provider，按 id 或 baseURL 匹配一个适配器，
由它负责取数与归一；匹配不到就退回本地统计（**这不是错误**）。

| 套餐 | 官方百分比 | 余额 | 额外窗口 |
|---|---|---|---|
| OpenCode Go | ✅ 5 小时 / 1 周 / 1 个月 | — | — |
| Command Code（GOAT / Go / Pro / Max …） | ✅ 本期（由 credits 算出） | ✅ 月度 / 加购 / 赠送 | ✅ `windowLimits` |

气泡第一行永远是**用量百分比**（适配器说了算，客户端不写死窗口名），
第二行是今日 token。加一家新套餐 = 加一个适配器，主模块不用改。

用 `node tools/probe-providers.mjs --provider <id>` 可以在**有 key 的机器**上
直接验证某家适配器还通不通 —— 未公开接口改字段时，这是最快的定位手段。

### 1. OpenCode Go：官方百分比（权威）

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
```

返回的就是官网控制台那三个数字：

```json
{ "usage": {
    "rolling": { "percent": 7, "resetsAt": "..." },
    "weekly":  { "percent": 3, "resetsAt": "..." },
    "monthly": { "percent": 1, "resetsAt": "..." } } }
```

- 探测在**宿主进程**里跑，API key 只在宿主侧解析，永远不进浏览器。
- 凭证解析顺序：`credentials` 服务的 `llm-pi-ai/<路由>` 记录 → 该路由配置的 `apiKeyEnv` → 进程环境变量 → `~/.dsh/.credentials.yaml`。
- 路由自动发现：凡是 `baseURL` 命中 `opencode.ai/zen/go` 或 id 以 `opencode` 开头的 provider 都算 Go 路由，优先选 `agent-default-model` 当前指定的那个。所以 `opencode-go` 和自定义的 `opencode-go-v41` 都能用。
- `percent` 为 0 时接口给的是占位重置时间，插件会丢弃它，卡片显示「尚未开始计时」。

### 2. 本地估算金额（DSH 自己的账）

订阅 `session/event`，在 `assistant/message` 事件里取 `usage`，按分钟聚合成带时间戳的本地账本，再用 Go 官方价目表（含 DeepSeek 系列的峰谷价）折算出滚动 5 小时 / 1 周 / 1 个月的花费。

**它和官方百分比口径不同，卡片里也标了：**

| | 官方百分比 | 本地估算 |
|---|---|---|
| 覆盖范围 | 整个订阅（含 opencode CLI 等其它客户端） | **只统计经过 DSH 的调用** |
| 精度 | 权威 | 估算：价目表假设 + 本地记账 |
| 窗口 | 服务端的 rolling / 周界 / 订阅周年 | 用服务端 `resetsAt` 反推同一窗口 |

> Go 的额度上限是**按模型**定的（$15 / $30 / $60 不等），接口返回的是订阅整体百分比，因此**无法反推出唯一的美元金额**——这正是需要本地估算的原因。

三个窗口都**锚定服务端的 `resetsAt` 反推窗口起点**，包括那个 `rolling`——它是收在 `resetsAt` 的固定 5 小时桶，不是滑动窗口。按「此刻减 5 小时」求和会把服务端早已丢弃的调用算进来，让本地估算高于官方百分比。只有服务端没给可用时间（percent 为 0）时才退回滚动口径。

峰谷价：DeepSeek 系列在 UTC 周一至周五 `01:00–04:00` 与 `06:00–10:00` 走峰时价，其余（含周末）走谷时价，与官方文档一致。

---

## 图片素材管线

原始插画是**白底、无透明通道**的（主人物图 1536×1152、娘化形象图 2448×3264 / 8.9MB），不能直接当网页桌宠用。本机没有可用的图像工具链，会话模型与 `describe-image` 插件也都看不了图，所以这条管线是自实现的（只用 `node:zlib`）：

```
tools/lib/png.mjs             PNG 解码 / 编码 / 缩放 / 抠图 / 连通域标注 / ASCII 预览
tools/build-assets.mjs        源图 → assets/pet.png（桌宠精灵图）
tools/analyze-components.mjs  连通域分析：判断一张图是单个角色还是角色合集
tools/inspect-png.mjs         元数据 + 透明通道 + 配色 + ASCII 缩略图
```

抠图不是全局白色键，而是**从边框向内的洪泛填充**：一个像素只有同时满足「与把它纳入的前一个像素颜色接近」（跟随渐变背景）和「与背景种子色距离在容差内」（不渗进画面）才被判为背景。这样角色**内部**的白色（高光、眼白、白衣）会被保留，而全局键控会把它们打穿。填充得到的硬蒙版再做一次 3px 盒式羽化，并按 `F = (C - (1-a)·B) / a` 反预乘，避免边缘留一圈白毛边。

裁剪取的是**最大连通域**而不是全部非透明像素的并集——源图带几个游离的小墨点，用并集会把画布撑大、角色缩小。

```powershell
node tools/build-assets.mjs            # 重新生成 assets/pet.png
node tools/build-assets.mjs --dry      # 只打印 ASCII 预览，不写文件
node tools/build-assets.mjs --height 300
```

脚本每次都会打印结果的 ASCII 缩略图（透明通道 + 明度），这就是在没有看图工具的情况下验证抠图有没有把角色抠坏的手段。

素材分工：**主人物图 = 桌宠本体**（单个干净角色）；娘化形象图是一整张含 6 个以上角色的合集，暂未使用，源图留在 `assets/source/`。

---

## 安装

插件源码在工作区，但 profile 安装路径不能含空格（pnpm 的 `link:` 协议会被空格拆坏），所以用一个目录联接做中转：

```powershell
# 1. 建立无空格的联接（指向工作区里的源码）
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\plugins" | Out-Null
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\plugins\dsh-opencode-go-usage" `
  -Target "<你的源码目录，路径不要含空格>"

# 2. 装进 web profile
dsh plugin --profile web add "link:$env:USERPROFILE\.dsh\plugins\dsh-opencode-go-usage"

# 3. 重启才生效
dsh web
```

改完源码（含重新生成 `assets/pet.png`）**只要重启 `dsh web`** 即可生效，不需要重新安装（联接指向源码）。

### 卸载 / 回滚

```powershell
dsh plugin --profile web remove dsh-opencode-go-usage
```

profile 的 `package.json` 与 `cordis.patch.yml` 在安装前有备份：`*.bak-oguw`。

---

## 动画：做过一次，回滚了

当前**待机动画是 CSS 的**：角色缓慢呼吸起伏、悬停轻抬、点击 Q 弹（含地面阴影同步反向缩放）、拖动跟手。不说话、不眨眼、头发和尾巴是静止的。

曾按"灵动度越高越好"做过一版**网格形变（mesh warp）**驱动：整张精灵图铺一张 30×38 的网格，头发/尾巴/呆毛各自绕轴心做弹簧摆动、眼睛区域压扁成眨眼、点击与拖动给弹簧注入冲量产生跟随余振。数学写在 `tools/lib/warp.mjs`，可以离线渲染胶片帧肉眼复核（`node tools/render-frames.mjs`）——正是靠这个才发现并修正了"眨眼方向反了"（真实眨眼是上眼皮往下合，原实现把眼睛内容往上堆成了怪异挤压）。

**但这版效果不理想，已整体回滚**，代码不在 `lib/client.js` 里了。留下的是：

- `tools/lib/warp.mjs` + `tools/render-frames.mjs`：形变数学与离线帧渲染器，仍可用、仍是自洽的；
- `tools/markup.mjs` / `tools/inspect-region.mjs`：在精灵图上画网格与候选区域，用来量取部位坐标（当时就是靠它们把呆毛、左右长发、鲸尾、两眼的位置量准的）。

要重新拾起这条路，需要：① 精灵图重新加透明边距（`OGUW_PAD_X=26 OGUW_PAD_Y=14 node tools/build-assets.mjs`）——部件摆动时会采样到画布外，无边距就会拖影；② 把 rig 与渲染器重新接回客户端。当时的结论是：形变本身数学没问题、离线帧也正常，但整体观感不达预期，收益不抵复杂度。

---

## 预览台（不装也能看）

`preview/preview.html` 加载的是**真正的 `lib/client.js` 和真正的 `assets/pet.png`**，只把宿主接口换成模拟数据，用来在没有重启 DSH 的情况下验证外观与交互。

直接用浏览器打开该文件即可。顶部可切换：心情好 / 过半 / 快超限 / 全新周期 / 探测失败 / 明暗主题 / 模拟图挂掉。滚轮缩放和 −/＋ 按钮在这里同样能试。

---

## 自检

```powershell
node test/selftest.mjs          # 28 项，无需网络
node test/live-probe.mjs        # 打真实接口验证解析（只读，只发一个 GET）
node test/verify-installed.mjs  # 针对运行中的实例做端到端验证（只读）
node test/which-bundle.mjs      # 报告宿主当前实际在提供哪一版客户端 bundle（只读）
```

selftest 覆盖：插件契约、补丁行 id、清单声明、bundle 的 loader 契约（含「apply 绝不抛异常」）、精灵图确实是带透明度的合法 RGBA PNG、精灵图路由的 200/404/403 行为、**尺寸的钳制 / 持久化 / 载荷透传（写入走临时目录，绝不碰真实 state.json）**、价目表查表、峰谷时钟、用量解析、路由识别、本地账本过滤、窗口切分与锚定、失败降级、心情阈值、配色阈值、四类文案齐全且颜文字格式正确、倒计时与金额格式化、卡片文本转义。

---

## 文件结构

```
package.json          宿主/浏览器双半区声明（dsh.bundle.patch + dsh.client）
cordis.patch.yml      把插件行插进 web 插件名册
lib/index.js          宿主半区：凭证解析、用量探测、本地账本、HTTP 路由、精灵图路由
lib/client.js         浏览器半区：桌宠、气泡、Q 弹动效、文案、缩放、详情卡片（纯 DOM，零外部模块）
assets/pet.png        桌宠精灵图（322×420，透明底）
assets/source/        两张原始插画（构建输入，不随包发布）
tools/                离线图片管线
preview/preview.html  真实 bundle + 模拟数据的预览台
test/                 自检与验证脚本
```

数据文件（运行时生成）：

```
~/.dsh/opencode-go-usage/state.json    桌宠位置 + 缩放后的高度
~/.dsh/opencode-go-usage/ledger.json   本地逐次调用账本（保留 32 天）
```

---

## HTTP 接口

所有路由都做了 loopback 围栏（socket 地址 + Host 头 + 同源标记），账号用量数据不出本机。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/opencode-go-usage/state` | 桌宠数据；数据过期时在后台触发探测，不阻塞响应 |
| POST | `/api/opencode-go-usage/refresh` | 强制探测后返回 |
| POST | `/api/opencode-go-usage/position` | 保存桌宠位置 `{left, bottom}` |
| POST | `/api/opencode-go-usage/size` | 保存桌宠高度 `{size}`，宿主侧钳制到 90–260，垃圾值回退默认 150 |
| GET | `/opencode-go-usage-assets/pet.png` | 桌宠精灵图，每次请求实时读取（重建图片后刷新页面即可，不必重启） |

---

## 已知限制

- `/usage` 是**未公开**接口。官方若改动，卡片底部会显示红色错误行而不是静默失败；官方百分比保留最后一次成功读数（状态点变琥珀色）。
- 本地账本只从**安装之后**开始记，所以 30 天窗口的估算在头一个月里偏低（会随时间补齐）。
- 未收录在价目表里的模型按 DeepSeek V4.1 Flash 的价格估算，并在卡片底部列出模型名提示。
- 缩放范围写死 90–260px（默认 150），上下限由宿主随载荷下发，客户端只照做。
- 娘化形象图里那些姿态各异的角色还没用上；要做「用量高时换个表情」的话，可以从那张合集里切。
