/**
 * 潮汐忆体 (TMA) v2.0 — 共享领域类型。
 *
 * 本文件是 v2 的冻结契约：`src/` 下所有模块都从这里取类型，不要重复定义。
 * 刻意保持零运行时依赖（只有 type 导出），以便单测直接 require。
 */

/* ────────────────────────────── 基本标识 ────────────────────────────── */

/** 年轮字母：a, b, … z, za, zb …（26 进制，z 之后进一位）。 */
export type CycleId = string
/** 日片：一个潮汐窗口内的第 1/2/3 天，如 'a1' 'a2' 'a3'。 */
export type ShardId = string
/** 年轮：如 'a11' 'b11' 'c11'（沿用用户命名法）。 */
export type RingId = string

/** 一个潮汐窗口的配置。 */
export interface WindowSpec {
  /** 窗口天数，默认 3。 */
  windowDays: number
  /** 当前周期字母。 */
  cycle: CycleId
}

/* ────────────────────────────── 模型目标 ────────────────────────────── */

/**
 * 一个独立的模型调用目标。三个 target（forget / memory / embedding）各自配置，
 * 与角色模型解耦 —— 这是"蒸馏模型与主模型解耦"的落点。
 */
export interface ModelTarget {
  /** provider 路由名，如 'deepseek' / 'ollama'。 */
  provider: string
  /** 模型名，如 'deepseek-chat' / 'qwen2.5:3b'。 */
  model: string
  /** 采样温度：遗忘要冷（0.1），记忆要暖（0.35）。 */
  temperature: number
  /** 单次输出上限。 */
  maxTokens: number
  /** 超时毫秒。 */
  timeoutMs: number
}

/* ────────────────────────────── 退潮产物 ────────────────────────────── */

/** 一条被有意丢弃的内容。 */
export interface DroppedItem {
  what: string
  /** routine=日常琐事 / duplicate=重复 / low-weight=低权重 / sensitive=敏感 / over-budget=超预算 */
  why: 'routine' | 'duplicate' | 'low-weight' | 'sensitive' | 'over-budget'
  /** 遗骸指针：archive/2026-11/a1.md#L12 或 rings/a11.md。 */
  ref: string
}

/** 索引条目（潜意识索引）。 */
export interface IndexEntry {
  topic: string
  keywords: string[]
  /** 指向年轮（近因优先）。 */
  ring: RingId
  /** 指向日片（若来自具体某天）。 */
  shard?: ShardId
  /** 0–10，由显式信号（"一定要记得"）决定，不按情绪。 */
  importance: number
  /** 0–1，越老越低，检索时加权。 */
  decay: number
  /** 遗骸指针，用于回溯原文。 */
  ptr: string
}

/** 退潮产物：一份带指针的压缩"遗骸"。 */
export interface Gist {
  shard: ShardId
  /** 原文 sha256，用于可回溯性校验。 */
  hash: string
  events: { t: string; what: string; who?: string; weight: number }[]
  facts: { key: string; value: string; confidence: number }[]
  entities: { name: string; type: 'person' | 'thing' | 'place' | 'concept'; salience: number }[]
  dropped: DroppedItem[]
  /** 未完成的事 / 待回答的问题。 */
  openLoops: string[]
  index: IndexEntry[]
  /** 是否走了确定性降级（F 模型不可用时）。 */
  degraded: boolean
}

/* ────────────────────────────── 涨潮产物 ────────────────────────────── */

/** 承诺锁：任何模型都不得删除。 */
export interface Commitment {
  id: string
  text: string
  createdAt: string
  sourceShard: ShardId
  /** 一次性约定（如生日）到期后转普通记忆；undefined 表示永久。 */
  expires?: string
}

/** 冲突裁定。 */
export interface Conflict {
  a: string
  b: string
  resolution: 'kept-old' | 'kept-new' | 'merged' | 'open'
}

/** 一道年轮：某轮退潮+涨潮的记忆结晶。 */
export interface Ring {
  id: RingId
  cycle: CycleId
  inputs: {
    prevRing?: RingId
    shards: ShardId[]
    /** sha256(prevRingId + sorted shard hashes + config fingerprint)。 */
    inputHash: string
  }
  /** 300–800 字，人类可读的"这段时间发生了什么"。 */
  narrative: string
  /** 注入稿（≤ memoryTokens）。 */
  memoryMd: string
  index: IndexEntry[]
  commitments: Commitment[]
  conflicts: Conflict[]
  stats: {
    inTokens: number
    outTokens: number
    /** 原文 token / 记忆 token，压缩比。 */
    compression: number
  }
  createdAt: string
}

