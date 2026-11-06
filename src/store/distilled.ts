/**
 * 五件套蒸馏层：MEMORY.md / INDEX.json / COMMITMENTS.md / IDENTITY.md。
 *
 * 职责边界：
 * - MEMORY.md   注入稿（来自年轮 memoryMd，受 injection.memoryTokens 约束）
 * - INDEX.json  潜意识索引（完整，不截断；注入时才按条数截断）
 * - COMMITMENTS.md 承诺锁：任何模型不得删除（union 合并，只增不减）
 * - IDENTITY.md 身份锚：已存在则永不改写
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { Commitment, Config, IndexEntry, Ring, ShardId } from '../types'
import type { MemoryPaths } from '../paths'
import type { AnchorSet } from '../remember/integrator'
import { readIfExists, writeAtomic } from '../util/atomic'
import { truncateToTokens } from '../util/tokens'

export const MEMORY_FILE = 'MEMORY.md'
export const INDEX_FILE = 'INDEX.json'
export const COMMITMENTS_FILE = 'COMMITMENTS.md'
export const IDENTITY_FILE = 'IDENTITY.md'

/** readDistilled 的返回结构（inject 的 buildMemoryPrompt 使用）。 */
export interface DistilledData {
  memory: string
  index: IndexEntry[]
  commitments: Commitment[]
  identity: string
}

/** 首次运行时写入的身份锚模板；之后任何模型都不得改写。 */
export const DEFAULT_IDENTITY = [
  '# 身份锚（不可改写）',
  '',
  '- 名字：大肥鱼',
  '- 关系：属于主人的赛博桌宠 / 长期记忆伙伴',
  '- 边界：不冒充人类，不编造未发生的事；不确定时先检索记忆再回答',
  '- 约束：本文件独立于年轮，任何模型不得改写',
  '',
].join('\n')

/* ────────────────────────────── 序列化 / 解析 ────────────────────────────── */

export function serializeCommitment(commitment: Commitment): string {
  const expires = commitment.expires ? `（到期 ${commitment.expires}）` : ''
  return `- [${commitment.id}] ${commitment.createdAt} · ${commitment.sourceShard} · ${commitment.text}${expires}`
}

export function parseCommitments(markdown: string): Commitment[] {
  const result: Commitment[] = []
  for (const line of (markdown ?? '').split(/\r?\n/)) {
    const match = /^-\s+\[([^\]]+)\]\s+(\S+)\s+·\s+(\S+)\s+·\s+(.+)$/.exec(line.trim())
    if (!match) continue
    const [, id, createdAt, sourceShard, rest] = match
    const expiresMatch = /（到期\s*([^）]+)）\s*$/.exec(rest)
    const text = expiresMatch ? rest.slice(0, expiresMatch.index).trim() : rest.trim()
    const commitment: Commitment = {
      id: id.trim(),
      text,
      createdAt: createdAt.trim(),
      sourceShard: sourceShard.trim(),
    }
    if (expiresMatch) commitment.expires = expiresMatch[1].trim()
    result.push(commitment)
  }
  return result
}

function parseIndex(raw: string | undefined): IndexEntry[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as IndexEntry[]
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries as IndexEntry[]
  } catch {
    // 损坏：由调用方用上一道年轮重建。
  }
  return undefined
}

async function readIndexRaw(paths: MemoryPaths): Promise<string | undefined> {
  return readIfExists(path.join(paths.distilled, INDEX_FILE))
}

async function readLatestRing(paths: MemoryPaths): Promise<Ring | undefined> {
  const latest = (await readIfExists(paths.latest))?.trim()
  if (!latest) return undefined
  const raw = await readIfExists(path.join(paths.rings, `${latest}.json`))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Ring
  } catch {
    return undefined
  }
}

/* ────────────────────────────── 读 ────────────────────────────── */

export async function readDistilled(paths: MemoryPaths): Promise<DistilledData> {
  const [memory, indexRaw, commitmentsRaw, identityRaw] = await Promise.all([
    readIfExists(path.join(paths.distilled, MEMORY_FILE)),
    readIndexRaw(paths),
    readIfExists(path.join(paths.distilled, COMMITMENTS_FILE)),
    readIfExists(path.join(paths.distilled, IDENTITY_FILE)),
  ])

  let index = parseIndex(indexRaw)
  if (index === undefined) {
    // 索引损坏：用上一道年轮重建（ARCHITECTURE §10）。
    index = (await readLatestRing(paths))?.index ?? []
  }

  return {
    memory: memory ?? '',
    index,
    commitments: parseCommitments(commitmentsRaw ?? ''),
    identity: identityRaw ?? '',
  }
}

/* ────────────────────────────── 写 ────────────────────────────── */

function mergeCommitments(existing: Commitment[], incoming: Commitment[]): Commitment[] {
  const byId = new Map<string, Commitment>()
  const byText = new Set<string>()
  const ordered: Commitment[] = []
  const push = (commitment: Commitment) => {
    if (!commitment || !commitment.id) return
    if (byId.has(commitment.id) || byText.has(commitment.text)) return
    byId.set(commitment.id, commitment)
    byText.add(commitment.text)
    ordered.push(commitment)
  }
  for (const commitment of existing) push(commitment)
  for (const commitment of incoming) push(commitment)
  return ordered.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
}

