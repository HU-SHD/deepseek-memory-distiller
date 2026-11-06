/**
 * 确定性抽取器（退潮降级路径）。
 *
 * F 模型不可用或输出无法解析时，用正则 + 规则把一天原文压成最小可用的 Gist。
 * 它不追求"好"，只追求三件事：**不抛错、结构完整、指针可回溯**。
 *
 * 本模块是「零运行时相对导入」的纯逻辑模块（只依赖 `node:crypto` 与类型），
 * 因此可被 `node --test tests/` 直接加载。
 */
import { createHash } from 'node:crypto'
import type { DroppedItem, Gist, IndexEntry, RingId, ShardId } from '../types'

/** 敏感信息：只留指针，正文不得进入摘要（隐私命中 → why='sensitive'）。 */
const SENSITIVE_PATTERN =
  /(密码|口令|身份证|银行卡|信用卡|手机号|电话号码|家庭住址|住址|api[_-]?key|access[_-]?token|secret|私钥|验证码)/iu
/** 寒暄 / 确认 / 语气词：属于日常琐事，直接丢弃。 */
const ROUTINE_PATTERN =
  /^(你好|您好|在吗|在么|早|早安|午安|晚安|好的|好滴|嗯+|哦+|噢+|哈+|呵呵|谢谢|多谢|拜拜|再见|收到|ok|okay|行|对|是的)[。！!~～…\s]*$/iu
/** 行首时间标记：`2026-11-06`、`23:10`、`昨天`、`晚上`。 */
const TIME_PATTERN =
  /^((?:\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)|(?:\d{1,2}[:：]\d{2})|(?:昨天|今天|前天|明天|上午|下午|晚上|早上|中午|凌晨))/u
/** 说话人：`主人：……`、`user: ……`。 */
const SPEAKER_PATTERN = /^([\u4e00-\u9fa5A-Za-z0-9_]{1,12})[:：]\s*/u
/** 引号/书名号里的专名：《三体》、「大肥鱼」。 */
const QUOTED_PATTERN = /[《「“"]([^》」”"\n]{1,24})[》」”"]/gu
/** 邮箱 / URL 之类可当作实体。 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu
/** 事实线索词。 */
const FACT_HINTS = [
  '生日', '电话', '手机', '地址', '邮箱', '名字', '住在', '喜欢', '讨厌',
  '工作', '学校', '公司', '宠物', '年龄', '忌口', '过敏', '约定', '承诺',
]
/** 显式重要性信号（"一定要记得"、生日、约定……）。 */
const IMPORTANCE_HIGH = /(一定要|必须|绝对|记住|别忘了|不要忘|重要|生日|约定|承诺|发誓)/u
/** 未完成的事 / 待回答的问题。 */
const OPEN_LOOP_PATTERN = /(？|\?|待办|TODO|todo|下次|回头|还没|要不要|怎么办|问题)/u
/** 关键词提取时过滤的虚词。 */
const STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '就是', '什么', '可以', '没有',
  '一个', '然后', '因为', '所以', '但是', '如果', '现在', '今天', '昨天', '明天',
  '还是', '已经', '自己', '感觉', '觉得', '真的', '应该', '可能', '知道',
])

/** 各字段的硬上限：降级路径也不能把输出撑爆。 */
const MAX_EVENTS = 24
const MAX_FACTS = 16
const MAX_ENTITIES = 16
const MAX_INDEX = 12
const MAX_OPEN_LOOPS = 6
const MAX_DROPPED = 60

