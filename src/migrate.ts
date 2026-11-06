/**
 * v0.2.1 → v2.0 原地迁移。
 *
 * v0.2.1 目录（memoryRoot 下）：raw/ + archive/（扁平）+ distilled/MEMORY.md + distilled/INDEX.json
 * v2 目标：rings/a11.json + rings/a11.md + rings/LATEST + distilled 五件套 + STATE.json
 *
 * 原则：
 * - 幂等：已有 rings/LATEST 即视为已迁移，直接跳过；
 * - 旧 distilled/MEMORY.md 原文复制进 archive/legacy-v0.2.1/ 保留；
 * - 旧 archive/ 扁平文件**不动**（ptr 仍可解析）；raw/ 原文搬进按月分桶的 archive/；
 * - 不调用任何模型（迁移不烧钱）。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Config, IndexEntry, Ring, RingId } from './types'
import type { MemoryPaths } from './paths'

export interface MigrateResult {
  migrated: boolean
  message: string
  ring?: RingId
}

export interface LegacyIndexEntry {
  topic?: string
  keywords?: string[]
  file?: string
  importance?: number
}

export interface MigrateOptions {
  /** 注入用 token 估算（测试可注入，生产用 util/tokens）。 */
  estimateTokens?: (text: string) => number
  /** 截断到指定 token（测试可注入）。 */
  truncate?: (text: string, max: number) => string
  now?: Date
}

const LEGACY_RING: RingId = 'a11'
const LEGACY_CYCLE = 'a'
const LEGACY_RAW_PREFIX = 'archive/legacy-v0.2.1/raw'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/* ────────────────────────────── 纯函数（可单测） ────────────────────────────── */

/**
 * 宽容解析 v0.2.1 的 INDEX.json：
 * - 允许 ```json 围栏与前后废话；
 * - 允许裸数组、{index:[...]}、{entries:[...]}；
 * - 失败返回 []（迁移不因索引损坏而失败）。
 */
export function parseLegacyIndex(raw: string): LegacyIndexEntry[] {
  if (!raw) return []
  let text = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced) text = fenced[1].trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => item && typeof item === 'object') as LegacyIndexEntry[]
      }
    } catch {
      // 继续尝试对象形态。
    }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      const container = parsed as { index?: unknown; entries?: unknown }
      const candidate = Array.isArray(container.index)
        ? container.index
        : Array.isArray(container.entries)
          ? container.entries
          : []
      return (candidate as unknown[]).filter((item) => item && typeof item === 'object') as LegacyIndexEntry[]
    }
  } catch {
    // 损坏。
  }
  return []
}

/**
 * 迁移后索引条目的指针：优先指向搬进 archive 的 raw 原文，其次旧扁平 archive，最后回退到年轮文件。
 */
export function legacyPointer(
  file: string | undefined,
  resolve: (file: string) => string | undefined,
  fallback: string = `rings/${LEGACY_RING}.md`,
): string {
  const name = (file ?? '').trim()
  if (!name) return fallback
  return resolve(name) ?? fallback
}

/** 把 v0.2.1 索引条目映射成 v2 IndexEntry（纯函数）。 */
export function mapLegacyIndex(
  entries: LegacyIndexEntry[],
  resolvePtr: (file: string | undefined) => string,
  ringId: RingId = LEGACY_RING,
): IndexEntry[] {
  return (entries ?? [])
    .filter((entry) => entry && (entry.topic || (entry.keywords && entry.keywords.length > 0)))
    .map((entry) => {
      const importance = Number.isFinite(entry.importance)
        ? Math.max(0, Math.min(10, Number(entry.importance)))
        : 5
      return {
        topic: String(entry.topic ?? '（迁移条目）').trim(),
        keywords: Array.isArray(entry.keywords)
          ? entry.keywords.map((keyword) => String(keyword)).filter(Boolean)
          : [],
        ring: ringId,
        importance,
        // 迁移来的条目视为「刚读取」，decay 给满，后续由检索加权自然衰减。
        decay: 1,
        ptr: resolvePtr(entry.file),
      }
    })
}

