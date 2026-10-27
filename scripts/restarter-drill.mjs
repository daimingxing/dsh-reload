/**
 * 重启链路的演练，**全程不碰正在运行的 DSH**。
 *
 * 1. **存活探测**：用 `launchDesktopAndVerify()` 直接拉起一个短命进程，
 *    验证它会被判定为「没活下来」（这正是「窗口关了不再开」的检测点）。
 * 2. **存活探测（常驻）**：常驻进程必须被判为「活下来了」。
 * 3. **环境剥离**：验证 `desktopLaunchEnv()` 真的去掉了 `ELECTRON_RUN_AS_NODE`，
 *    而保留用户环境。
 * 4. **restarter 全链路**：用一个假主进程走完
 *    「杀 → 等消失 → 拉起 → 探测 → 重试 → 报错」的完整流程。
 *
 * ⚠️ **为什么这里绝不出现桌面 exe 的路径**：
 * restarter 的 `killLeftovers()` 执行 `taskkill /IM <镜像名> /F`，那是**按镜像名
 * 杀所有同名进程**。只要把真实的 `DeepSeek Harness.exe` 传给演练，跑一次就等于
 * 替用户强制关掉一次正在使用的 DSH。所以这里统一用 `node.exe` 作替身，
 * 并用 `DSH_RELOAD_DRILL=1` 让 restarter 跳过按镜像名清理那一步。
 *
 * 用法：node scripts/restarter-drill.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { desktopLaunchEnv, launchDesktopAndVerify } from '../lib/restart.js'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const RESTARTER = join(HERE, 'lib', 'restarter.mjs')
const NODE = process.execPath

let bad = 0
const check = (label, ok) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  if (!ok) bad++
}

/* ------------------------------------------------------------------ */
/* 1. 存活探测：短命进程必须被判为「没活下来」                          */
/* ------------------------------------------------------------------ */
console.log('\n=== 1. 存活探测（短命进程） ===')
const dyingPid = await launchDesktopAndVerify({
  exe: NODE,
  args: ['-e', 'process.exit(0)'],
  probeMs: 1200,
})
check('立刻退出的进程被判为未存活（返回 null）', dyingPid === null)

/* ------------------------------------------------------------------ */
/* 2. 存活探测：长命进程必须被判为「活下来了」                          */
/* ------------------------------------------------------------------ */
console.log('\n=== 2. 存活探测（常驻进程） ===')
const livingPid = await launchDesktopAndVerify({
  exe: NODE,
  args: ['-e', 'setTimeout(() => {}, 5000)'],
  probeMs: 900,
})
check('常驻进程被判为存活（返回 PID）', typeof livingPid === 'number' && livingPid > 0)
if (typeof livingPid === 'number') {
  try {
    process.kill(livingPid)
  } catch {}
}

/* ------------------------------------------------------------------ */
/* 3. 环境剥离                                                          */
/* ------------------------------------------------------------------ */
console.log('\n=== 3. 环境剥离 ===')
const sourceEnv = {
  PATH: 'x',
  DSH_HOME: 'C:\\Users\\someone\\.dsh',
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_ENABLE_LOGGING: '1',
  ELECTRON_NO_ATTACH_CONSOLE: '1',
}
const launchEnv = desktopLaunchEnv(sourceEnv)
check('ELECTRON_RUN_AS_NODE 被剥离', launchEnv.ELECTRON_RUN_AS_NODE === undefined)
check('ELECTRON_ENABLE_LOGGING 被剥离', launchEnv.ELECTRON_ENABLE_LOGGING === undefined)
check('ELECTRON_NO_ATTACH_CONSOLE 被剥离', launchEnv.ELECTRON_NO_ATTACH_CONSOLE === undefined)
check('用户环境（PATH / DSH_HOME）保留', launchEnv.PATH === 'x' && launchEnv.DSH_HOME !== undefined)
check('不修改入参', sourceEnv.ELECTRON_RUN_AS_NODE === '1')

/* ------------------------------------------------------------------ */
/* 4. restarter 全链路（假主进程）                                      */
/* ------------------------------------------------------------------ */
/* ⚠️ 这一步**绝对不能**把真实桌面 exe 交给 restarter。                   */
/*
 * restarter 里有 `killLeftovers()`，它执行 `taskkill /IM "DeepSeek Harness.exe" /F`
 * ——**按镜像名杀掉所有 DSH 进程**，包括用户正在使用的那个。所以只要
 * config.exe 指向真实桌面 exe，跑一次演练就等于替用户强制关一次 DSH。
 *
 * 因此这里传的是**一个无害的替身可执行文件**（node.exe），
 * 这样 killLeftovers 只会去杀 "node.exe" 里与本次演练相关的假进程，
 * 不会波及用户的 DSH。
 */
console.log('\n=== 4. restarter 全链路（假主进程 + 替身 exe） ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reload-drill-'))
  const logPath = join(dir, 'restart.log')
  const donePath = join(dir, 'restart-done.txt')
  const configPath = join(dir, 'restart.json')

  // 假「主进程」：一个只会 sleep 的 node，restarter 会 taskkill 掉它。
  const fakeMain = spawn(NODE, ['-e', 'setTimeout(() => {}, 600000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  console.log(`  假主进程 pid=${fakeMain.pid}`)

  // ⚠️ exe 用 node.exe 而不是桌面 exe：见上面注释。这会让 restarter 的
  // `killLeftovers('node.exe')` 有误伤风险，所以下面把「清理残留」这一步
  // 通过 DSH_RELOAD_DRILL=1 关掉（restarter 读到该变量就跳过 killLeftovers）。
  writeFileSync(
    configPath,
    JSON.stringify({ mainPid: fakeMain.pid, exe: NODE, logPath, donePath }, null, 2),
    'utf8',
  )

  // `stdio: 'inherit'`：本沙箱禁止为子进程建立管道（piped stdio 会 EPERM），
  // 而 restarter 自己并不输出到 stdout，它只写日志文件。
  const child = spawn(NODE, [RESTARTER, configPath], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, DSH_RELOAD_DRILL: '1' },
  })
  await new Promise((resolve) => child.on('exit', resolve))

  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  console.log('  --- restart.log ---')
  for (const line of log.trim().split('\n')) console.log(`  ${line}`)
  console.log('  -------------------')

  check('日志记录了环境剥离', /ELECTRON_RUN_AS_NODE=\(已剥离\)/u.test(log))
  check('主进程已被结束', /主进程已退出/u.test(log))
  check('对拉起结果做了存活探测', /未存活|存活确认通过/u.test(log))
  check('写入了完成标记', existsSync(donePath))

  try {
    fakeMain.kill()
  } catch {}
  rmSync(dir, { recursive: true, force: true })
}

console.log(bad === 0 ? '\n全部检查通过' : `\n${bad} 项检查未通过`)
process.exit(bad === 0 ? 0 : 1)
