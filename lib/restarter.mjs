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

const execFileAsync = promisify(execFile)

/** 杀掉主进程前的等待：让 Host 的 HTTP 响应先落地，前端能收到「正在重启」。 */
const RESPONSE_GRACE_MS = 1200

/** 等主进程消失的上限；超过就放弃，避免无限挂起。 */
const MAIN_EXIT_TIMEOUT_MS = 10_000

/** 主进程消失后、拉起新实例前的等待：让单实例锁与端口释放。 */
const LOCK_RELEASE_MS = 1200

/** 轮询间隔。 */
const POLL_MS = 200

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
 * @param exePath - 桌面可执行文件绝对路径。
 * @param logPath - 日志路径。
 */
async function killLeftovers(exePath, logPath) {
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

  log(logPath, `拉起新实例：${exe}`)
  try {
    const child = execFile(exe, [], { windowsHide: false, detached: true })
    child.unref()
    log(logPath, `新实例已启动 pid=${child.pid ?? '(未知)'}`)
  } catch (error) {
    log(logPath, `拉起新实例失败：${String(error?.message ?? error)}`)
  }
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
