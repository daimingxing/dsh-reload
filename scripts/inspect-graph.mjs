/**
 * 诊断：clientModules 是否收录了 dsh-reload。
 *
 * 用法（与 Host 同环境）：
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" --expose-internals scripts/inspect-graph.mjs
 *
 * 只读：不写文件、不改配置。
 */
import fs from 'node:fs'

const RUNTIME = process.env.DSH_RUNTIME_DIR ?? 'E:/dsh-desktop/resources/app.asar/dsh'

// 直接解析 dsh-reload 的包清单，确认声明本身没问题。
const pkgPath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
console.log('=== dsh-reload 的声明 ===')
console.log('  name        :', pkg.name)
console.log('  type        :', pkg.type)
console.log('  dsh.client  :', JSON.stringify(pkg.dsh?.client))
console.log('  exports./client:', JSON.stringify(pkg.exports?.['./client']))
console.log('  client.js 存在 :', fs.existsSync(new URL('../client.js', import.meta.url)))

// 确认 client.js 的模块 id 与包名一致（不匹配会导致注册到不存在的槽位）。
const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const idMatch = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)
console.log('  client.js 的模块 id:', idMatch?.[1] ?? '(未找到)')
console.log('  id 与包名一致  :', idMatch?.[1] === pkg.name ? '是' : '否 ← 需要修正')

// 槽位 id 是否与注册时一致。
for (const slot of [
  'sidebar.footer.action',
  'conversation.header.leading',
  'shell.overlay',
  'sidebar.panellist.actions',
  'plugins.bundle.config',
  'settings.action',
]) {
  const used = clientSource.includes(`name: '${slot}'`)
  console.log(`  注册槽位 ${slot}: ${used ? '已引用' : '未引用'}`)
}

// 已废弃的槽位不得再出现（入口已从「通用设置」撤掉）。
for (const slot of ['settings.general.item']) {
  const used = clientSource.includes(`name: '${slot}'`)
  console.log(`  废弃槽位 ${slot}: ${used ? '⚠️ 仍在注册' : '已清除'}`)
}

// keyed 槽位（plugins.bundle.config）的 key 必须精确等于包名，否则卡片静默不出现。
const keyMatch = clientSource.match(/const PKG_NAME = '([^']+)'/)
console.log('  PKG_NAME       :', keyMatch?.[1] ?? '(未找到)')
console.log('  与包名一致      :', keyMatch?.[1] === pkg.name ? '是' : '否 ← 需要修正')

// 检查 client.js 里是否误用了 Node 专有的 API（浏览器会直接抛错，导致整个模块加载失败）。
const nodeOnly = ['require("node:', "require('node:", 'process.env.', 'readFileSync', 'writeFileSync']
console.log('\n=== 浏览器不兼容 API 检查 ===')
for (const token of nodeOnly) {
  const count = clientSource.split(token).length - 1
  if (count > 0) console.log(`  ⚠️ ${token} 出现 ${count} 次`)
}
console.log('  （以上为空表示未发现）')
