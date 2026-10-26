/**
 * 热重载的唯一实现：`ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile())`。
 *
 * 为什么必须在 `runExclusive` 内：HMR 用一条 AsyncLocalStorage 串行队列协调
 * 「模块替换 / Include 刷新 / profile 配置变更」三类变更，`reconcileProfile()`
 * 会在队列外调用时直接抛 `HMR profile reconciliation must run inside runExclusive`。
 *
 * 为什么用「fiber uid 前后快照」判断谁被替换，而不是听 `hmr/reload` 事件：
 * 该事件只在 `partialReload()`（源码文件监听路径）里 emit，`reconcileProfile()`
 * 走的是 app-boot 的 recompose 路径，不会发它。而 `root: []` 正是我们的默认
 * 配置，所以听事件会永远收不到。fiber uid 由 Cordis 在每次重新 apply 时更新，
 * 对比前后快照即可准确得到「哪些 Loader 条目换了新实例」。
 */

/** reason 的中文说明，供工具输出与 UI 展示；未知值原样返回。 */
const PENDING_REASON_TEXT = {
  'host-module': '该模块在宿主静态依赖图里，只能重启客户端才能换新代码',
  'unmanaged-plugin': '该插件不在 Loader 树内，热重载无法替换它',
  'module-comparison': '文件比较无法完成，需要重启客户端才能确认生效',
}

/** restartReason 的中文说明。 */
const RESTART_REASON_TEXT = {
  'module-comparison': '文件比较无法完成（可能缺少 ESM 缓存），需要重启客户端',
  'package-moved': '包被移动到了别的目录，需要重启客户端',
  'no-hmr': '当前 profile 未启用热重载',
}

/**
 * 给一次 Loader 快照：`entry.id → { uid, name }`。
 *
 * 只统计有 fiber 的条目：`uid` 为空表示该条目还没启动或已失败，它不会给出
 * 「换过实例」的信号，纳入对比反而会产生噪音。
 * @param loader - Cordis Loader 服务。
 * @returns Map<entryId, { uid: number, name: string }>。
 */
function snapshotEntries(loader) {
  const snapshot = new Map()
  try {
    for (const entry of loader?.entries?.() ?? []) {
      const uid = entry?.fiber?.uid
      if (uid === undefined || uid === null) continue
      snapshot.set(String(entry.id), {
        uid,
        name: String(entry?.options?.name ?? ''),
      })
    }
  } catch {
    // 取不到快照就退化成「无法判断谁被替换」，不影响重载本身。
  }
  return snapshot
}

/**
 * 对比前后快照，得出被替换的条目。
 *
 * 判定为「已替换」的两种情况：
 *  - uid 变了 → 该条目被停掉并重新 apply（正常替换）
 *  - 条目消失 → 该行被新的组合移除了
 *
 * @param before - 重载前快照。
 * @param after - 重载后快照。
 * @returns 被替换条目的 `{ id, name }` 列表。
 */
function diffEntries(before, after) {
  const replaced = []
  for (const [id, previous] of before) {
    const current = after.get(id)
    if (current === undefined || current.uid !== previous.uid) {
      replaced.push({ id, name: previous.name })
    }
  }
  return replaced
}

/**
 * 把 pending/restartReason 里的英文枚举翻译成给用户看的中文句子。
 * @param result - reconcileProfile 的原始返回值。
 * @returns 可直接展示的警告行数组。
 */
function describeDiagnostics(result) {
  const notes = []
  for (const item of result.pending ?? []) {
    const reason = PENDING_REASON_TEXT[item?.reason] ?? String(item?.reason ?? '未知原因')
    notes.push(`${item?.url ?? '(未知模块)'}：${reason}`)
  }
  if (result.restartReason !== undefined && result.restartReason !== null) {
    const reason = RESTART_REASON_TEXT[result.restartReason] ?? String(result.restartReason)
    notes.push(`需要重启客户端：${reason}`)
  }
  return notes
}

/**
 * 执行一次热重载。
 *
 * 返回结构是工具输出与 HTTP 响应的共同契约（见设计定稿 §5.1）：
 *  - `applied`  —— 操作本身是否成功完成（即使什么都没换也是 true）
 *  - `changed`  —— 是否真的有 Loader 条目被替换（false 表示磁盘无变化，不是错误）
 *  - `replaced` —— 被替换的条目（id + 包名）
 *  - `pending` / `restartReason` / `warnings` —— 原样保留，供调用方如实汇报
 *
 * @param ctx - 插件上下文。
 * @returns 结果对象。
 * @throws {Error} HMR 不可用、或 `reconcileProfile` 自身抛错时。
 */
export async function hotReload(ctx) {
  const hmr = ctx.get?.('hmr')
  if (hmr === undefined || hmr === null) {
    throw new Error('当前 profile 未启用热重载（HMR 不可用），无法热重载')
  }
  if (ctx.get?.('profileContext') === undefined) {
    throw new Error('当前 host 没有 profile 上下文，热重载仅适用于 profile 启动的 DSH')
  }

  const loader = ctx.get?.('loader')
  const before = snapshotEntries(loader)

  const result = await hmr.runExclusive(() => hmr.reconcileProfile())
  const after = snapshotEntries(loader)

  const replaced = diffEntries(before, after)
  return {
    applied: true,
    changed: replaced.length > 0,
    replaced,
    replacedPlugins: replaced.map((entry) => entry.name).filter((name) => name !== ''),
    pending: (result.pending ?? []).map((item) => ({
      url: String(item?.url ?? ''),
      reason: String(item?.reason ?? ''),
    })),
    restartReason: result.restartReason ?? null,
    warnings: (result.warnings ?? []).map((warning) => String(warning)),
    notes: describeDiagnostics(result),
  }
}
