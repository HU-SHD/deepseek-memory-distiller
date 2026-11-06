/**
 * 潮汐忆体（TMA v2.0）插件入口。
 *
 * `apply(ctx, config)` 组装全部接线：路径 / 模型路由 / 注入 / 工具 / 命令 / 定时器 / 启动自检。
 * `runCycle()` 是本插件唯一的调度器，严格按 ARCHITECTURE §5 的顺序：
 *
 *   读 state → 读 raw → 退潮 forgetShard×N → 涨潮 integrate → 落盘年轮 → 五件套
 *   → 归档原文 → 账本 → 汇报 → LATEST → 推进 state
 *
 * 失败矩阵（ARCHITECTURE §10）：
 * - F 模型失败：forgetShard 内部降级为确定性抽取，degraded=true，继续；
 * - M 模型失败：不落盘、不归档、不推进 cycle，raw 保留，返回 memory-failed（下轮重试）；
 * - 落盘失败：异常上抛，LATEST 未更新 → 下次启动自检回滚到上一一致点。
 */

import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Config, CycleReport, Gist, Ring, RingId, ShardId } from './types'
import { ConfigSchema, configFingerprint, resolveTargets, type ResolvedTargets } from './config'
import { ensureLayout, resolvePaths, type MemoryPaths } from './paths'
import { advanceCycle, loadState, saveState, type MemoryState } from './state'
import { appendLedger, ledgerHead, readRingsLedger } from './ledger'
import { createRouter, type ModelRouter } from './model/router'
import { computeInputHash, findPrevRing, listRings, ringIdFor, shardIdsFor } from './ring/chain'
import { forgetShard } from './forget/forgetter'
import { integrate } from './remember/integrator'
import { buildCycleReport, renderReport } from './report/template'
import { resolveReportDir } from './report/dir'
import { computeHealth } from './report/health'
import { readAnchors, writeDistilled } from './store/distilled'
import { archiveShards } from './store/archive'
import { refreshInjectionCache, registerInjection } from './inject'
import { registerTools } from './tools'
import { registerCommands } from './commands'
import { migrateFromV1 } from './migrate'
import { estimateTokens } from './util/tokens'
import { readIfExists, writeAtomic } from './util/atomic'
import { sha256 } from './util/text'

export const name = 'memory-distiller'
export const inject = ['llm', 'tools', 'commands', 'systemPrompt']
export const version = '2.0.0'
export { ConfigSchema, ConfigSchema as Config }

interface CycleOptions {
  force?: boolean
  dryRun?: boolean
}

interface CycleOutcome {
  ring?: RingId
  skipped: string
}

interface Runtime {
  ctx: Context
  config: Config
  paths: MemoryPaths
  targets: ResolvedTargets
  router: ModelRouter
}

interface RawShard {
  id: ShardId
  file: string
  text: string
}

/* ────────────────────────────── 日志（可选依赖） ────────────────────────────── */

type LogLevel = 'info' | 'warn' | 'error'

function log(ctx: Context, level: LogLevel, message: string): void {
  try {
    const logger = (ctx as unknown as { logger?: Record<string, ((message: string) => void) | undefined> }).logger
    logger?.[level]?.(message)
  } catch {
    // 日志不可用不影响记忆主流程。
  }
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

function targetLabel(target: { provider: string; model: string } | undefined): string {
  if (!target) return '未配置'
  return `${target.provider}/${target.model}`
}

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10000) / 10000
}

/** 读取 raw/ 下的日片；文件名若不符合 a1/a2 规则，按当前周期补齐 shard id。 */
async function readRawShards(paths: MemoryPaths, cycle: string, windowDays: number): Promise<RawShard[]> {
  let names: string[] = []
  try {
    names = (await fs.readdir(paths.raw)).filter((name) => /\.(md|txt)$/i.test(name))
  } catch {
    return []
  }
  names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const fallbackIds = shardIdsFor(cycle, Math.max(1, windowDays))
  return names.map((fileName, index) => {
    const stem = fileName.replace(/\.(md|txt)$/i, '')
    const id = /^[a-z]+\d+$/.test(stem) ? stem : fallbackIds[index] ?? `${cycle}${index + 1}`
    return { id, file: path.join(paths.raw, fileName), text: '' }
  })
  // 文本在调用处按需读取，避免一次读太多日志噪声。
}

