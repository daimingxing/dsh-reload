/**
 * 验证 profileContext 暴露的字段，以及 stateDir() 的最终落点。
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/check-paths.mjs
 *
 * 只做只读检查，不写任何文件。
 */
import fs from 'node:fs'

const RUNTIME = process.env.DSH_RUNTIME_DIR ?? 'E:/dsh-desktop/resources/app.asar/dsh'
const candidates = [
  `${RUNTIME}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`,
  `${RUNTIME}/node_modules/@deepseek-ai/dsh-hmr/lib/index.js`,
]

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
const wrong = `${process.env.DSH_HOME ?? 'C:/Users/user/.dsh'}/profiles/dsh-reload`
console.log(`  ${wrong}: ${fs.existsSync(wrong) ? '存在（错误）' : '不存在（正确）'}`)

console.log('\n=== 期望的状态目录 ===')
const expected = `${process.env.DSH_HOME ?? 'C:/Users/user/.dsh'}/dsh-reload`
console.log(`  ${expected}`)
