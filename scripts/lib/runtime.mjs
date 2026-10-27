/**
 * 定位 Host 的 dsh 包根目录。
 *
 * 这些校验脚本都要读 Host 的真实实现（dsh-tools 的断言函数、槽位契约、
 * 模块图），但 dsh 装在哪没有标准位置：默认安装目录、安装到别的盘、
 * `app.asar` 还是解包目录，都看用户怎么装。
 *
 * 以前每个脚本各自硬编码一个 `E:/dsh-desktop/...`，换台机器就全部跑不起来，
 * 而这类检查恰恰是最该随手可跑的那条 —— 一个要手敲 export 才能用的校验脚本，
 * 实际结果是没人跑。
 *
 * 策略：`DSH_RUNTIME_DIR` 优先（CI 与非默认安装用得上），否则按已知位置探测，
 * 第一个含 `dsh-tools` 的胜出。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 判断「这个目录确实是 dsh 包根」的标记文件。 */
const MARKER = 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'

/** 候选安装位置，按常见程度排序。用户装到别处时用环境变量指定。 */
const CANDIDATES = [
  'C:/deepseek-harness-desktop/resources/app.asar/dsh',
  'D:/deepseek-harness-desktop/resources/app.asar/dsh',
  'E:/deepseek-harness-desktop/resources/app.asar/dsh',
  'E:/dsh-desktop/resources/app.asar/dsh',
  'C:/Program Files/DeepSeek Harness/resources/app.asar/dsh',
]

// 每用户安装（NSIS 默认）落在 %LOCALAPPDATA% 下；环境变量缺失时跳过这一项，
// 而不是拼出一个 "undefined/Programs/..." 的无意义路径。
if (typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA !== '') {
  CANDIDATES.push(`${process.env.LOCALAPPDATA}/Programs/DeepSeek Harness/resources/app.asar/dsh`)
}

/**
 * 找到 dsh 包根目录。
 * @returns {{ root: string, found: boolean }}
 */
export function findRuntime() {
  const fromEnv = process.env.DSH_RUNTIME_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return { root: fromEnv, found: fs.existsSync(path.join(fromEnv, MARKER)) }
  }
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(path.join(candidate, MARKER))) return { root: candidate, found: true }
  }
  // 都没找到：返回第一个候选，让调用方的报错信息指向一个真实存在过的路径。
  return { root: CANDIDATES[0], found: false }
}

/**
 * 找 dsh 包根目录，找不到就退出。
 *
 * 报错里给出确切路径与修复方式 —— 只说「找不到」会让人不知道自己在找什么。
 * @param {string} scriptName - 调用方脚本名，仅用于报错信息。
 * @returns {string} dsh 包根目录。
 */
export function requireRuntime(scriptName) {
  const { root, found } = findRuntime()
  if (found) return root
  console.error(`[${scriptName}] 找不到 Host 的 dsh 包：${root}`)
  console.error('用 DSH_RUNTIME_DIR 环境变量指向 dsh 包根目录（就是含 node_modules 的那层）。')
  console.error('桌面版通常是 <安装目录>/resources/app.asar/dsh。')
  process.exit(2)
}