/** 旧 MEMORY.md → 年轮叙事（300–800 字；纯函数）。 */
export function legacyNarrative(memory: string, maxChars = 800, indexCount = 0): string {
  const normalized = (memory ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
  if (!normalized) {
    return `迁移自 v0.2.1：原 MEMORY.md 为空，现有 ${indexCount} 条索引条目已并入年轮 ${LEGACY_RING}。`
  }
  const chars = Array.from(normalized)
  if (chars.length <= maxChars) return normalized
  return `${chars.slice(0, maxChars).join('')}…`
}

/** 计算迁移环的 inputHash（纯函数；与 computeInputHash 的语义一致：内容哈希）。 */
export function legacyInputHash(memory: string, indexRaw: string, configFp: string): string {
  return sha256Hex(`migrate:v0.2.1:ring=${LEGACY_RING}|memory=${sha256Hex(memory)}|index=${sha256Hex(indexRaw)}|config=${configFp}`)
}

/* ────────────────────────────── 文件布局探测 ────────────────────────────── */

async function legacyFiles(paths: MemoryPaths): Promise<{
  memory: string
  indexRaw: string
  archiveFlat: Map<string, string>
  rawFiles: string[]
}> {
  const memory = (await fs.readFile(path.join(paths.distilled, 'MEMORY.md'), 'utf-8').catch(() => '')) || ''
  const indexRaw = (await fs.readFile(path.join(paths.distilled, 'INDEX.json'), 'utf-8').catch(() => '')) || ''

  const archiveFlat = new Map<string, string>()
  try {
    const entries = await fs.readdir(paths.archive, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) archiveFlat.set(entry.name, `archive/${entry.name}`)
    }
  } catch {
    // 没有旧归档。
  }

  let rawFiles: string[] = []
  try {
    rawFiles = (await fs.readdir(paths.raw)).filter((name) => /\.(md|txt)$/i.test(name))
  } catch {
    rawFiles = []
  }
  return { memory, indexRaw, archiveFlat, rawFiles }
}

