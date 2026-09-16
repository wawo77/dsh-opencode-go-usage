# dsh-opencode-go-usage

> DSH Web GUI 的**桌宠用量小窗**。角色叫 **蓝色大肥鱼**。

<img src="docs/pet.png" width="230" align="right" alt="蓝色大肥鱼">

在 DSH 网页界面角落里常驻一只角色，头顶气泡实时显示你的套餐用量——
**不点开任何面板就能一眼看到今天烧了多少**。

- **自动适配你用的套餐**：OpenCode Go、Command Code、DeepSeek 官方，
  按 DSH 里配置的 provider 自动匹配，不用手选
- **套餐制看百分比，按量计费看余额**——不会给钱包硬算一个假的"本期用了百分之多少"
- 骨骼动画：呼吸起伏、每 6 秒蹦一下、耳朵抖、尾巴摆，**循环首尾帧逐字节相同**
- 音效是**现场合成**的（点击"吱"、缩放"啵"），零音频文件、零版权问题
- 会转头：贴屏幕左半边朝右看，贴右半边朝左看
- 可拖动、滚轮缩放（90–260px），偏好存在宿主侧
- **纯本地**：账号数据不出本机，所有 HTTP 路由都有 loopback 围栏

<br clear="right">

## 安装

```powershell
dsh plugin --profile web add "github:wawo77/dsh-opencode-go-usage"
```

装完确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里有
`"dsh-opencode-go-usage"`，然后重启 `dsh web`。

<details>
<summary>取不到？不需要装 git，但有两个备用办法</summary>

**不需要本机装 git。** pnpm 会直接取 GitHub 的 tarball——实测在没装 git 的 Windows 上，
`github:` 形式的依赖能正常装成。安装会把整个仓库拉下来（约 19 MB，含素材与开发工具链）。

万一 `github:` 取不到：点 **Code → Download ZIP**，解压到**路径不含空格**的目录，然后

```powershell
dsh plugin --profile web add "link:C:/path/to/dsh-opencode-go-usage"
```

路径含空格会让 pnpm 把 `link:` 协议拆断（`ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST`）。

卸载：

```powershell
dsh plugin --profile web remove dsh-opencode-go-usage
```

再从 `dsh.profile.bundles` 里删掉对应项，重启。
</details>

## 它显示什么

| 你用的套餐 | 气泡第一行 | 卡片里还有什么 |
|---|---|---|
| **OpenCode Go** | 5 小时配额百分比 | 1 周 / 1 个月进度条、重置倒计时、本地估算金额 |
| **Command Code**（GOAT / Go / Pro / Max…） | 本期用量百分比 | 剩余额度（月度 / 加购 / 赠送）、`windowLimits` 各窗口 |
| **DeepSeek 官方 API** | **账户余额** | 充值 / 赠送拆分、今日 token 与花费 |
| 其它 / 没配 | 今日 token | 今日 token 与花费明细 |

气泡第二行永远是**今日 token**。

按量计费的钱包**没有"本期用了百分之多少"**这回事，硬算一个只会误导，所以那一档直接显示余额：
余额为负或账户不可用时数字**染红**，余额偏低染琥珀，其余跟随正文色。

## 交互

| 操作 | 反应 |
|---|---|
| 什么都不做 | 缓慢呼吸起伏；气泡持续显示用量 |
| 鼠标悬停 | 角色轻轻抬起 |
| **点一下角色** | Q 弹压缩→回弹，响起小黄鸭的"吱"声，说一句话，展开详情卡片 |
| 卡片开着时再点 | 换一句吐槽（「别戳啦，痒！」） |
| 点卡片外空白 | 收起卡片，气泡说句告别语 |
| 按住拖动 | 角色跟随并**转向**，松手记住位置；拖动中不会误触发点击 |
| **在角色上滚轮** | 缩放（90–260px），每变一档响一声"啵"；卡片底部也有 −/＋ |
| 卡片上的 🔊 | 静音 / 开启音效（默认开，偏好存在宿主侧） |
| 跨过 50% / 80% 阈值 | 角色**主动**说一句提醒，不打断你刚触发的台词 |
| 键盘 | Tab 聚焦后 Enter / 空格 = 点一下，Esc = 收起卡片 |

台词的语气跟着用量走，不是纯随机：宽裕时夸自己省、过半时提醒你悠着点、快超限时喊救命。
每句都配一个颜文字。

<img src="docs/animation.png" width="620" alt="一个 6 秒循环里的 8 帧">

## 两种数字的区别

卡片里有两类数字，**口径不同**，卡片自己也标了：

| | 官方数字 | 本地统计 |
|---|---|---|
| 来源 | 套餐方自己的用量接口 | DSH 的 `session/event` |
| 覆盖范围 | **整个订阅**（含其它客户端） | **只统计经过 DSH 的调用** |
| 精度 | 权威 | 估算：价目表假设 + 本地记账 |

所以"官方 32%"和"本地 $6.56"对不上是正常的——它们数的不是同一批调用。

本地金额按 Go 官方价目表折算（含 DeepSeek 系列的峰谷价）。价目表里没有的模型会被列在卡片底部提示。

## 常见问题

**看到一颗 `(・ω・)` 圆球而不是角色？**
角色的部件图没加载出来，插件退回了占位符（功能不受影响）。最常见的原因是宿主进程还在跑旧代码
——重启一次 `dsh web`。要确认，跑 `node test/verify-installed.mjs`，`GET the sprite is 200` 那条过了就是宿主版本没问题。

**气泡显示 `--`？**
还没拿到用量数据。检查该套餐的 key 是否在 DSH 里配好：OpenCode Go 用 `OPENCODE_GO_API_KEY`，
Command Code 用 `COMMAND_CODE_API_KEY` 或 `~/.commandcode/auth.json`，DeepSeek 用 `DEEPSEEK_API_KEY`。

**卡片底部出现红色错误行？**
探测失败了，行里带着具体原因。官方数字会保留最后一次成功读数（状态点变琥珀色）。

**会上传我的用量数据吗？**
不会。探测在**宿主进程**里跑，API key 只在宿主侧解析、永远不进浏览器；所有路由都有 loopback 围栏
（socket 地址 + Host 头 + 同源标记）。唯一的对外请求就是你那家套餐的用量接口。

## 开发

架构、素材管线、自检、HTTP 接口、已知限制都在 **[docs/DEVELOPING.md](docs/DEVELOPING.md)**。

```powershell
node test/selftest.mjs            # 65 项静态检查，不需要网络、不需要运行中的宿主
node test/verify-installed.mjs    # 针对运行中的实例做端到端验证（只读）
```

## License

[MIT](LICENSE)
