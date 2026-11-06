/**
 * 忆死体检：把「可回溯性 / 承诺完整 / 漂移 / 孤儿指针 / 检索命中」算成 MemoryHealth。
 *
 * 红线（ARCHITECTURE §6）：
 * - 可回溯率 < 0.99 → risk
 * - 承诺完整率 < 1.0 → risk
 * - 孤儿指针 > 0 / 漂移率 > 0.05 / 检索命中率 < 0.6 → watch（可回溯率、承诺完整率、漂移率与检索命中率的红线与 docs/REPORT_TEMPLATE.md 一致）
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { Commitment, Conflict, MemoryHealth, Ring } from '../types'
import type { MemoryPaths } from '../paths'
import { readIfExists } from '../util/atomic'
import { countOrphanPointers, verifyTraceability } from '../store/archive'

const TRACEABILITY_REDLINE = 0.99
const COMMITMENT_REDLINE = 1
const DRIFT_WARNLINE = 0.05
const RETRIEVAL_WARNLINE = 0.6
const RETRIEVAL_WINDOW_DAYS = 30

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10000) / 10000
}

/** 近 30 天检索命中率：recall 账本里「至少命中一条」的记录占比；无记录视为健康（1）。 */
async function retrievalHitRate(paths: MemoryPaths, now: Date = new Date()): Promise<number> {
  const raw = await readIfExists(path.join(paths.ledgers, 'recall.jsonl'))
  if (!raw) return 1
  const cutoff = now.getTime() - RETRIEVAL_WINDOW_DAYS * 864e5
  let total = 0
  let hit = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as { kind?: string; hits?: unknown[]; at?: string }
      if (record.kind !== 'recall') continue
      const at = record.at ? Date.parse(record.at) : NaN
      if (Number.isFinite(at) && at < cutoff) continue
      total += 1
      if (Array.isArray(record.hits) && record.hits.length > 0) hit += 1
    } catch {
      // 损坏行忽略。
    }
  }
  if (total === 0) return 1
  return round4(hit / total)
}

/** 承诺完整率：现有承诺锁是否覆盖上一轮锚点（只增不减）。 */
export function commitmentIntegrity(anchors: Commitment[], ringCommitments: Commitment[]): number {
  if (!anchors || anchors.length === 0) return 1
  const ids = new Set((ringCommitments ?? []).map((item) => item.id))
  const texts = new Set((ringCommitments ?? []).map((item) => item.text))
  const matched = anchors.filter((anchor) => ids.has(anchor.id) || texts.has(anchor.text)).length
  return round4(matched / anchors.length)
}

/** 漂移率：未裁定冲突 / 全部冲突。 */
export function driftRate(conflicts: Conflict[]): number {
  const list = conflicts ?? []
  if (list.length === 0) return 0
  const open = list.filter((conflict) => conflict.resolution === 'open').length
  return round4(open / list.length)
}

function verdictOf(health: Omit<MemoryHealth, 'verdict'>): MemoryHealth['verdict'] {
  if (health.traceability < TRACEABILITY_REDLINE) return 'risk'
  if (health.commitmentIntegrity < COMMITMENT_REDLINE) return 'risk'
  if (health.orphanPointers > 0) return 'watch'
  if (health.drift > DRIFT_WARNLINE) return 'watch'
  if (health.retrievalHit < RETRIEVAL_WARNLINE) return 'watch'
  return 'healthy'
}

export async function computeHealth(
  paths: MemoryPaths,
  ring: Ring,
  ringCtx: { commitments: Commitment[]; conflicts: Conflict[] },
): Promise<MemoryHealth> {
  const index = ring.index ?? []
  const [traceability, orphanPointers, retrievalHit] = await Promise.all([
    verifyTraceability(paths, index).catch(() => 1),
    countOrphanPointers(paths, index).catch(() => 0),
    retrievalHitRate(paths).catch(() => 1),
  ])

  const integrity = commitmentIntegrity(ringCtx?.commitments ?? [], ring.commitments ?? [])
  const conflicts = ringCtx?.conflicts ?? ring.conflicts ?? []
  const drift = driftRate(conflicts)

  const partial: Omit<MemoryHealth, 'verdict'> = {
    traceability: round4(traceability),
    commitmentIntegrity: round4(integrity),
    drift,
    orphanPointers,
    retrievalHit: round4(retrievalHit),
  }
  return { ...partial, verdict: verdictOf(partial) }
}