async function loadRawTexts(shards: RawShard[]): Promise<RawShard[]> {
  const result: RawShard[] = []
  for (const shard of shards) {
    const text = await readIfExists(shard.file)
    if (text === undefined) continue
    result.push({ ...shard, text })
  }
  return result
}

async function loadRing(paths: MemoryPaths, ringId: RingId): Promise<Ring | undefined> {
  const raw = await readIfExists(path.join(paths.rings, `${ringId}.json`))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Ring
  } catch {
    return undefined
  }
}

function renderRingMarkdown(ring: Ring): string {
  const indexLines = (ring.index ?? []).map(
    (entry) => `- ${entry.topic}（${(entry.keywords ?? []).join('、')}）→ ${entry.ptr}`,
  )
  return [
    `# 年轮 ${ring.id}`,
    '',
    `> 周期 ${ring.cycle} · 生成于 ${ring.createdAt}`,
    `> 输入：上一道年轮 ${ring.inputs.prevRing ?? '（无）'} ← 日片 ${ring.inputs.shards.join('+') || '（迁移）'}`,
    '',
    '## 叙事',
    '',
    ring.narrative,
    '',
    '## 核心记忆（注入稿）',
    '',
    ring.memoryMd,
    '',
    '## 索引',
    '',
    ...(indexLines.length > 0 ? indexLines : ['（无）']),
    '',
  ].join('\n')
}

/* ────────────────────────────── 启动自检 / 恢复 ────────────────────────────── */

/**
 * 启动自检 / 崩溃恢复（ARCHITECTURE §4.3：LATEST 与 rings/ 不一致时回滚到上一一致点）。
 *
 * 落盘顺序保证的崩溃窗口：
 * - 年轮 json/md、distilled 都写在 LATEST 之前；archive 也在 LATEST 之前。
 * - LATEST 落后于最新年轮：
 *   · raw/ 已空（说明归档完成）→ 前滚到最新年轮（记忆已完整落盘，不应丢弃）；
 *   · raw/ 仍有原文（归档未完成）→ 回滚：删掉未提交的新年轮文件，用 LATEST 年轮重建
 *     distilled，raw 保留待下轮重试。
 * - STATE 与 LATEST 不一致 → 对齐（崩溃后继续，不重复烧钱）。
 */
async function recover(ctx: Context, paths: MemoryPaths, config: Config): Promise<void> {
  const rings = await listRings(paths)
  const latestRaw = (await readIfExists(paths.latest))?.trim() ?? ''

  if (rings.length === 0) {
    if (latestRaw) await fs.unlink(paths.latest).catch(() => undefined)
    return
  }

  let committed = latestRaw && rings.includes(latestRaw) ? latestRaw : rings[rings.length - 1]
  if (latestRaw && latestRaw !== committed) {
    log(ctx, 'warn', `[memory-distiller] LATEST=${latestRaw} 指向不存在的年轮，回退到 ${committed}。`)
  }
  await writeAtomic(paths.latest, committed)

  let committedIndex = rings.indexOf(committed)
  const uncommitted = rings.slice(committedIndex + 1)
  if (uncommitted.length > 0) {
    const rawNames = await fs.readdir(paths.raw).catch(() => [] as string[])
    const rawCount = rawNames.filter((name) => /\.(md|txt)$/i.test(name)).length
    if (rawCount === 0) {
      // 前滚：raw 已归档，说明新年轮的全部落盘已完成（只差 LATEST）。
      committed = rings[rings.length - 1]
      committedIndex = rings.length - 1
      await writeAtomic(paths.latest, committed)
      log(ctx, 'info', `[memory-distiller] 检测到已落盘但未提交的年轮，前滚到 ${committed}。`)
    } else {
      // 回滚：删除未提交的年轮文件，用已提交年轮重建 distilled，raw 保留重试。
      for (const ringId of uncommitted) {
        await fs.unlink(path.join(paths.rings, `${ringId}.json`)).catch(() => undefined)
        await fs.unlink(path.join(paths.rings, `${ringId}.md`)).catch(() => undefined)
      }
      const committedRing = await loadRing(paths, committed)
      if (committedRing) {
        try {
          await writeDistilled(paths, committedRing, config)
        } catch (error) {
          log(ctx, 'warn', `[memory-distiller] distilled 回滚重建失败（继续运行）：${String(error)}`)
        }
      }
      log(ctx, 'warn', `[memory-distiller] 回滚未提交年轮（${uncommitted.join('、')}），raw/ 保留待重试。`)
    }
  }

  try {
    const ring = await loadRing(paths, committed)
    const state = await loadState(paths)
    if (ring && (state.lastRing !== ring.id || state.cycle !== advanceCycle(ring.cycle))) {
      await saveState(paths, {
        schemaVersion: 2,
        cycle: advanceCycle(ring.cycle),
        lastRing: ring.id,
        lastInputHash: ring.inputs.inputHash,
        degraded: state.degraded,
        updatedAt: state.updatedAt,
      })
      log(ctx, 'info', `[memory-distiller] 状态已对齐到年轮 ${ring.id}。`)
    }
  } catch (error) {
    log(ctx, 'warn', `[memory-distiller] 状态对齐失败（继续运行）：${String(error)}`)
  }

  // 缺文件静默：五件套第一次潮汐时才创建；若 IDENTITY 缺失但已有年轮，给出修复提示。
  const identity = await readIfExists(path.join(paths.distilled, 'IDENTITY.md'))
  if (identity === undefined && rings.length > 0) {
    log(ctx, 'warn', '[memory-distiller] 缺少 IDENTITY.md（身份锚），下次潮汐会写入默认模板。')
  }
}

