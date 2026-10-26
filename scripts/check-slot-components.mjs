/**
 * 静态审查：槽位注册的写法必须与宿主契约一致。
 *
 * 从宿主自己的源码（`@deepseek-ai/dsh-client-ui-settings-general`）可以看到标准写法：
 *
 *   ctx.slots.inject('settings.general.item', () => ctx.slots.register({
 *     name: 'settings.general.item', id: 'current-version', order: 100, locale: NS,
 *   }, CurrentVersionRow))
 *
 * 而组件从 **props** 取 `t`（`function CurrentVersionRow({ t })`）——`locale: NS`
 * 声明会让框架把翻译函数注入 props。这里检查三件事：
 *  1. 每个槽位都用 `slots.inject(slot, () => slots.register(...))` 的成对写法
 *  2. 注册选项里带 `locale`
 *  3. 组件形参接收 `t`
 *
 * 用法：node scripts/check-slot-components.mjs
 */
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const problems = []

/** 槽位 → 期望的注册 id / order / 组件名。 */
const EXPECTATIONS = [
  {
    slot: 'sidebar.footer.action',
    id: 'dsh-reload:button',
    order: 10,
    component: 'SidebarButton',
  },
  {
    slot: 'settings.general.item',
    id: 'dsh-reload:section',
    order: 110,
    component: 'SectionRow',
  },
]

for (const { slot, id, order, component } of EXPECTATIONS) {
  // 1) inject 与 register 成对出现，槽位名出现两次（inject 的参数 + register 的 name）
  const injectPattern = new RegExp(
    `ctx\\.slots\\.inject\\(\\s*'${slot.replace('.', '\\.')}'\\s*,\\s*\\(\\)\\s*=>`,
    'u',
  )
  if (!injectPattern.test(source)) {
    problems.push(`槽位 ${slot} 未使用 slots.inject(slot, () => ...) 的成对写法`)
  }
  if (!source.includes(`name: '${slot}'`)) problems.push(`slots.register 缺少 name: '${slot}'`)
  if (!source.includes(`id: '${id}'`)) problems.push(`槽位 ${slot} 的 id 应为 ${id}`)
  if (!source.includes(`order: ${order}`)) problems.push(`槽位 ${slot} 的 order 应为 ${order}`)

  // 2) 该 register 调用必须带 locale（否则组件拿不到 t）
  const registerBlock = source.slice(source.indexOf(`id: '${id}'`) - 200, source.indexOf(`id: '${id}'`) + 220)
  if (!registerBlock.includes('locale: NS')) {
    problems.push(`槽位 ${slot} 的注册缺少 locale: NS（组件将拿不到翻译函数 t）`)
  }

  // 3) 组件从 props 接收 t
  const signature = new RegExp(`function ${component}\\(([^)]*)\\)`, 'u').exec(source)
  if (signature === null) {
    problems.push(`找不到组件 ${component} 的定义`)
  } else if (!/\bt\b/u.test(signature[1])) {
    problems.push(`${component} 的形参未接收 t（应写成 function ${component}({ t })）`)
  }
}

if (problems.length > 0) {
  console.error('槽位注册审查发现问题：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`槽位注册审查通过（${EXPECTATIONS.length} 个槽位，写法符合宿主契约）`)
