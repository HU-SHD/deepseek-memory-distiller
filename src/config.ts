/**
 * 插件配置（Schemastery v2）。
 *
 * 与 v0.2.1 的根本区别：**三个独立 ModelTarget**（forget / memory / embedding），
 * 与角色模型解耦——退潮用便宜/本地模型、涨潮用强模型、检索用嵌入模型，各配各的。
 *
 * 「显式配置」的判定：provider 与 model 都非空。任一为空即视为未显式配置，
 * `resolveTargets` 会回退到默认 target 并把 `decoupled` 标为 false（汇报里标 coupled），
 * **而不是抛错**——插件必须能装起来、能降级运行，再提示用户去填真实值。
 */
import Schema from '@deepseek-ai/schemastery'
import type { Config, ModelTarget } from './types'
import { sha256, stableStringify } from './util/text'

export type { Config, ModelTarget } from './types'

/** 遗忘目标（F 模型）的默认采样参数：遗忘要冷酷。 */
const FORGET_DEFAULTS = { temperature: 0.1, maxTokens: 900, timeoutMs: 60_000 }
/** 记忆目标（M 模型）的默认采样参数：记忆要温情、输出更长。 */
const MEMORY_DEFAULTS = { temperature: 0.35, maxTokens: 2_500, timeoutMs: 120_000 }

/**
 * 未显式配置 forget/memory 时的回退 target。
 *
 * 注意：`provider` / `model` 只是**可改的占位默认值**（deepseek 路由 + deepseek-chat），
 * 用户必须按自己的环境填真实可用的 provider/model；否则运行时会在 probe 中报
 * NO_ADAPTER / 模型不存在，而不是悄悄用角色模型顶替。
 */
const FALLBACK_FORGET: ModelTarget = { provider: 'deepseek', model: 'deepseek-chat', ...FORGET_DEFAULTS }
const FALLBACK_MEMORY: ModelTarget = { provider: 'deepseek', model: 'deepseek-chat', ...MEMORY_DEFAULTS }

/** 一个 ModelTarget 的 Schema 工厂（三个 target 共用结构，默认参数不同）。 */
function modelTargetSchema(
  defaults: { temperature: number; maxTokens: number; timeoutMs: number },
  description: string,
) {
  return Schema.object({
    provider: Schema.string()
      .default('')
      .description('provider 路由名（如 deepseek / ollama）。留空 = 未显式配置，resolveTargets 会回退默认 target'),
    model: Schema.string()
      .default('')
      .description('模型名（如 deepseek-chat / qwen2.5:3b）。必须由用户填写真实可用的模型'),
    temperature: Schema.number()
      .default(defaults.temperature)
      .min(0)
      .max(2)
      .description('采样温度：遗忘 0.1（冷酷），记忆 0.35（温情）'),
    maxTokens: Schema.number().default(defaults.maxTokens).min(1).description('单次输出 token 上限'),
    timeoutMs: Schema.number().default(defaults.timeoutMs).min(1_000).description('单次调用超时（毫秒）'),
  }).description(description)
}

/** 插件配置校验器（与 types.ts 的 Config 完全一致）。 */
export const ConfigSchema: Schema<Config> = Schema.object({
  memoryRoot: Schema.string().default('./data/memory').description('记忆根目录（年轮/原文/账本/汇报都在其下）'),
  windowDays: Schema.number().default(3).min(1).description('一个潮汐窗口的天数（默认 3 天）'),
  forget: modelTargetSchema(FORGET_DEFAULTS, '退潮 · 遗忘官（F 模型）：逐日片把原文压成 Gist，便宜/本地模型即可'),
  memory: modelTargetSchema(MEMORY_DEFAULTS, '涨潮 · 记忆官（M 模型）：单次调用把上一道年轮 + 遗骸合成新年轮，用强模型'),
  embedding: Schema.object({
    provider: Schema.string().default('deepseek').description('嵌入模型的 provider 路由名'),
    model: Schema.string().default('text-embedding-3-small').description('嵌入模型名'),
    threshold: Schema.number().default(0.6).min(0).max(1).description('向量召回相似度阈值'),
  }).description('嵌入模型（E 模型）：检索用；不可用时回退词法检索'),
  injection: Schema.object({
    memoryTokens: Schema.number().default(1_200).min(100).description('核心记忆注入预算（token）'),
    indexEntries: Schema.number().default(15).min(1).description('潜意识索引注入条数'),
    commitments: Schema.number().default(20).min(1).description('承诺锁注入条数硬上限'),
  }).description('系统提示词注入预算'),
  protection: Schema.object({
    commitmentsLock: Schema.boolean().default(true).description('承诺锁：任何模型不得删除的约定'),
    identityAnchor: Schema.boolean().default(true).description('身份锚：名字/关系/边界，独立于年轮，不得改写'),
    archiveRetentionDays: Schema.number().default(0).min(0).description('原文归档保留天数（0 = 永久保留，永不删除）'),
  }).description('三道保护（防忆死）'),
  report: Schema.object({
    enabled: Schema.boolean().default(true).description('每轮是否生成 Markdown 汇报'),
    outputDir: Schema.string().default('./data/memory/reports').description('汇报输出目录（默认 <memoryRoot>/reports）'),
  }).description('汇报'),
  migration: Schema.object({
    auto: Schema.boolean().default(true).description('启动时自动把 v0.2.1 目录原地迁移成 a11 年轮'),
  }).description('迁移'),
  debug: Schema.boolean().default(false).description('输出调试日志'),
})

