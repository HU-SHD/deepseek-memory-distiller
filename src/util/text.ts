/**
 * 文本工具（纯逻辑，零运行时相对导入，可直接被 `node --test` 加载）。
 *
 * - `sha256`：遗骸指针 / 年轮 inputHash / 账本头的哈希基元；
 * - `normalizeText`：统一换行、去 BOM / 零宽字符、压缩空行；
 * - `bulletize`：把若干行渲染成 Markdown 列表（注入稿、报告用）；
 * - `stableStringify`：键排序的确定性 JSON 序列化（账本哈希用）。
 */
import { createHash } from 'node:crypto'

/** 计算 UTF-8 文本的 sha256（小写十六进制）。 */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 归一化文本：去 BOM、CRLF→LF、去零宽字符、去行尾空白、压缩连续空行、整体 trim。
 * 不改变语义，只让同一份内容在不同平台/复制粘贴下得到同一个 hash。
 */
export function normalizeText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 把若干行渲染成 Markdown 无序列表，最多 `max` 条；空行被忽略。
 * @param lines 原始行
 * @param max   最多保留条数（`<= 0` 返回空串）
 */
export function bulletize(lines: string[], max: number): string {
  if (max <= 0) return ''
  const kept = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, max)
  return kept.map((line) => `- ${line}`).join('\n')
}

/**
 * 确定性 JSON 序列化：对象键按字典序排序，数组保持原序，跳过 undefined。
 * 用于账本哈希——同一份记录无论对象字面量顺序如何都得到同一个哈希。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')
  return `{${body}}`
}