/** 本地 sha256（保持零运行时相对导入）。 */
function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 本地归一化（与 util/text.normalizeText 行为一致）。 */
function normalize(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 截断到 `max` 字符（超出时以省略号收尾）。 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * 归档月桶（UTC，`YYYY-MM`）。
 * 必须与 `store/archive.ts` 的 `monthBucket()` 保持一致——指针要能落到实际归档路径
 * `archive/<YYYY-MM>/<日片>.md`。退潮与归档在同一轮 runCycle 内完成，月份一致。
 */
function monthBucketUtc(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 遗骸指针：指向 archive 中该日片的对应行（与 store/archive 的月桶布局一致）。 */
function linePtr(shard: ShardId, lineNo: number): string {
  return `archive/${monthBucketUtc()}/${shard}.md#L${lineNo}`
}

/** 从行首提取时间标记；没有则返回 undefined。 */
function timeOf(line: string): string | undefined {
  const match = TIME_PATTERN.exec(line)
  return match ? match[1] : undefined
}

/** 提取说话人；返回名字与原始前缀长度（用于切掉前缀）。 */
function speakerOf(line: string): { name: string; length: number } | undefined {
  const match = SPEAKER_PATTERN.exec(line)
  if (!match) return undefined
  const name = match[1]
  // 把 `http://` 之类的协议头误判成说话人的情况排除
  if (name.includes('http') || /^\d+$/.test(name)) return undefined
  return { name, length: match[0].length }
}

/** 按显式信号给 0–10 的重要性打分（不按"情绪"）。 */
function importanceOf(line: string): number {
  if (IMPORTANCE_HIGH.test(line)) return 9
  if (FACT_HINTS.some((hint) => line.includes(hint))) return 7
  if (OPEN_LOOP_PATTERN.test(line)) return 6
  return 4
}

/** 提取关键词：中文 2–4 字词组 + 英文单词，去虚词、去重，最多 6 个。 */
function keywordsOf(line: string): string[] {
  const found = line.match(/[\u4e00-\u9fa5]{2,4}|[A-Za-z][A-Za-z0-9_-]{1,}/gu) ?? []
  const keywords: string[] = []
  for (const word of found) {
    if (STOPWORDS.has(word)) continue
    if (!keywords.includes(word)) keywords.push(word)
    if (keywords.length >= 6) break
  }
  return keywords
}

/** 猜测实体类型：地名 / 事物 / 概念（人物由说话人单独补）。 */
function guessEntityType(name: string): 'person' | 'thing' | 'place' | 'concept' {
  if (/(市|省|县|区|路|街|号|楼|镇|村)$/u.test(name)) return 'place'
  if (/(公司|集团|大学|学院|App|APP|app|系统|模型|项目)$/u.test(name)) return 'thing'
  return 'concept'
}

/**
 * 从一天原文中确定性抽取 Gist。
 *
 * @param shard 日片 id（如 'a1'），用于指针与索引
 * @param raw   当天原文
 * @param ring  该日片将汇入的年轮 id（如 'a11'），写入 index.ring
 */
export function extractDeterministic(shard: ShardId, raw: string, ring: RingId): Gist {
  const normalized = normalize(raw)
  const hash = hashText(raw)
  const lines = normalized.split('\n')

  const events: Gist['events'] = []
  const facts: Gist['facts'] = []
  const entities: Gist['entities'] = []
  const dropped: DroppedItem[] = []
  const openLoops: string[] = []
  const index: IndexEntry[] = []

  const seenLines = new Set<string>()
  const seenEntities = new Set<string>()

  const addEntity = (name: string, type: 'person' | 'thing' | 'place' | 'concept', salience: number): void => {
    const key = `${type}:${name}`
    if (seenEntities.has(key) || entities.length >= MAX_ENTITIES) return
    seenEntities.add(key)
    entities.push({ name, type, salience: Math.min(1, Math.max(0, salience)) })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const lineNo = i + 1
    const ptr = linePtr(shard, lineNo)

    // 1) 隐私命中：只留指针，正文不进任何摘要
    if (SENSITIVE_PATTERN.test(line)) {
      dropped.push({ what: '敏感内容（正文不落摘要，仅保留指针）', why: 'sensitive', ref: ptr })
      continue
    }

    // 2) 重复行：留指针即可
    const dedupeKey = line.replace(/\s+/gu, ' ')
    if (seenLines.has(dedupeKey)) {
      dropped.push({ what: clip(line, 40), why: 'duplicate', ref: ptr })
      continue
    }
    seenLines.add(dedupeKey)

    // 3) 寒暄/确认：日常琐事
    if (ROUTINE_PATTERN.test(line) || line.length <= 2) {
      dropped.push({ what: clip(line, 40), why: 'routine', ref: ptr })
      continue
    }

    const speaker = speakerOf(line)
    const body = speaker ? line.slice(speaker.length).trim() : line
    if (!body) continue

    const importance = importanceOf(body)

    // 事件
    if (events.length < MAX_EVENTS) {
      events.push({
        t: timeOf(body) ?? timeOf(line) ?? '',
        what: clip(body, 160),
        who: speaker?.name,
        weight: Number((importance / 10).toFixed(2)),
      })
    } else {
      dropped.push({ what: clip(body, 40), why: 'over-budget', ref: ptr })
    }

    // 事实
    const hint = FACT_HINTS.find((item) => body.includes(item))
    if (hint) {
      if (facts.length < MAX_FACTS) {
        facts.push({ key: hint, value: clip(body, 120), confidence: 0.6 })
      } else {
        dropped.push({ what: clip(body, 40), why: 'over-budget', ref: ptr })
      }
    }

    // 实体：说话人 + 引号专名 + 邮箱
    if (speaker) addEntity(speaker.name, 'person', 0.8)
    for (const match of body.matchAll(QUOTED_PATTERN)) {
      addEntity(match[1].trim(), guessEntityType(match[1].trim()), 0.6)
    }
    for (const match of body.matchAll(EMAIL_PATTERN)) {
      addEntity(match[0], 'thing', 0.5)
    }

    // 索引（潜意识线索）
    if (index.length < MAX_INDEX) {
      index.push({
        topic: clip(body, 32),
        keywords: keywordsOf(body),
        ring,
        shard,
        importance,
        decay: 0.9,
        ptr,
      })
    }

    // 未完成的事
    if (OPEN_LOOP_PATTERN.test(body) && openLoops.length < MAX_OPEN_LOOPS) {
      openLoops.push(clip(body, 100))
    }
  }

  return {
    shard,
    hash,
    events,
    facts,
    entities,
    dropped: dropped.slice(0, MAX_DROPPED),
    openLoops,
    index,
    degraded: false,
  }
}
