/**
 * 退潮：遗忘官（F 模型）逐日片把原文压成 Gist。
 *
 * 铁律（违反即返工）：
 * - **绝不向调用方抛错**：模型不可用 / 输出坏 JSON → 内部降级为确定性抽取，
 *   并把 `degraded = true` 交给上层（汇报标黄，不阻断本轮）；
 * - 解析失败**重试一次**（换更严格的提示），仍失败才降级；
 * - 输入按预算截断（≤ 8k token/日），输出再做一次预算裁剪。
 */
import type { Gist, ModelTarget, RingId, ShardId } from '../types'
import type { MemoryPaths } from '../paths'
import type { ModelRouter } from '../model/router'
import type { ChatResult } from '../model/gateway'
import { targetsOf } from '../model/router'
import { extractJson } from '../model/json'
import { estimateTokens, takeWithinBudget, truncateToTokens } from '../util/tokens'
import { sha256 } from '../util/text'
import { ringIdFor } from '../ring/chain'
import { extractDeterministic } from './deterministic'

/** 单日原文的输入预算（ARCHITECTURE 第 2 节：≤ 8k tok/日，留 1k 给提示词）。 */
const MAX_RAW_TOKENS = 7_000

/** 归档月桶（UTC）：与 store/archive 的 monthBucket 一致，保证 ptr 能落到实际文件。 */
function monthBucketUtc(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 未绑定 target 的占位：createRouter 会把它替换成创建时绑定的 forget target。 */
const UNBOUND_TARGET: ModelTarget = {
  provider: '',
  model: '',
  temperature: 0.1,
  maxTokens: 900,
  timeoutMs: 60_000,
}

/** 遗忘官的系统提示词：冷酷、去情感、抗叙事美化。 */
const FORGET_SYSTEM = `你是「潮汐忆体」的遗忘官（Forgetting Officer）。
你的唯一职责：把一天的原始对话压成一份冷酷、去情感、可回溯的「遗骸」（Gist）。
你不需要讨好任何人，也不要保留叙事美感；你只负责决定什么值得留下、什么该被丢掉、以及每条东西的指针。

硬性规则：
1. 只输出一个 JSON 对象，不要 Markdown 围栏，不要解释，不要前后缀。
2. 字段与类型（缺省用空数组，不要省略键）：
{
  "events": [{"t": "时间标记或空串", "what": "发生了什么（≤120字）", "who": "谁（可选）", "weight": 0.0-1.0}],
  "facts": [{"key": "事实名", "value": "事实内容（≤80字）", "confidence": 0.0-1.0}],
  "entities": [{"name": "实体名", "type": "person|thing|place|concept", "salience": 0.0-1.0}],
  "dropped": [{"what": "被丢弃内容的简述", "why": "routine|duplicate|low-weight|sensitive|over-budget", "ref": "指针"}],
  "openLoops": ["未完成的事 / 待回答的问题"],
  "index": [{"topic": "主题（≤30字）", "keywords": ["关键词"], "importance": 0-10, "decay": 0.0-1.0, "ptr": "指针"}]
}
3. 隐私优先：密码、验证码、身份证、银行卡、住址等敏感信息不得写进 events/facts/index 的正文，只能进 dropped，why="sensitive"，正文用「敏感内容」代替。
4. importance 只由显式信号决定（"一定要记得"、生日、约定、承诺 → 8-10），不按情绪打分。
5. 指针格式固定为 archive/<YYYY-MM>/<日片>.md#L<行号>（用户消息里会给出本轮的 <YYYY-MM>；行号从 1 开始）。
6. 日常寒暄、重复内容、低信息量内容进 dropped，不要塞进 events。`

/** 解析失败后重试时追加的提示（只重试一次）。 */
const RETRY_HINT =
  '\n\n【重试】上一次输出不是合法 JSON。现在只输出一个 JSON 对象：不要 Markdown 围栏、不要解释、不要前后缀。'

/** 退潮依赖。 */
export interface ForgetDeps {
  router: ModelRouter
  paths: MemoryPaths
}

/** 由日片 id 反推周期字母：'a1' → 'a'。 */
function cycleOfShard(shard: ShardId): string {
  const match = /^([a-z]+)\d+$/.exec(shard)
  return match ? match[1] : 'a'
}

/** 构造遗忘官的 user 提示词。 */
function buildForgetPrompt(shard: ShardId, raw: string, bucket: string): string {
  const trimmed = truncateToTokens(raw, MAX_RAW_TOKENS)
  return `日片：${shard}
原文（已按预算截断，约 ${estimateTokens(trimmed)} token）：
<raw>
${trimmed}
</raw>

指针格式：archive/${bucket}/${shard}.md#L<行号>（行号从 1 开始）。
只输出 JSON。`
}

/**
 * 退潮主入口：把一个日片的原文压成 Gist。
 *
 * 失败时**不抛错**，而是返回 `degraded = true` 的确定性 Gist。
 *
 * @param deps  路由器 + 路径（+ 可选 target）
 * @param shard 日片 id（如 'a1'）
 * @param raw   当天原文
 */
export async function forgetShard(deps: ForgetDeps, shard: ShardId, raw: string): Promise<Gist> {
  const ring = ringIdFor(cycleOfShard(shard))
  const hash = sha256(raw)
  const bucket = monthBucketUtc()
  // 温度/输出上限来自配置解析后的 forget target（INTERFACES 的 ForgetDeps 不带 config，
  // 通过 router 的绑定关系取回；手工构造的 router 取不到时用规范默认值）
  const target = targetsOf(deps.router)?.forget ?? UNBOUND_TARGET
  const prompt = buildForgetPrompt(shard, raw, bucket)
  let lastError: unknown

  // 最多 2 次（首次 + 解析失败重试一次）
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: ChatResult
    try {
      result = await deps.router.forget.chat(target, {
        system: FORGET_SYSTEM,
        prompt: attempt === 0 ? prompt : `${prompt}${RETRY_HINT}`,
        temperature: target.temperature,
        maxTokens: target.maxTokens,
        timeoutMs: target.timeoutMs,
        purpose: 'memory-forget',
      })
    } catch (error) {
      // 模型不可用：直接降级，不再重试（避免拖长整轮）
      lastError = error
      break
    }
    try {
      const gist = normalizeGist(extractJson<unknown>(result.text), shard, ring, hash, bucket)
      return fitGistBudget(gist, target.maxTokens)
    } catch (error) {
      // 解析/结构不合法：记录后重试一次
      lastError = error
    }
  }

  // 降级：确定性抽取，标记 degraded，绝不抛错
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? '未知原因')
  console.warn(`[memory-distiller] 退潮降级（${shard}）：${message}`)
  return { ...extractDeterministic(shard, raw, ring), degraded: true }
}

