/**
 * 涨潮：记忆官（M 模型）把「上一道年轮 + 本轮遗骸 + 承诺锁/身份锚」整合成一道新年轮。
 *
 * 铁律（违反即返工）：
 * - **单次调用**，温度 0.35；
 * - **只读上一道年轮 + Gist + 锚点，绝不读原文**（这是"遗忘与记忆分离"的物理实现）；
 * - 输出严格 JSON，**解析失败直接抛错**，由调用方决定不推进年轮（记忆只进不退）；
 * - 承诺锁与身份锚不得被模型删除/改写（承诺条目原样保留并强制注入）。
 */
import type { Commitment, Config, Conflict, CycleId, Gist, IndexEntry, Ring, RingId } from '../types'
import type { MemoryPaths } from '../paths'
import type { ModelRouter } from '../model/router'
import { configFingerprint, resolveTargets } from '../config'
import { extractJson } from '../model/json'
import { computeInputHash, ringIdFor } from '../ring/chain'
import { estimateTokens, truncateToTokens } from '../util/tokens'
import { sha256 } from '../util/text'

/** 涨潮输入的硬预算（ARCHITECTURE 第 2 节：≤ 14k tok）。 */
const MAX_INPUT_TOKENS = 14_000

/** 承诺锁 / 身份锚：独立于年轮，任何模型不得改写。 */
export interface AnchorSet {
  identity: string
  commitments: Commitment[]
}

/** 涨潮依赖。 */
export interface RememberDeps {
  router: ModelRouter
  paths: MemoryPaths
}

/** 涨潮入参。 */
export interface IntegrateArgs {
  prevRing?: Ring
  gists: Gist[]
  anchors: AnchorSet
  cycle: CycleId
  config: Config
}

/** 安全地把 unknown 收窄为对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 安全地把 unknown 收窄为数组（否则空数组）。 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 取字符串字段并 trim。 */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/** 取数字字段并夹到 [min, max]。 */
function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, parsed))
}

/** 记忆官的系统提示词。 */
function memorySystemPrompt(config: Config): string {
  return `你是「潮汐忆体」的记忆官（Memory Officer）。
你只读「上一道年轮 + 本轮遗骸 + 承诺锁/身份锚」，不读原文，也不得要求更多原文。
你的职责：把本轮遗骸整合进历史，写出一道新的年轮——叙事连贯、关系敏感、守诺。

硬性规则：
1. 只输出一个 JSON 对象，不要 Markdown 围栏，不要解释，不要前后缀。
2. 字段：
{
  "narrative": "300–800 字，人类可读：这段时间发生了什么、关系如何变化、有什么未完成",
  "memoryMd": "注入稿，≤${config.injection.memoryTokens} token；写成可直接注入系统提示词的中文记忆",
  "index": [{"topic": "主题", "keywords": ["关键词"], "importance": 0-10, "decay": 0.0-1.0, "ptr": "指针"}],
  "commitments": [{"id": "可选", "text": "承诺原文", "sourceShard": "日片id", "expires": "可选 ISO 日期"}],
  "conflicts": [{"a": "旧说法", "b": "新说法", "resolution": "kept-old|kept-new|merged|open"}]
}
3. 承诺锁：输入的承诺必须原样出现在 commitments 中，不得删除、不得改写；新承诺只能追加。
4. 身份锚不得改写：不要改名字、关系定义、边界。
5. 冲突必须显式记录到 conflicts；拿不准就 resolution="open"。
6. index 的 ptr 优先沿用遗骸里给出的指针；没有就用 rings/<新年轮>.md。
7. 不按情绪打分：importance 只由显式信号（约定、生日、"一定要记得"）决定。`
}

