/**
 * 模拟渲染两个槽位组件，捕获首次渲染期的异常。
 *
 * 槽位注册存在但 `active: false`，说明注册成功、渲染抛错。这里用一个最小 React
 * 替身跑一遍组件函数体，把异常抓出来。
 *
 * 用法：node scripts/render-probe.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let registered = null
const appendChild = () => {}
const makeElement = (tag) => ({
  tag,
  dataset: {},
  style: {},
  children: [],
  textContent: '',
  className: '',
  appendChild,
  append(...nodes) {
    this.children.push(...nodes)
  },
  setAttribute() {},
  removeAttribute() {},
  addEventListener() {},
  removeEventListener() {},
  remove() {},
  querySelectorAll: () => [],
})

const documentStub = {
  createElement: makeElement,
  head: { appendChild },
  body: { appendChild },
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}

const storage = new Map()

const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (mod) => {
        registered = mod
      },
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
  },
  document: documentStub,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
  },
  setTimeout,
  clearTimeout,
  queueMicrotask,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
  console,
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: () => {},
}
sandbox.window.window = sandbox.window
sandbox.globalThis = sandbox

/** 最小 React 替身：只提供组件函数体会用到的 hook。 */
function makeReact() {
  const hooks = { count: 0 }
  return {
    createElement: (type, props, ...kids) => ({ type, props: props ?? {}, kids }),
    useReducer: (_fn, initial) => [initial, () => {}],
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    Fragment: 'Fragment',
  }
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

if (registered === null) {
  console.error('模块没有注册，__ModuleLoader__.load 未被调用')
  process.exit(2)
}

const React = makeReact()
const mod = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error(`client.js require 了未预期的模块：${name}`)
})

/**
 * 槽位注入记录。宿主在 owner 就绪时才调用 inject 的回调，所以这里只**收集**
 * 回调与一对 register 记录，稍后逐个执行——不能在执行 apply 期间就触发回调，
 * 否则拿不到正确的归属关系。
 */
const captures = []
let activeCapture = null
const ctx = {
  locale: {
    register() {},
    bind: () => (key) => key,
  },
  slots: {
    inject(key, callback) {
      const capture = { key, callback, entry: null, pending: true }
      captures.push(capture)
    },
    register(options, component) {
      if (activeCapture !== null) activeCapture.entry = { options, component }
      return () => {}
    },
  },
  effect(setup) {
    // 只执行同步 setup 部分；返回的清理函数不调用。
    setup()
    return () => {}
  },
  get() {
    return undefined
  },
  on() {},
  logger: { info() {}, warn() {}, error() {} },
}

try {
  mod.apply(ctx)
} catch (error) {
  console.error(`apply 抛错：${error.message}`)
  process.exit(1)
}

console.log(`捕获到 ${captures.length} 个槽位注入`)

/**
 * 递归渲染：不仅执行组件函数体，还把返回的 `h()` 树里所有函数型子组件
 * 也真的调一遍。只跑顶层组件会漏掉子组件里的错误（例如图标组件、Modal）。
 * @param node - `h()` 的返回值或子节点。
 * @param depth - 递归深度，防御性上限。
 * @returns 渲染出的节点数。
 */
function renderTree(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'string' || typeof node === 'number') return 1
  if (Array.isArray(node)) {
    let count = 0
    for (const child of node) count += renderTree(child, depth + 1)
    return count
  }
  if (typeof node !== 'object') return 0
  if (depth > 20) throw new Error('渲染树过深（可能存在自引用）')

  let count = 1
  const type = node.type
  if (typeof type === 'function') {
    const props = node.props ?? {}
    // 子组件同样按真实调用方式执行（含其 hooks）。
    count += renderTree(type(props), depth + 1)
  }
  for (const kid of node.kids ?? []) count += renderTree(kid, depth + 1)
  return count
}

/**
 * 按槽位真实 owner props 构造渲染入参。
 *
 * 宿主各槽位传的东西不同，这里逐个照抄（不是「猜」）：
 *  - `sidebar.footer.action` → `{ wide }`
 *  - `plugins.bundle.config`  → `{ view, form? }`，插件页按 `view: 'page'` 渲染
 *  - `settings.action`        → 空接口（`children?: never`），只带 `t`
 *
 * `locale: NS` 声明会让框架再注入 `t`，所以每个场景都带 `t`。
 * @param slot - 槽位名。
 * @param t - 翻译函数。
 * @returns 渲染 props。
 */
function propsForSlot(slot, t) {
  if (slot === 'sidebar.footer.action') return { wide: true, t }
  if (slot === 'plugins.bundle.config') return { view: 'page', t }
  return { t }
}

let failures = 0
for (const capture of captures) {
  // 模拟 slots.inject 的回调：框架会在 owner 就绪时调用它。
  const previous = activeCapture
  activeCapture = capture
  try {
    capture.callback()
  } catch (error) {
    console.error(`❌ ${capture.key} 的 inject 回调抛错：${error.message}`)
    failures++
    activeCapture = previous
    continue
  } finally {
    activeCapture = previous
  }
  const entry = capture.entry
  if (entry === undefined) {
    console.error(`❌ ${capture.key} 没有调用 slots.register`)
    failures++
    continue
  }
  const identity =
    entry.options.key !== undefined
      ? `key=${entry.options.key}`
      : `id=${entry.options.id} order=${entry.options.order}`
  console.log(`  ${capture.key} -> ${identity}`)
  try {
    const t = (key) => key
    const output = entry.component(propsForSlot(capture.key, t))
    if (output === null) {
      console.log('     渲染 OK：null（该槽位本次不渲染内容）')
    } else {
      const rendered = renderTree(output)
      console.log(`     渲染 OK：${rendered} 个节点`)
    }
  } catch (error) {
    console.error(`     ❌ 渲染抛错：${error.message}`)
    if (error.stack) console.error(error.stack.split('\n').slice(0, 5).join('\n'))
    failures++
  }
}

if (failures > 0) process.exit(1)
console.log(`${captures.length} 个槽位组件均可正常渲染`)
