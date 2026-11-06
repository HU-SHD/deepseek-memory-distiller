/**
 * Token 估算与预算裁剪（纯逻辑，零运行时相对导入）。
 *
 * 这里刻意不引入任何 tokenizer 依赖：估算是为了**预算控制**而不是计费精确，
 * 只要方向一致、可复现即可。规则（与 ARCHITECTURE 的成本模型对齐）：
 * - 中日韩文字 / 全角标点：约 1 字 1 token；
 * - 其余字符（英文、数字、半角符号、空白）：约 4 字符 1 token；
 * - 按 Unicode 码点计数，避免把 emoji 的代理对拆开。
 *
 * 之所以保持「零运行时相对导入」，是为了让 `node --test tests/` 能直接加载本模块
 * （Node 原生 TS 类型擦除不解析扩展名省略的相对导入）。
 */

/** 判断一个码点是否属于 CJK / 全角字符（按 1 字 1 token 估算）。 */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本汉字
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
    (cp >= 0xff00 && cp <= 0xffef) || // 全角形式
    (cp >= 0x20000 && cp <= 0x2fa1f) // 扩展 B–F / 兼容补充
  )
}

/**
 * 估算一段文本的 token 数。
 * @param text 任意文本（可为空）。
 * @returns 估算 token 数，向上取整；空串返回 0。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (isCjk(cp)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * 把文本截断到不超过 `max` token；被截断时追加省略号 `…`。
 * 返回值保证 `estimateTokens(结果) <= max`（`max <= 0` 时返回空串）。
 *
 * @param text 原文
 * @param max  允许的最大 token 数
 */
export function truncateToTokens(text: string, max: number): string {
  if (!text) return ''
  if (max <= 0) return ''
  if (estimateTokens(text) <= max) return text
  // 给省略号预留 1 token
  const budget = Math.max(0, max - 1)
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length
  // 二分查找最长的、估算不超预算的前缀
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(chars.slice(0, mid).join('')) <= budget) lo = mid
    else hi = mid - 1
  }
  return chars.slice(0, lo).join('') + '…'
}

/**
 * 预算裁剪：按顺序保留条目，直到累计估算 token 超过 `maxTokens` 为止。
 * 用于退潮时把 events / facts / index 裁剪到输出预算内（超出的条目由调用方
 * 记入 `dropped`，理由 `over-budget`）。
 *
 * @param items     候选条目
 * @param maxTokens 预算上限
 * @param render    把条目渲染成文本（用于估算 token）
 * @returns 预算内保留的条目（保持原顺序）
 */
export function takeWithinBudget<T>(items: readonly T[], maxTokens: number, render: (item: T) => string): T[] {
  if (maxTokens <= 0) return []
  const kept: T[] = []
  let used = 0
  for (const item of items) {
    // +1 用于分隔符/结构开销
    const cost = estimateTokens(render(item)) + 1
    if (used + cost > maxTokens) break
    kept.push(item)
    used += cost
  }
  return kept
}
