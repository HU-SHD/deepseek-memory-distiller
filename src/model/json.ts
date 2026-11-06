/**
 * 模型输出 JSON 提取（纯逻辑，零运行时相对导入）。
 *
 * 双模型都要求「只输出一个 JSON 对象」，但现实中的模型会：包 ```json 围栏、
 * 前后加解释、输出尾随逗号、在 JSON 里写 `//` 注释。这里按「候选切片 → 解析 →
 * 一次修复」的顺序尽力提取；实在拿不到就抛 {@link JsonParseError}，由调用方决定
 * 重试（退潮）或不推进年轮（涨潮）。
 */

/** JSON 提取失败。`raw` 保留模型原始输出，便于账本/日志审计。 */
export class JsonParseError extends Error {
  /** 模型原始输出（未经裁剪）。 */
  raw: string

  constructor(message: string, raw: string) {
    super(message)
    this.name = 'JsonParseError'
    this.raw = raw
  }
}

/**
 * 从模型输出中提取并解析 JSON。
 *
 * 容忍：```json 围栏、前后废话、JSON 前后的说明文字、尾随逗号、JSON 内注释。
 * 失败时抛 {@link JsonParseError}（不抛原生 SyntaxError，方便调用方区分）。
 *
 * @typeParam T 期望的解析结果类型（调用方仍需自行校验结构）
 * @param text 模型原始输出
 */
export function extractJson<T>(text: string): T {
  const raw = text
  for (const candidate of collectCandidates(text)) {
    const parsed = tryParse<T>(candidate)
    if (parsed.ok) return parsed.value
  }
  throw new JsonParseError('模型输出中未找到可解析的 JSON', raw)
}

/** 依次产出候选 JSON 文本：围栏内容 → 平衡括号片段 → 整体文本。 */
function* collectCandidates(text: string): Generator<string> {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return

  // 1) Markdown 代码围栏：```json ... ``` / ``` ... ```
  const fence = /```(?:json|JSON|javascript|js)?\s*\n?([\s\S]*?)```/g
  for (const match of trimmed.matchAll(fence)) {
    const inner = match[1].trim()
    if (inner) yield inner
  }

  // 2) 平衡的 {...} / [...] 片段（跳过字符串内部的括号）
  yield* balancedSpans(trimmed)

  // 3) 整体文本（有些模型会直接输出裸 JSON）
  yield trimmed
}

/** 扫描文本中所有顶层平衡括号片段，最多尝试 24 个，避免病态输入放大开销。 */
function* balancedSpans(text: string): Generator<string> {
  let tried = 0
  for (let i = 0; i < text.length && tried < 24; i++) {
    const ch = text[i]
    if (ch !== '{' && ch !== '[') continue
    const end = matchBalanced(text, i)
    if (end !== undefined) {
      tried++
      yield text.slice(i, end + 1)
    }
  }
}

/**
 * 从 `start`（必须是 `{` 或 `[`）开始做括号配对，返回匹配的闭合下标。
 * 正确处理字符串与转义；括号不匹配时返回 undefined。
 */
function matchBalanced(text: string, start: number): number | undefined {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return undefined
      if (stack.length === 0) return i
    }
  }
  return undefined
}

/** 先原样解析，失败后对「修复版」再解析一次。 */
function tryParse<T>(candidate: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(candidate) as T }
  } catch {
    // 落到一次修复
  }
  try {
    return { ok: true, value: JSON.parse(repairJson(candidate)) as T }
  } catch {
    return { ok: false }
  }
}

/**
 * 一次修复：去 JSON 外的 `//`、`/* *\/` 注释，去对象/数组的尾随逗号。
 * 只做「不改变语义」的修复，不猜测引号或补全括号（猜错会制造错误数据）。
 */
function repairJson(text: string): string {
  return stripTrailingCommas(stripComments(text))
}

/** 去掉字符串外的 `//` 行注释与 `/* ... *\/` 块注释（替换成空白，保持换行）。 */
function stripComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++ // 跳过结尾的 '/'
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

/** 去掉字符串外的尾随逗号（`,}` / `,]` → `}` / `]`）。 */
function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue // 丢弃尾随逗号
    }
    out += ch
  }
  return out
}
