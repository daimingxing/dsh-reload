/**
 * 「有没有任务在跑」的判定，以及给 UI 看的任务清单。
 *
 * 判据必须与桌面壳自己的 `hasDesktopActiveTasks()` 一致，否则会出现「DSH 认为
 * 没事、本插件认为有事」这种自相矛盾。原文（@deepseek-ai/dsh-desktop-host）：
 *
 *   liveAgents.some(a => a.status === 'running'
 *                     || a.inbox.nextTurn.length > 0
 *                     || a.inbox.nextStep.length > 0)
 *   || [void 0, ...liveAgents].some(a =>
 *        jobs.list(a?.id).some(j => j.status === 'running' || j.status === 'stopping'))
 *
 * 两处 `[void 0, ...liveAgents]` 的 `void 0` 不能省：它让 `jobs.list(undefined)`
 * 也参与查询，覆盖「不属于任何会话的全局 job」。
 */

/** 每类任务在提示框里最多列几条，避免长列表把对话框撑爆。 */
const MAX_PER_KIND = 3

/** 任务状态里算「还在跑」的取值。 */
const ACTIVE_JOB_STATUS = new Set(['running', 'stopping'])

/**
 * 读取一个 agent 的显示标题。取不到就返回 null，由 UI 退化成「未命名会话」。
 * @param ctx - 携带 sessionTitle 服务的上下文。
 * @param agent - 目标 agent。
 * @returns 标题文本或 null。
 */
function titleOf(ctx, agent) {
  try {
    const session = agent?.session
    if (session === undefined) return null
    const snapshot = ctx.get?.('sessionTitle')?.get?.(session)
    const title = snapshot?.title
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : null
  } catch {
    // 标题只是展示信息，任何失败都不该影响「是否忙碌」的判定。
    return null
  }
}

/**
 * 收集当前在飞的任务。
 *
 * 返回的 `active` 是权威判定（决定界面走「禁止重启」还是「允许重启」）；
 * 其余字段只用于提示框展示。任何一环取不到服务都按「没有这一类任务」处理，
 * 但 `active` 的计算对 agent 的判定不依赖可选服务，避免漏判。
 *
 * @param ctx - 插件上下文。
 * @returns {{ active: boolean, agents: object[], jobs: object[], terminals: object[] }}
 */
export function inspectActivity(ctx) {
  const agents = []
  const jobs = []
  const terminals = []
  let active = false

  let liveAgents = []
  try {
    liveAgents = ctx.get?.('agents')?.list?.() ?? []
  } catch {
    liveAgents = []
  }

  for (const agent of liveAgents) {
    const running = agent?.status === 'running'
    const queued =
      (agent?.inbox?.nextTurn?.length ?? 0) > 0 || (agent?.inbox?.nextStep?.length ?? 0) > 0
    if (!running && !queued) continue
    active = true
    agents.push({
      id: String(agent?.id ?? ''),
      title: titleOf(ctx, agent),
      status: running ? 'running' : 'queued',
    })
  }

  try {
    const registry = ctx.get?.('jobs')
    if (registry !== undefined) {
      // void 0 代表「没有归属会话的全局 job」，与桌面壳的判据保持一致。
      for (const caller of [undefined, ...liveAgents.map((agent) => agent?.id)]) {
        for (const job of registry.list?.(caller) ?? []) {
          if (!ACTIVE_JOB_STATUS.has(job?.status)) continue
          active = true
          // 同一个 job 可能被全局与所属会话两次列出，按 id 去重。
          if (jobs.some((entry) => entry.id === String(job?.id))) continue
          jobs.push({
            id: String(job?.id ?? ''),
            label: typeof job?.label === 'string' && job.label !== '' ? job.label : String(job?.id ?? ''),
            status: String(job?.status ?? ''),
          })
        }
      }
    }
  } catch {
    // job 服务不可用：不影响 agent 维度的判定。
  }

  try {
    const registry = ctx.get?.('terminals')
    for (const agent of liveAgents) {
      for (const terminal of registry?.list?.(agent) ?? []) {
        terminals.push({
          id: String(terminal?.id ?? ''),
          title:
            typeof terminal?.title === 'string' && terminal.title !== ''
              ? terminal.title
              : String(terminal?.id ?? ''),
        })
      }
    }
  } catch {
    // terminal 服务不可用：同上。
  }

  return {
    active,
    agents: agents.slice(0, MAX_PER_KIND).map((entry) => entry),
    jobs: jobs.slice(0, MAX_PER_KIND),
    terminals: terminals.slice(0, MAX_PER_KIND),
    // 未截断的总数，供 UI 显示「等 N 个」。
    counts: {
      agents: agents.length,
      jobs: jobs.length,
      terminals: terminals.length,
    },
  }
}