/* ────────────────────────────── 成本估算（估算，不是账单） ────────────────────────────── */

/** 估算单价（CNY / 百万 token）；仅用于汇报里「节省百分比」，不参与调度。 */
const PRICE = { forgetInput: 0.5, memoryInput: 4, memoryOutput: 8 } as const

function estimateCost(args: { rawTokens: number; ring: Ring }): CycleReport['cost'] {
  const forgetTokens = args.rawTokens
  const memoryTokens = (args.ring.stats.inTokens ?? 0) + (args.ring.stats.outTokens ?? 0)
  const v2 =
    (forgetTokens / 1e6) * PRICE.forgetInput +
    ((args.ring.stats.inTokens ?? 0) / 1e6) * PRICE.memoryInput +
    ((args.ring.stats.outTokens ?? 0) / 1e6) * PRICE.memoryOutput
  // v1 对比：同量内容全部交给强模型（单模型全量摘要）。
  const v1 = ((forgetTokens + (args.ring.stats.inTokens ?? 0) + (args.ring.stats.outTokens ?? 0)) / 1e6) * PRICE.memoryInput
  const savedPct = v1 > 0 ? Math.max(0, Math.min(0.95, 1 - v2 / v1)) : 0
  return {
    forgetTokens,
    memoryTokens,
    estimatedCny: round4(v2),
    savedPct: round4(savedPct),
  }
}

async function buildChainSummary(paths: MemoryPaths): Promise<CycleReport['chain']> {
  const rings = await listRings(paths)
  const chain: CycleReport['chain'] = []
  for (const ringId of rings) {
    const jsonFile = path.join(paths.rings, `${ringId}.json`)
    const mdFile = path.join(paths.rings, `${ringId}.md`)
    const ring = await loadRing(paths, ringId)
    let sizeBytes = 0
    for (const file of [jsonFile, mdFile]) {
      try {
        const stat = await fs.stat(file)
        sizeBytes += stat.size
      } catch {
        // 缺文件按 0 计。
      }
    }
    const inputs = ring
      ? `${ring.inputs.prevRing ?? '∅'} ← ${ring.inputs.shards.join('+') || '迁移'}`
      : '（年轮 JSON 缺失）'
    chain.push({ id: ringId, inputs, sizeBytes })
  }
  return chain
}

/* ────────────────────────────── 调度器 ────────────────────────────── */