function bucketFor(fileName: string, fallback: Date): string {
  const match = /(\d{4})-(\d{2})-\d{2}/.exec(fileName)
  if (match) return `${match[1]}-${match[2]}`
  return `${fallback.getUTCFullYear()}-${String(fallback.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 把旧 raw/ 原文搬进 archive/<YYYY-MM>/，返回 文件名 → ptr 映射。 */
async function moveLegacyRaw(
  paths: MemoryPaths,
  rawFiles: string[],
  now: Date,
): Promise<Map<string, string>> {
  const moved = new Map<string, string>()
  for (const name of rawFiles) {
    const source = path.join(paths.raw, name)
    const bucket = bucketFor(name, now)
    const dir = path.join(paths.archive, bucket)
    await fs.mkdir(dir, { recursive: true })
    let targetName = name
    if (await exists(path.join(dir, targetName))) targetName = `${sha256Hex(name).slice(0, 8)}-${name}`
    const target = path.join(dir, targetName)
    await fs.copyFile(source, target)
    await fs.unlink(source).catch(() => undefined)
    moved.set(name, `archive/${bucket}/${targetName}`)
  }
  return moved
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

interface PipelineDeps {
  writeAtomic: (file: string, data: string) => Promise<void>
  truncateToTokens: (text: string, max: number) => string
  estimateTokens: (text: string) => number
  computeInputHash: (prev: RingId | undefined, shardHashes: string[], configFp: string) => string
  configFingerprint: (targets: unknown) => string
  resolveTargets: (config: Config) => unknown
  writeDistilled: (paths: MemoryPaths, ring: Ring, config: Config) => Promise<void>
  loadState: (paths: MemoryPaths) => Promise<Record<string, unknown>>
  saveState: (paths: MemoryPaths, state: Record<string, unknown>) => Promise<void>
  appendLedger: (paths: MemoryPaths, record: unknown) => Promise<void>
}

async function loadPipelineDeps(): Promise<PipelineDeps> {
  const [atomic, tokens, chain, configModule, distilled, state, ledger] = await Promise.all([
    import('./util/atomic'),
    import('./util/tokens'),
    import('./ring/chain'),
    import('./config'),
    import('./store/distilled'),
    import('./state'),
    import('./ledger'),
  ])
  return {
    writeAtomic: atomic.writeAtomic,
    truncateToTokens: tokens.truncateToTokens,
    estimateTokens: tokens.estimateTokens,
    computeInputHash: chain.computeInputHash,
    configFingerprint: configModule.configFingerprint as unknown as PipelineDeps['configFingerprint'],
    resolveTargets: configModule.resolveTargets as unknown as PipelineDeps['resolveTargets'],
    writeDistilled: distilled.writeDistilled,
    loadState: state.loadState as unknown as PipelineDeps['loadState'],
    saveState: state.saveState as unknown as PipelineDeps['saveState'],
    appendLedger: ledger.appendLedger as unknown as PipelineDeps['appendLedger'],
  }
}

export async function migrateFromV1(
  paths: MemoryPaths,
  config: Config,
  models: { forget: string; memory: string },
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const now = options.now ?? new Date()
  const deps = await loadPipelineDeps()

  // 幂等：已有 LATEST 或已有年轮 → 跳过。
  const latest = (await fs.readFile(paths.latest, 'utf-8').catch(() => '')).trim()
  if (latest) {
    return { migrated: false, message: `已是 v2 结构（rings/LATEST = ${latest}），跳过迁移。`, ring: latest }
  }
  const existingRings = await fs.readdir(paths.rings).catch(() => [] as string[])
  if (existingRings.some((name) => name.endsWith('.json'))) {
    return { migrated: false, message: 'rings/ 中已存在年轮，跳过迁移（请人工确认）。' }
  }

  const legacy = await legacyFiles(paths)
  if (!legacy.memory.trim() && !legacy.indexRaw.trim()) {
    return { migrated: false, message: '未发现 v0.2.1 数据（distilled/MEMORY.md 与 INDEX.json 均不存在），无需迁移。' }
  }

  // 1) 旧 distilled 原文复制进 archive/legacy-v0.2.1/ 保留。
  const legacyArchiveDir = path.join(paths.archive, 'legacy-v0.2.1')
  await fs.mkdir(legacyArchiveDir, { recursive: true })
  if (legacy.memory) await deps.writeAtomic(path.join(legacyArchiveDir, 'MEMORY.md'), legacy.memory)
  if (legacy.indexRaw) await deps.writeAtomic(path.join(legacyArchiveDir, 'INDEX.json'), legacy.indexRaw)

  // 2) 旧 raw/ 原文搬进 archive/<YYYY-MM>/，并建立 ptr 映射。
  const movedRaw = await moveLegacyRaw(paths, legacy.rawFiles, now)
  const resolvePtr = (file: string | undefined): string =>
    legacyPointer(
      file,
      (name) => movedRaw.get(name) ?? legacy.archiveFlat.get(name),
      `rings/${LEGACY_RING}.md`,
    )

  // 3) 旧索引 → v2 索引。
  const legacyEntries = parseLegacyIndex(legacy.indexRaw)
  const index = mapLegacyIndex(legacyEntries, resolvePtr)

  // 4) 旧 MEMORY.md → 年轮 narrative + 注入稿。
  const estimate = options.estimateTokens ?? deps.estimateTokens
  const truncate = options.truncate ?? deps.truncateToTokens
  const narrative = legacyNarrative(legacy.memory, 800, index.length)
  const memoryBudget = Math.max(120, config.injection?.memoryTokens ?? 1200)
  const memoryMd = truncate(legacy.memory.trim() || narrative, memoryBudget)

  // 5) inputHash：内容哈希 + 配置指纹（迁移不读 raw 日片）。
  let configFp = ''
  try {
    configFp = deps.configFingerprint(deps.resolveTargets(config))
  } catch {
    configFp = sha256Hex(`${JSON.stringify(config.forget)}|${JSON.stringify(config.memory)}`).slice(0, 16)
  }
  const inputHash = deps.computeInputHash(undefined, [], configFp) || legacyInputHash(legacy.memory, legacy.indexRaw, configFp)

  const inTokens = Math.max(estimate(narrative) + estimate(legacy.indexRaw), estimate(memoryMd))
  const outTokens = estimate(memoryMd)
  const ring: Ring = {
    id: LEGACY_RING,
    cycle: LEGACY_CYCLE,
    inputs: { shards: [], inputHash },
    narrative,
    memoryMd,
    index,
    commitments: [],
    conflicts: [],
    stats: {
      inTokens,
      outTokens,
      compression: outTokens > 0 ? Math.round((inTokens / outTokens) * 100) / 100 : 0,
    },
    createdAt: now.toISOString(),
  }

  // 6) 落盘：年轮（json + md）→ LATEST → 五件套。
  const ringJson = path.join(paths.rings, `${LEGACY_RING}.json`)
  const ringMd = path.join(paths.rings, `${LEGACY_RING}.md`)
  await deps.writeAtomic(ringJson, JSON.stringify(ring, null, 2))
  await deps.writeAtomic(
    ringMd,
    [
      `# 年轮 ${LEGACY_RING}（迁移自 v0.2.1）`,
      '',
      '## 叙事',
      '',
      narrative,
      '',
      '## 核心记忆（注入稿）',
      '',
      memoryMd,
      '',
      '## 索引',
      '',
      ...index.map((entry) => `- ${entry.topic}（${entry.keywords.join('、')}）→ ${entry.ptr}`),
      '',
    ].join('\n'),
  )
  await deps.writeAtomic(paths.latest, LEGACY_RING)
  await deps.writeDistilled(paths, ring, config)

  // 7) 状态：a 周期已消费，下一轮是 b。
  const state = await deps.loadState(paths)
  await deps.saveState(paths, {
    ...state,
    schemaVersion: 2,
    cycle: 'b',
    lastRing: LEGACY_RING,
    lastInputHash: inputHash,
    updatedAt: now.toISOString(),
  })

  // 8) 账本：迁移也留痕。
  try {
    await deps.appendLedger(paths, {
      kind: 'ring',
      ring: LEGACY_RING,
      cycle: LEGACY_CYCLE,
      inputHash,
      shards: [],
      models,
      tokens: { forgetIn: 0, memoryIn: inTokens, memoryOut: outTokens },
      degraded: false,
      at: now.toISOString(),
    })
  } catch {
    // 账本失败不阻断迁移。
  }

  const movedCount = movedRaw.size
  const parts = [
    `v0.2.1 → v2 迁移完成：生成年轮 ${LEGACY_RING}（${index.length} 条索引、${Array.from(narrative).length} 字叙事）。`,
    movedCount > 0 ? `旧 raw/ 原文 ${movedCount} 份已归档到 archive/<YYYY-MM>/。` : '旧 raw/ 为空。',
    '旧 distilled 原文已复制到 archive/legacy-v0.2.1/，旧 archive/ 扁平文件未改动。',
    '下一轮潮汐将从周期 b 开始（b1 b2 b3 + a11 → b11）。',
  ]
  return { migrated: true, message: parts.join(' '), ring: LEGACY_RING }
}

