/**
 * dsh-reload — 浏览器半边。
 *
 * 三块 UI，都经 slots 注册到宿主声明过的槽位：
 *  1. `sidebar.footer.action`（order 10）：侧边栏底部的「热重载」按钮，
 *     展开时带文字标签，折叠时只留图标。可在插件页里隐藏。
 *  2. `plugins.bundle.config`（keyed，key = 包名 `dsh-reload`）：本插件在
 *     「设置 → 插件」里自己那一页的卡片，含「热重载」「重启客户端」两个按钮
 *     和「在侧边栏显示热重载按钮」开关。
 *  3. `settings.action`：设置面板顶栏右侧（Close 左边）的两个按钮，
 *     在任何设置页都可见。
 *
 * 「设置 → 通用」里**没有**本插件的任何内容：通用页放全局偏好（语言、主题、
 * 输入框回车行为），热重载 / 重启是插件自己的动作，不该占据那一列。
 *
 * 与宿主的约定：
 *  - 不 require 宿主 primitives 包（practices.md 的 UI 规则）：控件自绘，
 *    只引用 `--dsw-alias-*` 主题 token。
 *  - 文案走 client locale 服务（`ctx.locale.register` + `bind`）。
 *  - HTTP 走同源相对路径（document.baseURI），桌面 shell 会把非静态路径转发
 *    到 Host；桌面代理会剥掉 Origin/Host，所以前端先探 `/ping` 再决定通道。
 *
 * 关于重启遮罩：它直接挂到 `document.body` 而不是走 React 槽位。原因是重启
 * 按钮在设置面板里，设置面板 z-index 实测 1000–1100，走槽位渲染的遮罩会被困在
 * 槽位的层叠上下文内、盖不住设置面板，用户仍能操作其他控件。同目录的
 * `dsh-session-recycle` 因同样原因采取同样做法。
 */
