/**
 * 模型路由器：把「退潮」与「涨潮」固定绑定到各自的 target，并共享用量统计。
 *
 * 路由器的存在意义：调用方（forgetter / integrator）只认识 `router.forget` 与
 * `router.memory`，不需要知道 provider/model 从哪来——这正是 P1「模型只是载体」的代码形态。
 * 若调用方传入了不完整的 target（provider/model 为空），路由器回退到 createRouter 时绑定的
 * target，保证降级路径也能跑。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelTarget } from '../types'
import type { ResolvedTargets } from '../config'
import { createDshGateway, UsageMeter } from './gateway'
import type { ChatRequest, ChatResult, LlmGateway } from './gateway'

/** 双模型路由器。 */
export interface ModelRouter {
  /** 退潮（遗忘官 F 模型）。 */
  forget: LlmGateway
  /** 涨潮（记忆官 M 模型）。 */
  memory: LlmGateway
  /** 用量统计。 */
  meter: UsageMeter
  /** 运行时自检：两个 target 是否可解析。永不抛错。 */
  probe(): Promise<{ ok: boolean; detail: string }>
}

/**
 * 路由器 → 解析后 targets 的弱引用表。
 * forgetter 需要知道 forget target 的温度/输出上限（INTERFACES 的 ForgetDeps 不带 config），
 * 这里用 WeakMap 传递，避免改动已冻结的 ForgetDeps 签名；手工构造的 router 查不到时走默认值。
 */
const routerTargets = new WeakMap<object, ResolvedTargets>()

/** 取回 createRouter 时绑定的 targets（非 createRouter 构造的 router 返回 undefined）。 */
export function targetsOf(router: ModelRouter): ResolvedTargets | undefined {
  return routerTargets.get(router)
}

/** target 是否完整到足以发起调用。 */
function isUsableTarget(target: ModelTarget | undefined): target is ModelTarget {
  return !!target && target.provider.trim() !== '' && target.model.trim() !== ''
}

/**
 * 创建路由器。
 *
 * @param ctx     插件上下文（需要 `llm` 服务）
 * @param targets 由 resolveTargets 解析出的三个 target
 */
export function createRouter(ctx: Context, targets: ResolvedTargets): ModelRouter {
  const meter = new UsageMeter()
  const gateway = createDshGateway(ctx)

  /** 绑定角色的网关：调用方传完整 target 就用它，否则用绑定 target。 */
  const bind = (role: 'forget' | 'memory', bound: ModelTarget): LlmGateway => ({
    async chat(target: ModelTarget, req: ChatRequest): Promise<ChatResult> {
      const use = isUsableTarget(target) ? target : bound
      const result = await gateway.chat(use, req)
      meter.add(role, result)
      return result
    },
  })

  const router: ModelRouter = {
    forget: bind('forget', targets.forget),
    memory: bind('memory', targets.memory),
    meter,
    async probe(): Promise<{ ok: boolean; detail: string }> {
      const lines: string[] = []
      let ok = true
      const checks: { role: string; target: ModelTarget }[] = [
        { role: 'forget', target: targets.forget },
        { role: 'memory', target: targets.memory },
      ]
      try {
        for (const check of checks) {
          try {
            await ctx.llm.resolveModelInfo(check.target.provider, check.target.model)
            lines.push(`${check.role}: ${check.target.provider}/${check.target.model} ✓`)
          } catch (error) {
            ok = false
            const message = error instanceof Error ? error.message : String(error)
            lines.push(`${check.role}: ${check.target.provider}/${check.target.model} ✗ ${message}`)
          }
        }
        if (!targets.decoupled) {
          lines.push('forget/memory 未全部显式配置 → 已回退默认 target（coupled，建议分别配置 provider/model）')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, detail: `probe 异常：${message}` }
      }
      return { ok, detail: lines.join('；') }
    },
  }
  routerTargets.set(router, targets)
  return router
}
