/**
 * DSH LLM 网关：把一次「一次性调用」封装成 Promise。
 *
 * DSH 0.2.2 没有 `textChat`，只有流式 `ctx.llm.stream`。这里用官方
 * {@link BlockAssembler} 把流式 chunk 拼成完整文本，并统一处理超时、错误包装、
 * 用量统计——双模型解耦的物理落点就是「两次独立的 stream 调用，各自的 provider/model」。
 */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelTarget } from '../types'

/** 一次模型调用请求（与具体 provider 无关）。 */
export interface ChatRequest {
  /** 一次性 system slot。 */
  system?: string
  /** 用户侧提示词。 */
  prompt: string
  /** 采样温度：遗忘 0.1 / 记忆 0.35。 */
  temperature: number
  /** 输出 token 上限。 */
  maxTokens: number
  /** 超时毫秒。 */
  timeoutMs: number
  /** 调用用途（审计用），如 'memory-forget'。 */
  purpose: string
}

/** 一次模型调用结果。 */
export interface ChatResult {
  /** 拼好的完整文本。 */
  text: string
  /** 输入 token（provider 未上报时为 undefined，由估算兜底）。 */
  inputTokens?: number
  /** 输出 token。 */
  outputTokens?: number
}

/** 模型网关：同一实例可服务任意 target（provider/model 由调用参数决定）。 */
export interface LlmGateway {
  chat(target: ModelTarget, req: ChatRequest): Promise<ChatResult>
}

/**
 * 基于 DSH `ctx.llm.stream` 创建网关。
 *
 * @param ctx 插件上下文（需要 `llm` 服务已注入）
 */
export function createDshGateway(ctx: Context): LlmGateway {
  return {
    async chat(target: ModelTarget, req: ChatRequest): Promise<ChatResult> {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort(new Error(`LLM 调用超时（${req.timeoutMs}ms，purpose=${req.purpose}）`))
      }, req.timeoutMs)

      const assembler = new BlockAssembler()
      try {
        const options: GenerateOptions = {
          provider: target.provider,
          model: target.model,
          system: req.system,
          messages: [{ role: 'user', content: [{ type: 'text', text: req.prompt }] }],
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          // DSH 要求生产方通过模块增强登记 purpose；本仓库 tsconfig 为 node10 解析，
          // 无法增强 `@deepseek-ai/dsh-llm/types` 子路径，故在边界处窄化（运行时适配器透传字符串）。
          purpose: req.purpose as unknown as GenerateOptions['purpose'],
          signal: controller.signal,
        }
        for await (const chunk of ctx.llm.stream(options)) {
          assembler.push(chunk)
        }
      } catch (error) {
        throw wrapLlmError(target, req, error)
      } finally {
        clearTimeout(timer)
      }

      const blocks = assembler.blocks()
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      const usage = assembler.usage
      return {
        text,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      }
    },
  }
}

/** 把底层错误包装成带 purpose/provider 信息的 Error（保留 cause）。 */
function wrapLlmError(target: ModelTarget, req: ChatRequest, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`[memory-distiller] ${req.purpose} 调用失败（${target.provider}/${target.model}）：${message}`, {
    cause: error,
  })
}

/** 单个角色的用量。 */
export interface ModelUsage {
  role: 'forget' | 'memory'
  inputTokens: number
  outputTokens: number
  calls: number
}

/** 用量统计器：按 forget / memory 两个角色累计 token 与调用次数（汇报成本用）。 */
export class UsageMeter {
  private readonly counters: Record<'forget' | 'memory', Omit<ModelUsage, 'role'>> = {
    forget: { inputTokens: 0, outputTokens: 0, calls: 0 },
    memory: { inputTokens: 0, outputTokens: 0, calls: 0 },
  }

  /** 记录一次调用结果（provider 未上报 token 时按 0 计）。 */
  add(role: 'forget' | 'memory', result: ChatResult): void {
    const counter = this.counters[role]
    counter.inputTokens += result.inputTokens ?? 0
    counter.outputTokens += result.outputTokens ?? 0
    counter.calls += 1
  }

  /** 快照（返回副本，调用方可安全修改/序列化）。 */
  snapshot(): ModelUsage[] {
    return (['forget', 'memory'] as const).map((role) => ({ role, ...this.counters[role] }))
  }

  /** 清零（新一轮开始前调用）。 */
  reset(): void {
    for (const role of ['forget', 'memory'] as const) {
      this.counters[role] = { inputTokens: 0, outputTokens: 0, calls: 0 }
    }
  }
}