async function runCycleImpl(runtime: Runtime, opts: CycleOptions = {}): Promise<CycleOutcome> {
  const { ctx, config, paths, targets, router } = runtime
  await ensureLayout(paths)

  const state = await loadState(paths)
  const shards = await loadRawTexts(await readRawShards(paths, state.cycle, config.windowDays))
  if (shards.length === 0) {
    return { skipped: 'raw-empty' }
  }

  // 幂等：相同 prevRing + 相同日片 + 相同配置 → 跳过。
  const shardHashes = shards.map((shard) => sha256(shard.text))
  const prevId = await findPrevRing(paths)
  const configFp = configFingerprint(targets)
  const inputHash = computeInputHash(prevId, shardHashes, configFp)
  if (!opts.force && state.lastInputHash === inputHash) {
    return { skipped: 'duplicate-input' }
  }

  const targetRing = ringIdFor(state.cycle)
  const alreadyExists = await readIfExists(path.join(paths.rings, `${targetRing}.json`))
  if (alreadyExists) {
    await saveState(paths, {
      schemaVersion: 2,
      cycle: advanceCycle(state.cycle),
      lastRing: targetRing,
      lastInputHash: inputHash,
      updatedAt: state.updatedAt,
    })
    return { ring: targetRing, skipped: 'already-exists' }
  }

  if (opts.dryRun) {
    return { ring: targetRing, skipped: 'dry-run' }
  }

  // ── 退潮（F 模型，逐日并行；失败内部降级，绝不抛出） ──
  const gists: Gist[] = await Promise.all(
    shards.map((shard) => forgetShard({ router, paths }, shard.id, shard.text)),
  )
  const degraded = gists.some((gist) => gist.degraded)

  // ── 涨潮（M 模型，单次；失败不落盘、不推进） ──
  const prevRing = prevId ? await loadRing(paths, prevId) : undefined
  let anchors
  try {
    anchors = await readAnchors(paths, config)
  } catch (error) {
    log(ctx, 'warn', `[memory-distiller] 锚点读取失败（按空锚点继续）：${String(error)}`)
    anchors = { identity: '', commitments: [] }
  }

  let ring: Ring
  try {
    ring = await integrate({ router, paths }, { prevRing, gists, anchors, cycle: state.cycle, config })
  } catch (error) {
    log(ctx, 'error', `[memory-distiller] 涨潮（M 模型）失败，本轮不推进：${String(error)}`)
    return { skipped: `memory-failed: ${String(error)}` }
  }

  const rawTokens = estimateTokens(shards.map((shard) => shard.text).join('\n'))

  // ── 落盘：年轮（json + md）→ 五件套 → 归档原文 ──
  const ringJson = path.join(paths.rings, `${ring.id}.json`)
  const ringMd = path.join(paths.rings, `${ring.id}.md`)
  await writeAtomic(ringJson, JSON.stringify(ring, null, 2))
  await writeAtomic(ringMd, renderRingMarkdown(ring))
  await writeDistilled(paths, ring, config)
  await archiveShards(
    paths,
    shards.map((shard) => ({ id: shard.id, file: shard.file })),
    ring.id,
  )

  // ── 账本：年轮 + 每条 dropped 一行 ──
  const models = { forget: targetLabel(targets.forget), memory: targetLabel(targets.memory) }
  try {
    await appendLedger(paths, {
      kind: 'ring',
      ring: ring.id,
      cycle: ring.cycle,
      inputHash: ring.inputs.inputHash,
      prevRing: ring.inputs.prevRing,
      shards: ring.inputs.shards,
      models,
      tokens: {
        forgetIn: rawTokens,
        memoryIn: ring.stats.inTokens,
        memoryOut: ring.stats.outTokens,
      },
      degraded,
      at: new Date().toISOString(),
    })
    for (const gist of gists) {
      for (const item of gist.dropped ?? []) {
        await appendLedger(paths, {
          kind: 'forget',
          ring: ring.id,
          shard: gist.shard,
          item,
          at: new Date().toISOString(),
        })
      }
    }
  } catch (error) {
    log(ctx, 'warn', `[memory-distiller] 账本写入失败（不阻断）：${String(error)}`)
  }

  // ── 汇报（12 节） ──
  if (config.report?.enabled !== false) {
    try {
      const health = await computeHealth(paths, ring, {
        commitments: anchors.commitments,
        conflicts: ring.conflicts,
      })
      const chain = await buildChainSummary(paths)
      const cost = estimateCost({ rawTokens, ring })
      const records = await readRingsLedger(paths).catch(() => [])
      const head = ledgerHead(records)

      const report = buildCycleReport({
        ring,
        gists,
        models: { ...models, decoupled: targets.decoupled },
        health,
        chain,
        cost,
        ledgerHead: head,
        version,
      })
      // CycleReport 由年轮 + cost 组装；把退潮侧真实 token 与压缩比补回报告。
      report.forget.inTokens = rawTokens
      report.forget.compression = round4(rawTokens / Math.max(1, ring.stats.outTokens || ring.stats.inTokens || 1))
      report.remember.inTokens = ring.stats.inTokens

      const reportDir = resolveReportDir(config, paths)
      await fs.mkdir(reportDir, { recursive: true })
      await writeAtomic(path.join(reportDir, `${ring.id}.md`), `${renderReport(report)}\n`)
      await writeAtomic(path.join(reportDir, 'LATEST'), `${ring.id}\n`)
    } catch (error) {
      log(ctx, 'warn', `[memory-distiller] 汇报生成失败（不阻断）：${String(error)}`)
    }
  }

  // ── LATEST 最后更新（保证「要么旧年轮可见，要么新年轮可见」） ──
  await writeAtomic(paths.latest, ring.id)

  // ── 推进周期 ──
  const nextState: MemoryState = {
    schemaVersion: 2,
    cycle: advanceCycle(ring.cycle),
    lastRing: ring.id,
    lastInputHash: ring.inputs.inputHash,
    ...(degraded ? { degraded: true } : {}),
    updatedAt: new Date().toISOString(),
  }
  await saveState(paths, nextState)

  // 注入快照刷新（下一轮主对话立刻看到新记忆）
  try {
    refreshInjectionCache(config, paths)
  } catch {
    // 注入刷新失败不影响落盘结果。
  }

  log(
    ctx,
    'info',
    `[memory-distiller] 潮汐完成：年轮 ${ring.id}（${shards.length} 份日片，压缩比 ${round4(
      rawTokens / Math.max(1, ring.stats.outTokens || 1),
    )}×，degraded=${degraded}）。`,
  )
  return { ring: ring.id, skipped: '' }
}