/* ────────────────────────────── CLI（npm run migrate） ────────────────────────────── */

/** CLI 用默认配置（与 ConfigSchema 默认值一致；memoryRoot 由参数覆盖）。 */
export function cliConfig(memoryRoot: string): Config {
  return {
    memoryRoot,
    windowDays: 3,
    // 迁移不调用模型，target 留空即可（resolveTargets 会回退并标 coupled）。
    forget: { provider: '', model: '', temperature: 0.1, maxTokens: 900, timeoutMs: 60_000 },
    memory: { provider: '', model: '', temperature: 0.35, maxTokens: 2_500, timeoutMs: 120_000 },
    embedding: { provider: 'deepseek', model: 'text-embedding-3-small', threshold: 0.6 },
    injection: { memoryTokens: 1_200, indexEntries: 15, commitments: 20 },
    protection: { commitmentsLock: true, identityAnchor: true, archiveRetentionDays: 0 },
    report: { enabled: true, outputDir: './data/memory/reports' },
    migration: { auto: true },
    debug: false,
  }
}

/** `npm run migrate [-- --root=./data/memory]` 的入口实现。 */
export async function runMigrateCli(argv: string[]): Promise<MigrateResult> {
  const rootArg =
    argv.find((arg) => arg.startsWith('--root='))?.slice('--root='.length) ??
    argv.find((arg) => !arg.startsWith('-')) ??
    './data/memory'
  const { ensureLayout, resolvePaths } = await import('./paths')
  const paths = resolvePaths(rootArg)
  await ensureLayout(paths)
  const result = await migrateFromV1(paths, cliConfig(paths.root), { forget: 'cli', memory: 'cli' })
  console.log(`[memory-distiller] ${result.message}`)
  if (result.migrated && result.ring) {
    console.log(`[memory-distiller] 年轮 ${result.ring} 已生成：${paths.rings}`)
  }
  return result
}

// CommonJS CLI 入口（tsconfig module=CommonJS；被 tests import 时 require.main !== module，不会执行）。
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runMigrateCli(process.argv.slice(2)).catch((error) => {
    console.error(`[memory-distiller] 迁移失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
