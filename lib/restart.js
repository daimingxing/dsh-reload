/**
 * 桌面客户端重启：定位主进程 → 起一个逃逸进程树的重启器 → 重启器杀主进程并拉起新实例。
 *
 * 为什么必须外部重启：插件拿不到 Electron 主进程的 `app` 对象，`DESKTOP_IPC`
 * 通道表里也没有任何 restart/relaunch 通道（全表核对过）。唯一的路径是让一个
 * 独立进程在主进程死掉之后把它重新拉起来。
 *
 * 为什么用 `spawn({ detached: true })` 就够了：实测 DSH 的进程树**不在** job
 * object 内（`NtQueryInformationProcess` + `ProcessJobObjectInformation` 判定
 * main 与 host 均为 NO_JOB），所以主进程被杀不会连带杀掉它的子进程。
 *
 * ⚠️ 单实例锁是唯一的次序保障：`requestSingleInstanceLock()` 失败时 Electron
 * 会直接 quit。新实例若启动太早，会静默退出，用户看到的就是「DSH 关了，再也
 * 没起来」。因此 restarter 必须**轮询确认主进程消失**，而不是固定 sleep 后盲启。
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** restarter 脚本与校验逻辑同目录，避免依赖打包结构。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 可执行文件必须像 DSH 桌面端；用于拒绝在 `dsh web` / `node` 场景下误杀终端。 */
const DESKTOP_EXE_PATTERN = /\bdeepseek[ -]?harness(\.exe)?$/i

/**
 * 从当前进程环境推断「桌面主进程」与「桌面可执行文件」。
 *
 * 依据（均已实测）：
 *  - Host 的 `process.ppid` 就是 Electron 主进程 PID（`20084 → 4924`）
 *  - `process.execPath` 就是桌面 exe（`E:\dsh-desktop\DeepSeek Harness.exe`）
 *
 * 这些只是**定位**，安全校验在 {@link describeTarget} 里单独做。
 * @returns {{ mainPid: number, exe: string }} 目标进程与可执行文件。
 */
function locateDesktop() {
  return { mainPid: process.ppid, exe: process.execPath }
}

/**
 * 校验定位结果，决定「能不能重启」。
 *
 * 三道闸，任一不过就拒绝：
 *  1. 可执行文件存在且可执行
 *  2. 文件名像 DSH 桌面端（排除 `node.exe`、`dsh web` 的 shell 等）
 *  3. 平台是 Windows（重启器的取舍是实现细节；非 Windows 先明确拒绝，
 *     避免给出「按钮能点但一定失败」的假象）
 *
 * 另外一道闸在 restarter 侧：确认目标 PID 的 cmdline **不含** `--type=`
 * （排除 GPU / renderer / utility 子进程），见 `lib/restarter.mjs`。
 *
 * @param mainPid - 候选主进程 PID。
 * @param exe - 候选可执行文件路径。
 * @returns { null | string } 不可重启时返回原因，可重启时返回 null。
 */
export function describeTarget(mainPid, exe) {
  if (process.platform !== 'win32') {
    return '重启客户端目前仅支持 Windows 桌面端'
  }
  if (!Number.isInteger(mainPid) || mainPid <= 0) {
    return '无法定位桌面主进程'
  }
  if (typeof exe !== 'string' || exe === '' || !existsSync(exe)) {
    return '无法定位桌面可执行文件'
  }
  try {
    accessSync(exe, constants.X_OK)
  } catch {
    return '桌面可执行文件不可执行'
  }
  if (!DESKTOP_EXE_PATTERN.test(basename(exe).trim())) {
    return `当前进程不是桌面客户端（${basename(exe)}），无法重启`
  }
  return null
}

/**
 * 找一个能跑 restarter 的 node 可执行文件。
 *
 * 优先用 DSH 自带的 node（路径稳定、版本匹配），退回 `process.execPath`：
 * 桌面版里后者本身就是 Electron 可执行文件，配 `ELECTRON_RUN_AS_NODE=1`
 * 可以当 node 用；源码模式下它本来就是 node。
 * @returns {{ command: string, env: Record<string, string> }} 命令与环境。
 */
function resolveNode() {
  const bundled = join(
    process.resourcesPath ?? dirname(dirname(dirname(process.execPath))),
    'runtime',
    'primary-runtime',
    'dependencies',
    'node',
    'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  )
  if (existsSync(bundled)) return { command: bundled, env: {} }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/**
 * 启动重启器并立即返回。
 *
 * 关键点：
 *  - `detached: true` + `unref()`：让重启器脱离当前进程，主进程被杀后继续存活
 *  - `stdio: 'ignore'`：不占管道，父进程死后不会因写管道失败而崩溃
 *  - 参数走 JSON 文件而不是命令行：路径里可能有空格与引号，命令行转义极易出错
 *
 * @param params - 重启参数（主进程 PID、可执行文件、日志路径等）。
 * @returns 重启器的 PID。
 */
export function launchRestarter(params) {
  const { command, env } = resolveNode()
  const script = join(HERE, 'restarter.mjs')
  const configPath = params.configPath

  const child = spawn(command, [script, configPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  child.unref()
  return child.pid
}

export { locateDesktop }
