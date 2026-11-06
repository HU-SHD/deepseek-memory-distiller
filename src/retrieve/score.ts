/**
 * 检索打分（纯函数，零运行时相对导入，可直接单测）。
 *
 * 公式见 ARCHITECTURE §8：
 *   score = 0.45×语义 + 0.25×关键词 + 0.20×importance/10 + 0.10×decay
 * 召回加固：命中次数提升该条 importance，最多 +2。
 */

export interface ScoreParts {
  /** 语义相似度 0–1。embedding 可用时用余弦；不可用时用词法近似。 */
  semantic: number
  /** 关键词覆盖率 0–1。 */
  keyword: number
  /** 索引原始重要度 0–10。 */
  importance: number
  /** 衰减系数 0–1，越老越低。 */
  decay: number
}

/** 冻结权重（ARCHITECTURE §8）。 */
export const SCORE_WEIGHTS = {
  semantic: 0.45,
  keyword: 0.25,
  importance: 0.2,
  decay: 0.1,
} as const

/** 召回加固单条最多提升量。 */
export const MAX_REINFORCE = 2

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 统一打分。各项先归一化，importance 按 /10 归一化。 */
export function combineScore(parts: ScoreParts): number {
  const semantic = clamp01(parts.semantic)
  const keyword = clamp01(parts.keyword)
  const importance = clamp01(parts.importance / 10)
  const decay = clamp01(parts.decay)
  return round(
    SCORE_WEIGHTS.semantic * semantic +
      SCORE_WEIGHTS.keyword * keyword +
      SCORE_WEIGHTS.importance * importance +
      SCORE_WEIGHTS.decay * decay,
  )
}

/**
 * 召回加固后的有效 importance：基础值 + 命中次数，最多 +2，封顶 10。
 * 用账本里的命中次数（而不是直接改 INDEX.json）保证「最多 +2」可审计。
 */
export function reinforceImportance(base: number, hitCount: number): number {
  const hits = Math.max(0, Math.floor(Number.isFinite(hitCount) ? hitCount : 0))
  return round(clamp(base + Math.min(MAX_REINFORCE, hits), 0, 10), 4)
}

/* ────────────────────────────── 词法工具 ────────────────────────────── */

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g
const LATIN_WORD = /[a-z0-9_]{2,}/g

/**
 * 分词：中文按 bigram（单字 run 保留单字），英文/数字按词（长度 ≥2）。
 * 去重后返回，用于关键词覆盖率与词法近似。
 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>()
  const source = (text ?? '').toLowerCase()
  for (const match of source.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2))
  }
  for (const match of source.matchAll(LATIN_WORD)) tokens.add(match[0])
  return [...tokens]
}

/** 关键词覆盖率 = |query ∩ target| / |query|；query 为空时返回 0。 */
export function keywordOverlapScore(queryTokens: string[], targetTokens: string[]): number {
  if (!queryTokens || queryTokens.length === 0) return 0
  const target = new Set(targetTokens ?? [])
  let hit = 0
  for (const token of queryTokens) if (target.has(token)) hit += 1
  return round(clamp01(hit / queryTokens.length), 4)
}

/** 词法相似度（无 embedding 时的语义代理）。 */
export function lexicalSimilarity(query: string, text: string): number {
  return keywordOverlapScore(tokenize(query), tokenize(text))
}

/** 余弦相似度；任一向量为零向量/维度不一致时返回 0。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return round(clamp01(dot / (Math.sqrt(normA) * Math.sqrt(normB))), 4)
}

/** 从文本抽关键词（偏好 bigram / 英文词，去重，最多 max 个）。 */
export function extractKeywords(text: string, max = 8): string[] {
  const limit = Math.max(0, Math.floor(max))
  if (limit === 0) return []
  return tokenize(text).slice(0, limit)
}

/** 近因权重：最新一轮 1，最老一轮 0.5，线性插值。ringCount ≤ 0 时返回 1。 */
export function recencyWeight(positionFromOldest: number, ringCount: number): number {
  if (!Number.isFinite(ringCount) || ringCount <= 1) return 1
  const ratio = clamp01(positionFromOldest / (ringCount - 1))
  return round(1 - 0.5 * ratio, 4)
}

/** 判断一条候选是否达到召回门槛（无 embedding 时走关键词门槛）。 */
export function passesThreshold(args: {
  keyword: number
  semantic?: number
  threshold: number
  embeddingUsed: boolean
}): boolean {
  if (args.embeddingUsed) {
    const semantic = args.semantic ?? 0
    return semantic >= Math.max(0, args.threshold) * 0.9 || args.keyword >= 0.2
  }
  return args.keyword >= 0.15
}
