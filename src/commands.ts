/**
 * DSH 斜杠命令注册：`/dream` 与 `/memory status|report|pin|forget`。
 *
 * 依据 `.ref/dsh-plugin-api-0.2.2.md` §4：
 * - `ctx.commands.register({ definitionId, name, description, handler })`；
 * - handler 返回 `{ kind: 'success' | 'error', text }`；
 * - rawInput 是命令名之后的原始输入（含空格）。
 */

import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Config, IndexEntry, RingId } from './types'
import type { MemoryPaths } from './paths'
import type { ModelRouter } from './model/router'
import { readIfExists } from './util/atomic'
import { loadState } from './state'
import { listRings } from './ring/chain'
import { appendCommitment, forgetByKeyword, readDistilled } from './store/distilled'
import { appendLedger } from './ledger'
import { resolveReportDir } from './report/dir'
import { refreshInjectionCache } from './inject'

export interface RunCycleResult {
  ring?: RingId
  skipped: string
}

export interface CommandDeps {
  runCycle: (opts: { force?: boolean; dryRun?: boolean }) => Promise<RunCycleResult>
  router: ModelRouter
}

const USAGE = [
  '用法：',
  '/dream [--dry-run]  手动触发一次潮汐（退潮 + 涨潮）；--dry-run 只预演不落盘',
  '/memory status     查看当前周期、最新年轮、raw/ 待处理数量',
  '/memory report [年轮]  查看汇报（省略年轮则读最新一份）',
  '/memory pin <文本> 写入承诺锁（不得删除，每轮注入）',
  '/memory forget <关键词> 从索引中移除匹配条目（原文仍在 archive）',
].join('\n')

function latestRingFrom(latestRaw: string | undefined, rings: RingId[]): RingId | '' {
  const latest = (latestRaw ?? '').trim()
  if (latest) return latest
  return rings.length > 0 ? rings[rings.length - 1] : ''
}

