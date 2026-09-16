/**
 * dsh-opencode-go-usage — browser half, desktop-pet edition.
 *
 * The widget is a character illustration pinned to a screen corner. Collapsed,
 * a speech bubble over its head shows the server's 5-hour quota percentage;
 * clicking the character plays a squash-and-stretch bounce, says something
 * cute, and opens the detail card with all three quota windows.
 *
 * Mounted straight onto document.body rather than into a shell slot: the
 * session-scoped slots have no session on the new-conversation screen, which is
 * exactly the page this widget exists for.
 *
 * No framework and no external modules — the module body is plain DOM, so the
 * bundle has no module-graph edges to satisfy. The sprite is the only external
 * resource and it degrades to a drawn face if it cannot load.
 */

window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-usage',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Host route prefix (same origin). */
    var API = '/api/opencode-go-usage'

    /**
     * The pet sprite. The host hands over the authoritative URL in every
     * payload; this default paints immediately on first mount, and the preview
     * harness overrides it through window.__OGUW_SPRITE__.
     */
    var DEFAULT_SPRITE = '/opencode-go-usage-assets/pet.png'

    /** Snapshot poll cadence while the tab is visible. */
    var POLL_MS = 60000

    /** Countdown re-render cadence between polls. */
    var TICK_MS = 20000

    /** How long a spoken line stays up before the bubble returns to the quota. */
    var REACTION_MS = 2800

    /** Movement past this many px counts as a drag, not a click. */
    var DRAG_SLOP = 5

    /** Default on-screen character height, and the fallback adjustable bounds. */
    var DEFAULT_SIZE = 150
    var SIZE_MIN = 90
    var SIZE_MAX = 260
    /** Wheel step per notch, in px of character height. */
    var SIZE_STEP = 8

    /**
     * 点击压缩弹动的时长。CSS 里的动画时长和拆除 class 的定时器都用它，
     * 两边分开写就会出现"动画还没播完就被撤掉"的收尾顿挫。
     */
    var POP_MS = 850

    /**
     * 同一个时长给 CSS 用的字符串形式。之前 CSS 里写的是裸标识符
     * `popSeconds`，但文件里只有 `POP_MS` —— 模块级求值直接抛
     * ReferenceError，整个 client 插件加载失败，shell 报“Failed to load plugins”。
     * 这里由 POP_MS 派生，两边不会再有第二个真值来源。
     */
    var popSeconds = (POP_MS / 1000) + 's'

    /** Quota thresholds that switch the mood. */
    var WARN_AT = 50
    var DANGER_AT = 80

    var STYLE_ID = 'opencode-go-usage-style'

    // ---------------------------------------------------------------------
    // Copy
    // ---------------------------------------------------------------------

    /**
     * Spoken lines, keyed by mood. The mood comes from the 5-hour percentage,
     * so the pet's tone tracks how much quota is left instead of being
     * decorative randomness.
     */
    var LINES = {
      calm: [
        '状态超好，随便用～',
        '电量满格，放心造！',
        '今天很省呢，夸夸我',
        '还早得很，慢慢来',
      ],
      warn: [
        '有点热起来了…',
        '过半啦，悠着点哦',
        '要不要喝口水歇一下？',
        '我开始有点紧张了',
      ],
      danger: [
        '快顶不住了！',
        '要见底啦 QAQ',
        '求你了，歇会儿吧',
        '红色警报，省着点用！',
      ],
      unknown: [
        '让我看看用量…',
        '还在读数据哦',
        '稍等一下下～',
      ],
    }

    /** Faces shown above a spoken line, matching the mood. */
    var FACES = {
      calm: ['( ˘ω˘ )', 'ヾ(≧▽≦*)o', '(*・ω・)', '(๑•̀ㅂ•́)و'],
      warn: ['(・_・;)', '(´・ω・`)', '(・ω・)?', '(°ロ°)'],
      danger: ['(>_<)', '(ﾟДﾟ)', '(;´Д`)', '(ノдヽ)'],
      unknown: ['(・ω・)?', '(´・ω・`)'],
    }

    /** Said when the card is dismissed. */
    var FAREWELL = ['那我先歇着～', '随时叫我哦', '拜拜～ (｡･ω･｡)ﾉ', '哼，用完就丢']

    /** Said when the character is poked again while its card is already open. */
    var POKE = ['别戳啦，痒！', '再看也是这个数啦', '好痒好痒 (｡•́︿•̀｡)', '你再戳我要生气了哦']

    /**
     * Said once, unprompted, when the reading crosses a threshold — so a long
     * session gets warned without the user having to open anything.
     */
    var MOOD_ALERT = {
      warn: ['用量过半了，提醒你一下', '过半啦，注意点哦'],
      danger: ['快到限额了！', '红色警报，真的快了'],
      calm: ['用量回落，安全啦', '松口气，退回去了'],
    }

    // ---------------------------------------------------------------------
    // Style
    // ---------------------------------------------------------------------

    // CSS 里的动画时长由 POP_MS 统一换算，免得和 JS 的定时器各写一个数
    var popSeconds = (POP_MS / 1000).toFixed(2) + 's'

    var CSS = [
      // --- shell ---------------------------------------------------------
      '.oguw-root{position:fixed;z-index:2147482000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;line-height:1.45;-webkit-font-smoothing:antialiased;--oguw-pet-h:150px}',
      '.oguw-root[data-theme="dark"]{--oguw-surface:rgba(30,32,38,.95);--oguw-border:rgba(255,255,255,.14);--oguw-text:#e9ebef;--oguw-muted:#9aa1ad;--oguw-track:rgba(255,255,255,.14);--oguw-shadow:0 12px 34px rgba(0,0,0,.5);--oguw-accent:#7f96ff;--oguw-bubble:rgba(38,41,50,.97)}',
      '.oguw-root[data-theme="light"]{--oguw-surface:rgba(255,255,255,.98);--oguw-border:rgba(20,30,60,.13);--oguw-text:#1d2333;--oguw-muted:#6b7280;--oguw-track:rgba(20,30,60,.12);--oguw-shadow:0 12px 34px rgba(30,40,80,.22);--oguw-accent:#4d6bfe;--oguw-bubble:rgba(255,255,255,.99)}',

      // --- character -----------------------------------------------------
      '.oguw-pet{position:relative;display:flex;flex-direction:column;align-items:center;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}',
      '.oguw-root[data-dragging="1"] .oguw-pet{cursor:grabbing}',
      '.oguw-breathe{transform-origin:50% 100%;animation:oguw-breathe 4.2s ease-in-out infinite}',
      '.oguw-root[data-dragging="1"] .oguw-breathe{animation-play-state:paused}',
      '@keyframes oguw-breathe{0%,100%{transform:translateY(0) scale(1,1)}50%{transform:translateY(-3px) scale(1.012,1.02)}}',
      '.oguw-sprite{display:block;height:var(--oguw-pet-h);width:auto;aspect-ratio:322 / 420;transform-origin:50% 100%;-webkit-user-drag:none;filter:drop-shadow(0 6px 14px rgba(20,30,70,.28))}',
      '.oguw-root[data-dragging="1"] .oguw-sprite{filter:drop-shadow(0 14px 20px rgba(20,30,70,.34))}',
      // 骨骼桌宠：canvas 宽度由 JS 按 rig 画布比例写入 --oguw-pet-w
      '.oguw-rigcanvas{width:var(--oguw-pet-w,auto)}',
      '.oguw-rigcanvas{display:none}',
      '.oguw-root[data-mode="rig"] .oguw-rigcanvas{display:block}',
      '.oguw-root[data-mode="rig"] .oguw-flatimg{display:none}',
      // rig 模式下待机动画由骨骼驱动，CSS 呼吸必须让位，否则两套动作叠加
      '.oguw-root[data-mode="rig"] .oguw-breathe{animation:none}',
      '.oguw-shadow{width:calc(var(--oguw-pet-w, 120px) * .60);height:calc(var(--oguw-pet-h) * .085);margin-top:-4px;border-radius:50%;background:radial-gradient(closest-side,rgba(20,30,70,.34),rgba(20,30,70,0));transform-origin:50% 50%;pointer-events:none;opacity:.75}',

      // --- the Q-bounce --------------------------------------------------
      // 注意顺序与特异度：`hover` 那条是 (0,3,0)，比 `.oguw-pop`(0,1,0) 高。
      // 点击时鼠标一定还在角色上，所以只写 `.oguw-pop` 会被 hover 顶掉 ——
      // 表现就是"点了没有压缩弹动，只有一下轻微抬起"。
      // 因此反馈由根节点的 data-popping 驱动，选择器特意写到 (0,4,0) 压过 hover。
      '.oguw-pop{animation:oguw-pop ' + popSeconds + ' cubic-bezier(.22,1.4,.36,1) both}',
      '@keyframes oguw-pop{'
        + '0%{transform:translateY(0) scale(1,1)}'
        + '13%{transform:translateY(2px) scale(1.15,.85)}'
        + '29%{transform:translateY(-17px) scale(.9,1.15)}'
        + '45%{transform:translateY(0) scale(1.085,.925)}'
        + '59%{transform:translateY(-7px) scale(.95,1.06)}'
        + '73%{transform:translateY(0) scale(1.035,.97)}'
        + '85%{transform:translateY(-2px) scale(.99,1.015)}'
        + '100%{transform:translateY(0) scale(1,1)}}',
      '.oguw-shadow-pop{animation:oguw-shadow-pop ' + popSeconds + ' cubic-bezier(.22,1.4,.36,1) both}',
      '@keyframes oguw-shadow-pop{'
        + '0%{transform:scale(1,1);opacity:.75}'
        + '13%{transform:scale(1.19,1);opacity:1}'
        + '29%{transform:scale(.78,.9);opacity:.32}'
        + '45%{transform:scale(1.09,1);opacity:.85}'
        + '59%{transform:scale(.92,.96);opacity:.6}'
        + '100%{transform:scale(1,1);opacity:.75}}',
      '.oguw-pet:hover .oguw-sprite{animation:oguw-hover .5s ease-out both}',
      '@keyframes oguw-hover{0%{transform:translateY(0)}45%{transform:translateY(-6px)}100%{transform:translateY(-3px)}}',
      '.oguw-root[data-popping="1"] .oguw-pet .oguw-sprite{animation:oguw-pop ' + popSeconds + ' cubic-bezier(.22,1.4,.36,1) both}',

      // --- 朝向：贴左半屏朝右、贴右半屏朝左 --------------------------------
      // 角色是正面立绘，只能用水平镜像表达朝向。镜像放在独立的一层上，
      // 这样它和呼吸、弹动的 transform 互不覆盖。
      '.oguw-facing{transform:scaleX(var(--oguw-flip,1));transform-origin:50% 100%;transition:transform .18s ease-out}',

      // --- speech bubble -------------------------------------------------
      '.oguw-bubble{position:absolute;bottom:calc(100% - 4px);left:50%;transform:translateX(-50%);min-width:54px;max-width:190px;padding:5px 11px 6px;border-radius:13px;background:var(--oguw-bubble);border:1px solid var(--oguw-border);box-shadow:var(--oguw-shadow);color:var(--oguw-text);text-align:center;pointer-events:none}',
      '.oguw-bubble::after{content:"";position:absolute;left:50%;bottom:-5px;width:9px;height:9px;margin-left:-4.5px;background:inherit;border-right:1px solid var(--oguw-border);border-bottom:1px solid var(--oguw-border);transform:rotate(45deg);border-radius:0 0 3px 0}',
      '.oguw-quota{display:flex;align-items:baseline;justify-content:center;gap:5px;white-space:nowrap}',
      '.oguw-quota-label{font-size:10px;color:var(--oguw-muted);letter-spacing:.2px}',
      '.oguw-quota-value{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.4px}',
      '.oguw-quota-unit{font-size:11px;font-weight:600;color:var(--oguw-muted)}',
      '.oguw-today{display:block;margin-top:2px;font-size:10px;color:var(--oguw-muted);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.oguw-say{display:block;font-size:11.5px;line-height:1.4;color:var(--oguw-text)}',
      '.oguw-say-face{display:block;font-size:11px;color:var(--oguw-muted);margin-bottom:1px;font-family:ui-monospace,Menlo,Consolas,monospace}',
      '.oguw-bubble-pop{animation:oguw-bubble-pop .42s cubic-bezier(.22,1.5,.36,1) both}',
      '@keyframes oguw-bubble-pop{0%{transform:translateX(-50%) scale(.86)}55%{transform:translateX(-50%) scale(1.07)}100%{transform:translateX(-50%) scale(1)}}',

      // --- fallback face (sprite unavailable) ----------------------------
      '.oguw-fallback{display:none;width:calc(var(--oguw-pet-h) * .66);height:calc(var(--oguw-pet-h) * .66);border-radius:46% 46% 42% 42%;background:linear-gradient(160deg,var(--oguw-accent),#8f7bff);color:#fff;font-size:calc(var(--oguw-pet-h) * .15);align-items:center;justify-content:center;box-shadow:var(--oguw-shadow)}',
      '.oguw-root[data-sprite="missing"] .oguw-sprite{display:none}',
      '.oguw-root[data-sprite="missing"] .oguw-fallback{display:flex}',

      // --- detail card ---------------------------------------------------
      '.oguw-card{position:fixed;width:272px;box-sizing:border-box;padding:13px;border-radius:16px;background:var(--oguw-surface);border:1px solid var(--oguw-border);box-shadow:var(--oguw-shadow);color:var(--oguw-text);backdrop-filter:blur(12px)}',
      '.oguw-card[hidden]{display:none}',
      '.oguw-card-open{animation:oguw-card-open .26s cubic-bezier(.22,1.3,.4,1) both}',
      '@keyframes oguw-card-open{0%{opacity:0;transform:translateY(8px) scale(.97)}100%{opacity:1;transform:none}}',
      '.oguw-head{display:flex;align-items:center;gap:6px;margin-bottom:11px}',
      '.oguw-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#3fb950;box-shadow:0 0 0 3px rgba(63,185,80,.16)}',
      '.oguw-head[data-state="stale"] .oguw-dot{background:#d29922;box-shadow:0 0 0 3px rgba(210,153,34,.18)}',
      '.oguw-head[data-state="error"] .oguw-dot{background:#f85149;box-shadow:0 0 0 3px rgba(248,81,73,.18)}',
      '.oguw-title{font-size:13px;font-weight:650}',
      // 桌宠名字在套餐名上方，小一号、淡一点 —— 它是"角色是谁"，
      // 不是这份数据的主语，不该抢套餐名的位置
      '.oguw-titles{display:flex;flex-direction:column;line-height:1.25;min-width:0}',
      '.oguw-petname{font-size:10px;color:var(--oguw-muted);letter-spacing:.3px}',
      '.oguw-price{color:var(--oguw-muted);font-size:11px}',
      '.oguw-close{margin-left:auto;border:0;background:transparent;color:var(--oguw-muted);font-size:16px;line-height:1;cursor:pointer;padding:0 2px;border-radius:5px}',
      '.oguw-close:hover{color:var(--oguw-text)}',
      '.oguw-row+.oguw-row{margin-top:11px}',
      '.oguw-row-head{display:flex;align-items:baseline;gap:6px;margin-bottom:5px}',
      '.oguw-row-label{color:var(--oguw-muted);font-size:11.5px}',
      '.oguw-row-pct{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums;font-size:13px}',
      '.oguw-bar{height:7px;border-radius:4px;background:var(--oguw-track);overflow:hidden}',
      '.oguw-bar>i{display:block;height:100%;border-radius:4px;transition:width .45s cubic-bezier(.3,1,.4,1),background .3s ease}',
      '.oguw-row-foot{display:flex;gap:8px;margin-top:4px;color:var(--oguw-muted);font-size:10.5px}',
      '.oguw-row-foot span:last-child{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.oguw-foot{display:flex;align-items:center;gap:8px;margin-top:13px;padding-top:10px;border-top:1px solid var(--oguw-border);color:var(--oguw-muted);font-size:10.5px}',
      '.oguw-note{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.oguw-note[data-tone="error"]{color:#f85149}',
      '.oguw-btn{border:1px solid var(--oguw-border);background:transparent;color:var(--oguw-text);font:inherit;font-size:10.5px;padding:3px 9px;border-radius:7px;cursor:pointer;flex:none}',
      '.oguw-btn:hover{border-color:var(--oguw-accent)}',
      '.oguw-btn[disabled]{opacity:.5;cursor:default}',
      '.oguw-sizegroup{display:inline-flex;gap:3px;flex:none}',
      '.oguw-sizegroup .oguw-btn{min-width:24px;padding:3px 6px;text-align:center;line-height:1.2}',
      '.oguw-console{color:inherit;text-decoration:none;border-bottom:1px dotted currentColor;flex:none}',
      '.oguw-console:hover{color:var(--oguw-accent)}',
    ].join('')

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    var ui = null
    var snapshot = null
    var expanded = false
    var dragging = false
    var unmounted = false
    var pollTimer = null
    var tickTimer = null
    var sayTimer = null
    var popTimer = null
    /** Debounce for scroll-wheel resizing, so a gesture writes the state once. */
    var sizeTimer = null
    /** Mood of the last rendered reading, so a threshold crossing can speak up. */
    var lastMood = null
    /** Whether a spoken line currently occupies the bubble. */
    var speaking = false

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /** The character's current on-screen height in px. */
    function currentSize() {
      if (ui === null) return DEFAULT_SIZE
      var raw = parseFloat(ui.root.style.getPropertyValue('--oguw-pet-h'))
      return isFinite(raw) ? raw : DEFAULT_SIZE
    }

    /** The sprite URL in force (the preview harness may override it). */
    function spriteUrl() {
      if (typeof window.__OGUW_SPRITE__ === 'string' && window.__OGUW_SPRITE__ !== '') return window.__OGUW_SPRITE__
      if (snapshot !== null && snapshot.pet && typeof snapshot.pet.spriteUrl === 'string') return snapshot.pet.spriteUrl
      return DEFAULT_SPRITE
    }

    /** Inject the stylesheet once per page. */
    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Whether the page currently renders a dark palette. */
    function detectTheme() {
      var html = document.documentElement
      var marks = [html.className, html.getAttribute('data-theme'), html.getAttribute('data-color-scheme'), html.getAttribute('data-mode')].join(' ')
      if (/dark/i.test(marks)) return 'dark'
      if (/light/i.test(marks)) return 'light'
      try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      } catch (error) {
        return 'dark'
      }
    }

    /** Traffic-light colour for a percentage. */
    function colorFor(percent) {
      if (percent === null || percent === undefined) return '#8b949e'
      if (percent >= DANGER_AT) return '#f85149'
      if (percent >= WARN_AT) return '#d29922'
      return '#3fb950'
    }

    /** Mood bucket for a percentage. */
    function moodFor(percent) {
      if (percent === null || percent === undefined) return 'unknown'
      if (percent >= DANGER_AT) return 'danger'
      if (percent >= WARN_AT) return 'warn'
      return 'calm'
    }

    /** A random element of a list. */
    function pick(list) {
      return list[Math.floor(Math.random() * list.length)]
    }

    /** Human countdown to a reset instant. */
    function countdown(iso) {
      if (typeof iso !== 'string' || iso === '') return '尚未开始计时'
      var ms = Date.parse(iso) - Date.now()
      if (!isFinite(ms)) return ''
      if (ms <= 0) return '已到重置时刻'
      var totalMinutes = Math.floor(ms / 60000)
      var days = Math.floor(totalMinutes / 1440)
      var hours = Math.floor((totalMinutes % 1440) / 60)
      var minutes = totalMinutes % 60
      if (days > 0) return days + ' 天 ' + hours + ' 小时后重置'
      if (hours > 0) return hours + ' 小时 ' + minutes + ' 分后重置'
      return minutes + ' 分钟后重置'
    }

    /** USD caption, or a dash when nothing was recorded. */
    function money(value) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '本地 ≈ $0'
      if (value < 0.01) return '本地 ≈ <$0.01'
      return '本地 ≈ $' + value.toFixed(2)
    }

    /**
     * Token 计数。用量动辄百万级，卡片上放不下全数字，
     * 所以按 K/M 缩写取三位有效数字；不足一千的照实显示。
     */
    function formatTokens(value) {
      var n = Number(value)
      if (!isFinite(n) || n <= 0) return '0'
      if (n < 1000) return String(Math.round(n))
      if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'K'
      return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M'
    }

    /** Minimal HTML escaping for interpolated card values. */
    function escapeHtml(value) {
      return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }

    /** Same-origin JSON call. */
    function apiFetch(path, method) {
      return fetch(path, {
        method: method || 'GET',
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
    }

    /**
     * 气泡第一行的主指标。宿主按"哪家套餐"给出 `primary`，有两种形态：
     *   { kind:'percent', label, percent }  —— 套餐制（Go 是 5 小时，Command Code 是本期）
     *   { kind:'balance', balance }         —— 按量计费的钱包（DeepSeek 官方）
     * 客户端不写死窗口 key，换套餐时不该跟着改。
     */
    function primaryReading() {
      if (snapshot === null) return { kind: 'percent', label: '5 小时', percent: null }
      var primary = snapshot.primary
      if (primary && primary.kind === 'balance' && primary.balance) {
        return { kind: 'balance', label: primary.label || '余额', balance: primary.balance }
      }
      if (primary && typeof primary.percent === 'number') {
        return {
          kind: 'percent',
          label: typeof primary.label === 'string' && primary.label !== '' ? primary.label : '用量',
          percent: primary.percent,
        }
      }
      var windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
      for (var index = 0; index < windows.length; index += 1) {
        if (windows[index].key === '5h') {
          return {
            kind: 'percent',
            label: typeof windows[index].label === 'string' ? windows[index].label : '5 小时',
            percent: typeof windows[index].percent === 'number' ? windows[index].percent : null,
          }
        }
      }
      var first = windows[0]
      if (first !== undefined) {
        return {
          kind: 'percent',
          label: typeof first.label === 'string' ? first.label : '用量',
          percent: typeof first.percent === 'number' ? first.percent : null,
        }
      }
      return { kind: 'percent', label: '5 小时', percent: null }
    }

    function primaryPercent() {
      var reading = primaryReading()
      return reading.kind === 'percent' ? reading.percent : null
    }

    /** 金额显示：余额可能很小也可能为负，固定两位小数。 */
    function formatAmount(amount) {
      if (typeof amount !== 'number' || !isFinite(amount)) return '--'
      return amount.toFixed(2)
    }

    /**
     * 余额的颜色。按量计费的钱包没有客观的百分比阈值，
     * 所以这里只标两种真的需要处理的状态：不可用（通常意味着余额为负）与余额偏低。
     * 其余用 inherit 跟随气泡正文色 —— 不编造"用了百分之多少"。
     * 色值与 colorFor 的三档保持一致，免得同一张卡片上出现两套红黄绿。
     */
    function colorForBalance(balance) {
      var total = balance.total
      if (balance.available === false || (typeof total === 'number' && total <= 0)) return '#f85149'
      if (typeof total === 'number' && total < 10) return '#d29922'
      return 'inherit'
    }

    /** 余额对应的情绪，让桌宠说的话跟着状态走，而不是永远"未知用量"。 */
    function moodFromBalance(balance) {
      if (balance.available === false || (typeof balance.total === 'number' && balance.total <= 0)) return 'danger'
      if (typeof balance.total === 'number' && balance.total < 10) return 'warn'
      return 'calm'
    }

    // ---------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------

    /**
     * 今日（本机时区零点起）已经消耗掉的 token。宿主没发这些字段就返回 null —— 
     * 老宿主下气泡少一行，不会显示成 undefined。
     */
    function todayUsage() {
      var local = (snapshot && snapshot.local) || {}
      if (typeof local.todayTokens !== 'number') return null
      return local
    }

    /** 紧凑的 token 计数，用于气泡那一行。 */
    function todayLabel() {
      var local = todayUsage()
      if (local === null || local.todayTokens <= 0) return ''
      return '今日 ' + formatTokens(local.todayTokens) + ' tok'
    }

    /** Paint the primary reading into the bubble (percent or balance). */
    function renderQuota() {
      if (ui === null) return
      var reading = primaryReading()
      var today = todayLabel()
      var head
      var title
      if (reading.kind === 'balance') {
        var balance = reading.balance
        var amount = balance.symbol + formatAmount(balance.total)
        head = '<span class="oguw-quota">'
          + '<span class="oguw-quota-label">' + escapeHtml(reading.label) + '</span>'
          + '<span class="oguw-quota-value" style="color:' + colorForBalance(balance) + '">'
          + escapeHtml(amount) + '</span>'
          + '</span>'
        title = (balance.available === false ? '账户余额不可用（已欠费）' : '账户余额') + ' ' + amount
          + '（充值 ' + balance.symbol + formatAmount(balance.toppedUp)
          + ' / 赠送 ' + balance.symbol + formatAmount(balance.granted) + '）'
      } else {
        var percent = reading.percent
        head = '<span class="oguw-quota">'
          + '<span class="oguw-quota-label">' + escapeHtml(reading.label) + '</span>'
          + '<span class="oguw-quota-value" style="color:' + colorFor(percent) + '">'
          + (percent === null ? '--' : Math.round(percent)) + '</span>'
          + '<span class="oguw-quota-unit">%</span>'
          + '</span>'
        title = percent === null
          ? '还没有拿到用量数据'
          : reading.label + '已用 ' + percent + '%（官方口径）'
      }
      ui.bubble.innerHTML = head
        + (today === '' ? '' : '<span class="oguw-today">' + escapeHtml(today) + '</span>')
      ui.bubble.title = title
        + (today === '' ? '' : '；' + today + '（只统计经过 DSH 的调用）')
        + '，点我看看详情'
    }

    /**
     * 当前情绪。套餐制看百分比，按量计费看余额 —— 否则用 DeepSeek 时
     * 桌宠会永远说"未知用量"那套词。
     */
    function currentMood() {
      var reading = primaryReading()
      if (reading.kind === 'balance') return moodFromBalance(reading.balance)
      return moodFor(reading.percent)
    }

    /** Paint a spoken line into the bubble. */
    function renderSay(face, line) {
      ui.bubble.innerHTML = '<span class="oguw-say-face">' + escapeHtml(face) + '</span>'
        + '<span class="oguw-say">' + escapeHtml(line) + '</span>'
    }

    /** Pop the bubble, restarting the animation if it is already running. */
    function bumpBubble() {
      if (ui === null) return
      ui.bubble.classList.remove('oguw-bubble-pop')
      void ui.bubble.offsetWidth
      ui.bubble.classList.add('oguw-bubble-pop')
    }

    /** Say something for a while, then fall back to the quota reading. */
    function say(mood, line) {
      if (ui === null) return
      speaking = true
      renderSay(pick(FACES[mood] || FACES.unknown), line)
      bumpBubble()
      if (sayTimer !== null) window.clearTimeout(sayTimer)
      sayTimer = window.setTimeout(function () {
        sayTimer = null
        speaking = false
        renderQuota()
      }, REACTION_MS)
    }

    /**
     * 点击反馈（弹一下/晃一下）。
     *
     * 由根节点的 data-popping 驱动，不直接往角色元素上加类：
     * 那样会被 `.oguw-pet:hover .oguw-sprite` 的动画顶掉（它特异度更高，
     * 而点击时鼠标必然还在角色上），表现就是"点了只有轻微抬起、没有压缩弹动"。
     * 这里靠 CSS 里特意写到 (0,4,0) 的选择器压过 hover。
     *
     * 只做竖直方向的压缩-回弹，不加左右晃动 —— 晃动会和"朝向镜像"以及
     * 骨骼待机动画叠在一起，看起来像站不稳。
     */
    function bounce() {
      if (ui === null) return
      delete ui.root.dataset.popping
      void ui.pet.offsetWidth // 强制重排，让动画能被重新触发
      void ui.shadow.offsetWidth
      ui.root.dataset.popping = '1'
      ui.shadow.classList.add('oguw-shadow-pop')
      if (popTimer !== null) window.clearTimeout(popTimer)
      popTimer = window.setTimeout(function () {
        popTimer = null
        if (ui === null) return
        delete ui.root.dataset.popping
        ui.shadow.classList.remove('oguw-shadow-pop')
      }, POP_MS + 40) // 留一点余量，别在动画收尾前把属性撤掉
    }

    /** Render the detail card from the current snapshot. */
    function renderCard() {
      if (ui === null || snapshot === null) return
      var windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
      // 音效开关的图标要跟着宿主存的值走，否则刷新后图标和实际状态会不一致
      renderSoundButton()
      ui.petname.textContent = petName()
      ui.pet.setAttribute('title', petName() + ' —— 点我看看，拖动可以搬家，滚轮可以调大小')

      var probeState = snapshot.probe === undefined ? 'error'
        : (snapshot.probe.ok ? (snapshot.probe.stale ? 'stale' : 'ok') : 'error')
      ui.head.dataset.state = probeState
      if (snapshot.plan !== undefined) {
        ui.title.textContent = snapshot.plan.name || 'OpenCode Go'
        ui.price.textContent = snapshot.plan.price || ''
        if (typeof snapshot.plan.consoleUrl === 'string' && snapshot.plan.consoleUrl !== '') {
          ui.console.href = snapshot.plan.consoleUrl
        }
      }

      var html = ''
      for (var index = 0; index < windows.length; index += 1) {
        var entry = windows[index]
        var percent = typeof entry.percent === 'number' ? entry.percent : null
        var label = percent === null ? '—' : Math.round(percent) + '%'
        var width = percent === null ? 0 : Math.max(percent, 1.5)
        var local = entry.local || {}
        html += '<div class="oguw-row">'
          + '<div class="oguw-row-head"><span class="oguw-row-label">' + escapeHtml(entry.label) + '</span>'
          + '<span class="oguw-row-pct" style="color:' + colorFor(percent) + '">' + label + '</span></div>'
          + '<div class="oguw-bar"><i style="width:' + width + '%;background:' + colorFor(percent) + '"></i></div>'
          + '<div class="oguw-row-foot"><span>' + escapeHtml(countdown(entry.resetsAt)) + '</span>'
          + '<span>' + escapeHtml(money(local.usd)) + '</span></div>'
          + '</div>'
      }
      ui.rows.innerHTML = html

      if (snapshot.probe && snapshot.probe.error) {
        ui.note.dataset.tone = 'error'
        ui.note.textContent = '探测失败：' + snapshot.probe.error
        ui.note.title = snapshot.probe.error
      } else {
        ui.note.dataset.tone = 'ok'
        var local = snapshot.local || {}
        var unknown = Array.isArray(local.unknownModels) ? local.unknownModels : []
        var parts = []
        // 没有适配器不是错误（用户在用别家套餐），用中性语气说明，
        // 而不是把 probe.note 当成失败信息染红。
        if (typeof snapshot.probe === 'object' && snapshot.probe !== null
          && typeof snapshot.probe.note === 'string' && snapshot.probe.note !== '') {
          parts.push(snapshot.probe.note)
        }
        // credits 类套餐（Command Code）：给出余额明细。百分比已经能算出来，
        // 但"还剩多少钱"是这类套餐最实际的信息。
        var credits = snapshot.credits
        if (credits !== null && credits !== undefined && credits.hasCredits === true) {
          parts.push('剩余 $' + Number(credits.totalRemaining).toFixed(2)
            + ' / 共 $' + Number(credits.totalPool).toFixed(2)
            + '（月度 $' + Number(credits.monthlyRemaining).toFixed(2)
            + (credits.purchasedRemaining > 0 ? ' / 加购 $' + Number(credits.purchasedRemaining).toFixed(2) : '')
            + (credits.freeRemaining > 0 ? ' / 赠送 $' + Number(credits.freeRemaining).toFixed(2) : '')
            + '）')
        }
        // 按量计费的钱包（DeepSeek 官方）：主指标已经是余额，这里补上充值/赠送的拆分，
        // 以及"是否可用"——余额为负时 is_available 是 false，那比数字本身更该被看见。
        var balance = snapshot.primary && snapshot.primary.kind === 'balance'
          ? snapshot.primary.balance
          : null
        if (balance !== null && balance !== undefined) {
          var piece = '充值 ' + balance.symbol + formatAmount(balance.toppedUp)
            + ' / 赠送 ' + balance.symbol + formatAmount(balance.granted)
          if (balance.available === false) piece += ' · 账户不可用（余额不足，需充值）'
          parts.push(piece)
        }
        if (local.topModel) {
          var limit = typeof local.topModelMonthlyLimitUsd === 'number'
            ? '（月度额度 $' + local.topModelMonthlyLimitUsd + '）'
            : ''
          parts.push('主力 ' + local.topModel + limit)
        }
        if (unknown.length > 0) parts.push('未收录价目表：' + unknown.join('、'))
        // 今日已消耗的 token。输入/输出/缓存拆开列 —— 缓存便宜得多，
        // 混在一起会让人误判花费结构。口径是本机时区的今天零点起。
        if (typeof local.todayTokens === 'number' && local.todayTokens > 0) {
          parts.push('今日 ' + formatTokens(local.todayTokens) + ' tok'
            + '（入 ' + formatTokens(local.todayInTokens)
            + ' / 出 ' + formatTokens(local.todayOutTokens)
            + ' / 缓存 ' + formatTokens(local.todayCachedTokens) + '）')
        }
        if (parts.length === 0) parts.push('本地金额只统计经过 DSH 的调用')
        ui.note.textContent = parts.join(' · ')
        ui.note.title = '官方百分比是订阅整体口径，包含 opencode CLI 等其它客户端的用量；'
          + '本地金额与 token 数只统计经过 DSH 的调用，金额是按 Go 价目表折算的估算值。'
          + '「今日」按本机时区的零点起算。'
      }
    }

    // ---------------- 骨骼桌宠 ----------------
    // 运动学由 tools/sync-anim.mjs 从 tools/lib/anim.mjs 生成，唯一真值在那份文件里。
    // 所有运动都是周期为 LOOP_SECONDS 的周期函数，因此时间对 LOOP_SECONDS 取模
    // 不会产生跳帧：t=0 与 t=T 的取值恒等，接缝在数学上不存在。

    // @oguw-anim:start 由 tools/sync-anim.mjs 从 tools/lib/anim.mjs 生成（桌宠动画运动学），请勿手改
    /** 一个完整循环的时长（秒）。客户端对时间取模靠它，必须一起内联。 */
    const LOOP_SECONDS = 6;

    const TAU = Math.PI * 2;

    /** 紧支撑平滑脉冲：|t-c| >= hw 时严格为 0。 */
    function bump(t, c, hw) {
      const d = Math.abs(t - c);
      if (d >= hw) return 0;
      return 0.5 * (1 + Math.cos((Math.PI * d) / hw));
    }

    /** 呼吸：每循环 2 个周期。 */
    function breath(t) {
      return Math.sin((TAU * 2 * t) / LOOP_SECONDS);
    }

    /**
     * 蹦一下的压缩量：先压（t≈3.00）再弹（t≈3.46）。
     * 两个脉冲都紧支撑 ⇒ t=0 与 t=T 处恒为 0。
     */
    function squashAt(t) {
      return 0.62 * bump(t, 3.0, 0.3) - 0.4 * bump(t, 3.46, 0.34);
    }

    /** 弹起时整只离地一点点。 */
    function liftAt(t) {
      return bump(t, 3.5, 0.3);
    }

    /** 主体：绕脚下锚点做近似体积守恒的压扁/拉伸。 */
    function bodyTransform(t) {
      const s = squashAt(t);
      const sy = 1 - 0.078 * s + 0.011 * breath(t);
      const sx = 1 - 0.55 * (sy - 1);
      return { sx, sy, dy: -7 * liftAt(t) };
    }

    /** 呆毛：轴心在根部，跟随主体压缩弹动（滞后一帧量 ⇒ 甩尾）。 */
    function ahogeAngle(t) {
      const lag = 0.17;
      const whip = 30 * (squashAt(t - lag) - squashAt(t));
      const idle = 3.4 * Math.sin((TAU * 2 * t) / LOOP_SECONDS + 0.7);
      return idle + whip;
    }

    /** 耳朵：持续微摆 + 各自一次干脆的抖动。 */
    function earAngle(t, side) {
      const isLeft = side === 'left';
      const dir = isLeft ? -1 : 1;
      const sway = 2.2 * Math.sin((TAU * 3 * t) / LOOP_SECONDS + (isLeft ? 0 : 1.1));
      const twitch = isLeft
        ? bump(t, 1.5, 0.17) - 0.5 * bump(t, 1.7, 0.19)
        : bump(t, 4.3, 0.17) - 0.5 * bump(t, 4.5, 0.19);
      return sway + dir * 14 * twitch + 3.0 * dir * squashAt(t);
    }

    /** 尾巴：慢摆 + 二次谐波 + 蹦跳时的甩动。 */
    function tailAngle(t) {
      const sway = 8 * Math.sin((TAU * 2 * t) / LOOP_SECONDS + 1.2);
      const second = 3 * Math.sin((TAU * 4 * t) / LOOP_SECONDS + 0.4);
      const flick = 18 * (squashAt(t - 0.12) - squashAt(t));
      return sway + second + flick;
    }
    // @oguw-anim:end

    // ---------------- 点击音效（小黄鸭） ----------------
    // 合成代码由 tools/sync-anim.mjs 从 tools/lib/duck.mjs 生成，唯一真值在那份文件里。
    // 只有 /oguw-usage/click 这一个动作会响，不做常驻音。

    // @oguw-duck:start 由 tools/sync-anim.mjs 从 tools/lib/duck.mjs 生成（点击音效合成），请勿手改
    /** 音效时长（秒）。比点击反馈动画短得多，要的是"轻快"而不是"余音"。 */
    const DUCK_SECONDS = 0.17;

    /** 采样率。客户端会用 AudioContext 的真实采样率调用，这里只是默认值。 */
    const DUCK_RATE = 48000;

    /**
     * 基频曲线：挤下去 → 尖上去 → 回落。
     * 输入是归一化时间 u∈[0,1]，输出频率 Hz。分段之间用平滑插值，避免爆音。
     */
    function duckPitch(u) {
      const points = [
        [0.0, 560],
        [0.12, 760],
        [0.38, 1320],
        [0.62, 1180],
        [1.0, 820],
      ];
      for (let i = 1; i < points.length; i += 1) {
        if (u <= points[i][0]) {
          const [u0, f0] = points[i - 1];
          const [u1, f1] = points[i];
          const k = (u - u0) / (u1 - u0);
          // smoothstep：分段的线性插值会有折角，听感上是"咔"的一下
          const s = k * k * (3 - 2 * k);
          return f0 + (f1 - f0) * s;
        }
      }
      return points[points.length - 1][1];
    }

    /** 音量包络：极快起音 + 指数衰减。捏一下就是"啪"地开始、"吱"地消失。 */
    function duckEnvelope(u) {
      const attack = 0.06;
      if (u < attack) return u / attack;
      const decay = (u - attack) / (1 - attack);
      return Math.pow(1 - decay, 2.2);
    }

    /**
     * 二阶带通（RBJ cookbook），模拟鸭嘴/哨片的共振峰。
     * 固定中心频率而不是跟着音高走 —— 真实的哨片共振是腔体决定的，基本不随音高变，
     * 跟着走反而会听成电子音。
     */
    function duckBandpass(samples, rate, centerHz, q) {
      const w0 = (2 * Math.PI * centerHz) / rate;
      const alpha = Math.sin(w0) / (2 * q);
      const cos0 = Math.cos(w0);
      const b0 = alpha, b1 = 0, b2 = -alpha;
      const a0 = 1 + alpha, a1 = -2 * cos0, a2 = 1 - alpha;
      const out = new Float32Array(samples.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const x0 = samples[i];
        const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2
          - (a1 / a0) * y1 - (a2 / a0) * y2;
        out[i] = y0;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      }
      return out;
    }

    /**
     * 生成鸭子叫的采样。返回 [-1,1] 的 Float32Array，长度 = rate * DUCK_SECONDS。
     * 纯函数：同样的 rate 一定得到同样的样本，这是离线试听能与实机一致的前提。
     */
    function renderDuck(rate) {
      const sampleRate = Number.isFinite(rate) && rate > 0 ? rate : DUCK_RATE;
      const total = Math.max(1, Math.floor(sampleRate * DUCK_SECONDS));
      const raw = new Float32Array(total);
      let phase = 0;
      for (let i = 0; i < total; i += 1) {
        const u = i / (total - 1);
        phase += (2 * Math.PI * duckPitch(u)) / sampleRate;
        // 谐波堆叠：基波弱一点，二三次强一点，才有"吱"的鼻音而不是圆润的笛声
        const tone = Math.sin(phase) * 0.45
          + Math.sin(phase * 2) * 0.34
          + Math.sin(phase * 3) * 0.21;
        raw[i] = tone * duckEnvelope(u);
      }
      const filtered = duckBandpass(raw, sampleRate, 1850, 3.2);
      // 带通会吃掉不少能量，归一化到 0.9 峰值，保证不同采样率听感一致
      let peak = 0;
      for (let i = 0; i < total; i += 1) peak = Math.max(peak, Math.abs(filtered[i]));
      const gain = peak > 0 ? 0.9 / peak : 1;
      const out = new Float32Array(total);
      for (let i = 0; i < total; i += 1) out[i] = filtered[i] * gain;
      return out;
    }
    // @oguw-duck:end

    // @oguw-boop:start 由 tools/sync-anim.mjs 从 tools/lib/boop.mjs 生成（缩放音效合成），请勿手改
    /** 时长（秒）。比鸭子更短 —— 缩放是高频动作，声音要"点一下就收"。 */
    const BOOP_SECONDS = 0.115;

    const BOOP_RATE = 48000;

    /** 音高曲线：快速上滑 → 轻回落。 */
    function boopPitch(u) {
      const points = [
        [0.0, 330],
        [0.09, 560],
        [0.32, 880],
        [0.58, 800],
        [1.0, 690],
      ];
      for (let i = 1; i < points.length; i += 1) {
        if (u <= points[i][0]) {
          const [u0, f0] = points[i - 1];
          const [u1, f1] = points[i];
          const k = (u - u0) / (u1 - u0);
          const s = k * k * (3 - 2 * k);
          return f0 + (f1 - f0) * s;
        }
      }
      return points[points.length - 1][1];
    }

    /** 包络：比鸭子稍慢的起音（去掉"啪"的爆音感），然后干净收尾。 */
    function boopEnvelope(u) {
      const attack = 0.11;
      if (u < attack) {
        const k = u / attack;
        return k * k * (3 - 2 * k);
      }
      const decay = (u - attack) / (1 - attack);
      return Math.pow(1 - decay, 2.6);
    }

    /**
     * 一阶低通。啵的圆润来自"几乎没有高频" —— 鸭子靠带通做出鼻音，
     * 这里反过来，把高频削掉，留下一个软乎乎的团。
     */
    function boopLowpass(samples, rate, cutoffHz) {
      const dt = 1 / rate;
      const rc = 1 / (2 * Math.PI * cutoffHz);
      const alpha = dt / (rc + dt);
      const out = new Float32Array(samples.length);
      let previous = 0;
      for (let i = 0; i < samples.length; i += 1) {
        previous += alpha * (samples[i] - previous);
        out[i] = previous;
      }
      return out;
    }

    /**
     * 生成"啵"的采样。纯函数，同样的 rate 得到同样的样本。
     */
    function renderBoop(rate) {
      const sampleRate = Number.isFinite(rate) && rate > 0 ? rate : BOOP_RATE;
      const total = Math.max(1, Math.floor(sampleRate * BOOP_SECONDS));
      const raw = new Float32Array(total);
      let phase = 0;
      for (let i = 0; i < total; i += 1) {
        const u = i / (total - 1);
        phase += (2 * Math.PI * boopPitch(u)) / sampleRate;
        // 以正弦为主，只加一点二次谐波：全是正弦会像测试音，加太多就变鸭子
        const tone = Math.sin(phase) * 0.78 + Math.sin(phase * 2) * 0.22;
        raw[i] = tone * boopEnvelope(u);
      }
      const filtered = boopLowpass(raw, sampleRate, 2300);
      let peak = 0;
      for (let i = 0; i < total; i += 1) peak = Math.max(peak, Math.abs(filtered[i]));
      const gain = peak > 0 ? 0.9 / peak : 1;
      const out = new Float32Array(total);
      for (let i = 0; i < total; i += 1) out[i] = filtered[i] * gain;
      return out;
    }
    // @oguw-boop:end

    var audioCtx = null
    /** 采样缓冲按音色缓存：合成一次要几毫秒，不该每次点击都重算。 */
    var toneBuffers = {}

    /**
     * 懒建 AudioContext。浏览器要求音频上下文在**用户手势**里创建或恢复 ——
     * 点击正好是手势，所以在这里建没问题；提前建反而会被挂起。
     */
    function audioContext() {
      if (audioCtx !== null) return audioCtx
      var Ctor = window.AudioContext || window.webkitAudioContext
      if (typeof Ctor !== 'function') return null
      try {
        audioCtx = new Ctor()
        toneBuffers = {}
      } catch (error) {
        audioCtx = null
      }
      return audioCtx
    }

    /** 音效开关。默认开，关掉后持久化到宿主。 */
    function soundEnabled() {
      var pet = (snapshot && snapshot.pet) || {}
      return pet.sound !== false
    }

    /** 桌宠的名字。宿主可以覆盖（payload 里的 pet.name），缺省用这个。 */
    var DEFAULT_PET_NAME = '蓝色大肥鱼'

    function petName() {
      var pet = (snapshot && snapshot.pet) || {}
      return typeof pet.name === 'string' && pet.name !== '' ? pet.name : DEFAULT_PET_NAME
    }

    /**
     * 响一声。任何一步失败都静默跳过 —— 音效坏了不该影响点击或缩放本身。
     * `render` 是纯采样函数（由 sync-anim 从 tools/lib/ 内联进来）。
     */
    function playTone(name, render, volume, rate) {
      if (!soundEnabled()) return
      var ctx = audioContext()
      if (ctx === null) return
      try {
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume()
        if (toneBuffers[name] === undefined) {
          // 用真实采样率生成，保证不同设备听感一致（而不是把 48k 的样本硬塞给 44.1k）
          var samples = render(ctx.sampleRate)
          var buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
          buffer.copyToChannel(samples, 0)
          toneBuffers[name] = buffer
        }
        var source = ctx.createBufferSource()
        source.buffer = toneBuffers[name]
        // 轻微随机变调：连续缩放时同一段采样重复播放会像机械音
        if (typeof rate === 'number' && rate !== 1) source.playbackRate.value = rate
        var gain = ctx.createGain()
        gain.gain.value = volume
        source.connect(gain)
        gain.connect(ctx.destination)
        source.start()
      } catch (error) {
        // 忽略：音效是锦上添花
      }
    }

    /** 点击角色：小黄鸭。 */
    function playDuck() {
      playTone('duck', renderDuck, 0.55, 1)
    }

    var lastBoopAt = 0

    /**
     * 缩放：啵。
     *
     * **必须限流** —— 滚轮一次手势会触发几十个事件，逐个播放会变成机关枪。
     * 120ms 一次既跟得上手感，又听不出堆叠。配合轻微随机变调，连续几次
     * 不会听成同一个音。
     */
    function playBoop() {
      var now = Date.now()
      if (now - lastBoopAt < 120) return
      lastBoopAt = now
      playTone('boop', renderBoop, 0.4, 0.94 + Math.random() * 0.12)
    }

    var rig = null
    var rigRaf = null
    var rigStart = 0

    /** 2x3 仿射 [a,b,tx,c,d,ty]（x' = a·x + b·y + tx）。与 lib/rig-geometry.js 同构。 */
    function rigMul(m, n) {
      return [
        m[0] * n[0] + m[1] * n[3], m[0] * n[1] + m[1] * n[4], m[0] * n[2] + m[1] * n[5] + m[2],
        m[3] * n[0] + m[4] * n[3], m[3] * n[1] + m[4] * n[4], m[3] * n[2] + m[4] * n[5] + m[5],
      ]
    }
    function rigApply(m, x, y) {
      return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]
    }
    function rigRotate(rad, px, py) {
      var c = Math.cos(rad), s = Math.sin(rad)
      return [c, -s, px - c * px + s * py, s, c, py - s * px - c * py]
    }

    /** 宿主给的 rig 描述；缺失（或宿主解析失败）时返回 null，退回静态整图。 */
    function rigDescriptor() {
      var pet = (snapshot && snapshot.pet) || {}
      var r = pet.rig
      if (!r || !r.canvas || !r.parts || !r.body) return null
      return r
    }

    /** 加载全部部件图。任何一张失败就整体放弃 —— 宁可退回静态整图，也不要半个身子。 */
    function loadRigImages(descriptor) {
      var names = Object.keys(descriptor.parts)
      return Promise.all(names.concat(['body']).map(function (name) {
        var spec = name === 'body' ? descriptor.body : descriptor.parts[name]
        return new Promise(function (resolve, reject) {
          var img = new Image()
          img.onload = function () { resolve([name, img]) }
          img.onerror = function () { reject(new Error('部件加载失败: ' + spec.url)) }
          img.src = spec.url
        })
      })).then(function (pairs) {
        var images = {}
        for (var i = 0; i < pairs.length; i += 1) images[pairs[i][0]] = pairs[i][1]
        return images
      })
    }

    /** 画出 t 时刻的一帧。矩阵与 tools/lib/rig-render.mjs 逐项一致。 */
    function paintRig(t) {
      var d = rig.descriptor
      var canvas = ui.canvas
      var cssH = ui.canvas.clientHeight
      if (!cssH) return
      var cssW = ui.canvas.clientWidth || Math.round(cssH * d.canvas.width / d.canvas.height)
      var dpr = Math.min(window.devicePixelRatio || 1, 3)
      var bw = Math.max(1, Math.round(cssW * dpr))
      var bh = Math.max(1, Math.round(cssH * dpr))
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh }
      var ctx = canvas.getContext('2d')
      if (ctx === null) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, bw, bh)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'

      var scale = bh / d.canvas.height
      var S = [scale, 0, 0, 0, scale, 0]
      var body = bodyTransform(t)
      var B = [body.sx, 0, d.anchor.x * (1 - body.sx), 0, body.sy, d.anchor.y * (1 - body.sy) + body.dy]
      var angles = {
        ahoge: ahogeAngle(t),
        earLeft: earAngle(t, 'left'),
        earRight: earAngle(t, 'right'),
        tail: tailAngle(t),
      }
      for (var i = 0; i < d.order.length; i += 1) {
        var name = d.order[i]
        var m
        if (name === 'body') {
          m = rigMul(rigMul(S, B), [1, 0, d.body.originX, 0, 1, d.body.originY])
        } else {
          var p = d.parts[name]
          if (!p) continue
          // 轴心先随主体变换移动，再绕移动后的轴心旋转 —— 与主体同步，不会脱臼
          var q = rigApply(B, p.pivotCanvasX, p.pivotCanvasY)
          m = rigMul(rigMul(rigMul(S, rigRotate(angles[name] * Math.PI / 180, q[0], q[1])), B), p.place)
        }
        var img = name === 'body' ? rig.images.body : rig.images[name]
        if (!img) continue
        ctx.setTransform(m[0], m[3], m[1], m[4], m[2], m[5])
        ctx.drawImage(img, 0, 0)
      }
    }

    function rigTick(now) {
      if (rig === null) { rigRaf = null; return }
      if (rigStart === 0) rigStart = now
      paintRig(((now - rigStart) / 1000) % LOOP_SECONDS)
      rigRaf = window.requestAnimationFrame(rigTick)
    }

    function stopRig() {
      if (rigRaf !== null) { window.cancelAnimationFrame(rigRaf); rigRaf = null }
    }

    /** 首次拿到 rig 描述就启动；已经启动过就什么都不做。 */
    function startRig() {
      if (rig !== null || ui === null) return
      var descriptor = rigDescriptor()
      if (descriptor === null) return
      loadRigImages(descriptor).then(function (images) {
        if (ui === null || rig !== null) return
        rig = { descriptor: descriptor, images: images }
        ui.root.dataset.mode = 'rig'
        applyPosition()
        if (rigRaf === null) rigRaf = window.requestAnimationFrame(rigTick)
      }).catch(function () {
        // 部件缺失：留在静态整图模式，不打断用量显示
      })
    }

    /** Anchor the pet from the persisted position, and apply its size. */
    function applyPosition() {
      if (ui === null) return
      var pet = (snapshot && snapshot.pet) || {}
      var size = clampSize(Number(pet.size) || DEFAULT_SIZE)
      ui.root.style.setProperty('--oguw-pet-h', size + 'px')
      // canvas 与阴影的宽度都跟着比例走：整只的宽高比随 rig 而变，不能写死。
      // 退回静态图时沿用原来那套 322/420，外观与接入前一致。
      var ratio = rig !== null
        ? rig.descriptor.canvas.width / rig.descriptor.canvas.height
        : 322 / 420
      ui.root.style.setProperty('--oguw-pet-w', Math.round(size * ratio) + 'px')
      var position = (snapshot && snapshot.position) || { left: 20, bottom: 20 }
      var width = ui.pet.offsetWidth || 120
      var height = ui.pet.offsetHeight || 160
      var left = Math.max(0, Math.min(window.innerWidth - width, Number(position.left) || 0))
      var bottom = Math.max(0, Math.min(window.innerHeight - height, Number(position.bottom) || 0))
      ui.root.style.left = left + 'px'
      ui.root.style.bottom = bottom + 'px'
      ui.root.style.top = 'auto'
      applyFacing(left, width)
      if (expanded) placeCard()
    }

    /**
     * 朝向：贴左半屏转向右、贴右半屏转向左 —— 让角色朝着屏幕中间看。
     * 角色是正面立绘，只能用水平镜像表达朝向；方向反了就改这一个常量。
     */
    var FLIP_WHEN_ON_LEFT = true

    function applyFacing(left, width) {
      if (ui === null) return
      var centerX = left + width / 2
      var onLeft = centerX < window.innerWidth / 2
      var flip = onLeft === FLIP_WHEN_ON_LEFT
      ui.root.style.setProperty('--oguw-flip', flip ? '-1' : '1')
    }

    /** The on-screen height bounds, from the host when it advertises them. */
    function sizeBounds() {
      var pet = (snapshot && snapshot.pet) || {}
      return {
        min: Number(pet.min) || SIZE_MIN,
        max: Number(pet.max) || SIZE_MAX,
      }
    }

    /** Clamp a requested height into the adjustable bounds. */
    function clampSize(size) {
      var bounds = sizeBounds()
      if (!isFinite(size)) return DEFAULT_SIZE
      return Math.max(bounds.min, Math.min(bounds.max, Math.round(size)))
    }

    /**
     * Change the character's height. `persist` is deferred: the scroll wheel
     * fires dozens of events per gesture, and each one would otherwise rewrite
     * the state file.
     */
    function resizeTo(size, immediate) {
      if (ui === null) return
      var next = clampSize(size)
      // 音效只在尺寸**真的变了**时响：已经到上下限还继续滚，
      // 角色没动却一直"啵啵啵"会很怪。playBoop 内部还有限流。
      var changed = snapshot === null || (snapshot.pet && snapshot.pet.size) !== next
      ui.root.style.setProperty('--oguw-pet-h', next + 'px')
      if (snapshot !== null) {
        snapshot.pet = snapshot.pet || {}
        snapshot.pet.size = next
      }
      if (changed) playBoop()
      applyPosition()
      if (immediate) {
        if (sizeTimer !== null) { window.clearTimeout(sizeTimer); sizeTimer = null }
        saveSize(next)
        return
      }
      if (sizeTimer !== null) window.clearTimeout(sizeTimer)
      sizeTimer = window.setTimeout(function () {
        sizeTimer = null
        saveSize(next)
      }, 400)
    }

    /** Persist the height host-side. */
    function saveSize(size) {
      fetch(API + '/size', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ size: size }),
      }).catch(function () { /* cosmetic */ })
    }

    /**
     * 切换点击音效并持久化。存到宿主而不是 localStorage：位置、尺寸也在那边，
     * 一个挂件的偏好集中放一处，换浏览器打开还是同一个设置。
     */
    function saveSound(on) {
      if (snapshot !== null) {
        snapshot.pet = snapshot.pet || {}
        snapshot.pet.sound = on
      }
      fetch(API + '/sound', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sound: on }),
      }).catch(function () { /* cosmetic */ })
      renderSoundButton()
    }

    /** 音效按钮的图标与提示跟着当前状态走。 */
    function renderSoundButton() {
      if (ui === null || ui.sound === null) return
      var on = soundEnabled()
      ui.sound.textContent = on ? '🔊' : '🔇'
      ui.sound.title = on ? '点击音效：开（点一下静音）' : '点击音效：关（点一下开启）'
      ui.sound.dataset.on = on ? '1' : '0'
    }

    /** Place the card beside the pet, flipping when it would overflow. */
    function placeCard() {
      var petRect = ui.pet.getBoundingClientRect()
      var width = ui.card.offsetWidth
      var height = ui.card.offsetHeight
      var left = petRect.right + 14
      var top = petRect.bottom - height
      // Not enough room on the right: sit above the character instead.
      if (left + width > window.innerWidth - 8) {
        left = petRect.left + petRect.width / 2 - width / 2
        top = petRect.top - height - 12
        if (top < 8) top = petRect.bottom + 12
      }
      left = Math.max(8, Math.min(window.innerWidth - width - 8, left))
      top = Math.max(8, Math.min(window.innerHeight - height - 8, top))
      ui.card.style.left = left + 'px'
      ui.card.style.top = top + 'px'
    }

    /** Expand or collapse the detail card. */
    function setExpanded(next, options) {
      if (ui === null) return
      var silent = options && options.silent
      expanded = next
      ui.card.hidden = !next
      if (next) {
        ui.root.dataset.theme = detectTheme()
        renderCard()
        ui.card.classList.remove('oguw-card-open')
        void ui.card.offsetWidth
        ui.card.classList.add('oguw-card-open')
        placeCard()
        refresh(true)
        if (!silent) {
          var mood = currentMood()
          say(mood, pick(LINES[mood]))
        }
      } else if (!silent) {
        say(currentMood(), pick(FAREWELL))
      }
    }

    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------

    /** Point the sprite at the host's URL, falling back to the drawn face. */
    function adoptSprite() {
      if (ui === null) return
      var url = spriteUrl()
      if (ui.sprite.getAttribute('src') !== url) ui.sprite.setAttribute('src', url)
    }

    /** Fetch the host document; `force` asks the host to re-probe first. */
    function refresh(force) {
      if (unmounted) return
      if (force === true && ui !== null) ui.refresh.disabled = true
      var request = force === true ? apiFetch(API + '/refresh', 'POST') : apiFetch(API + '/state')
      request.then(function (doc) {
        if (unmounted || ui === null) return
        var first = snapshot === null
        var previousMood = lastMood
        snapshot = doc
        if (first) {
          adoptSprite()
          applyPosition()
          // rig 描述来自状态文档，挂载时 snapshot 还是 null，
          // 所以骨骼桌宠必须在这里启动 —— 放在挂载流程里只会读到 null 然后永远不重试。
          startRig()
        }
        var mood = currentMood()
        lastMood = mood
        if (!speaking) renderQuota()
        if (expanded) renderCard()
        // Speak up on its own only when the mood actually crossed a threshold,
        // and never over a line the user just triggered by clicking.
        if (!first && !speaking && previousMood !== null && previousMood !== mood && MOOD_ALERT[mood] !== undefined) {
          say(mood, pick(MOOD_ALERT[mood]))
        }
      }).catch(function () {
        if (unmounted || ui === null) return
        if (expanded) {
          ui.note.dataset.tone = 'error'
          ui.note.textContent = '无法连接 DSH 宿主，请确认 dsh web 仍在运行'
        }
      }).then(function () {
        if (ui !== null) ui.refresh.disabled = false
      })
    }

    /** Persist the pet's anchor host-side. */
    function savePosition() {
      var left = parseFloat(ui.root.style.left) || 0
      var bottom = parseFloat(ui.root.style.bottom) || 0
      if (snapshot !== null) snapshot.position = { left: left, bottom: bottom }
      fetch(API + '/position', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ left: left, bottom: bottom }),
      }).catch(function () { /* cosmetic */ })
    }

    // ---------------------------------------------------------------------
    // Mount
    // ---------------------------------------------------------------------

    /** Build the widget DOM once. */
    function build() {
      ensureStyle()
      var root = document.createElement('div')
      root.className = 'oguw-root'
      root.dataset.dshPlugin = 'opencode-go-usage'
      root.dataset.theme = detectTheme()
      root.dataset.dragging = '0'

      var pet = document.createElement('div')
      pet.className = 'oguw-pet'
      pet.setAttribute('role', 'button')
      pet.setAttribute('tabindex', '0')
      pet.setAttribute('title', petName() + ' —— 点我看看，拖动可以搬家，滚轮可以调大小')
      pet.innerHTML = '<div class="oguw-bubble"></div>'
        + '<div class="oguw-breathe"><div class="oguw-facing">'
        + '<canvas class="oguw-sprite oguw-rigcanvas" aria-hidden="true"></canvas>'
        + '<img class="oguw-sprite oguw-flatimg" alt="" draggable="false">'
        + '</div></div>'
        + '<div class="oguw-fallback">(・ω・)</div>'
        + '<div class="oguw-shadow"></div>'

      var card = document.createElement('div')
      card.className = 'oguw-card'
      card.hidden = true
      card.innerHTML = '<div class="oguw-head" data-state="ok">'
        + '<span class="oguw-dot"></span>'
        + '<span class="oguw-titles">'
        + '<span class="oguw-petname"></span>'
        + '<span class="oguw-title">OpenCode Go</span>'
        + '</span>'
        + '<span class="oguw-price"></span>'
        + '<button class="oguw-close" type="button" title="收起">×</button>'
        + '</div>'
        + '<div class="oguw-rows"></div>'
        + '<div class="oguw-foot">'
        + '<span class="oguw-note"></span>'
        + '<span class="oguw-sizegroup">'
        + '<button class="oguw-btn oguw-smaller" type="button" title="缩小（在角色上滚轮也可以）">−</button>'
        + '<button class="oguw-btn oguw-bigger" type="button" title="放大（在角色上滚轮也可以）">＋</button>'
        + '</span>'
        + '<button class="oguw-btn oguw-sound" type="button">🔊</button>'
        + '<button class="oguw-btn oguw-refresh" type="button">刷新</button>'
        + '<a class="oguw-console" target="_blank" rel="noreferrer noopener">控制台</a>'
        + '</div>'

      root.appendChild(pet)
      root.appendChild(card)
      document.body.appendChild(root)

      ui = {
        root: root,
        pet: pet,
        bubble: pet.querySelector('.oguw-bubble'),
        sprite: pet.querySelector('.oguw-flatimg'),
        canvas: pet.querySelector('.oguw-rigcanvas'),
        shadow: pet.querySelector('.oguw-shadow'),
        card: card,
        head: card.querySelector('.oguw-head'),
        title: card.querySelector('.oguw-title'),
        petname: card.querySelector('.oguw-petname'),
        price: card.querySelector('.oguw-price'),
        close: card.querySelector('.oguw-close'),
        rows: card.querySelector('.oguw-rows'),
        note: card.querySelector('.oguw-note'),
        smaller: card.querySelector('.oguw-smaller'),
        bigger: card.querySelector('.oguw-bigger'),
        sound: card.querySelector('.oguw-sound'),
        refresh: card.querySelector('.oguw-refresh'),
        console: card.querySelector('.oguw-console'),
      }

      ui.sprite.addEventListener('error', function () { root.dataset.sprite = 'missing' })
      ui.sprite.addEventListener('load', function () {
        root.dataset.sprite = 'ready'
        applyPosition()
      })
      ui.sprite.setAttribute('src', spriteUrl())

      // 页面切到后台就停掉逐帧渲染，回来再续上 —— 常驻挂件不该白烧 CPU
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopRig()
        else if (rig !== null && rigRaf === null) rigRaf = window.requestAnimationFrame(rigTick)
      })
      startRig()

      renderQuota()
      bindEvents()
      applyPosition()
      return root
    }

    /** Wire the character, card, drag and poll behaviour. */
    function bindEvents() {
      var startX = 0
      var startY = 0
      var originLeft = 0
      var originBottom = 0
      var moved = false
      var active = false

      ui.pet.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return
        active = true
        moved = false
        startX = event.clientX
        startY = event.clientY
        originLeft = parseFloat(ui.root.style.left) || 0
        originBottom = parseFloat(ui.root.style.bottom) || 0
        ui.root.dataset.dragging = '0'
        try { ui.pet.setPointerCapture(event.pointerId) } catch (error) { /* older engines */ }
      })

      ui.pet.addEventListener('pointermove', function (event) {
        if (!active) return
        var dx = event.clientX - startX
        var dy = event.clientY - startY
        if (!moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return
        if (!moved) {
          moved = true
          dragging = true
          ui.root.dataset.dragging = '1'
          if (expanded) setExpanded(false, { silent: true })
        }
        var width = ui.pet.offsetWidth || 120
        var height = ui.pet.offsetHeight || 160
        var left = Math.max(0, Math.min(window.innerWidth - width, originLeft + dx))
        ui.root.style.left = left + 'px'
        ui.root.style.bottom = Math.max(0, Math.min(window.innerHeight - height, originBottom - dy)) + 'px'
        // 拖动过程中就转身，而不是等松手才转 —— 否则跨过中线时看着像卡住
        applyFacing(left, width)
      })

      function endDrag(event) {
        if (!active) return
        active = false
        try { ui.pet.releasePointerCapture(event.pointerId) } catch (error) { /* ignore */ }
        ui.root.dataset.dragging = '0'
        if (moved) {
          dragging = false
          savePosition()
        } else {
          poke()
        }
      }
      ui.pet.addEventListener('pointerup', endDrag)
      ui.pet.addEventListener('pointercancel', function (event) {
        if (!active) return
        active = false
        ui.root.dataset.dragging = '0'
        try { ui.pet.releasePointerCapture(event.pointerId) } catch (error) { /* ignore */ }
      })

      ui.pet.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          poke()
        } else if (event.key === 'Escape') {
          setExpanded(false)
        }
      })

      ui.close.addEventListener('click', function () { setExpanded(false) })
      ui.refresh.addEventListener('click', function () { refresh(true); bounce() })
      ui.smaller.addEventListener('click', function () {
        resizeTo(currentSize() - SIZE_STEP, true)
        bounce()
      })
      ui.bigger.addEventListener('click', function () {
        resizeTo(currentSize() + SIZE_STEP, true)
        bounce()
      })
      ui.sound.addEventListener('click', function () {
        var next = !soundEnabled()
        saveSound(next)
        // 开的时候立刻响一声，让用户马上听到效果，而不用关掉卡片再点角色
        if (next) playDuck()
      })

      // Scroll over the character to resize it — the most direct way to find a
      // size that fits, and the reason persistence is debounced.
      ui.pet.addEventListener('wheel', function (event) {
        if (!event.deltaY) return
        event.preventDefault()
        resizeTo(currentSize() + (event.deltaY < 0 ? SIZE_STEP : -SIZE_STEP), false)
      }, { passive: false })

      document.addEventListener('pointerdown', function (event) {
        if (!expanded) return
        if (ui.root.contains(event.target)) return
        setExpanded(false, { silent: true })
      })

      window.addEventListener('resize', function () {
        applyPosition()
        if (expanded) placeCard()
      })
    }

    /**
     * The character's click reaction: always a bounce, then either a poke
     * complaint (card already open) or the greeting that opens the card.
     */
    function poke() {
      var mood = currentMood()
      bounce()
      // 音效只在"点角色"这一个动作上响。点击本身就是用户手势，
      // AudioContext 在这一刻创建不会被浏览器挂起。
      playDuck()
      if (expanded) {
        say(mood, pick(POKE))
        return
      }
      setExpanded(true)
    }

    /** Poll loops, respecting tab visibility. */
    function startTimers() {
      function stop() {
        if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null }
        if (tickTimer !== null) { window.clearInterval(tickTimer); tickTimer = null }
      }
      function start() {
        if (pollTimer === null && document.visibilityState === 'visible') {
          pollTimer = window.setInterval(function () { refresh(false) }, POLL_MS)
          tickTimer = window.setInterval(function () {
            // The countdown decays between polls; re-render it rather than
            // waiting for the next fetch.
            if (expanded) renderCard()
          }, TICK_MS)
        }
      }
      function onVisibility() {
        if (document.visibilityState === 'visible') { refresh(false); start() } else { stop() }
      }
      start()
      document.addEventListener('visibilitychange', onVisibility)
      return function () {
        stop()
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }

    /**
     * Client plugin body: mount the global surface for the page lifetime and
     * tear it down with the fiber. A stale container left by an earlier bundle
     * instance (hot reload) is removed first so the page keeps exactly one.
     */
    function apply(ctx) {
      // A throw escaping this body would fail client-plugin activation and the
      // shell would report "Failed to load plugins", so the whole mount is
      // contained: a broken pet must never take the GUI down with it.
      try {
        var stale = document.querySelectorAll('div[data-dsh-plugin="opencode-go-usage"]')
        for (var index = 0; index < stale.length; index += 1) stale[index].remove()
        unmounted = false
        expanded = false
        snapshot = null
        speaking = false
        lastMood = null

        build()
        refresh(false)

        var stopTimers = startTimers()
        var teardown = function () {
          if (unmounted) return
          unmounted = true
          stopTimers()
          if (sayTimer !== null) { window.clearTimeout(sayTimer); sayTimer = null }
          if (popTimer !== null) { window.clearTimeout(popTimer); popTimer = null }
          if (sizeTimer !== null) { window.clearTimeout(sizeTimer); sizeTimer = null }
          if (ui !== null) {
            ui.root.remove()
            ui = null
          }
        }
        if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
          ctx.effect(function () { return teardown }, 'opencode-go-usage: widget')
        }
      } catch (error) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[opencode-go-usage] 桌宠挂载失败：', error)
        }
      }
    }

    exports.apply = apply
    exports.inject = []
    /**
     * Test seam: the mood/colour/format helpers and the copy tables, so
     * test/selftest.mjs can assert the user-facing strings and thresholds
     * without a DOM. Nothing in the shell reads this.
     */
    exports.__internals = {
      moodFor: moodFor,
      colorFor: colorFor,
      countdown: countdown,
      money: money,
      escapeHtml: escapeHtml,
      primaryPercent: primaryPercent,
      LINES: LINES,
      FACES: FACES,
      FAREWELL: FAREWELL,
      POKE: POKE,
      MOOD_ALERT: MOOD_ALERT,
      DEFAULT_SPRITE: DEFAULT_SPRITE,
      WARN_AT: WARN_AT,
      DANGER_AT: DANGER_AT,
      // 骨骼桌宠的内部件：导出是为了让测试能把它和离线渲染器逐项对齐，
      // 两条路径一旦分叉（改了一边忘了另一边）测试立刻失败。
      rigInternals: {
        LOOP_SECONDS: LOOP_SECONDS,
        bodyTransform: bodyTransform,
        ahogeAngle: ahogeAngle,
        earAngle: earAngle,
        tailAngle: tailAngle,
        rigMul: rigMul,
        rigApply: rigApply,
        rigRotate: rigRotate,
        /** 与 paintRig 同一套合成顺序，只是不入画布，供测试取矩阵。 */
        matrices: function (t, descriptor, scale) {
          var S = [scale, 0, 0, 0, scale, 0]
          var body = bodyTransform(t)
          var B = [body.sx, 0, descriptor.anchor.x * (1 - body.sx),
            0, body.sy, descriptor.anchor.y * (1 - body.sy) + body.dy]
          var angles = {
            ahoge: ahogeAngle(t),
            earLeft: earAngle(t, 'left'),
            earRight: earAngle(t, 'right'),
            tail: tailAngle(t),
          }
          var out = {
            body: rigMul(rigMul(S, B), [1, 0, descriptor.body.originX, 0, 1, descriptor.body.originY]),
          }
          for (var i = 0; i < descriptor.order.length; i += 1) {
            var name = descriptor.order[i]
            var p = descriptor.parts[name]
            if (!p) continue
            var q = rigApply(B, p.pivotCanvasX, p.pivotCanvasY)
            out[name] = rigMul(rigMul(rigMul(S, rigRotate(angles[name] * Math.PI / 180, q[0], q[1])), B), p.place)
          }
          return out
        },
      },
    }
    return module.exports
  },
})
