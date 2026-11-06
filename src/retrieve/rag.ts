/**
 * 潜意识检索：三路召回（年轮 / 索引 / 遗骸）→ 统一打分 → 带出处返回。
 *
 * 打分公式与召回加固在 ./score.ts（纯函数，可单测）。
 * 本模块只做 I/O 编排；任何异常都吞掉并降级，绝不打断主对话。
 */

import path from 'node:path'
import type { IndexEntry, RecallHit, RecallOptions, Ring, RingId } from '../types'
import type { MemoryPaths } from '../paths'
import { readIfExists } from '../util/atomic'
import { listRings } from '../ring/chain'
import { readDistilled } from '../store/distilled'
import { listArchiveFiles } from '../store/archive'
import { appendLedger } from '../ledger'
import {
  clamp,
  combineScore,
  cosineSimilarity,
  keywordOverlapScore,
  lexicalSimilarity,
  passesThreshold,
  reinforceImportance,
  tokenize,
} from './score'

export interface RagDeps {
  getEmbedding?: (text: string) => Promise<number[] | undefined>
  threshold: number
}

interface Candidate {
  source: RecallHit['source']
  ptr: string
  text: string
  ring?: RingId
  importance: number
  decay: number
  keyword: number
  semantic?: number
}

const DEFAULT_LIMIT = 8
const EXCERPT_CHARS = 600
const MAX_ARCHIVE_FILES = 300
const MAX_EMBEDDING_CANDIDATES = 24

async function readRecallCounts(paths: MemoryPaths): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  const raw = await readIfExists(path.join(paths.ledgers, 'recall.jsonl'))
  if (!raw) return counts
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as { kind?: string; hits?: { ptr?: string; score?: number }[] }
      if (record.kind !== 'recall') continue
      for (const hit of record.hits ?? []) {
        if (!hit.ptr) continue
        counts.set(hit.ptr, (counts.get(hit.ptr) ?? 0) + 1)
      }
    } catch {
      // 跳过损坏行，检索绝不起因于此失败。
    }
  }
  return counts
}

function excerpt(content: string, queryTokens: string[], max = EXCERPT_CHARS): string {
  if (!content) return ''
  if (content.length <= max) return content
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const lowered = line.toLowerCase()
    if (queryTokens.some((token) => lowered.includes(token))) {
      const start = Math.max(0, content.indexOf(line) - 120)
      return `${start > 0 ? '…' : ''}${content.slice(start, start + max)}…`
    }
  }
  return `${content.slice(0, max)}…`
}

function toCandidate(
  source: RecallHit['source'],
  entry: IndexEntry,
  queryTokens: string[],
  narrative: string,
): Candidate {
  const text = `${entry.topic ?? ''} ${(entry.keywords ?? []).join(' ')}`
  return {
    source,
    ptr: entry.ptr ?? `rings/${entry.ring}.md`,
    text,
    ring: entry.ring,
    importance: Number.isFinite(entry.importance) ? entry.importance : 5,
    decay: Number.isFinite(entry.decay) ? entry.decay : 1,
    keyword: bound(keywordOverlapScore(queryTokens, tokenize(`${text} ${narrative}`))),
  }
}

function bound(value: number): number {
  return clamp(value, 0, 1)
}

function dedupe(candidates: Candidate[]): Candidate[] {
  const byPtr = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const previous = byPtr.get(candidate.ptr)
    if (!previous || candidate.keyword > previous.keyword) byPtr.set(candidate.ptr, candidate)
  }
  return [...byPtr.values()]
}

/**
 * 三路召回。返回按统一分数降序的命中；同时写 ledgers/recall.jsonl 做召回加固。
 */