/* ────────────────────────────── 插件入口 ────────────────────────────── */

export function apply(ctx: Context, config: Config): void {
  const paths = resolvePaths(config.memoryRoot)

  let targets: ResolvedTargets
  try {
    targets = resolveTargets(config)
  } catch (error) {
    log(ctx, 'error', `[memory-distiller] 模型目标解析失败，插件退化为禁用状态：${String(error)}`)
    return
  }
  const router = createRouter(ctx, targets)
  const runtime: Runtime = { ctx, config, paths, targets, router }

  const runCycle = (opts: CycleOptions = {}): Promise<CycleOutcome> => runCycleImpl(runtime, opts)

  // 1) 注入（必须先刷新快照，再注册 section，避免首轮注入为空段）
  registerInjection(ctx, config, paths)

  // 2) 工具
  registerTools(ctx, config, paths, { router, targets })

  // 3) 命令（/dream、/memory）
  registerCommands(ctx, config, paths, { runCycle, router })

  // 4) 定时潮汐（windowDays 天一次；/dream 可手动触发）
  ctx.effect(() => {
    const intervalMs = Math.max(1, config.windowDays ?? 3) * 864e5
    const timer = setInterval(() => {
      void runCycle({}).catch((error) => log(ctx, 'error', `[memory-distiller] 定时潮汐失败：${String(error)}`))
    }, intervalMs)
    return () => {
      try {
        clearInterval(timer)
      } catch {
        // ignore
      }
    }
  })

  // 5) 启动自检 + 迁移（异步，不阻塞 apply）
  ctx.effect(() => {
    let disposed = false
    void (async () => {
      try {
        await ensureLayout(paths)
        if (disposed) return
        await recover(ctx, paths, config)
        if (disposed) return

        if (config.migration?.auto) {
          const result = await migrateFromV1(paths, config, {
            forget: targetLabel(targets.forget),
            memory: targetLabel(targets.memory),
          })
          if (result.migrated) {
            log(ctx, 'info', `[memory-distiller] ${result.message}`)
            refreshInjectionCache(config, paths)
          }
        }
        refreshInjectionCache(config, paths)
      } catch (error) {
        // 启动自检失败绝不让插件加载失败。
        log(ctx, 'warn', `[memory-distiller] 启动自检失败（继续运行）：${String(error)}`)
      }
    })()
    return () => {
      disposed = true
    }
  })

  log(ctx, 'info', `[memory-distiller] v${version} 已加载（memoryRoot=${paths.root}，windowDays=${config.windowDays}）。`)
}