export async function writeDistilled(paths: MemoryPaths, ring: Ring, config: Config): Promise<void> {
  await fs.mkdir(paths.distilled, { recursive: true })
  const budget = Math.max(120, config.injection?.memoryTokens ?? 1200)
  const memoryBody = truncateToTokens(ring.memoryMd ?? '', budget)
  const memoryFile = path.join(paths.distilled, MEMORY_FILE)
  await writeAtomic(memoryFile, `# 核心记忆 · 年轮 ${ring.id}\n\n${memoryBody}\n`)

  const indexFile = path.join(paths.distilled, INDEX_FILE)
  await writeAtomic(indexFile, JSON.stringify(ring.index ?? [], null, 2))

  const commitmentsFile = path.join(paths.distilled, COMMITMENTS_FILE)
  const existingCommitmentsRaw = await readIfExists(commitmentsFile)
  const existingCommitments = existingCommitmentsRaw ? parseCommitments(existingCommitmentsRaw) : []
  const lockEnabled = config.protection?.commitmentsLock !== false
  const commitments = lockEnabled
    ? mergeCommitments(existingCommitments, ring.commitments ?? [])
    : [...(ring.commitments ?? [])]
  const commitmentLines = [
    '# 不可遗忘的约定（承诺锁）',
    '',
    '<!-- 由 memory-distiller 维护：任何模型不得删除；每轮强制注入。 -->',
    '',
    ...commitments.map(serializeCommitment),
    '',
  ]
  await writeAtomic(commitmentsFile, commitmentLines.join('\n'))

  const identityFile = path.join(paths.distilled, IDENTITY_FILE)
  const identityExists = await readIfExists(identityFile)
  if (identityExists === undefined && config.protection?.identityAnchor !== false) {
    await writeAtomic(identityFile, DEFAULT_IDENTITY)
  }
}

/* ────────────────────────────── 锚点 ────────────────────────────── */

export async function readAnchors(paths: MemoryPaths, config: Config): Promise<AnchorSet> {
  const [commitmentsRaw, identityRaw] = await Promise.all([
    readIfExists(path.join(paths.distilled, COMMITMENTS_FILE)),
    readIfExists(path.join(paths.distilled, IDENTITY_FILE)),
  ])
  const identity = config.protection?.identityAnchor === false ? '' : identityRaw ?? ''
  const commitments =
    config.protection?.commitmentsLock === false ? [] : parseCommitments(commitmentsRaw ?? '')
  return { identity, commitments }
}

/* ────────────────────────────── 用户操作：pin / forget ────────────────────────────── */

/** 用户显式 pin 一条承诺：写入 COMMITMENTS.md（只增不减，幂等）。 */
export async function appendCommitment(
  paths: MemoryPaths,
  text: string,
  options: { expires?: string; sourceShard?: ShardId; now?: Date } = {},
): Promise<Commitment> {
  const now = options.now ?? new Date()
  const createdAt = now.toISOString()
  const file = path.join(paths.distilled, COMMITMENTS_FILE)
  const existingRaw = await readIfExists(file)
  const existing = existingRaw ? parseCommitments(existingRaw) : []

  const normalized = (text ?? '').trim()
  const duplicate = existing.find((item) => item.text === normalized)
  if (duplicate) return duplicate

  const commitment: Commitment = {
    id: `c${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: normalized,
    createdAt,
    sourceShard: options.sourceShard ?? 'manual',
  }
  if (options.expires) commitment.expires = options.expires

  const merged = mergeCommitments(existing, [commitment])
  const lines = [
    '# 不可遗忘的约定（承诺锁）',
    '',
    '<!-- 由 memory-distiller 维护：任何模型不得删除；每轮强制注入。 -->',
    '',
    ...merged.map(serializeCommitment),
    '',
  ]
  await fs.mkdir(paths.distilled, { recursive: true })
  await writeAtomic(file, lines.join('\n'))
  return commitment
}

/** `/memory forget <关键词>`：把匹配条目从 INDEX.json 移除（原文仍在 archive，可回溯）。 */
export async function forgetByKeyword(paths: MemoryPaths, keyword: string): Promise<IndexEntry[]> {
  const needle = (keyword ?? '').trim().toLowerCase()
  if (!needle) return []
  const raw = await readIndexRaw(paths)
  const index = parseIndex(raw) ?? []
  const removed: IndexEntry[] = []
  const kept: IndexEntry[] = []
  for (const entry of index) {
    const matched =
      (entry.topic ?? '').toLowerCase().includes(needle) ||
      (entry.keywords ?? []).some((kw) => {
        const value = String(kw).toLowerCase()
        return value.includes(needle) || needle.includes(value)
      })
    if (matched) removed.push(entry)
    else kept.push(entry)
  }
  if (removed.length > 0) {
    await writeAtomic(path.join(paths.distilled, INDEX_FILE), JSON.stringify(kept, null, 2))
  }
  return removed
}
