/**
 * 系统提示词注入：五段预算注入（ARCHITECTURE §7）。
 *
 * 顺序固定：身份锚 → 承诺锁 → 核心记忆 → 潜意识索引 → 检索准则。
 * 总预算 config.injection.memoryTokens（默认 1200）。
 * 失败策略：读文件失败返回空串，绝不打断主对话。
 *
 * DSH 0.2.2 的 `systemPrompt.section().text` **必须是同步的**（不接受 Promise），
 * 所以这里走「同步读 + 进程内快照缓存」：注册时读一次，runCycle 写盘后由 index.ts
 * 调 refreshInjectionCache() 刷新；另附 5 分钟兜底刷新。readFileSync 只在小文件上执行，
 * 不在主对话热路径上做异步 I/O。
 *
 * 本文件顶层只有 node 内置依赖（零运行时相对导入），便于 tests/inject.test.ts 直接单测。
 */

import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import path from 'node:path'
import type { Commitment, Config, IndexEntry } from './types'
import type { MemoryPaths } from './paths'

/**
 * 注入纯函数需要的最小数据快照（结构上等于 store/distilled.readDistilled 的返回值）。
 * 刻意本地定义：inject.ts 顶层没有任何运行时相对导入，tests/inject.test.ts 只加载
 * 本文件就能测「组装 + 预算截断」，不需要碰文件系统或 pipeline 模块。
 */
export interface InjectionSnapshot {
  memory: string
  index: IndexEntry[]
  commitments: Commitment[]
  identity: string
}

/* ────────────────────────────── token 估算（与 util/tokens 同口径，纯函数） ────────────────────────────── */

const CJK_CHAR = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 中文≈1 字 1 token，英文/符号≈4 字符 1 token，混合取整。 */
export function estimateBudgetTokens(text: string): number {
  const value = text ?? ''
  if (!value) return 0
  let cjk = 0
  let latin = 0
  for (const char of value) {
    if (CJK_CHAR.test(char)) cjk += 1
    else latin += 1
  }
  return Math.ceil(cjk + latin / 4)
}

/** 截断到 token 预算；截断时补 `…`（保证结果估算 ≤ max）。 */
export function truncateBudgetTokens(text: string, max: number): string {
  const value = text ?? ''
  const limit = Math.max(0, Math.floor(max))
  if (!value) return ''
  if (estimateBudgetTokens(value) <= limit) return value
  if (limit <= 1) return '…'
  const sliceBudget = Math.max(0, limit - 1)
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateBudgetTokens(value.slice(0, mid)) <= sliceBudget) low = mid
    else high = mid - 1
  }
  const prefix = value.slice(0, low).trimEnd()
  return prefix ? `${prefix}…` : '…'
}

/** DSH 会对 `{{变量}}` 做插值：记忆文本里的花括号全部换成全角，避免被误插值。 */
function sanitize(text: string): string {
  return (text ?? '').replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝')
}

/* ────────────────────────────── 五段渲染 ────────────────────────────── */

const GUIDANCE_TEXT =
  '缺失细节时先调用 recall_memory 检索归档记忆（三路召回）；禁止直接回答「我忘了」。' +
  '检索不到时再说明不确定，不要编造。'

const SECTION_LABELS = ['【你是谁】', '【不可遗忘的约定】', '【核心记忆】', '【潜意识索引】', '【检索准则】']

function renderCommitments(distilled: InjectionSnapshot, maxCount: number): string {
  const list = [...(distilled.commitments ?? [])]
    .filter((commitment) => commitment && (commitment.text ?? '').trim())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, maxCount)
  if (list.length === 0) return ''
  return list
    .map((commitment) => {
      const expires = commitment.expires ? `（到期 ${commitment.expires}）` : ''
      return `- ${commitment.text}${expires}`
    })
    .join('\n')
}

function renderIndex(distilled: InjectionSnapshot, maxCount: number, tokenBudget: number): string {
  const entries = [...(distilled.index ?? [])]
    .filter((entry) => entry && (entry.topic ?? '').trim())
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, maxCount)
  const lines: string[] = []
  let used = 0
  for (const entry of entries) {
    const keywords = (entry.keywords ?? []).slice(0, 4).join('、')
    const line = `- ${entry.topic}${keywords ? `（${keywords}）` : ''} [重要度 ${formatImportance(entry)}]`
    const cost = estimateBudgetTokens(line) + 1
    if (used + cost > tokenBudget) break
    used += cost
    lines.push(line)
  }
  return lines.join('\n')
}

function scoreOf(entry: IndexEntry): number {
  const importance = Number.isFinite(entry.importance) ? entry.importance : 5
  const decay = Number.isFinite(entry.decay) ? entry.decay : 1
  return importance * decay
}

function formatImportance(entry: IndexEntry): string {
  const importance = Number.isFinite(entry.importance) ? entry.importance : 5
  return String(Math.round(importance * 10) / 10)
}

/* ────────────────────────────── 主函数 ────────────────────────────── */