window.__ModuleLoader__.load({
  id: 'dsh-reload',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-reload'

    /**
     * 包名。`plugins.bundle.config` 的 key 必须与插件管理页 inventory 里的包名
     * 精确相等，否则卡片静默不出现。
     */
    const PKG_NAME = 'dsh-reload'

    /** 侧边栏按钮显示开关的本地偏好键。 */
    const PREF_KEY = 'dsh-reload:sidebar-button'

    /** 右下角悬浮按钮显示开关的本地偏好键。 */
    const PREF_FLOATING_KEY = 'dsh-reload:floating-button'

    /** 重启锁定超时：超过这个时间页面还活着，说明重启没发生，自动解锁。 */
    const LOCK_TIMEOUT_MS = 8000

    /** 重启后等新实例的轮询上限——这里只用于「遮罩期间页面仍存活」的兜底。 */
    const PENDING_POLL_MS = 1500

    const zh = {
      'action.reload': '热重载',
      'action.reloading': '重载中…',
      // 「更多」菜单里用用户视角的说法（见 MoreMenuItem 的注释）。
      'action.refresh': '刷新插件',
      'action.refreshing': '刷新中…',
      'action.restart': '重启客户端',
      'action.restarting': '正在重启…',
      'section.title': '热重载',
      'section.desc': '重新加载文件有改动的插件，不中断会话。',
      'section.sidebarToggle': '在侧边栏显示热重载按钮',
      'section.sidebarToggleDesc': '关闭后只隐藏侧边栏底部那个按钮，本页和设置顶栏的按钮不受影响。',
      'section.floatingToggle': '在右下角显示悬浮按钮',
      'section.floatingToggleDesc': '固定浮在窗口右下角，任何界面都能点到。',
      'toast.unchanged': '没有检测到改动（可能还没重新构建）',
      'toast.reloaded': '已热重载 {n} 个插件',
      'toast.reloadFailed': '热重载失败：{message}',
      'toast.restartFailed': '重启失败：{message}',
      'toast.restarted': 'DSH 已重启',
      'toast.restartTimeout': '重启似乎没有生效，请重试或手动重开 DSH',
      'toast.statusFailed': '无法读取任务状态：{message}',
      'modal.busyTitle': '现在无法重启',
      'modal.busyDesc': '有任务正在运行，重启会中断它们。请等待任务结束后再试。',
      'modal.busyAgents': '会话',
      'modal.busyJobs': '后台任务',
      'modal.busyTerminals': '终端',
      'modal.busyMore': '等 {n} 个',
      'modal.busyRunning': '运行中',
      'modal.busyQueued': '排队中',
      'modal.busyUntitled': '未命名会话',
      'modal.ok': '知道了',
      'modal.confirmTitle': '重启客户端？',
      'modal.confirmDesc': 'DSH 会关闭并自动重新打开。当前没有任务在运行。重启期间窗口会短暂消失。',
      'modal.confirmTerminalsDesc': 'DSH 会关闭并自动重新打开。下面这些终端会一起关掉——如果里面还有进程在跑，它们会被中断。会话和后台任务才是阻止重启的原因，终端不会。',
      'modal.confirmCancel': '取消',
      'modal.confirmOk': '重启客户端',
      'modal.restarting': '正在重启 DSH…',
      'modal.restartingHint': '窗口即将关闭，稍后会自动重新打开。',
      'pending.hint': '有 {n} 个模块需重启客户端才生效',
      'restart.unsupported': '仅桌面客户端支持重启',
    }

    const en = {
      'action.reload': 'Hot reload',
      'action.reloading': 'Reloading…',
      'action.refresh': 'Refresh plugins',
      'action.refreshing': 'Refreshing…',
      'action.restart': 'Restart app',
      'action.restarting': 'Restarting…',
      'section.title': 'Hot reload',
      'section.desc': 'Reload plugins whose files changed without interrupting sessions.',
      'section.sidebarToggle': 'Show the hot reload button in the sidebar',
      'section.sidebarToggleDesc':
        'Turning this off only hides the sidebar button; the buttons on this page and in the settings header keep working.',
      'section.floatingToggle': 'Show a floating button in the bottom-right corner',
      'section.floatingToggleDesc':
        'Pinned to the window corner, reachable from any screen.',
      'toast.unchanged': 'No changes detected (the build may not have run yet)',
      'toast.reloadFailed': 'Hot reload failed: {message}',
      'toast.restartFailed': 'Restart failed: {message}',
      'toast.restarted': 'DSH restarted',
      'toast.restartTimeout': 'The restart did not seem to happen. Try again or reopen DSH manually.',
      'toast.statusFailed': 'Could not read task status: {message}',
      'modal.busyTitle': 'Cannot restart now',
      'modal.busyDesc': 'Tasks are running; restarting would interrupt them. Wait for them to finish and try again.',
      'modal.busyAgents': 'Sessions',
      'modal.busyJobs': 'Background jobs',
      'modal.busyTerminals': 'Terminals',
      'modal.busyMore': 'and {n} more',
      'modal.busyRunning': 'running',
      'modal.busyQueued': 'queued',
      'modal.busyUntitled': 'Untitled session',
      'modal.ok': 'Got it',
      'modal.confirmTitle': 'Restart the app?',
      'modal.confirmDesc': 'DSH will close and reopen automatically. No tasks are running. The window disappears briefly.',
      'modal.confirmTerminalsDesc': 'DSH will close and reopen automatically. These terminals close with it - anything still running inside them is cut off. Terminals alone never block a restart; sessions and background jobs do.',
      'modal.confirmCancel': 'Cancel',
      'modal.confirmOk': 'Restart app',
      'modal.restarting': 'Restarting DSH…',
      'modal.restartingHint': 'The window will close and reopen automatically.',
      'pending.hint': '{n} module(s) need an app restart to take effect',
      'restart.unsupported': 'Restart is only available in the desktop app',
    }

    const STYLE = `
.dshr-root{display:flex;align-items:center;gap:8px}
.dshr-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);
  background:transparent;cursor:pointer;border-radius:8px;padding:6px 12px;font-size:13px;
  color:var(--dsw-alias-label-primary);white-space:nowrap;line-height:1.4}
.dshr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dshr-btn:disabled{opacity:.55;cursor:default}
.dshr-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshr-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dshr-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  border:none;background:transparent;cursor:pointer;border-radius:6px;color:var(--dsw-alias-label-secondary);padding:0}
.dshr-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshr-icon-btn:disabled{opacity:.5;cursor:default}
.dshr-icon-btn-wide{width:auto;gap:8px;padding:0 8px;height:28px;font-size:13px}
/* 侧边栏展开时的「图标 + 文字」按钮。尺寸照抄宿主 Settings 触发器
   （ui-settings-general 的 .trigger：42px 高、14px 字号、radius-md、
   padding 0 10px 0 8px、hover 用 interactive-bg-hover），
   这样两行看起来是同一个控件家族，而不是「一个图标 + 一个按钮」。 */
.dshr-footer-btn{box-sizing:border-box;display:flex;align-items:center;gap:8px;
  width:100%;height:42px;margin:0;padding:0 10px 0 8px;
  border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;
  overflow:hidden;text-align:left}
.dshr-footer-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshr-footer-btn:disabled{opacity:.55;cursor:default}
.dshr-footer-btn-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
/* 设置面板顶栏的紧凑按钮。顶栏高 54px、padding 20px 14px 8px 10px，
   右侧 .actions 是 flex-end + gap 8px，Close 是 28×28。
   这里用 28px 高、12px 字号，保证不撑高顶栏，也不跟 Close 抢注意力。 */
.dshr-hdr-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;
  height:28px;padding:0 10px;margin:0;flex:none;
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  background:transparent;cursor:pointer;white-space:nowrap;
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px}
.dshr-hdr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshr-hdr-btn:disabled{opacity:.5;cursor:default}
.dshr-hdr-btn-danger{border-color:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-state-error-primary)}
.dshr-hdr-btn-label{white-space:nowrap}
/* 右下角悬浮按钮：**只放图标**，尽量小（32px 圆形）。
   宿主 shell.overlay 层本身 pointer-events:none，占用者要自己 auto 回来，
   否则点不到。hover 时图标转起来，作为「可以点」的反馈。 */
.dshr-float-btn{position:fixed;right:20px;bottom:20px;z-index:12000;pointer-events:auto;
  box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;
  width:32px;height:32px;padding:0;margin:0;
  border:1px solid var(--dsw-alias-border-l2);border-radius:50%;
  background:var(--dsw-alias-bg-overlay);cursor:pointer;
  color:var(--dsw-alias-label-secondary);
  box-shadow:0 2px 10px rgba(0,0,0,.2);
  transition:background .15s,color .15s,box-shadow .15s}
.dshr-float-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);box-shadow:0 4px 16px rgba(0,0,0,.28)}
.dshr-float-btn:disabled{opacity:.5;cursor:default}
/* hover 时图标转满一圈。
   ⚠️ 必须是 **360°**，不能是 270° 之类的非整圈角度：动画结束后样式会撤销、
   图标回到 transform:none，若终点不是整圈就会「啪」地弹回原位，很突兀。
   转满 360° 时终点与起点视觉完全一致，撤销样式时看不出跳变。 */
.dshr-float-btn:hover:not(:disabled) .dshr-float-icon{animation:dshr-float-spin .55s ease-in-out}
@keyframes dshr-float-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){
  .dshr-float-btn:hover:not(:disabled) .dshr-float-icon{animation:none}
}
/* 「更多」菜单里的一行。宿主 MenuItemButton 的高度/字号/hover 照抄：
   32px 高、14px 字号、圆角、hover 用 interactive-bg-hover。
   宽度 100% 撑满菜单（宿主菜单宽 288px）。 */
.dshr-menu-item{box-sizing:border-box;display:flex;align-items:center;gap:10px;
  width:100%;min-height:32px;padding:0 10px;margin:0;
  border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;
  text-align:left}
.dshr-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshr-menu-item:disabled{opacity:.5;cursor:default}
.dshr-menu-item-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:16px;height:16px;color:var(--dsw-alias-label-secondary)}
.dshr-menu-item-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshr-spin{animation:dshr-rotate 1s linear infinite}
@keyframes dshr-rotate{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dshr-spin{animation:none}}
.dshr-section{display:flex;flex-direction:column;gap:10px;padding:2px 0}
.dshr-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dshr-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshr-section-desc{margin-top:4px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dshr-section-actions{display:flex;gap:8px;flex-wrap:wrap}
.dshr-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding-top:10px;margin-top:2px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshr-toggle-label{min-width:0}
.dshr-toggle-title{font-size:13px;color:var(--dsw-alias-label-primary)}
.dshr-toggle-desc{margin-top:2px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dshr-pending{margin-top:2px;font-size:12px;color:var(--dsw-alias-state-warning-primary,#c98a00)}
.dshr-switch{position:relative;display:inline-flex;align-items:center;width:34px;height:20px;flex:none;
  border-radius:999px;border:none;cursor:pointer;padding:0;background:var(--dsw-alias-bg-layer-3,#3a3a3a);
  transition:background .15s}
.dshr-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.dshr-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:transform .15s}
.dshr-switch[aria-checked="true"]::after{transform:translateX(14px)}
.dshr-switch:disabled{opacity:.5;cursor:default}
.dshr-modal-mask{position:fixed;inset:0;z-index:12000;background:rgba(0,0,0,.42);
  display:flex;align-items:center;justify-content:center;padding:24px}
.dshr-modal{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:12px;width:min(520px,92vw);
  box-shadow:0 12px 40px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden}
.dshr-modal-head{padding:16px 18px 0;font-size:15px;font-weight:600}
.dshr-modal-body{padding:10px 18px 16px;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary)}
.dshr-modal-desc{color:var(--dsw-alias-label-secondary)}
.dshr-task-group{margin-top:12px}
.dshr-task-kind{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.dshr-task-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:12px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.dshr-task-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshr-task-state{flex:none;color:var(--dsw-alias-label-secondary)}
.dshr-task-more{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshr-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;
  border-top:1px solid var(--dsw-alias-border-l1)}
/* 重启遮罩。
   ⚠️ 背景色必须用 --dsw-alias-bg-mask-*（真正的半透明遮罩色：深色 #00000080、
   浅色 #0000003d），不能用 --dsw-alias-bg-base——后者是「不透明的页面底色」，
   跟页面背景同色，盖上去等于没盖，用户看到的就是「没有出现蒙版」。
   这里再叠一层 backdrop-filter 让底下的界面明显失焦。 */
.dshr-lock{position:fixed;inset:0;z-index:12001;
  background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
  color:var(--dsw-alias-label-primary);cursor:wait}
/* 遮罩中央的提示卡片：深色遮罩上直接放浅色文字在浅色主题下会糊，
   所以文字放进一个有底色与边框的卡片里。 */
.dshr-lock-card{display:flex;flex-direction:column;align-items:center;gap:8px;
  padding:20px 28px;border-radius:12px;max-width:min(420px,86vw);text-align:center;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);
  box-shadow:0 12px 40px rgba(0,0,0,.28)}
.dshr-lock-title{font-size:15px;font-weight:600}
.dshr-lock-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}
/* 遮罩里的转圈指示器（与 .dshr-spin 同一套 keyframes）。 */
.dshr-lock-spinner{width:22px;height:22px;border-radius:50%;flex:none;
  border:2px solid var(--dsw-alias-border-l2);
  border-top-color:var(--dsw-alias-brand-primary);
  animation:dshr-rotate .9s linear infinite}
/* toast 放在顶部：底部会跟输入框、状态栏挤在一起，而且重启遮罩也在中间，
   顶部更容易被注意到。
   --dsh-frame-chrome-top 是宿主自己的窗口标题栏高度变量（设置面板的遮罩
   也用它：inset: var(--dsh-frame-chrome-top,0px) 0 0），加上它才不会
   被标题栏压住。 */
.dshr-toast{position:fixed;left:50%;top:calc(var(--dsh-frame-chrome-top,0px) + 16px);
  transform:translateX(-50%);z-index:12002;
  display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:10px;font-size:13px;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 28px rgba(0,0,0,.28);max-width:min(520px,90vw)}
.dshr-toast-error{border-color:var(--dsw-alias-state-error-primary)}
`

    /* ---------------------------------------------------------------- */
    /*  HTTP                                                             */
    /* ---------------------------------------------------------------- */

    /** 同源相对路径解析（保留反代目录前缀；desktop shell 转发到 Host）。 */
    function apiUrl(path) {
      const base =
        typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://dsh.internal/'
      return new URL(`api/dsh-reload/${path}`.replace(/^\/+/, ''), base).toString()
    }

    /**
     * 调用 Host。
     *
     * 桌面端页面走 `dsh-app://app`，请求由主进程代理到 Host（剥掉 Origin/Host），
     * 所以同源相对路径在两种部署下都成立；`cache: 'no-store'` 防止状态被缓存。
     *
     * @param path - 相对方法名（ping/status/hot-reload/restart/pending-restart）。
     * @param method - HTTP 方法。
     * @returns Host 返回的 `data` 字段。
     */
    async function api(path, method = 'GET') {
      const response = await fetch(apiUrl(path), {
        method,
        cache: 'no-store',
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload?.error?.message || `HTTP ${response.status}`)
        error.code = payload?.error?.code
        error.data = payload?.data
        throw error
      }
      return payload.data
    }

    /* ---------------------------------------------------------------- */
    /*  图标                                                             */
    /* ---------------------------------------------------------------- */

    /** 热重载图标：环形箭头。`spinning` 时旋转。 */
    function ReloadIcon({ spinning, size = 15 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className: spinning ? 'dshr-spin' : undefined,
          'aria-hidden': true,
        },
        h('path', { d: 'M21 12a9 9 0 1 1-3.2-6.9' }),
        h('polyline', { points: '21 3 21 9 15 9' }),
      )
    }

    /* ---------------------------------------------------------------- */
    /*  命令式浮层（遮罩 / toast）                                        */
    /* ---------------------------------------------------------------- */

    /**
     * 直接挂到 body 的浮层容器。
     *
     * 为什么不用 React 槽位：遮罩必须盖住设置面板（z-index 1000–1100），
     * 而槽位渲染出的节点被困在槽位的层叠上下文里，再高的 z-index 也无效。
     */
    let overlayRoot = null
    let overlayRefs = 0

    /** 取得（或创建）body 级浮层容器。 */
    function acquireOverlayRoot() {
      overlayRefs += 1
      if (overlayRoot === null) {
        overlayRoot = document.createElement('div')
        overlayRoot.dataset.plugin = 'dsh-reload'
        document.body.appendChild(overlayRoot)
      }
      return overlayRoot
    }

    /** 归还容器；最后一个使用者释放时移除。 */
    function releaseOverlayRoot() {
      overlayRefs = Math.max(0, overlayRefs - 1)
      if (overlayRefs === 0 && overlayRoot !== null) {
        overlayRoot.remove()
        overlayRoot = null
      }
    }

    /** 当前 toast 元素与定时器。 */
    let toastEl = null
    let toastTimer = null

    /**
     * 显示一条 toast。
     * @param text - 文案。
     * @param isError - 是否错误样式。
     */
    function showToast(text, isError = false) {
      const root = acquireOverlayRoot()
      if (toastEl !== null) toastEl.remove()
      if (toastTimer !== null) clearTimeout(toastTimer)

      const el = document.createElement('div')
      el.className = isError ? 'dshr-toast dshr-toast-error' : 'dshr-toast'
      el.setAttribute('role', isError ? 'alert' : 'status')
      el.textContent = text
      root.appendChild(el)
      toastEl = el

      toastTimer = setTimeout(() => {
        el.remove()
        toastEl = null
        toastTimer = null
        releaseOverlayRoot()
      }, isError ? 6000 : 3200)
    }

    /** 当前重启遮罩元素。 */
    let lockEl = null
    /** 重启锁定超时定时器。 */
    let lockTimer = null
    /** 由遮罩创建的解锁函数，供插件卸载时调用。 */
    let releaseLock = null

    /**
     * 升起重启遮罩并锁定界面。
     *
     * 锁定必须在**点击瞬间**开始，不能等 HTTP 返回：POST 往返 + Host 二次查任务
     * 可能上百毫秒，这期间用户完全可能再点一次或去别处操作。
     *
     * @param title - 主文案。
     * @param hint - 次要说明。
     * @returns 解锁函数（幂等）。
     */
    function lockUI(title, hint) {
      if (lockEl !== null) return releaseLock ?? (() => {})
      const root = acquireOverlayRoot()

      const el = document.createElement('div')
      el.className = 'dshr-lock'
      el.setAttribute('role', 'alertdialog')
      el.setAttribute('aria-busy', 'true')
      el.setAttribute('aria-live', 'assertive')

      const card = document.createElement('div')
      card.className = 'dshr-lock-card'

      // 转圈指示器：光有文字会让人怀疑「是不是卡住了」，动起来才像在做事。
      const spinnerEl = document.createElement('div')
      spinnerEl.className = 'dshr-lock-spinner'
      spinnerEl.setAttribute('aria-hidden', 'true')

      const titleEl = document.createElement('div')
      titleEl.className = 'dshr-lock-title'
      titleEl.textContent = title
      const hintEl = document.createElement('div')
      hintEl.className = 'dshr-lock-hint'
      hintEl.textContent = hint

      card.append(spinnerEl, titleEl, hintEl)
      el.appendChild(card)
      root.appendChild(el)
      lockEl = el

      // 兜底：页面在锁定后仍存活，说明重启没有真正发生（或 restarter 失败）。
      // 不解除的话，用户会卡在一个永远不消失的遮罩上，而进程还活着。
      lockTimer = setTimeout(() => {
        releaseLock?.()
        showToast(currentT('toast.restartTimeout'), true)
      }, LOCK_TIMEOUT_MS)

      const unlock = () => {
        if (lockEl !== el) return
        if (lockTimer !== null) {
          clearTimeout(lockTimer)
          lockTimer = null
        }
        el.remove()
        lockEl = null
        releaseLock = null
        releaseOverlayRoot()
        wakeAll()
      }
      releaseLock = unlock
      wakeAll()
      return unlock
    }

    /* ---------------------------------------------------------------- */
    /*  locale 绑定                                                       */
    /* ---------------------------------------------------------------- */

    /**
     * 供**命令式**代码路径使用的翻译函数（toast、遮罩等 React 之外的地方）。
     *
     * React 组件一律从 props 取 `t`：注册选项里的 `locale: NS` 就是宿主注入
     * `t` 的开关，宿主自己的组件也是这么写的。这里只是把同一份 `t` 存一份到
     * 闭包，好让 `showToast()` 这类不经过 React 的调用也能拿到译文。
     *
     * （早期误以为槽位组件不能读 `props.t`，那是个误判，记录见 03-实现笔记 §3.2。）
     */
    let currentT = (key) => key

    /* ---------------------------------------------------------------- */
    /*  共享状态：跨两个槽位同步                                             */
    /* ---------------------------------------------------------------- */

    const listeners = new Set()

    /** 通知所有订阅者重新渲染。 */
    function wakeAll() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // 单个订阅者失败不该影响其他订阅者。
        }
      }
    }

    /**
     * 全局 UI 状态（各槽位共享，避免各存一份导致不同步）。
     *
     * **三个入口默认全部关闭**：本插件追求轻量，不主动往界面上塞东西，
     * 用户需要时自己在插件详情页里打开。
     */
    const state = {
      reloading: false,
      restarting: false,
      sidebarVisible: false,
      floatingVisible: false,
      pending: null,
    }

    /** 订阅状态变化。 */
    function useSharedState() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => listeners.delete(force)
      }, [force])
    }

    /* ---------------------------------------------------------------- */
    /*  动作                                                             */
    /* ---------------------------------------------------------------- */

    /**
     * 执行热重载。热重载对会话无破坏性，因此**不弹任何确认框**，直接执行。
     */
    async function doHotReload() {
      if (state.reloading || state.restarting) return
      state.reloading = true
      wakeAll()
      try {
        const result = await api('hot-reload', 'POST')
        if (result.changed) {
          showToast(currentT('toast.reloaded').replace('{n}', String(result.replacedPlugins.length)))
        } else {
          showToast(currentT('toast.unchanged'))
        }
        if (Array.isArray(result.notes) && result.notes.length > 0) {
          // notes 是「需要重启客户端」这类重要提示，用错误色延长展示。
          showToast(result.notes.join('；'), true)
        }
        state.pending = result.notes ?? null
      } catch (error) {
        showToast(currentT('toast.reloadFailed').replace('{message}', String(error?.message ?? error)), true)
      } finally {
        state.reloading = false
        wakeAll()
      }
    }

    /**
     * 点「重启客户端」的第一步：查状态，决定弹提示框还是确认框。
     *
     * 三种情况，分流依据是**重启会不会毁掉用户看不见的工作**：
     *
     *  - 会话或后台任务在跑 → 只读提示框（**没有重启选项**）。它们跑在
     *    Host 里，重启必然中断，用户还没法从界面上看出「断在半路」的状态。
     *  - 只有终端开着 → 确认框，**并把终端列出来**。终端不参与 `active`
     *    判定（见 lib/activity.js）：无头终端、已卡死的终端都很常见，把它
     *    当成硬拦截会让用户卡在「关不掉也重启不了」的死角，只能强杀进程
     *    —— 那比重启更糟。所以改成「说清楚会关掉哪些，你确认就放行」。
     *  - 什么都没有 → 普通确认框。
     */
    async function beginRestart(openModal) {
      if (state.reloading || state.restarting) return
      try {
        const status = await api('status')
        if (!status.restatable) {
          openModal({
            kind: 'info',
            title: currentT('modal.busyTitle'),
            desc: status.restartBlockedReason || currentT('restart.unsupported'),
          })
          return
        }
        if (status.activity?.active === true) {
          openModal({ kind: 'busy', activity: status.activity })
          return
        }
        // 终端只提醒、不拦截：把它们交给确认框展示。
        const terminals = status.activity?.terminals ?? []
        if (terminals.length > 0) {
          openModal({ kind: 'confirm', activity: status.activity })
          return
        }
        openModal({ kind: 'confirm' })
      } catch (error) {
        showToast(currentT('toast.statusFailed').replace('{message}', String(error?.message ?? error)), true)
      }
    }

    /**
     * 真正执行重启。**先上升遮罩再发请求**——锁定必须早于网络往返。
     *
     * 只有 200 才保持锁定（窗口即将消失）；任何失败都必须立刻解锁，
     * 否则用户会卡在冻结的界面上而进程还活着。
     */
    async function performRestart() {
      if (state.restarting) return
      state.restarting = true
      wakeAll()

      const unlock = lockUI(currentT('modal.restarting'), currentT('modal.restartingHint'))

      try {
        await api('restart', 'POST')
        // 成功：保持锁定，等主进程收掉窗口。不再轮询、不再刷新——
        // 窗口会随主进程一起消失，不存在「活着的页面在等新实例」。
      } catch (error) {
        unlock()
        state.restarting = false
        wakeAll()
        if (error?.code === 'busy') {
          // 查询与执行之间冒出了任务：Host 拒绝执行，改用只读提示框展示。
          showToast(currentT('modal.busyDesc'), true)
        } else {
          showToast(
            currentT('toast.restartFailed').replace('{message}', String(error?.message ?? error)),
            true,
          )
        }
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Modal                                                            */
    /* ---------------------------------------------------------------- */

    /**
     * 自绘 Modal。`role="dialog"` + `aria-modal`，Esc 关闭，初始焦点落在主按钮。
     *
     * @param props - `{ spec, t, onClose, onRestart }`
     */
    function Modal({ spec, t, onClose, onRestart }) {
      const primaryRef = React.useRef(null)
      const isConfirm = spec.kind === 'confirm'

      React.useEffect(() => {
        primaryRef.current?.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const title = spec.kind === 'busy' ? t('modal.busyTitle') : isConfirm ? t('modal.confirmTitle') : spec.title
      // 确认框带 activity 时，说明「只有终端在开着」：换个说法，别再说
      // 「当前没有任务在运行」——那句话在终端可见的情况下是自相矛盾的。
      const hasTerminals = isConfirm && (spec.activity?.terminals?.length ?? 0) > 0
      const desc = spec.kind === 'busy'
        ? t('modal.busyDesc')
        : hasTerminals
          ? t('modal.confirmTerminalsDesc')
          : isConfirm
            ? t('modal.confirmDesc')
            : spec.desc

      const children = [
        h('div', { className: 'dshr-modal-head', key: 'head' }, title),
        h(
          'div',
          { className: 'dshr-modal-body', key: 'body' },
          h('div', { className: 'dshr-modal-desc' }, desc),
          // 提示框列出「谁在拦」，终端确认框列出「哪些会被一起关掉」。
          spec.kind === 'busy' || hasTerminals
            ? h(TaskList, { activity: spec.activity, t })
            : null,
        ),
        h(
          'div',
          { className: 'dshr-modal-foot', key: 'foot' },
          isConfirm
            ? h(
                'button',
                { className: 'dshr-btn', onClick: onClose, key: 'cancel' },
                t('modal.confirmCancel'),
              )
            : null,
          h(
            'button',
            {
              key: 'ok',
              ref: primaryRef,
              className: isConfirm ? 'dshr-btn dshr-btn-danger' : 'dshr-btn dshr-btn-primary',
              onClick: isConfirm ? onRestart : onClose,
            },
            isConfirm ? t('modal.confirmOk') : t('modal.ok'),
          ),
        ),
      ]

      return h(
        'div',
        {
          className: 'dshr-modal-mask',
          onMouseDown: (event) => {
            // 点遮罩空白处关闭；点对话框内部不关。
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'dshr-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          ...children,
        ),
      )
    }

    /**
     * 提示框里的在飞任务清单：分类列，每类最多 3 条（Host 侧已截断），
     * 超过的部分用「等 N 个」提示。
     */
    function TaskList({ activity, t }) {
      const groups = [
        {
          kind: 'agents',
          label: t('modal.busyAgents'),
          total: activity.counts?.agents ?? activity.agents?.length ?? 0,
          rows: (activity.agents ?? []).map((entry) => ({
            name: entry.title || t('modal.busyUntitled'),
            status: entry.status === 'queued' ? t('modal.busyQueued') : t('modal.busyRunning'),
          })),
        },
        {
          kind: 'jobs',
          label: t('modal.busyJobs'),
          total: activity.counts?.jobs ?? activity.jobs?.length ?? 0,
          rows: (activity.jobs ?? []).map((entry) => ({
            name: entry.label,
            status: t('modal.busyRunning'),
          })),
        },
        {
          kind: 'terminals',
          label: t('modal.busyTerminals'),
          total: activity.counts?.terminals ?? activity.terminals?.length ?? 0,
          rows: (activity.terminals ?? []).map((entry) => ({
            name: entry.title,
            status: t('modal.busyRunning'),
          })),
        },
      ].filter((group) => group.rows.length > 0)

      if (groups.length === 0) return null

      return h(
        'div',
        null,
        ...groups.map((group) =>
          h(
            'div',
            { className: 'dshr-task-group', key: group.kind },
            h('div', { className: 'dshr-task-kind' }, group.label),
            ...group.rows.map((row, index) =>
              h(
                'div',
                { className: 'dshr-task-row', key: `${group.kind}-${index}` },
                h('span', { className: 'dshr-task-name' }, row.name),
                h('span', { className: 'dshr-task-state' }, row.status),
              ),
            ),
            group.total > group.rows.length
              ? h(
                  'div',
                  { className: 'dshr-task-more' },
                  t('modal.busyMore').replace('{n}', String(group.total - group.rows.length)),
                )
              : null,
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------- */
    /*  侧边栏按钮                                                        */
    /* ---------------------------------------------------------------- */

    /**
     * `sidebar.footer.action` 的按钮。点击即热重载，不弹任何框。
     *
     * **展开时带文字标签**：宿主自己的 Settings 按钮在 `wide` 下是
     * 「图标 + 文字」（`IconSettingsOutlineMedium` + `triggerLabel`，高度 42px、
     * 字号 14px、`padding: 0 10px 0 8px`）。只放一个光秃秃的图标会跟旁边
     * 那行不搭，所以这里照抄同一套尺寸与间距。
     *
     * 窄栏（`wide === false`，36/56px 竖排）只留图标——那时没有横向空间放字。
     *
     * `t` 来自注册选项的 `locale: NS`（宿主用同一契约注入）。
     */
    function SidebarButton({ wide, t }) {
      useSharedState()

      if (!state.sidebarVisible) return null

      const busy = state.reloading || state.restarting
      const label = state.reloading ? t('action.reloading') : t('action.reload')

      return h(
        'button',
        {
          type: 'button',
          // 展开时用宿主 Settings 触发器的同款外观（42px 高、图标+文字），
          // 折叠时退回紧凑图标按钮。
          className: wide ? 'dshr-footer-btn' : 'dshr-icon-btn',
          title: label,
          'aria-label': label,
          disabled: busy,
          onClick: () => void doHotReload(),
        },
        h(ReloadIcon, { spinning: state.reloading, size: wide ? 16 : 15 }),
        wide ? h('span', { className: 'dshr-footer-btn-label' }, label) : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /*  右下角悬浮按钮                                                     */
    /* ---------------------------------------------------------------- */

    /**
     * `shell.overlay` 的悬浮按钮：固定在窗口右下角，**只有图标**（32px 圆形）。
     *
     * 宿主对该槽位的说明明确鼓励这类用途：「a badge, a toast stack or a status pill
     * all belong here」；层本身 `pointer-events: none`，占用者自己 `auto` 回来，
     * 所以不会挡住底下的界面。
     *
     * 右下角在多数界面都是空的（对话流靠左、输入框居中偏下），且**不受侧边栏
     * 折叠影响**，是「随时都能点到」的兜底入口。
     *
     * 不放文字：一行文字会把它变成 100px 宽的胶囊，在右下角过于显眼。
     * 可读性交给 `title` / `aria-label`（悬停有 tooltip），
     * 「这是个刷新按钮」由 hover 时的旋转动画表达（见 CSS `.dshr-float-icon`）。
     */
    function FloatingButton({ t }) {
      useSharedState()

      if (!state.floatingVisible) return null

      const busy = state.reloading || state.restarting
      const label = state.reloading ? t('action.reloading') : t('action.reload')

      return h(
        'button',
        {
          type: 'button',
          className: 'dshr-float-btn',
          title: label,
          'aria-label': label,
          disabled: busy,
          onClick: () => void doHotReload(),
        },
        // `dshr-float-icon` 只用于挂 hover 旋转动画，不参与布局。
        h('span', { className: 'dshr-float-icon' }, h(ReloadIcon, { spinning: state.reloading, size: 16 })),
      )
    }

    /* ---------------------------------------------------------------- */
    /*  侧边栏「更多」菜单里的一行                                          */
    /* ---------------------------------------------------------------- */

    /**
     * `sidebar.panellist.actions`：侧边栏「更多」展开菜单里的一行「刷新插件」。
     *
     * 为什么叫「刷新插件」而不是「热重载」：这个菜单里全是**用户视角**的功能
     * （插件、自动化任务、上下文洞察、浏览更多插件），「热重载」是开发术语，
     * 放在这里格格不入；「刷新插件」说的是用户看到的效果。
     *
     * 官方规则不允许 require 宿主 primitives 包（`MenuItemButton` 在那里），
     * 所以这里**自绘菜单行**，尺寸与行为照抄宿主 `entry-customization` 的
     * `MenuItemButton` 用法：高度 32px、图标 16px、字号 14px、hover 底色。
     *
     * owner props 里有 `onDismiss`（关闭菜单）。点击后先关菜单再执行——
     * 菜单是 portal 浮层，不关掉会一直压在界面上。
     */
    function MoreMenuItem({ t, onDismiss }) {
      useSharedState()
      const busy = state.reloading || state.restarting
      // 这一行用「刷新插件」的说法（`action.refresh`），不用开发术语「热重载」。
      const label = state.reloading ? t('action.refreshing') : t('action.refresh')

      const select = () => {
        // 先关菜单：热重载是异步的，菜单不该一直开着。
        if (typeof onDismiss === 'function') onDismiss()
        void doHotReload()
      }

      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'dshr-menu-item',
          disabled: busy,
          onClick: select,
        },
        h('span', { className: 'dshr-menu-item-icon' }, h(ReloadIcon, { spinning: state.reloading, size: 16 })),
        h('span', { className: 'dshr-menu-item-label' }, label),
      )
    }

    /**
     * 读取一个布尔型本地偏好。
     *
     * **默认关闭**：只有明确存过 `'1'` 才算开启；没存过（首次安装）或读不到
     * （无痕模式）都按**关闭**处理。本插件追求轻量，不主动往界面上塞东西，
     * 用户需要时自己在插件详情页里打开。
     *
     * @param key - localStorage 键。
     * @returns 是否显示。
     */
    function readPref(key) {
      try {
        return window.localStorage.getItem(key) === '1'
      } catch {
        return false
      }
    }

    /* ---------------------------------------------------------------- */
    /*  开关行（插件页与通用页共用）                                        */
    /* ---------------------------------------------------------------- */

    /**
     * 渲染一行「标题 + 说明 + 右侧开关」。
     *
     * 抽出来是因为插件页有两个同类开关（侧边栏 / 右下角悬浮），
     * 复制两遍既啰嗦又容易让某一行漏掉 `aria-checked`。
     *
     * @param t - 翻译函数。
     * @param keyPrefix - 文案键前缀；实际读 `${keyPrefix}` 与 `${keyPrefix}Desc`。
     * @param checked - 当前是否开启。
     * @param onToggle - 点击切换。
     * @returns 一行开关的 vnode。
     */
    function makeToggle(t, keyPrefix, checked, onToggle) {
      const title = t(keyPrefix)
      return h(
        'div',
        { className: 'dshr-toggle-row', key: keyPrefix },
        h(
          'div',
          { className: 'dshr-toggle-label' },
          h('div', { className: 'dshr-toggle-title' }, title),
          h('div', { className: 'dshr-toggle-desc' }, t(`${keyPrefix}Desc`)),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dshr-switch',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': title,
            title,
            onClick: onToggle,
          },
          null,
        ),
      )
    }

    /* ---------------------------------------------------------------- */
    /*  插件详情页卡片                                                     */
    /* ---------------------------------------------------------------- */

    /**
     * 本插件在「设置 → 插件」里自己那一页的卡片。
     *
     * 挂在 `plugins.bundle.config`（keyed，key = 包名）上：插件管理页按
     * `ledger.bundles.has(pkg.name)` 决定要不要渲染这一段，而 `ledger.bundles`
     * 正是这个槽位上注册过的 key 集合——所以 key 必须**恰好等于包名**
     * `dsh-reload`，写成 Loader entry id（`reload` / `include:reload`）都不会出现。
     *
     * owner props 是 `{ view, form }`，`view: 'summary'` 时宿主只取一行摘要，
     * 本卡片没有摘要语义，直接返回 null。
     *
     * `t` 来自注册选项的 `locale: NS`（与宿主自己的组件同一契约），不从 props 之外猜。
     *
     * 为什么入口从「通用设置」搬到这里：通用页是全局偏好，而这两个动作属于
     * 本插件自己；插件页是用户看这个插件的地方，开关和按钮放在这里才符合语境。
     */
    function PluginPageCard({ t, view }) {
      useSharedState()
      const [modal, setModal] = React.useState(null)

      // 摘要视图不渲染任何内容（宿主可能用 `view: 'summary'` 取一行）。
      if (view === 'summary') return null

      const busy = state.reloading || state.restarting

      const closeModal = () => setModal(null)
      const confirmRestart = () => {
        setModal(null)
        void performRestart()
      }

      const toggleSidebar = () => {
        state.sidebarVisible = !state.sidebarVisible
        try {
          window.localStorage.setItem(PREF_KEY, state.sidebarVisible ? '1' : '0')
        } catch {
          // 无痕模式等场景不持久化，仅本页生效。
        }
        wakeAll()
      }

      const toggleFloating = () => {
        state.floatingVisible = !state.floatingVisible
        try {
          window.localStorage.setItem(PREF_FLOATING_KEY, state.floatingVisible ? '1' : '0')
        } catch {
          // 同上。
        }
        wakeAll()
      }

      const pendingHint =
        Array.isArray(state.pending) && state.pending.length > 0
          ? t('pending.hint').replace('{n}', String(state.pending.length))
          : null

      return h(
        'div',
        { className: 'dshr-section' },
        h('div', { className: 'dshr-section-title' }, t('section.title')),
        h('div', { className: 'dshr-section-desc' }, t('section.desc')),
        pendingHint !== null ? h('div', { className: 'dshr-pending' }, pendingHint) : null,
        h(
          'div',
          { className: 'dshr-section-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshr-btn dshr-btn-primary',
              disabled: busy,
              onClick: () => void doHotReload(),
            },
            h(ReloadIcon, { spinning: state.reloading }),
            state.reloading ? t('action.reloading') : t('action.reload'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshr-btn dshr-btn-danger',
              disabled: busy,
              onClick: () => void beginRestart(setModal),
            },
            t('action.restart'),
          ),
        ),
        // 两个「在哪儿显示」开关。每个都带可见文字标签与说明：
        // 只放 tooltip 的话用户看不出它是做什么的。**默认都关**，用户自己开。
        makeToggle(t, 'section.sidebarToggle', state.sidebarVisible, toggleSidebar),
        makeToggle(t, 'section.floatingToggle', state.floatingVisible, toggleFloating),
        modal !== null
          ? h(Modal, { spec: modal, t, onClose: closeModal, onRestart: confirmRestart })
          : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /*  设置面板顶栏右侧的两个按钮                                          */
    /* ---------------------------------------------------------------- */

    /**
     * `settings.action`：设置面板顶栏右侧（Close 左边）的「热重载」「重启客户端」。
     *
     * 位置约束来自宿主（`ui-settings-general` 的 `SettingsPanel`）：
     *   `.content > .header` 高 54px、`padding: 20px 14px 8px 10px`
     *   `.actions` 是 `justify-content:flex-end; align-items:center; gap:8px`
     *   Close 按钮 28×28
     *
     * 所以这里用**紧凑按钮**（28px 高、12px 字号），保证不撑高顶栏、也不跟
     * Close 抢视线。「重启客户端」保留危险色以示区别。
     *
     * 该槽位是 root scope，任何设置页都会渲染；这符合「随时能热重载」的预期。
     */
    function SettingsHeaderActions({ t }) {
      useSharedState()
      const [modal, setModal] = React.useState(null)
      const busy = state.reloading || state.restarting

      const closeModal = () => setModal(null)
      const confirmRestart = () => {
        setModal(null)
        void performRestart()
      }

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dshr-hdr-btn',
            title: t('action.reload'),
            'aria-label': t('action.reload'),
            disabled: busy,
            onClick: () => void doHotReload(),
          },
          h(ReloadIcon, { spinning: state.reloading, size: 13 }),
          h('span', { className: 'dshr-hdr-btn-label' }, state.reloading ? t('action.reloading') : t('action.reload')),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dshr-hdr-btn dshr-hdr-btn-danger',
            title: t('action.restart'),
            'aria-label': t('action.restart'),
            disabled: busy,
            onClick: () => void beginRestart(setModal),
          },
          t('action.restart'),
        ),
        modal !== null
          ? h(Modal, { spec: modal, t, onClose: closeModal, onRestart: confirmRestart })
          : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /*  入口                                                              */
    /* ---------------------------------------------------------------- */

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.locale.register(NS, { zh, en })
      const t = ctx.locale.bind(NS)
      currentT = t

      // 读取两个入口的显示偏好。**默认关闭**（`readPref` 的默认值见下），
      // 用户需要时自己在插件详情页里打开——插件不主动往界面上塞东西。
      state.sidebarVisible = readPref(PREF_KEY)
      state.floatingVisible = readPref(PREF_FLOATING_KEY)

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-reload'
        style.textContent = STYLE
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-reload: styles')

      // 卸载时收回遮罩与 toast：否则插件被热重载替换后会留下孤儿 DOM。
      ctx.effect(
        () => () => {
          releaseLock?.()
          if (toastEl !== null) toastEl.remove()
          if (toastTimer !== null) clearTimeout(toastTimer)
          toastEl = null
          toastTimer = null
          listeners.clear()
          if (overlayRoot !== null) {
            overlayRoot.remove()
            overlayRoot = null
            overlayRefs = 0
          }
        },
        'dsh-reload: overlays',
      )

      // 启动后问一次「上次是不是刚重启过」：读到标记就提示一次并清掉。
      //
      // 放在 apply 而不是卡片组件里：卡片只在用户打开插件详情页时才挂载，
      // 而这条提示应该在应用启动后就出现，且只出现一次。
      void (async () => {
        try {
          const data = await api('pending-restart', 'POST')
          if (data?.pending) showToast(currentT('toast.restarted'))
        } catch {
          // 读不到标记不影响任何功能。
        }
      })()

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-reload:button', order: 10, locale: NS },
          SidebarButton,
        ),
      )

      // 整窗浮层的右下角悬浮按钮。宿主说明里明确鼓励这类用途。
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-reload:floating', order: 900, locale: NS },
          FloatingButton,
        ),
      )

      // 侧边栏「更多」菜单里的一行。放在 order 100，排在宿主那两行之后。
      ctx.slots.inject('sidebar.panellist.actions', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist.actions', id: 'dsh-reload:more-menu', order: 100, locale: NS },
          MoreMenuItem,
        ),
      )

      // 卡片挂在插件管理页自己的 bundle 配置位上，key 必须是**包名**：
      // 插件页用 `ledger.bundles.has(pkg.name)` 决定是否渲染，而那个 Set 就是
      // 本槽位上注册过的 key。写成 Loader entry id 会静默不显示。
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          { name: 'plugins.bundle.config', key: PKG_NAME, locale: NS },
          PluginPageCard,
        ),
      )

      // 设置面板顶栏右侧（Close 左边）的两个按钮。
      //
      // 宿主把 `settings.action` 渲染在 `.content > .header > .actions` 里
      // （`justify-content:flex-end`，高 54px，gap 8px，Close 28×28），所以这里
      // 必须给**紧凑尺寸**：按钮比正文里的小一号，不能撑高顶栏。
      //
      // 这个槽位是 root scope、在任何设置页都渲染（不只是「账户与余额」），
      // 这是官方扩展点里最接近「设置面板底部/角落」的位置，且不依赖宿主 CSS 结构。
      ctx.slots.inject('settings.action', () =>
        ctx.slots.register(
          { name: 'settings.action', id: 'dsh-reload:header-actions', order: 10, locale: NS },
          SettingsHeaderActions,
        ),
      )
    }

    return { inject, apply }
  },
})
