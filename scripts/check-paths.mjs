/**
 * 验证 profileContext 暴露的字段，以及 stateDir() 的最终落点。
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/check-paths.mjs
 *
 * 只做只读检查，不写任何文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { requireRuntime } from './lib/runtime.mjs'

const RUNTIME = requireRuntime('check-paths')
const candidates = [
  path.join(RUNTIME, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'),
  path.join(RUNTIME, 'node_modules/@deepseek-ai/dsh-hmr/lib/index.js'),
]

// DSH_HOME 没设置时，宿主自己用的默认值是 ~/.dsh —— 这里必须跟着推同一个值，
// 而不是写一个 'C:/Users/user/.dsh' 的占位路径（那样检查的落点永远是假的）。
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

console.log('=== 环境变量 ===')
for (const key of ['DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR']) {
  console.log(`  ${key} = ${process.env[key] ?? '(未设置)'}`)
}

console.log('\n=== 源码里 profileContext 的已知字段 ===')
for (const file of candidates) {
  if (!fs.existsSync(file)) {
    console.log(`  ${file}: 不存在`)
    continue
  }
  const source = fs.readFileSync(file, 'utf8')
  const fields = new Set()
  for (const match of source.matchAll(/profile(?:Context)?\.([a-zA-Z_$][\w$]*)/g)) {
    fields.add(match[1])
  }
  console.log(`  ${file.split('/').pop()}: ${[...fields].sort().join(', ')}`)
}

console.log('\n=== profiles/dsh-reload 是否被误建 ===')
const wrong = path.join(DSH_HOME, 'profiles', 'dsh-reload')
console.log(`  ${wrong}: ${fs.existsSync(wrong) ? '存在（错误）' : '不存在（正确）'}`)

console.log('\n=== 期望的状态目录 ===')
const expected = path.join(DSH_HOME, 'dsh-reload')
console.log(`  ${expected}`)