/** 解析后的模型目标集合。 */
export interface ResolvedTargets {
  forget: ModelTarget
  memory: ModelTarget
  embedding: Config['embedding']
  /** 两个 target 是否都显式配置（false 表示回退到默认 target，汇报里要标 coupled）。 */
  decoupled: boolean
}

/** 一个 target 是否显式配置：provider 与 model 都非空。 */
function isExplicit(target: ModelTarget | undefined): boolean {
  return !!target && target.provider.trim() !== '' && target.model.trim() !== ''
}

/**
 * 把配置里的 target 与回退默认值合并：显式字段优先，缺失字段用默认值补齐。
 * 这样用户只填了 provider 而没填 model 时，不会整个 target 丢失。
 */
function mergeTarget(raw: ModelTarget | undefined, fallback: ModelTarget): ModelTarget {
  return {
    provider: raw && raw.provider.trim() !== '' ? raw.provider.trim() : fallback.provider,
    model: raw && raw.model.trim() !== '' ? raw.model.trim() : fallback.model,
    temperature: typeof raw?.temperature === 'number' ? raw.temperature : fallback.temperature,
    maxTokens: typeof raw?.maxTokens === 'number' ? raw.maxTokens : fallback.maxTokens,
    timeoutMs: typeof raw?.timeoutMs === 'number' ? raw.timeoutMs : fallback.timeoutMs,
  }
}

/**
 * 解析 forget / memory / embedding 三个 target。
 *
 * 行为契约（INTERFACES 第 1 节）：
 * - 两个 target 都显式配置 → `decoupled = true`（真正的双模型分离）；
 * - 任一未显式配置 → 回退到默认 target，`decoupled = false`（**不抛错**，
 *   汇报里标 coupled，提醒用户去配置；插件仍可运行）。
 *
 * @param config 已校验的插件配置
 */
export function resolveTargets(config: Config): ResolvedTargets {
  const forgetRaw = config.forget as ModelTarget | undefined
  const memoryRaw = config.memory as ModelTarget | undefined
  const forgetExplicit = isExplicit(forgetRaw)
  const memoryExplicit = isExplicit(memoryRaw)
  return {
    forget: mergeTarget(forgetRaw, FALLBACK_FORGET),
    memory: mergeTarget(memoryRaw, FALLBACK_MEMORY),
    embedding: config.embedding,
    decoupled: forgetExplicit && memoryExplicit,
  }
}

/**
 * 配置指纹：进入 inputHash 的配置快照。
 * 只包含**会影响记忆内容**的字段（provider/model/温度/输出上限/嵌入），
 * 换模型或换温度会得到新的 inputHash，从而不复用旧年轮。
 *
 * @param targets 由 {@link resolveTargets} 解析出的 target 集合
 */
export function configFingerprint(targets: ResolvedTargets): string {
  const snapshot = {
    forget: {
      provider: targets.forget.provider,
      model: targets.forget.model,
      temperature: targets.forget.temperature,
      maxTokens: targets.forget.maxTokens,
    },
    memory: {
      provider: targets.memory.provider,
      model: targets.memory.model,
      temperature: targets.memory.temperature,
      maxTokens: targets.memory.maxTokens,
    },
    embedding: {
      provider: targets.embedding.provider,
      model: targets.embedding.model,
      threshold: targets.embedding.threshold,
    },
  }
  return sha256(stableStringify(snapshot))
}
