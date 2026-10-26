/**
 * dsh-reload — 浏览器半边。
 *
 * 两块 UI，都经 slots 注册到宿主声明过的槽位：
 *  1. `sidebar.footer.action`（order 10）：热重载图标按钮，点击即执行。
 *  2. `settings.general.item`（order 110）：「通用」页最后一行，
 *     含侧边栏按钮开关 + 「热重载」「重启客户端」两个按钮。
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

    /** 侧边栏按钮显示开关的本地偏好键。 */
    const PREF_KEY = 'dsh-reload:sidebar-button'

    /** 重启锁定超时：超过这个时间页面还活着，说明重启没发生，自动解锁。 */
    const LOCK_TIMEOUT_MS = 8000

    /** 重启后等新实例的轮询上限——这里只用于「遮罩期间页面仍存活」的兜底。 */
    const PENDING_POLL_MS = 1500

    const zh = {
      'action.reload': '热重载',
      'action.reloading': '重载中…',
      'action.restart': '重启客户端',
      'action.restarting': '正在重启…',
      'section.title': '热重载',
      'section.desc': '重新加载文件有改动的插件，不中断会话。',
      'section.sidebarToggle': '在侧边栏显示热重载按钮',
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
      'action.restart': 'Restart app',
      'action.restarting': 'Restarting…',
      'section.title': 'Hot reload',
      'section.desc': 'Reload plugins whose files changed without interrupting sessions.',
      'section.sidebarToggle': 'Show the hot reload button in the sidebar',
      'toast.unchanged': 'No changes detected (the build may not have run yet)',
      'toast.reloaded': 'Hot reloaded {n} plugin(s)',
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
.dshr-spin{animation:dshr-rotate 1s linear infinite}
@keyframes dshr-rotate{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dshr-spin{animation:none}}
.dshr-section{display:flex;flex-direction:column;gap:10px;padding:2px 0}
.dshr-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dshr-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshr-section-desc{margin-top:4px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dshr-section-actions{display:flex;gap:8px;flex-wrap:wrap}
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
.dshr-lock{position:fixed;inset:0;z-index:12001;background:var(--dsw-alias-bg-base,rgba(0,0,0,.72));
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
  color:var(--dsw-alias-label-primary);cursor:wait}
.dshr-lock-title{font-size:15px;font-weight:600}
.dshr-lock-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshr-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:12002;
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
    function ReloadIcon({ spinning }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 15,
          height: 15,
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

      const titleEl = document.createElement('div')
      titleEl.className = 'dshr-lock-title'
      titleEl.textContent = title
      const hintEl = document.createElement('div')
      hintEl.className = 'dshr-lock-hint'
      hintEl.textContent = hint

      el.append(titleEl, hintEl)
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
     * 当前生效的翻译函数。
     *
     * 放在模块级而不是 `apply` 的局部：槽位组件定义在 `apply` 之外，只能从闭包
     * 读它。**不能**改成从 props 取——槽位只传自身声明的 owner props（
     * `sidebar.footer.action` 传 `{ wide }`，`settings.general.item` 传空），
     * 读 `props.t` 会在首次渲染就抛错，整个槽位条目被移除、界面上什么都不出现。
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

    /** 全局 UI 状态（两个槽位共享，避免各存一份导致不同步）。 */
    const state = {
      reloading: false,
      restarting: false,
      sidebarVisible: true,
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
     * 有任务 → 只读提示框（**没有重启选项**），安全优先；
     * 无任务 → 确认框，用户确认后才真正执行。
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
      const desc = spec.kind === 'busy' ? t('modal.busyDesc') : isConfirm ? t('modal.confirmDesc') : spec.desc

      const children = [
        h('div', { className: 'dshr-modal-head', key: 'head' }, title),
        h(
          'div',
          { className: 'dshr-modal-body', key: 'body' },
          h('div', { className: 'dshr-modal-desc' }, desc),
          spec.kind === 'busy' ? h(TaskList, { activity: spec.activity, t }) : null,
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
     * 窄栏（`wide === false`，56px）只显示图标。
     */
    /**
     * `sidebar.footer.action` 的按钮。点击即热重载，不弹任何框。
     * 窄栏（`wide === false`，56px）只显示图标。
     *
     * 翻译函数来自 apply 里绑定的闭包 `t`，不从 props 取：槽位只传自身声明的
     * owner props（这里是 `{ wide }`），不会传 `t`——从 props 读会让组件在渲染
     * 瞬间抛错，整个槽位条目被移除。
     */
    function SidebarButton({ t }) {
      useSharedState()

      if (!state.sidebarVisible) return null

      const busy = state.reloading || state.restarting
      const label = state.reloading ? t('action.reloading') : t('action.reload')

      return h(
        'button',
        {
          type: 'button',
          className: 'dshr-icon-btn',
          title: label,
          'aria-label': label,
          disabled: busy,
          onClick: () => void doHotReload(),
        },
        h(ReloadIcon, { spinning: state.reloading }),
      )
    }

    /* ---------------------------------------------------------------- */
    /*  设置行                                                            */
    /* ---------------------------------------------------------------- */

    /**
     * 「通用」设置页的最后一行：标题 + 侧边栏开关 + 两个动作按钮。
     *
     * 同样从闭包取 `t`：`settings.general.item` 的 owner props 是空接口
     * （`children?: never`），不传任何东西，读 props.t 会立即崩掉该行。
     */
    function SectionRow({ t }) {
      useSharedState()
      const [modal, setModal] = React.useState(null)
      const busy = state.reloading || state.restarting

      // 启动后问一次「上次是不是刚重启过」：读到标记就提示一次并清掉。
      React.useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const data = await api('pending-restart', 'POST')
            if (!cancelled && data?.pending) showToast(t('toast.restarted'))
          } catch {
            // 读不到标记不影响任何功能。
          }
        })()
        return () => {
          cancelled = true
        }
        // 依赖为空：`t` 由槽位的 `locale: NS` 声明注入，locale 变化时框架会重挂组件。
      }, [])

      const closeModal = React.useCallback(() => setModal(null), [])
      const confirmRestart = React.useCallback(() => {
        setModal(null)
        void performRestart()
      }, [])

      // 重启进行中：用 React 再画一层「正在重启」提示（遮罩由 lockUI 负责）。
      // 这里只做按钮态，避免两套 UI 打架。

      const toggleSidebar = React.useCallback(() => {
        state.sidebarVisible = !state.sidebarVisible
        try {
          window.localStorage.setItem(PREF_KEY, state.sidebarVisible ? '1' : '0')
        } catch {
          // 无痕模式等场景不持久化，仅本页生效。
        }
        wakeAll()
      }, [])

      const pendingHint =
        Array.isArray(state.pending) && state.pending.length > 0
          ? t('pending.hint').replace('{n}', String(state.pending.length))
          : null

      return h(
        'div',
        { className: 'dshr-section' },
        h(
          'div',
          { className: 'dshr-section-head' },
          h(
            'div',
            null,
            h('div', { className: 'dshr-section-title' }, t('section.title')),
            h('div', { className: 'dshr-section-desc' }, t('section.desc')),
            pendingHint !== null ? h('div', { className: 'dshr-pending' }, pendingHint) : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshr-switch',
              role: 'switch',
              'aria-checked': state.sidebarVisible ? 'true' : 'false',
              'aria-label': t('section.sidebarToggle'),
              title: t('section.sidebarToggle'),
              onClick: toggleSidebar,
            },
            null,
          ),
        ),
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

      // 读取侧边栏按钮的本地偏好。
      try {
        state.sidebarVisible = window.localStorage.getItem(PREF_KEY) !== '0'
      } catch {
        state.sidebarVisible = true
      }

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

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-reload:button', order: 10, locale: NS },
          SidebarButton,
        ),
      )

      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          { name: 'settings.general.item', id: 'dsh-reload:section', order: 110, locale: NS },
          SectionRow,
        ),
      )
    }

    return { inject, apply }
  },
})