/* ────────────────────────────── 输出规范化 ────────────────────────────── */

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

/**
 * 把模型给的指针归一化成本轮真实的归档路径：
 * `archive/<YYYY-MM>/<日片>.md#L<行号>`（只信任行号，路径由我们拼，避免模型编造路径）。
 */
function normalizePtr(raw: string, bucket: string, shard: ShardId, fallbackLine = 1): string {
  const line = /#L(\d+)/.exec(raw)?.[1] ?? String(fallbackLine)
  return `archive/${bucket}/${shard}.md#L${line}`
}

/** 校验并规范化 F 模型的 JSON 输出；结构完全不可用时抛错（由调用方重试/降级）。 */
function normalizeGist(payload: unknown, shard: ShardId, ring: RingId, hash: string, bucket: string): Gist {
  const record = asRecord(payload)
  if (!record) throw new Error('F 模型输出不是 JSON 对象')

  const events: Gist['events'] = []
  for (const item of asArray(record.events)) {
    const event = asRecord(item)
    const what = str(event?.what)
    if (!event || !what) continue
    events.push({
      t: str(event.t),
      what,
      ...(str(event.who) ? { who: str(event.who) } : {}),
      weight: num(event.weight, 0.5, 0, 1),
    })
  }

  const facts: Gist['facts'] = []
  for (const item of asArray(record.facts)) {
    const fact = asRecord(item)
    const key = str(fact?.key)
    const value = str(fact?.value)
    if (!fact || !key || !value) continue
    facts.push({ key, value, confidence: num(fact.confidence, 0.6, 0, 1) })
  }

  const entityTypes = new Set(['person', 'thing', 'place', 'concept'])
  const entities: Gist['entities'] = []
  for (const item of asArray(record.entities)) {
    const entity = asRecord(item)
    const name = str(entity?.name)
    if (!entity || !name) continue
    const type = str(entity.type)
    entities.push({
      name,
      type: entityTypes.has(type) ? (type as 'person' | 'thing' | 'place' | 'concept') : 'concept',
      salience: num(entity.salience, 0.5, 0, 1),
    })
  }

  const dropReasons = new Set(['routine', 'duplicate', 'low-weight', 'sensitive', 'over-budget'])
  const dropped: Gist['dropped'] = []
  for (const item of asArray(record.dropped)) {
    const entry = asRecord(item)
    const what = str(entry?.what)
    if (!entry || !what) continue
    const why = str(entry.why)
    dropped.push({
      what,
      why: dropReasons.has(why) ? (why as Gist['dropped'][number]['why']) : 'low-weight',
      ref: normalizePtr(str(entry.ref), bucket, shard),
    })
  }

  const openLoops = asArray(record.openLoops)
    .map((item) => str(item))
    .filter((item) => item.length > 0)

  const index: Gist['index'] = []
  for (const item of asArray(record.index)) {
    const entry = asRecord(item)
    const topic = str(entry?.topic)
    if (!entry || !topic) continue
    index.push({
      topic,
      keywords: asArray(entry.keywords)
        .map((keyword) => str(keyword))
        .filter((keyword) => keyword.length > 0),
      ring,
      shard,
      importance: num(entry.importance, 5, 0, 10),
      decay: num(entry.decay, 0.9, 0, 1),
      ptr: normalizePtr(str(entry.ptr), bucket, shard),
    })
  }

  return { shard, hash, events, facts, entities, dropped, openLoops, index, degraded: false }
}