export function registerCommands(
  ctx: Context,
  config: Config,
  paths: MemoryPaths,
  deps: CommandDeps,
): void {

  const formatCycleResult = (result: RunCycleResult): { kind: 'success' | 'error'; text: string } => {
    if (result.skipped === '' && result.ring) {
      return {
        kind: 'success',
        text: `潮汐完成：年轮 ${result.ring} 已生成，汇报见 ${path.join(resolveReportDir(config, paths), `${result.ring}.md`)}。`,
      }
    }
    if (result.skipped === 'raw-empty') {
      return { kind: 'success', text: '潮间带（raw/）为空：没有新的原文需要退潮，本轮跳过（未消耗模型调用）。' }
    }
    if (result.skipped === 'duplicate-input') {
      return { kind: 'success', text: '输入与上一轮完全相同（inputHash 幂等），跳过本轮，避免重复烧钱。' }
    }
    if (result.skipped === 'dry-run') {
      return {
        kind: 'success',
        text: `预演完成：若现在触发，将生成年轮 ${result.ring ?? '（未知）'}（dry-run：未调用模型、未写盘、未推进周期）。`,
      }
    }
    if (result.skipped.startsWith('memory-failed')) {
      return {
        kind: 'error',
        text: `涨潮（M 模型）失败：${result.skipped.replace(/^memory-failed:\s*/, '')}\n原文保留在 raw/，周期未推进，下一轮自动重试（记忆只进不退）。`,
      }
    }
    if (result.skipped.startsWith('already-exists')) {
      return { kind: 'success', text: `年轮 ${result.ring ?? ''} 已存在，已对齐状态，未重复生成。` }
    }
    return { kind: 'error', text: `本轮未完成：${result.skipped || '未知原因'}` }
  }

  const disposeDream = ctx.commands.register({
    name: 'dream',
    description: '手动触发一次记忆潮汐（退潮遗忘 + 涨潮记忆），可加 --dry-run 预演',
    handler: async (invocation) => {
      const raw = String(invocation.rawInput ?? '').trim()
      const tokens = raw.split(/\s+/).filter(Boolean)
      const dryRun = tokens.some((token) => token === '--dry-run' || token === '-n')
      const unknown = tokens.filter((token) => token !== '--dry-run' && token !== '-n')
      if (unknown.length > 0) return { kind: 'error', text: `未知参数：${unknown.join(' ')}\n${USAGE}` }
      try {
        const result = await deps.runCycle({ force: true, dryRun })
        return formatCycleResult(result)
      } catch (error) {
        return { kind: 'error', text: `潮汐执行异常：${String(error)}（原文仍在 raw/，未推进周期）。` }
      }
    },
  })

  const disposeMemory = ctx.commands.register({
    name: 'memory',
    description: '潮汐忆体管理：/memory status | report [年轮] | pin <文本> | forget <关键词>',
    handler: async (invocation) => {
      const raw = String(invocation.rawInput ?? '').trim()
      if (!raw) return { kind: 'error', text: USAGE }
      const match = /^(\S+)\s*([\s\S]*)$/.exec(raw)
      const sub = (match?.[1] ?? '').toLowerCase()
      const rest = (match?.[2] ?? '').trim()

      if (sub === 'status') {
        try {
          const state = await loadState(paths)
          const rings = await listRings(paths).catch(() => [] as RingId[])
          const rawFiles = await fs.readdir(paths.raw).catch(() => [] as string[])
          const pending = rawFiles.filter((name) => /\.(md|txt)$/i.test(name)).length
          const latest = latestRingFrom(await readIfExists(paths.latest), rings)
          const distilled = await readDistilled(paths).catch(() => undefined)
          const lines = [
            `周期：${state.cycle}`,
            `最新年轮：${latest || '（无）'}`,
            `年轮总数：${rings.length}`,
            `raw/ 待处理：${pending} 份`,
            `退潮降级：${state.degraded ? '是（本轮 F 模型降级）' : '否'}`,
            `待重试：${pending > 0 ? '是（M 失败时原文保留，下轮重试）' : '否'}`,
            `承诺锁：${distilled?.commitments.length ?? 0} 条`,
            `索引条目：${distilled?.index.length ?? 0} 条`,
          ]
          return { kind: 'success', text: lines.join('\n') }
        } catch (error) {
          return { kind: 'error', text: `读取状态失败：${String(error)}` }
        }
      }

      if (sub === 'report') {
        const requested = rest.split(/\s+/)[0] ?? ''
        const rings = await listRings(paths).catch(() => [] as RingId[])
        const latest = latestRingFrom(await readIfExists(paths.latest), rings)
        const ringId = (requested || latest) as RingId
        if (!ringId) {
          return { kind: 'error', text: '还没有任何年轮：先执行 /dream 触发一次潮汐。' }
        }
        const markdown = await readIfExists(path.join(resolveReportDir(config, paths), `${ringId}.md`))
        if (markdown === undefined) {
          return {
            kind: 'error',
            text: `没有找到年轮 ${ringId} 的汇报（${path.join(resolveReportDir(config, paths), `${ringId}.md`)}）。先执行 /dream，或确认 report.enabled=true。`,
          }
        }
        return { kind: 'success', text: markdown }
      }

      if (sub === 'pin') {
        if (!rest) return { kind: 'error', text: `请提供要 pin 的内容。\n${USAGE}` }
        try {
          const commitment = await appendCommitment(paths, rest)
          refreshInjectionCache(config, paths)
          const distilled = await readDistilled(paths)
          return {
            kind: 'success',
            text: `已写入承诺锁：${commitment.text}\n当前共 ${distilled.commitments.length} 条承诺（任何模型不得删除，每轮强制注入）。`,
          }
        } catch (error) {
          return { kind: 'error', text: `写入承诺锁失败：${String(error)}` }
        }
      }

      if (sub === 'forget') {
        if (!rest) return { kind: 'error', text: `请提供要遗忘的关键词。\n${USAGE}` }
        try {
          const removed = await forgetByKeyword(paths, rest)
          if (removed.length === 0) {
            return { kind: 'success', text: `索引里没有匹配「${rest}」的条目（原文仍在 archive/，可用 recall_memory 检索）。` }
          }
          refreshInjectionCache(config, paths)
          for (const entry of removed as IndexEntry[]) {
            try {
              await appendLedger(paths, {
                kind: 'forget',
                ring: entry.ring as RingId,
                shard: entry.shard ?? 'manual',
                item: { what: entry.topic, why: 'low-weight', ref: entry.ptr },
                at: new Date().toISOString(),
              })
            } catch {
              // 账本失败不阻断遗忘操作。
            }
          }
          return {
            kind: 'success',
            text: `已从索引移除 ${removed.length} 条：${removed.map((entry) => entry.topic).join('、')}\n原文仍在 archive/，可回溯；遗忘已记入 ledgers/forget.jsonl。`,
          }
        } catch (error) {
          return { kind: 'error', text: `遗忘操作失败：${String(error)}` }
        }
      }

      return { kind: 'error', text: `未知子命令「${sub}」。\n${USAGE}` }
    },
  })

  ctx.effect(() => () => {
    for (const dispose of [disposeDream, disposeMemory]) {
      try {
        ;(dispose as unknown as () => void)?.()
      } catch {
        // ignore
      }
    }
  })

  // config 与 router 保留在签名里：report 渲染与后续审校模型共用，不重复构造。
  void config
  void deps.router
}
