/**
 * 独立的 DSH 重启器。
 *
 * 由 host 用 `spawn({ detached: true })` 启动，因此父进程（Host）被杀之后它仍
 * 然存活，负责「等一会儿 → 杀掉 Electron 主进程 → 确认它消失 → 清理残留 →
 * 拉起新实例」。
 *
 * 参数只从一个 JSON 配置文件读，不从命令行读：Windows 路径含空格与反斜杠，
 * 命令行转义是这类工具最常见的失败来源。
 *
 * 日志写到 `$DSH_HOME/dsh-reload/restart.log`，因为本进程没有控制台
 * （`stdio: 'ignore'`，且 Windows 上 detached 进程不会继承父控制台）。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

import { desktopLaunchEnv, launchDesktopAndVerify } from './restart.js'

const execFileAsync = promisify(execFile)

/** 杀掉主进程前的等待：让 Host 的 HTTP 响应先落地，前端能收到「正在重启」。 */
const RESPONSE_GRACE_MS = 1200

/** 等主进程消失的上限；超过就放弃，避免无限挂起。 */
const MAIN_EXIT_TIMEOUT_MS = 10_000

/** 主进程消失后、拉起新实例前的等待：让单实例锁与端口释放。 */
const LOCK_RELEASE_MS = 1200

/** 轮询间隔。 */
const POLL_MS = 200

/**
 * 新实例「活着」的判定窗口。
 *
 * 这一步是「窗口关了但没重开」的第二道保险：Electron 在拿到单实例锁失败、
 * 或环境变量让它退化成 Node 模式时，**会立刻以 0 退出且不报错**。只看
 * `spawn()` 有没有抛异常是不够的——那时进程已经起来了，只是马上又死了。
 */
const LAUNCH_PROBE_MS = 2000

/** 拉起新实例的最大尝试次数（含首次）。 */
const LAUNCH_ATTEMPTS = 3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 追加一行日志。日志失败不得影响重启流程。
 * @param logPath - 日志文件路径。
 * @param message - 内容。
 */
function log(logPath, message) {
  try {
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // 日志只是诊断手段；重启流程优先。
  }
}

/**
 * 执行一个 Windows 命令，忽略失败。
 * @param file - 可执行文件。
 * @param args - 参数。
 */
async function tryRun(file, args) {
  try {
    await execFileAsync(file, args, { windowsHide: true, timeout: 15_000 })
  } catch {
    // taskkill 对已退出进程会返回非零；这不是错误。
  }
}

/**
 * 轮询直到目标进程消失。
 * @param pid - 目标 PID。
 * @param timeoutMs - 上限。
 * @returns 是否在超时前消失。
 */
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    try {
      // signal 0 只做存在性检查：进程还在就返回，不在就抛 ESRCH。
      process.kill(pid, 0)
    } catch {
      return true
    }
  }
  return false
}

/**
 * 清理主进程的残留子进程。
 *
 * 正常情况下 Host 收到 IPC `disconnect` 会主动 shutdown，但卡死的 Host 会变成
 * 孤儿并占着端口，导致新实例启动失败。这里按镜像名清一遍，**不连带 `taskkill /T`**
 * ——那会把还没启动的新实例也带走。
 *
 * ⚠️ **`taskkill /IM <镜像名> /F` 会杀掉所有同名进程。** 对桌面 exe 来说这正是
 * 想要的（单实例，旧的全清掉），但如果有人把别的 exe 传进来（比如测试用的
 * node.exe），就会误杀无关进程。所以演练脚本通过 `DSH_RELOAD_DRILL=1` 跳过这一步。
 *
 * @param exePath - 桌面可执行文件绝对路径。
 * @param logPath - 日志路径。
 */
async function killLeftovers(exePath, logPath) {
  if (process.env.DSH_RELOAD_DRILL === '1') {
    log(logPath, '演练模式（DSH_RELOAD_DRILL=1）：跳过按镜像名清理残留进程')
    return
  }
  const imageName = exePath.split(/[\\/]/).pop()
  if (typeof imageName !== 'string' || imageName === '') return
  log(logPath, `清理残留进程：${imageName}`)
  // 重试两次：第一次之后可能还有进程在退出中。
  for (let attempt = 0; attempt < 2; attempt++) {
    await tryRun('taskkill', ['/IM', imageName, '/F'])
    await sleep(400)
  }
}