/** 把年轮压成提示词里的一节（限制 token 预算）。 */
function buildPrevRingSection(prevRing: Ring | undefined, budget: number): string {
  if (!prevRing) {
    return '【上一道年轮】\n（这是第一道年轮，没有历史；请从本轮遗骸开始建立记忆）'
  }
  const indexLines = [...prevRing.index]
    .sort((a, b) => b.importance * b.decay - a.importance * a.decay)
    .slice(0, 15)
    .map((entry) => `- [${entry.importance}/10] ${entry.topic}（${entry.keywords.join('、')}）→ ${entry.ptr}`)
    .join('\n')
  const text = `【上一道年轮】
id: ${prevRing.id}（周期 ${prevRing.cycle}）
叙事：
${prevRing.narrative}

注入稿：
${prevRing.memoryMd}

索引（按 importance×decay 排序）：
${indexLines || '（无）'}`
  return truncateToTokens(text, budget)
}

/** 把本轮遗骸压成提示词里的一节（每个 Gist 平分预算）。 */
function buildGistSection(gists: Gist[], budget: number): string {
  if (gists.length === 0) return '【本轮遗骸】\n（无）'
  const perGist = Math.max(200, Math.floor(budget / gists.length))
  const blocks = gists.map((gist) => {
    const compact = {
      shard: gist.shard,
      hash: gist.hash,
      events: gist.events,
      facts: gist.facts,
      entities: gist.entities,
      dropped: gist.dropped,
      openLoops: gist.openLoops,
      index: gist.index,
      degraded: gist.degraded,
    }
    return `【日片 ${gist.shard}】\n${truncateToTokens(JSON.stringify(compact), perGist)}`
  })
  return `【本轮遗骸】\n${blocks.join('\n\n')}`
}

/** 组装涨潮提示词，并返回输入 token 估算。 */
function buildIntegratePrompt(args: IntegrateArgs, ringId: RingId): { prompt: string; inputTokens: number } {
  const commitmentText = args.anchors.commitments
    .slice(0, args.config.injection.commitments)
    .map((commitment) => `- [${commitment.sourceShard}] ${commitment.text}${commitment.expires ? `（到期：${commitment.expires}）` : ''}`)
    .join('\n')
  // 身份锚与承诺锁不可裁剪（三道保护的硬要求）
  const anchorSection = `【身份锚】（不得改写）
${args.anchors.identity || '（未设置）'}

【承诺锁】（任何模型都不得删除）
${commitmentText || '（无）'}`

  const remaining = Math.max(1_000, MAX_INPUT_TOKENS - estimateTokens(anchorSection))
  const prevBudget = Math.floor(remaining * 0.4)
  const gistBudget = remaining - prevBudget
  const prompt = [
    anchorSection,
    buildPrevRingSection(args.prevRing, prevBudget),
    buildGistSection(args.gists, gistBudget),
    `【本轮任务】
周期：${args.cycle}
新年轮：${ringId}
请输出整合后的 JSON。`,
  ].join('\n\n')
  return { prompt, inputTokens: estimateTokens(prompt) }
}

/**
 * 涨潮主入口：单次调用 M 模型，产出新年轮。
 *
 * **解析失败抛错**（由调用方决定不推进 cycle、保留 raw 下轮重试）。
 *
 * @param deps 路由器 + 路径
 * @param args 上一年轮、本轮遗骸、锚点、周期、配置
 */
