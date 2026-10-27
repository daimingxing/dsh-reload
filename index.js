/**
 * dsh-reload — Host 半边。
 *
 * 两个动作，各只有一个实现，工具与 UI 共用（见 references/user-actions.md 的
 * 「一个操作，两个调用者」）：
 *
 *  - `hotReload()`  —— 不碰进程，重新加载文件有改动的插件
 *  - `restart()`    —— 结束并重新拉起桌面客户端
 *
 * 权限差异是关键设计：**热重载对智能体开放，重启只对 UI 开放**。原因是 Host
 * 就是 Electron 主进程的子进程，智能体跑在 Host 里——让它杀主进程等于杀自己，
 * 工具响应必然丢失。这不是保守，是进程拓扑决定的。
 *
 * 安全策略：**有任务在跑时禁止重启**，即使前端已经确认。判定在 Host 侧做两次
 * （点击前查询 + 执行前复查），因为「查询」和「真正动手」之间存在冲突窗口。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { hotReload as runHotReload } from './lib/hot-reload.js'
import { inspectActivity } from './lib/activity.js'
import { locateDesktop, describeTarget, launchRestarter } from './lib/restart.js'
import { consumePendingRestart, markPendingRestart, recordHotReload, stateDir } from './lib/state.js'

export const name = 'dsh-reload'

/**
 * 只依赖这些服务，缺失时插件保持不激活而不是抛错。
 *
 * `connection` / `webServer` 只在带 Web 界面的 profile 里有；`hmr` 只在启用 HMR
 * 的 profile 里有。用 optional 注入让插件在没有它们的 profile 中安静地不工作。
 */
export const inject = ['connection', 'webServer']

/** HTTP 路由前缀（`connection.fetch` 用的完整路径；webServer 用同名前缀）。 */
const API_PREFIX = '/api/dsh-reload'

/** Web 端兜底路由前缀。桌面代理只转发 `dsh-app://app` 下的非静态路径到 Host，
 *  两条通道都挂上，前端先探 `/ping` 决定用哪个。 */
const WEB_PREFIX = '/dsh-reload/api'

/** 重启器需要的等待上限（毫秒），仅用于给前端一个预期，不参与控制流。 */
const RESTART_ESTIMATE_MS = 4000

/**
 * 写 JSON 响应。
 * @param res - Node HTTP 响应。
 * @param status - HTTP 状态码。
 * @param payload - 响应体。
 */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 判断一次重启请求是否被允许，并准备重启器配置。
 *
 * 这里是**权威判定**：前端查过一遍，但查询与执行之间的窗口里可能有新任务启动，
 * 所以必须再查一次。
 *
 * @param ctx - 插件上下文。
 * @returns {{ allowed: true, restarterPid: number } | { allowed: false, status: number, payload: object }}
 */
