/**
 * 静态审查：槽位组件不得依赖未声明的 props。
 *
 * 背景：槽位只传它自己声明的 owner props。`sidebar.footer.action` 传 `{ wide }`，
 * `settings.general.item` 传空对象。组件若从 props 读别的字段（尤其是 `t`），
 * 首次渲染就抛错，整个槽位条目被移除——界面上什么都不出现，且没有明显报错。
 *
 * 这个脚本检查两个槽位组件的形参列表，以及它们是否引用 `props.`。
 * 用法：node scripts/check-slot-components.mjs
 */
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const problems = []

/** 期望「不接收任何 props」的槽位组件。 */
const SLOT_COMPONENTS = ['SidebarButton', 'SectionRow']

for (const name of SLOT_COMPONENTS) {
  const pattern = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`, 'u')
  const match = source.match(pattern)
  if (match === null) {
    problems.push(`找不到组件 ${name} 的定义`)
    continue
  }
  const params = match[1].trim()
  if (params !== '') {
    problems.push(`${name} 声明了形参 "${params}"，但槽位不会传这些 props；请改用闭包（currentT）`)
  }
}

// 反向检查：这两个组件体内不应出现 props 访问。
for (const name of SLOT_COMPONENTS) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) continue
  const end = source.indexOf('\n    }', start)
  const body = source.slice(start, end)
  if (/\bprops\./u.test(body)) problems.push(`${name} 的组件体内访问了 props`)
}

// 槽位注册的 id / order 必须与设计一致。
const expectations = [
  ["sidebar.footer.action", "dsh-reload:button", "order: 10"],
  ["settings.general.item", "dsh-reload:section", "order: 110"],
]
for (const [slot, id, order] of expectations) {
  if (!source.includes(`name: '${slot}'`)) problems.push(`未注册槽位 ${slot}`)
  if (!source.includes(`id: '${id}'`)) problems.push(`槽位 ${slot} 的 id 应为 ${id}`)
  if (!source.includes(order)) problems.push(`槽位 ${slot} 的 ${order} 缺失`)
}

if (problems.length > 0) {
  console.error('槽位组件审查发现问题：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`槽位组件审查通过（${SLOT_COMPONENTS.length} 个组件，均不依赖 props）`)