/**
 * 输出预算裁剪：超出输出上限时，先裁 dropped（最不重要），再裁 events/facts/index。
 * 保证单日 Gist 不会把涨潮的输入撑爆。
 */
function fitGistBudget(gist: Gist, maxTokens: number): Gist {
  const budget = Math.max(200, maxTokens)
  const sizeOf = (value: unknown): number => estimateTokens(JSON.stringify(value))
  if (sizeOf(gist) <= budget) return gist

  // 1) 先裁 dropped（它们是"被丢弃项"的清单，信息密度最低）
  gist.dropped = takeWithinBudget(gist.dropped, Math.floor(budget * 0.15), (item) => JSON.stringify(item))
  if (sizeOf(gist) <= budget) return gist

  // 2) 再裁 events / facts / index / entities / openLoops
  gist.events = takeWithinBudget(gist.events, Math.floor(budget * 0.35), (item) => JSON.stringify(item))
  gist.facts = takeWithinBudget(gist.facts, Math.floor(budget * 0.2), (item) => JSON.stringify(item))
  gist.index = takeWithinBudget(gist.index, Math.floor(budget * 0.25), (item) => JSON.stringify(item))
  gist.entities = takeWithinBudget(gist.entities, Math.floor(budget * 0.1), (item) => JSON.stringify(item))
  gist.openLoops = takeWithinBudget(gist.openLoops, Math.floor(budget * 0.1), (item) => item)
  return gist
}