async function prepareRestart(ctx) {
  const activity = inspectActivity(ctx)
  if (activity.active) {
    return {
      allowed: false,
      status: 409,
      payload: {
        ok: false,
        error: { code: 'busy', message: '有任务正在运行，已拒绝重启' },
        data: activity,
      },
    }
  }

  const { mainPid, exe } = locateDesktop()
  const rejection = describeTarget(mainPid, exe)
  if (rejection !== null) {
    return {
      allowed: false,
      status: 409,
      payload: { ok: false, error: { code: 'unsupported', message: rejection } },
    }
  }

  // 落盘「即将重启」标记：新实例启动后读到它就提示一次，然后清掉。
  // 必须在杀进程之前写完，否则这次重启会「无痕」发生。
  await markPendingRestart(ctx, 'ui')

  const dir = stateDir(ctx)
  const token = randomUUID().slice(0, 8)
  const configPath = join(dir, `restart-${token}.json`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mainPid,
          exe,
          logPath: join(dir, 'restart.log'),
          donePath: join(dir, 'restart-done.txt'),
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch (error) {
    return {
      allowed: false,
      status: 500,
      payload: {
        ok: false,
        error: { code: 'io', message: `无法准备重启器：${String(error?.message ?? error)}` },
      },
    }
  }

  const restarterPid = launchRestarter({ configPath })
  ctx?.logger?.('dsh-reload')?.info?.(`重启器已启动 pid=${restarterPid}，目标主进程 ${mainPid}`)

  return { allowed: true, restarterPid }
}

/**
 * 注册 `dsh_hot_reload` 工具。
 *
 * 工具**只做热重载**。它不是能力缺失，而是进程拓扑决定的：智能体 kill 主进程
 * 会同时杀掉承载自己的 Host，工具响应无法返回。
 *
 * @param ctx - 插件上下文。
 */
function registerTool(ctx) {
  const tools = ctx.get?.('tools')
  if (tools === undefined) return

  ctx.effect(
    () =>
      tools.register({
        name: 'dsh_hot_reload',
        description: [
          'Reload DSH plugins whose files changed on disk, without restarting the client or interrupting sessions. Call after editing and rebuilding plugin code, or when the user asks.',
          '',
          'changed=false is not an error: nothing changed on disk (not rebuilt, edit affects no emitted JS, or already reloaded). Non-empty pending/restartReason needs a client restart.',
        ].join('\n'),
        // `tools.register()` 直接接收 JSON Schema（不是 defineTool 的简写规格），
        // 无参工具也必须显式声明 `type: 'object'` + `properties: {}`；
        // 缺 `type` 会让服务端在组装工具列表时拒绝整个请求。
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          // 宿主只支持 JSON Schema 的一个子集：type/oneOf/properties/required/
          // additionalProperties/items/enum/const。`required` 必须是父级数组，
          // `type` 不能写成数组（所以 restartReason 用 oneOf 表达可空字符串）。
          schema: {
            type: 'object',
            additionalProperties: false,
            required: [
              'applied',
              'changed',
              'replaced',
              'replacedPlugins',
              'pending',
              'restartReason',
              'warnings',
              'notes',
            ],
            properties: {
              applied: { type: 'boolean' },
              changed: { type: 'boolean' },
              // hotReload() 的完整返回值必须与这份 schema 严格一致：
              // 输出按 additionalProperties:false 校验，多一个字段整个结果会被丢弃。
              replaced: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name'],
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                  },
                },
              },
              replacedPlugins: {
                type: 'array',
                items: { type: 'string' },
              },
              pending: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['url', 'reason'],
                  properties: {
                    url: { type: 'string' },
                    reason: { type: 'string' },
                  },
                },
              },
              restartReason: {
                oneOf: [{ type: 'string' }, { type: 'null' }],
              },
              warnings: {
                type: 'array',
                items: { type: 'string' },
              },
              notes: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          render: (_args, value) => {
            const lines = []
            if (value.changed) {
              lines.push(`已热重载 ${value.replacedPlugins.length} 个插件：${value.replacedPlugins.join('、')}`)
            } else {
              lines.push('没有检测到改动：磁盘上没有插件文件变化，未触发重载。')
            }
            for (const note of value.notes ?? []) lines.push(`注意：${note}`)
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute() {
          const result = await runHotReload(ctx)
          await recordHotReload(ctx, result)
          return result
        },
        presentCall: () => ({
          card: 'generic',
          title: '热重载插件',
          kind: 'other',
        }),
      }),
    'dsh-reload: dsh_hot_reload tool',
  )
}

/**
 * 注册 `connection.fetch` 路由（桌面版主通道）。
 *
 * 桌面端页面运行在 `dsh-app://` 下，请求由 Electron 主进程代理到 Host，`Origin`
 * 与 `Host` 都被剥掉——所以这里不能依赖 `webServer` 的常规路由，必须挂
 * `connection.fetch`（它自带 desktop 代理形状的鉴权）。
 *
 * @param ctx - 插件上下文。
 */
