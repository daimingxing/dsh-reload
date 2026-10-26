/**
 * dsh-reload 的持久状态（$DSH_HOME/dsh-reload/state.json）。
 *
 * 为什么需要落盘而不是放内存：热重载会把本插件自己的 Loader entry 停掉再重新
 * import，内存状态随之清零。上次热重载的结果、以及「正在重启」标记都必须先
 * 落盘，新实例才能读到，UI 也才能在插件被替换后继续显示结果。
 *
 * 写入用「临时文件 + rename」：rename 在同一卷上是原子的，进程在写一半时被杀
 * 不会留下截断的 JSON（重启场景恰好就是随时会被杀）。
 */
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** 状态文件格式版本；字段语义变化时递增，读到不认识的版本按空状态处理。 */
const STATE_VERSION = 1

/**
 * 状态目录：`$DSH_HOME/dsh-reload`。
 *
 * 四个来源按可靠性排序，第一个可用的胜出：
 *  1. `profileContext.home` —— 启动器提供的权威家目录，HMR 自己也用它定位
 *     `$DSH_HOME/cordis.patch.yml`。profile 启动的 DSH 一定有。
 *  2. `$DSH_HOME` —— 常规环境变量；某些启动方式下 Host 进程并不设置它。
 *  3. `$DSH_PROFILE_DIR` 的上两级 —— `profiles/<name>` 的祖父即家目录。
 *     注意是**两级**：`profiles/desktop/..` 只是 `profiles/`，不是家目录。
 *  4. 当前工作目录 —— 最后兜底，保证任何情况下都有可写位置。
 *
 * @param ctx - 插件上下文，用于读取 profile 信息。
 * @returns 状态目录绝对路径。
 */
export function stateDir(ctx) {
  const profile = ctx?.get?.('profileContext')
  if (typeof profile?.home === 'string' && profile.home !== '') {
    return join(profile.home, 'dsh-reload')
  }

  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'dsh-reload')

  // profiles/<name> → profiles → 家目录，所以上溯两级而不是一级。
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '') {
    return join(profileDir, '..', '..', 'dsh-reload')
  }

  if (typeof profile?.dir === 'string' && profile.dir !== '') {
    return join(profile.dir, '..', '..', 'dsh-reload')
  }

  return join(process.cwd(), '.dsh-reload')
}

/** 状态文件的绝对路径。 */
export function statePath(ctx) {
  return join(stateDir(ctx), 'state.json')
}

/** 空状态；任何读失败都退回它，调用方不需要区分「文件不存在」与「文件损坏」。 */
function emptyState() {
  return { version: STATE_VERSION, lastHotReload: null, pendingRestart: null }
}

/**
 * 读取状态。读失败一律返回空状态：状态只用于展示，不该阻断任何操作。
 * @param ctx - 插件上下文。
 * @returns 状态对象。
 */
export async function readState(ctx) {
  try {
    const raw = await readFile(statePath(ctx), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return emptyState()
    if (parsed.version !== STATE_VERSION) return emptyState()
    return {
      version: STATE_VERSION,
      lastHotReload: parsed.lastHotReload ?? null,
      pendingRestart: parsed.pendingRestart ?? null,
    }
  } catch {
    return emptyState()
  }
}

/**
 * 原子写入状态。失败只记日志，不抛出——状态落盘失败不该让热重载或重启失败。
 * @param ctx - 插件上下文（提供 logger）。
 * @param state - 完整状态对象。
 */
export async function writeState(ctx, state) {
  const dir = stateDir(ctx)
  const target = statePath(ctx)
  const temp = `${target}.${process.pid}.tmp`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(temp, `${JSON.stringify({ ...state, version: STATE_VERSION }, null, 2)}\n`, 'utf8')
    await rename(temp, target)
  } catch (error) {
    try {
      await unlink(temp)
    } catch {
      // 临时文件可能没创建成功，忽略。
    }
    ctx?.logger?.('dsh-reload')?.warn?.(`状态写入失败：${String(error?.message ?? error)}`)
  }
}

/**
 * 记录一次热重载结果（保留 pendingRestart 不动）。
 * @param ctx - 插件上下文。
 * @param result - 工具/接口返回的结果对象。
 */
export async function recordHotReload(ctx, result) {
  const current = await readState(ctx)
  await writeState(ctx, { ...current, lastHotReload: { at: Date.now(), result } })
}

/**
 * 标记「即将重启」。新实例启动后读到它就会提示一次，然后清掉。
 * @param ctx - 插件上下文。
 * @param reason - 触发来源（`ui`），用于诊断。
 */
export async function markPendingRestart(ctx, reason = 'ui') {
  const current = await readState(ctx)
  await writeState(ctx, { ...current, pendingRestart: { at: Date.now(), reason } })
}

/**
 * 取出并清除「即将重启」标记。
 * 只有确实读到标记时才重写文件，正常启动（无标记）不产生任何磁盘写入。
 * @param ctx - 插件上下文。
 * @returns 标记内容，没有则 null。
 */
export async function consumePendingRestart(ctx) {
  const current = await readState(ctx)
  if (current.pendingRestart === null) return null
  await writeState(ctx, { ...current, pendingRestart: null })
  return current.pendingRestart
}