export function buildMemoryPrompt(distilled: InjectionSnapshot, config: Config): string {
  const total = Math.max(120, Math.floor(config.injection?.memoryTokens ?? 1200))
  const maxCommitments = Math.max(1, Math.min(20, Math.floor(config.injection?.commitments ?? 20)))
  const maxIndexEntries = Math.max(0, Math.floor(config.injection?.indexEntries ?? 15))

  const guidanceCost = estimateBudgetTokens(GUIDANCE_TEXT)
  const labelCost = estimateBudgetTokens(SECTION_LABELS.join('')) + 8
  const contentBudget = Math.max(0, total - guidanceCost - labelCost)

  // 预算分配：身份锚 ≤120，承诺锁优先，记忆 ≤900，索引吃剩余的 15% 左右。
  const identityCap = Math.min(120, Math.max(0, Math.round(contentBudget * 0.1)))
  const commitmentCap = Math.max(0, Math.round(contentBudget * 0.3))
  const indexCapBase = Math.max(0, Math.round(contentBudget * 0.15))
  const memoryCap = Math.min(900, Math.max(0, contentBudget - identityCap - commitmentCap - indexCapBase))
  const indexCap = Math.max(0, contentBudget - identityCap - commitmentCap - memoryCap)

  const bodies: string[] = [
    truncateBudgetTokens(sanitize(distilled.identity ?? ''), identityCap),
    truncateBudgetTokens(renderCommitments(distilled, maxCommitments), commitmentCap),
    truncateBudgetTokens(sanitize(distilled.memory ?? ''), memoryCap),
    renderIndex(distilled, maxIndexEntries, indexCap),
    GUIDANCE_TEXT,
  ]

  const assemble = (): string =>
    bodies.map((body, index) => (body ? `${SECTION_LABELS[index]}\n${body}` : SECTION_LABELS[index])).join('\n\n')

  let prompt = assemble()
  let guard = 0
  while (estimateBudgetTokens(prompt) > total && guard < 8) {
    guard += 1
    const overflow = estimateBudgetTokens(prompt) - total
    let largest = -1
    let largestCost = 0
    for (let i = 0; i < 4; i += 1) {
      const cost = estimateBudgetTokens(bodies[i])
      if (cost > largestCost) {
        largestCost = cost
        largest = i
      }
    }
    if (largest < 0 || largestCost <= 1) break
    const newCap = Math.max(0, largestCost - overflow - 1)
    const truncated = truncateBudgetTokens(bodies[largest], newCap)
    if (truncated === bodies[largest]) break
    bodies[largest] = truncated
    prompt = assemble()
  }
  if (estimateBudgetTokens(prompt) > total) prompt = truncateBudgetTokens(prompt, total)
  return prompt
}

/* ────────────────────────────── 同步快照（注入热路径） ────────────────────────────── */

function readTextSync(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function parseIndexSync(raw: string | undefined): IndexEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as IndexEntry[]
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries as IndexEntry[]
  } catch {
    // 索引损坏 → 返回空索引（注入侧不重建，重建由 readDistilled 负责）。
  }
  return []
}

function parseCommitmentsSync(markdown: string): Commitment[] {
  const result: Commitment[] = []
  for (const line of (markdown ?? '').split(/\r?\n/)) {
    const match = /^-\s+\[([^\]]+)\]\s+(\S+)\s+·\s+(\S+)\s+·\s+(.+)$/.exec(line.trim())
    if (!match) continue
    const [, id, createdAt, sourceShard, rest] = match
    const expiresMatch = /（到期\s*([^）]+)）\s*$/.exec(rest)
    const text = expiresMatch ? rest.slice(0, expiresMatch.index).trim() : rest.trim()
    const commitment: Commitment = { id: id.trim(), text, createdAt: createdAt.trim(), sourceShard: sourceShard.trim() }
    if (expiresMatch) commitment.expires = expiresMatch[1].trim()
    result.push(commitment)
  }
  return result
}

let injectionCache = ''

/** 同步读取 distilled 五件套并刷新注入快照；任何异常都退化为空串。 */
export function refreshInjectionCache(config: Config, paths: MemoryPaths): string {
  try {
    const memoryFile = path.join(paths.distilled, 'MEMORY.md')
    const indexFile = path.join(paths.distilled, 'INDEX.json')
    const commitmentsFile = path.join(paths.distilled, 'COMMITMENTS.md')
    const identityFile = path.join(paths.distilled, 'IDENTITY.md')
    const distilled: InjectionSnapshot = {
      memory: readTextSync(memoryFile) ?? '',
      index: parseIndexSync(readTextSync(indexFile)),
      commitments: parseCommitmentsSync(readTextSync(commitmentsFile) ?? ''),
      identity: readTextSync(identityFile) ?? '',
    }
    injectionCache = buildMemoryPrompt(distilled, config)
  } catch {
    injectionCache = ''
  }
  return injectionCache
}

/** 当前注入快照（测试/诊断用）。 */
export function currentInjectionSnapshot(): string {
  return injectionCache
}

/* ────────────────────────────── 注册 ────────────────────────────── */

function warn(ctx: Context, message: string): void {
  try {
    const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
    logger?.warn?.(message)
  } catch {
    // 日志不可用也不影响主对话。
  }
}

export function registerInjection(ctx: Context, config: Config, paths: MemoryPaths): void {
  // 注册先读一次；之后由 index.ts 在每轮潮汐落盘后刷新。
  refreshInjectionCache(config, paths)
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section({
      name: 'memory:core',
      order: 500,
      // 必须是同步函数：DSH 0.2.2 的类型是 string | ((ctx) => string)。
      text: (() => injectionCache) as unknown as (context: unknown) => string,
    })
    // 兜底刷新：即使没有 runCycle（例如用户手动改文件），5 分钟后也能自愈。
    const timer = setInterval(() => {
      try {
        refreshInjectionCache(config, paths)
      } catch (error) {
        warn(ctx, `[memory-distiller] 注入快照刷新失败（已保留旧快照）：${String(error)}`)
      }
    }, 5 * 60 * 1000)
    return () => {
      try {
        clearInterval(timer)
      } catch {
        // ignore
      }
      try {
        ;(dispose as unknown as () => void)?.()
      } catch {
        // ignore
      }
    }
  })
}