function registerConnectionRoutes(ctx) {
  const connection = ctx.get?.('connection')
  if (connection?.fetch?.register === undefined) return

  const route = (path, methods, fetch) => {
    ctx.effect(
      () => connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }),
      `dsh-reload: ${path}`,
    )
  }

  route(`${API_PREFIX}/ping`, ['GET'], async () => writeJsonResponse({ ok: true, data: { version: 1 } }))

  route(`${API_PREFIX}/status`, ['GET'], async () => {
    const activity = inspectActivity(ctx)
    const { mainPid, exe } = locateDesktop()
    const rejection = describeTarget(mainPid, exe)
    return writeJsonResponse({
      ok: true,
      data: {
        activity,
        restatable: rejection === null,
        restartBlockedReason: rejection,
        restartEstimateMs: RESTART_ESTIMATE_MS,
      },
    })
  })

  route(`${API_PREFIX}/hot-reload`, ['POST'], async () => {
    try {
      const result = await runHotReload(ctx)
      await recordHotReload(ctx, result)
      return writeJsonResponse({ ok: true, data: result })
    } catch (error) {
      return writeJsonResponse(
        { ok: false, error: { code: 'reload-failed', message: String(error?.message ?? error) } },
        500,
      )
    }
  })

  route(`${API_PREFIX}/restart`, ['POST'], async () => {
    const prepared = await prepareRestart(ctx)
    if (!prepared.allowed) return writeJsonResponse(prepared.payload, prepared.status)
    return writeJsonResponse({
      ok: true,
      data: { restarting: true, estimateMs: RESTART_ESTIMATE_MS },
    })
  })

  route(`${API_PREFIX}/pending-restart`, ['POST'], async () => {
    // 新实例启动后由前端调用：读到标记就提示一次，然后清掉。
    const pending = await consumePendingRestart(ctx)
    return writeJsonResponse({ ok: true, data: { pending } })
  })
}

/**
 * 把普通对象包装成 Fetch `Response`。
 * @param payload - JSON 体。
 * @param status - 状态码。
 * @returns Response。
 */
function writeJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * 注册 `webServer` 前缀路由（`dsh web` 兜底通道）。
 *
 * 桌面版到此的路由走 `connection.fetch` 更好；但源码模式下没有 Electron 代理，
 * `webServer` 是唯一入口。两条通道并存，前端探活后选一个用。
 *
 * @param ctx - 插件上下文。
 */
function registerWebRoutes(ctx) {
  const webServer = ctx.get?.('webServer')
  if (webServer?.register === undefined) return

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: WEB_PREFIX,
        handler: async (req, res) => {
          // 同源/回环校验交给 connection；它不在时退化为只允许本机。
          const rejection = ctx.get?.('connection')?.requestRejection?.(req)
          if (rejection !== undefined && rejection !== null) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }

          const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(
            WEB_PREFIX.length + 1,
          )

          try {
            if (req.method === 'GET' && method === 'ping') {
              writeJson(res, 200, { ok: true, data: { version: 1 } })
              return
            }
            if (req.method === 'GET' && method === 'status') {
              const activity = inspectActivity(ctx)
              const { mainPid, exe } = locateDesktop()
              const reason = describeTarget(mainPid, exe)
              writeJson(res, 200, {
                ok: true,
                data: {
                  activity,
                  restatable: reason === null,
                  restartBlockedReason: reason,
                  restartEstimateMs: RESTART_ESTIMATE_MS,
                },
              })
              return
            }
            if (req.method === 'POST' && method === 'hot-reload') {
              try {
                const result = await runHotReload(ctx)
                await recordHotReload(ctx, result)
                writeJson(res, 200, { ok: true, data: result })
              } catch (error) {
                writeJson(res, 500, {
                  ok: false,
                  error: { code: 'reload-failed', message: String(error?.message ?? error) },
                })
              }
              return
            }
            if (req.method === 'POST' && method === 'restart') {
              const prepared = await prepareRestart(ctx)
              writeJson(res, prepared.allowed ? 200 : prepared.status, prepared.payload)
              return
            }
            if (req.method === 'POST' && method === 'pending-restart') {
              const pending = await consumePendingRestart(ctx)
              writeJson(res, 200, { ok: true, data: { pending } })
              return
            }
            writeJson(res, 404, {
              ok: false,
              error: { code: 'not-found', message: `unknown method "${method}"` },
            })
          } catch (error) {
            writeJson(res, 500, {
              ok: false,
              error: { code: 'error', message: String(error?.message ?? error) },
            })
          }
        },
      }),
    'dsh-reload: web routes',
  )
}

/**
 * 插件入口。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  registerTool(ctx)
  registerConnectionRoutes(ctx)
  registerWebRoutes(ctx)
}