export async function integrate(deps: RememberDeps, args: IntegrateArgs): Promise<Ring> {
  const target = args.config.memory
  const ringId = ringIdFor(args.cycle)
  const { prompt, inputTokens } = buildIntegratePrompt(args, ringId)

  const result = await deps.router.memory.chat(target, {
    system: memorySystemPrompt(args.config),
    prompt,
    temperature: target.temperature,
    maxTokens: target.maxTokens,
    timeoutMs: target.timeoutMs,
    purpose: 'memory-integrate',
  })

  let payload: unknown
  try {
    payload = extractJson<unknown>(result.text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`[memory-distiller] 涨潮失败：M 模型输出不是合法 JSON（${message}）；本轮不推进年轮`, {
      cause: error,
    })
  }

  const record = asRecord(payload)
  if (!record) throw new Error('[memory-distiller] 涨潮失败：M 模型输出的 JSON 不是对象；本轮不推进年轮')

  const narrative = str(record.narrative)
  const memoryMd = str(record.memoryMd)
  if (!narrative || !memoryMd) {
    throw new Error('[memory-distiller] 涨潮失败：M 模型输出缺少 narrative / memoryMd；本轮不推进年轮')
  }

  const commitments = mergeCommitments(args.anchors.commitments, asArray(record.commitments), args.gists)
  const index = normalizeIndex(asArray(record.index), ringId)
  const conflicts = normalizeConflicts(asArray(record.conflicts))

  const inputHash = computeInputHash(
    args.prevRing?.id,
    args.gists.map((gist) => gist.hash),
    configFingerprint(resolveTargets(args.config)),
  )
  const inTokens = result.inputTokens ?? inputTokens
  const outTokens = result.outputTokens ?? estimateTokens(result.text)

  return {
    id: ringId,
    cycle: args.cycle,
    inputs: {
      ...(args.prevRing ? { prevRing: args.prevRing.id } : {}),
      shards: args.gists.map((gist) => gist.shard),
      inputHash,
    },
    narrative,
    memoryMd: truncateToTokens(memoryMd, args.config.injection.memoryTokens),
    index,
    commitments,
    conflicts,
    stats: {
      inTokens,
      outTokens,
      // 本轮"输入 / 注入稿"的压缩比（原文 token 由退潮账本单独统计）
      compression: outTokens > 0 ? Number((inTokens / outTokens).toFixed(2)) : 0,
    },
    createdAt: new Date().toISOString(),
  }
}

/* ────────────────────────────── 输出规范化 ────────────────────────────── */

/**
 * 合并承诺锁：锚点里的承诺**全部保留**，模型新增的承诺去重后追加。
 * 这是"任何模型都不得删除承诺"的代码实现。
 */
function mergeCommitments(existing: Commitment[], incoming: unknown[], gists: Gist[]): Commitment[] {
  const merged: Commitment[] = [...existing]
  const seen = new Set(existing.map((commitment) => commitment.text.replace(/\s+/gu, ' ').trim()))
  for (const item of incoming) {
    const record = asRecord(item)
    const text = str(record?.text)
    if (!record || !text) continue
    const key = text.replace(/\s+/gu, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      id: str(record.id) || `cm_${sha256(text).slice(0, 10)}`,
      text,
      createdAt: str(record.createdAt) || new Date().toISOString(),
      sourceShard: str(record.sourceShard) || gists[0]?.shard || 'manual',
      ...(str(record.expires) ? { expires: str(record.expires) } : {}),
    })
  }
  return merged
}

/** 规范化索引：补 ring / ptr，夹取 importance 与 decay，丢弃空 topic。 */
function normalizeIndex(incoming: unknown[], ringId: RingId): IndexEntry[] {
  const index: IndexEntry[] = []
  for (const item of incoming) {
    const record = asRecord(item)
    const topic = str(record?.topic)
    if (!record || !topic) continue
    index.push({
      topic,
      keywords: asArray(record.keywords)
        .map((keyword) => str(keyword))
        .filter((keyword) => keyword.length > 0),
      ring: ringId,
      ...(str(record.shard) ? { shard: str(record.shard) } : {}),
      importance: num(record.importance, 5, 0, 10),
      decay: num(record.decay, 0.9, 0, 1),
      ptr: str(record.ptr) || `rings/${ringId}.md`,
    })
  }
  return index
}

/** 规范化冲突裁定；未知 resolution 一律记 open（待人工）。 */
function normalizeConflicts(incoming: unknown[]): Conflict[] {
  const resolutions = new Set(['kept-old', 'kept-new', 'merged', 'open'])
  const conflicts: Conflict[] = []
  for (const item of incoming) {
    const record = asRecord(item)
    const a = str(record?.a)
    const b = str(record?.b)
    if (!record || !a || !b) continue
    const resolution = str(record.resolution)
    conflicts.push({
      a,
      b,
      resolution: resolutions.has(resolution) ? (resolution as Conflict['resolution']) : 'open',
    })
  }
  return conflicts
}
