/**
 * 静态审查：槽位注册的写法必须与宿主契约一致。
 *
 * 从宿主自己的源码（`@deepseek-ai/dsh-client-ui-settings-general`、
 * `@deepseek-ai/dsh-client-ui-plugin-manager`）可以看到标准写法：
 *
 *   ctx.slots.inject('settings.general.item', () => ctx.slots.register({
 *     name: 'settings.general.item', id: 'current-version', order: 100, locale: NS,
 *   }, CurrentVersionRow))
 *
 * 而组件从 **props** 取 `t`（`function CurrentVersionRow({ t })`）——`locale: NS`
 * 声明会让框架把翻译函数注入 props。这里检查四件事：
 *  1. 每个槽位都用 `slots.inject(slot, () => slots.register(...))` 的成对写法
 *  2. 注册选项里带 `locale`
 *  3. 组件形参接收 `t`
 *  4. keyed 槽位的 key 是**包名**（插件页用 `ledger.bundles.has(pkg.name)` 判断
 *     是否渲染；写成 Loader entry id 会静默不显示）
 *
 * 用法：node scripts/check-slot-components.mjs
 */
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const problems = []

/** 槽位 → 期望的注册选项 / 组件名。 */
const EXPECTATIONS = [
  {
    slot: 'sidebar.footer.action',
    id: 'dsh-reload:button',
    order: 10,
    component: 'SidebarButton',
  },
  {
    slot: 'plugins.bundle.config',
    // keyed 槽位没有 id / order：key 就是它的身份。
    key: pkg.name,
    component: 'PluginPageCard',
  },
  {
    slot: 'settings.action',
    id: 'dsh-reload:header-actions',
    order: 10,
    component: 'SettingsHeaderActions',
  },
  {
    slot: 'shell.overlay',
    id: 'dsh-reload:floating',
    order: 900,
    component: 'FloatingButton',
  },
  {
    slot: 'sidebar.panellist.actions',
    id: 'dsh-reload:more-menu',
    order: 100,
    component: 'MoreMenuItem',
  },
]

/**
 * 已经废弃、不得再出现的槽位。
 *
 * `settings.general.item`：本插件曾在「设置 → 通用」底部放一行按钮 + 开关，
 * 现已全部撤掉——通用页只放全局偏好，热重载 / 重启的入口在插件详情页和
 * 设置面板顶栏。
 *
 * `conversation.header.leading`：曾在主区域顶栏最左侧放热重载按钮，
 * 用户认为不该占那个位置（会跟会话标题抢视线），已整体撤掉。
 */
const RETIRED_SLOTS = ['settings.general.item', 'conversation.header.leading']

for (const retired of RETIRED_SLOTS) {
  if (source.includes(`name: '${retired}'`)) {
    problems.push(`槽位 ${retired} 已废弃，不应再注册`)
  }
}

for (const { slot, id, key, order, component } of EXPECTATIONS) {
  // 1) inject 与 register 成对出现，槽位名出现两次（inject 的参数 + register 的 name）
  const injectPattern = new RegExp(
    `ctx\\.slots\\.inject\\(\\s*'${slot.replace(/\./gu, '\\.')}'\\s*,\\s*\\(\\)\\s*=>`,
    'u',
  )
  if (!injectPattern.test(source)) {
    problems.push(`槽位 ${slot} 未使用 slots.inject(slot, () => ...) 的成对写法`)
  }
  if (!source.includes(`name: '${slot}'`)) problems.push(`slots.register 缺少 name: '${slot}'`)
  if (id !== undefined && !source.includes(`id: '${id}'`)) {
    problems.push(`槽位 ${slot} 的 id 应为 ${id}`)
  }
  if (order !== undefined && !source.includes(`order: ${order}`)) {
    problems.push(`槽位 ${slot} 的 order 应为 ${order}`)
  }
  if (key !== undefined) {
    if (!source.includes(`key: PKG_NAME`)) {
      problems.push(`槽位 ${slot} 的注册缺少 key: PKG_NAME`)
    }
    if (!source.includes(`const PKG_NAME = '${key}'`)) {
      problems.push(`PKG_NAME 应等于包名 ${key}（keyed 槽位的 key 必须精确匹配）`)
    }
  }

  // 2) 该 register 调用必须带 locale（否则组件拿不到 t）
  //
  // single 槽位（如 conversation.header.leading）没有 id，注册选项只有
  // name + locale，所以锚点退回 `name: '<slot>'`。
  const anchor = id !== undefined ? `id: '${id}'` : key !== undefined ? `key: PKG_NAME` : `name: '${slot}'`
  const at = source.indexOf(anchor)
  const registerBlock = at === -1 ? '' : source.slice(Math.max(0, at - 200), at + 220)
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