/* ────────────────────────────── 报告 / 健康度 ────────────────────────────── */

/** 忆体健康度（用于月度体检与每轮汇报）。 */
export interface MemoryHealth {
  /** 可回溯率：能在 archive 找到原文的条目比例，红线 0.99。 */
  traceability: number
  /** 承诺完整率：承诺锁条目齐全比例，红线 1.0。 */
  commitmentIntegrity: number
  /** 漂移率：与上一轮冲突且未裁定的条目比例。 */
  drift: number
  /** 孤儿指针：ptr 指向不存在文件的数量。 */
  orphanPointers: number
  /** 检索命中率（近 30 天）。 */
  retrievalHit: number
  /** 综合判定。 */
  verdict: 'healthy' | 'watch' | 'risk'
}

/** 每轮汇报的数据模型（渲染见 report/template）。 */
export interface CycleReport {
  version: string
  ring: RingId
  cycle: CycleId
  generatedAt: string
  models: { forget: string; memory: string; decoupled: boolean }
  /** 一句话摘要。 */
  summary: string
  forget: {
    shards: number
    inTokens: number
    dropped: number
    dropsByReason: Record<string, number>
    compression: number
    degraded: boolean
  }
  remember: {
    inTokens: number
    outTokens: number
    commitments: number
    conflicts: number
    narrativeChars: number
  }
  chain: { id: RingId; inputs: string; sizeBytes: number }[]
  health: MemoryHealth
  risks: string[]
  cost: { forgetTokens: number; memoryTokens: number; estimatedCny: number; savedPct: number }
  next: string[]
  ledgerHead: string
}

/* ────────────────────────────── 账本 ────────────────────────────── */

export interface RingLedgerRecord {
  kind: 'ring'
  ring: RingId
  cycle: CycleId
  inputHash: string
  prevRing?: RingId
  shards: ShardId[]
  models: { forget: string; memory: string }
  tokens: { forgetIn: number; memoryIn: number; memoryOut: number }
  degraded: boolean
  at: string
}

export interface ForgetLedgerRecord {
  kind: 'forget'
  ring: RingId
  shard: ShardId
  item: DroppedItem
  at: string
}

export interface RecallLedgerRecord {
  kind: 'recall'
  query: string
  hits: { ptr: string; score: number }[]
  at: string
}

export type LedgerRecord = RingLedgerRecord | ForgetLedgerRecord | RecallLedgerRecord

/* ────────────────────────────── 检索 ────────────────────────────── */

export interface RecallHit {
  /** 'ring' | 'index' | 'archive' */
  source: 'ring' | 'index' | 'archive'
  /** 出处指针。 */
  ptr: string
  text: string
  score: number
  ring?: RingId
  importance?: number
}

export interface RecallOptions {
  scope?: 'all' | 'rings' | 'archive'
  limit?: number
  /** 只看某道年轮及以后。 */
  since?: RingId
}

/* ────────────────────────────── 配置 ────────────────────────────── */

/** 插件配置（ConfigSchema 的 TS 契约，见 config.ts）。 */
export interface Config {
  /** 记忆根目录。 */
  memoryRoot: string
  /** 潮汐窗口天数。 */
  windowDays: number
  /** 遗忘模型（退潮）。 */
  forget: ModelTarget
  /** 记忆模型（涨潮）。 */
  memory: ModelTarget
  /** 嵌入模型（检索）。 */
  embedding: { provider: string; model: string; threshold: number }
  /** 注入预算。 */
  injection: { memoryTokens: number; indexEntries: number; commitments: number }
  /** 三道保护。 */
  protection: { commitmentsLock: boolean; identityAnchor: boolean; archiveRetentionDays: number }
  /** 汇报。 */
  report: { enabled: boolean; outputDir: string }
  /** 迁移。 */
  migration: { auto: boolean }
  /** 调试日志。 */
  debug: boolean
}