export async function recall(
  paths: MemoryPaths,
  query: string,
  opts: RecallOptions = {},
  deps: RagDeps,
): Promise<RecallHit[]> {
  const scope = opts.scope ?? 'all'
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT))
  const queryTokens = tokenize(query)
  const threshold = Number.isFinite(deps.threshold) ? deps.threshold : 0.6
  const candidates: Candidate[] = []

  try {
    // 路 1：年轮（narrative + index，近因优先）
    if (scope !== 'archive') {
      let rings: RingId[] = []
      try {
        rings = await listRings(paths)
      } catch {
        rings = []
      }
      const sinceIndex = opts.since ? rings.indexOf(opts.since) : -1
      const scoped = opts.since && sinceIndex >= 0 ? rings.slice(sinceIndex) : rings
      const total = Math.max(scoped.length, 1)
      for (let i = scoped.length - 1; i >= 0; i -= 1) {
        const ringId = scoped[i]
        const raw = await readIfExists(path.join(paths.rings, `${ringId}.json`))
        if (!raw) continue
        let ring: Ring
        try {
          ring = JSON.parse(raw) as Ring
        } catch {
          continue
        }
        const recency = 0.5 + 0.5 * ((i + 1) / total)
        for (const entry of ring.index ?? []) {
          const candidate = toCandidate('ring', entry, queryTokens, ring.narrative ?? '')
          candidate.decay = bound(candidate.decay * recency)
          candidates.push(candidate)
        }
        const narrativeKeyword = keywordOverlapScore(queryTokens, tokenize(ring.narrative ?? ''))
        if (narrativeKeyword > 0) {
          candidates.push({
            source: 'ring',
            ptr: `rings/${ringId}.md`,
            text: excerpt(ring.narrative ?? '', queryTokens),
            ring: ringId,
            importance: 8,
            decay: recency,
            keyword: narrativeKeyword,
          })
        }
      }
    }

    // 路 2：索引（INDEX.json 直接匹配）
    if (scope !== 'rings' && scope !== 'archive') {
      const distilled = await readDistilled(paths)
      for (const entry of distilled.index ?? []) {
        candidates.push(toCandidate('index', entry, queryTokens, ''))
      }
    }

    // 路 3：遗骸（archive 原文兜底）
    if (scope !== 'rings') {
      let files: Awaited<ReturnType<typeof listArchiveFiles>> = []
      try {
        files = (await listArchiveFiles(paths)).slice(0, MAX_ARCHIVE_FILES)
      } catch {
        files = []
      }
      for (const file of files) {
        const content = await readIfExists(file.file)
        if (!content) continue
        const keyword = keywordOverlapScore(queryTokens, tokenize(content))
        if (keyword <= 0) continue
        const matchingRing = /(?:^|[/\\])([a-z]+11)(?:[/\\]|$)/.exec(file.ptr)?.[1] as RingId | undefined
        candidates.push({
          source: 'archive',
          ptr: file.ptr,
          text: excerpt(content, queryTokens),
          ring: matchingRing,
          importance: 5,
          decay: 1,
          keyword,
        })
      }
    }
  } catch {
    // 任一通路失败 → 其余通路的结果仍然可用。
  }

  const unique = dedupe(candidates)
  const recallCounts = await readRecallCounts(paths).catch(() => new Map<string, number>())

  // embedding：可用则算余弦，不可用则用词法近似（降级，绝不阻断）。
  let queryVector: number[] | undefined
  if (deps.getEmbedding) {
    try {
      queryVector = await deps.getEmbedding(query)
    } catch {
      queryVector = undefined
    }
  }
  const embeddingUsed = Array.isArray(queryVector) && queryVector.length > 0

  const scored: RecallHit[] = []
  for (const candidate of unique.slice(0, MAX_EMBEDDING_CANDIDATES * 4)) {
    let semantic = lexicalSimilarity(query, candidate.text)
    if (embeddingUsed) {
      try {
        const vector = await deps.getEmbedding!(candidate.text)
        if (Array.isArray(vector) && vector.length > 0) {
          semantic = cosineSimilarity(queryVector!, vector)
        }
      } catch {
        // 单条文本 embedding 失败 → 用词法近似。
      }
    }
    if (!passesThreshold({ keyword: candidate.keyword, semantic, threshold, embeddingUsed })) continue
    const effectiveImportance = reinforceImportance(candidate.importance, recallCounts.get(candidate.ptr) ?? 0)
    const score = combineScore({
      semantic,
      keyword: candidate.keyword,
      importance: effectiveImportance,
      decay: candidate.decay,
    })
    scored.push({
      source: candidate.source,
      ptr: candidate.ptr,
      text: candidate.text,
      score,
      ring: candidate.ring,
      importance: effectiveImportance,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  const hits = scored.slice(0, limit)

  // 召回加固账本：命中次数用于把 importance 最多提升 +2（可审计）。
  if (hits.length > 0) {
    try {
      await appendLedger(paths, {
        kind: 'recall',
        query,
        hits: hits.map((hit) => ({ ptr: hit.ptr, score: hit.score })),
        at: new Date().toISOString(),
      })
    } catch {
      // 账本写失败不影响本次召回结果。
    }
  }

  return hits
}

/** 供工具层复用的检索辅助：按关键词粗略过滤索引（不写账本）。 */
export async function peekIndex(paths: MemoryPaths, keyword: string): Promise<IndexEntry[]> {
  const distilled = await readDistilled(paths)
  const needle = (keyword ?? '').toLowerCase()
  return (distilled.index ?? []).filter((entry) =>
    `${entry.topic} ${(entry.keywords ?? []).join(' ')}`.toLowerCase().includes(needle),
  )
}
