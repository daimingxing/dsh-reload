/**
 * 用 Host 自己的校验器验证 dsh-reload 注册的工具 schema。
 *
 * 为什么需要这个脚本：`tools.register()` 接收的是**完整 JSON Schema**，而 Host 只
 * 支持其中一个子集；写错（例如 `required` 挂在属性上、`type` 写成数组、根节点缺
 * `type`）在注册时不会立刻报错，要到「组装工具列表发给模型」时才被服务端拒绝，
 * 表现为整个会话报「工具的参数结构不符合当前模型要求」。
 *
 * 做法：在 Electron 的 node 模式里、带 --expose-internals 启动，直接 import Host
 * 的断言函数，喂进我们从 index.js 里抽出的真实 schema 字面量。
 *
 * 用法（在桌面安装目录前提下）：
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" --expose-internals scripts/check-schema.mjs
 *
 * 安装位置会自动探测几个常见路径；装在别处时用 DSH_RUNTIME_DIR 指定。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { requireRuntime } from './lib/runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = requireRuntime('check-schema')

const toolsEntry = path.join(
  RUNTIME,
  'node_modules/@deepseek-ai/dsh-tools/lib/index.js',
)

console.log(`Host 运行时：${RUNTIME}`)

const { assertSupportedJsonSchema, assertObjectJsonSchema } = await import(
  new URL(`file://${toolsEntry.replaceAll('\\', '/')}`).href
).catch(async () => {
  // 打包产物未必导出断言函数；退回按同一份规则做静态检查。
  return { assertSupportedJsonSchema: undefined, assertObjectJsonSchema: undefined }
})

/** Host 支持的 JSON Schema 关键字（与 checkSchemaNode 的白名单一致）。 */
const SUPPORTED = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

/**
 * 按 Host 规则静态检查一个 schema 节点。
 * @param node - 候选 schema。
 * @param at - 诊断路径。
 * @param out - 收集问题。
 */
function check(node, at, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${at} 必须是 schema 对象`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) out.push(`${at}.${key} 不是受支持的关键字`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) out.push(`${at} 不能同时声明 type 与 oneOf`)
  if (!hasType && !hasOneOf) out.push(`${at} 必须声明 type 或 oneOf`)
  if (hasType && typeof node.type !== 'string') out.push(`${at}.type 必须是单个字符串`)
  if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) {
    out.push(`${at}.required 必须是数组`)
  }
  if (node.properties !== undefined && (typeof node.properties !== 'object' || node.properties === null)) {
    out.push(`${at}.properties 必须是对象`)
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    check(child, `${at}.properties.${key}`, out)
  }
  if (node.items !== undefined) check(node.items, `${at}.items`, out)
  if (Array.isArray(node.oneOf)) {
    if (node.oneOf.length < 2) out.push(`${at}.oneOf 至少需要两个分支`)
    node.oneOf.forEach((child, index) => check(child, `${at}.oneOf[${index}]`, out))
  }
}

/**
 * 从 index.js 里抽出工具定义的两个 schema。
 *
 * 不 import index.js 本身：它依赖 Host 注入的 ctx，直接跑会失败；而且我们要检查
 * 的正是「注册时传进去的那份字面量」，静态抽取更贴近真实。
 * @returns {{ parameters: unknown, outputSchema: unknown }}
 */
function extractSchemas() {
  const source = fs.readFileSync(path.join(HERE, '..', 'index.js'), 'utf8')
  const grab = (startMarker, endMarker) => {
    const start = source.indexOf(startMarker)
    if (start < 0) return undefined
    const end = source.indexOf(endMarker, start)
    if (end < 0) return undefined
    const literal = source.slice(start + startMarker.length, end).trim()
    const expr = literal.endsWith(',') ? literal.slice(0, -1) : literal
    return Function(`"use strict"; return (${expr});`)()
  }
  return {
    parameters: grab('parameters: ', '\n        output:'),
    outputSchema: grab('schema: ', '\n          render:'),
  }
}

const { parameters, outputSchema } = extractSchemas()
const problems = []

if (parameters === undefined) problems.push('未能从 index.js 抽出 parameters')
else check(parameters, 'parameters', problems)

if (outputSchema === undefined) problems.push('未能从 index.js 抽出 output.schema')
else check(outputSchema, 'output.schema', problems)

// 如果有 Host 的真实断言，再用它交叉验证一次。
if (typeof assertSupportedJsonSchema === 'function') {
  for (const [label, schema] of [
    ['parameters', parameters],
    ['output.schema', outputSchema],
  ]) {
    if (schema === undefined) continue
    try {
      assertSupportedJsonSchema(schema)
    } catch (error) {
      problems.push(`${label}（Host 断言）：${String(error?.message ?? error)}`)
    }
  }
  if (typeof assertObjectJsonSchema === 'function' && outputSchema !== undefined) {
    try {
      assertObjectJsonSchema(outputSchema)
    } catch (error) {
      problems.push(`output.schema（Host 对象根断言）：${String(error?.message ?? error)}`)
    }
  }
  console.log('（已用 Host 的真实断言函数交叉验证）')
} else {
  console.log('（Host 断言函数不可导入，仅做等价规则静态检查）')
}

if (problems.length > 0) {
  console.error('\n发现 schema 问题：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

// 第二重检查：实现返回的字段必须与 output.schema 完全一致。
// 输出按 additionalProperties:false 校验，多一个或少一个字段都会让整个工具调用失败。
const implFields = Object.keys(
  (() => {
    const source = fs.readFileSync(path.join(HERE, '..', 'lib', 'hot-reload.js'), 'utf8')
    const start = source.indexOf('  return {', source.indexOf('async function hotReload'))
    const end = source.indexOf('\n  }', start)
    const body = source.slice(start + '  return {'.length, end)
    const names = []
    for (const line of body.split('\n')) {
      const match = line.match(/^\s{4}([A-Za-z_$][\w$]*)\s*[:,]/)
      if (match !== null) names.push(match[1])
    }
    return Object.fromEntries(names.map((name) => [name, true]))
  })(),
)

const declaredFields = new Set([
  ...Object.keys(outputSchema?.properties ?? {}),
])
const missing = implFields.filter((field) => !declaredFields.has(field))
const extra = [...declaredFields].filter((field) => !implFields.includes(field))

if (missing.length > 0) {
  console.error(`\n实现返回了未声明的字段（会导致工具调用失败）：${missing.join(', ')}`)
  process.exit(1)
}
if (extra.length > 0) {
  console.error(`\nschema 声明了实现不返回的字段：${extra.join(', ')}`)
  process.exit(1)
}

console.log(`实现字段与 schema 一致（${implFields.length} 个字段）`)
console.log('schema 校验通过')