/**
 * 拉起桌面客户端并确认它**真的活下来了**。
 *
 * 为什么不能只看 `spawn()` 有没有抛错：Electron 在单实例锁被占用、或
 * `ELECTRON_RUN_AS_NODE=1` 让它退化成 Node 模式时，**会正常启动然后立刻以 0
 * 退出**——父进程这边完全看不到错误，用户看到的就是「关了没再开」。
 *
 * 所以这里在拉起后观察 `LAUNCH_PROBE_MS`：
 *  - 进程仍在 → 成功
 *  - 进程已退出 → 等一会儿再试（锁可能还没释放干净）
 *
 * @param exe - 桌面可执行文件绝对路径。
 * @param logPath - 日志路径。
 * @returns 成功时返回新实例 PID，全部尝试都失败时返回 null。
 */
async function launchDesktop(exe, logPath) {
  const env = desktopLaunchEnv()
  log(
    logPath,
    `新实例环境：ELECTRON_RUN_AS_NODE=${env.ELECTRON_RUN_AS_NODE === undefined ? '(已剥离)' : env.ELECTRON_RUN_AS_NODE}`,
  )

  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    log(logPath, `第 ${attempt}/${LAUNCH_ATTEMPTS} 次拉起新实例：${exe}`)

    const pid = await launchDesktopAndVerify({ exe, env, probeMs: LAUNCH_PROBE_MS })
    if (pid !== null) {
      log(logPath, `新实例存活确认通过 pid=${pid}`)
      return pid
    }

    log(logPath, `新实例在 ${LAUNCH_PROBE_MS}ms 内未存活（可能被单实例锁挡掉），准备重试`)
    // 单实例锁释放需要时间；重试前多等一会儿。
    await sleep(LOCK_RELEASE_MS)
  }

  log(logPath, `连续 ${LAUNCH_ATTEMPTS} 次拉起新实例均失败，需要用户手动双击图标`)
  return null
}

/**
 * 重启主流程。
 * @param config - 重启参数。
 */
async function main(config) {
  const { logPath, mainPid, exe } = config

  log(logPath, `restarter 启动 pid=${process.pid} 目标主进程=${mainPid}`)
  log(logPath, `等待 ${RESPONSE_GRACE_MS}ms 让响应落地`)
  await sleep(RESPONSE_GRACE_MS)

  log(logPath, `结束主进程 ${mainPid}`)
  await tryRun('taskkill', ['/PID', String(mainPid), '/F'])

  const exited = await waitForExit(mainPid, MAIN_EXIT_TIMEOUT_MS)
  if (!exited) {
    // 主进程没死透：**不启动新实例**。否则新实例会因单实例锁直接退出，
    // 用户会同时面对「旧实例卡住 + 新实例秒退」两个问题，比不重启更难恢复。
    log(logPath, `主进程 ${MAIN_EXIT_TIMEOUT_MS}ms 内未退出，放弃重启`)
    return
  }
  log(logPath, '主进程已退出')

  await killLeftovers(exe, logPath)

  log(logPath, `等待 ${LOCK_RELEASE_MS}ms 释放单实例锁`)
  await sleep(LOCK_RELEASE_MS)

  const launchedPid = await launchDesktop(exe, logPath)
  if (launchedPid === null) {
    // 走到这里说明这次重启「关掉了但没起来」。日志是唯一的诊断线索，
    // 前端的「正在重启」遮罩会在超时后自行解除并提示用户手动重开。
    log(logPath, '重启失败：客户端未能在本进程内重新拉起')
    throw new Error('desktop relaunch failed')
  }
  log(logPath, `重启完成，新实例 pid=${launchedPid}`)
}

/**
 * 入口：读配置 → 执行 → 写完成标记。
 */
async function run() {
  const configPath = process.argv[2]
  if (typeof configPath !== 'string' || configPath === '') {
    process.exitCode = 2
    return
  }

  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    process.exitCode = 3
    return
  }

  try {
    await main(config)
  } catch (error) {
    log(config?.logPath ?? configPath, `restarter 异常：${String(error?.stack ?? error)}`)
    process.exitCode = 1
  } finally {
    // 完成标记：宿主侧「上次重启是否走完」的唯一证据。
    try {
      if (typeof config?.donePath === 'string') {
        writeFileSync(config.donePath, `${new Date().toISOString()}\n`, 'utf8')
      }
    } catch {
      // 标记写入失败不影响已经完成的重启。
    }
  }
}

await run()
