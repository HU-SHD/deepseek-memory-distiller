/**
 * 双账本（jsonl 追加）。
 *
 * 账本是「遗忘可审计」的落点：每道年轮一行 rings.jsonl，每条被丢弃的内容一行
 * forget.jsonl，每次召回一行 recall.jsonl。追加写不追求原子（jsonl 天然按行切分，
 * 半行会被读取端跳过），但每行都是完整 JSON。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { LedgerRecord, RingLedgerRecord } from './types'
import type { MemoryPaths } from './paths'
import { sha256, stableStringify } from './util/text'

/** 账本文件按记录类型分文件。 */
const LEDGER_FILES = {
  ring: 'rings.jsonl',
  forget: 'forget.jsonl',
  recall: 'recall.jsonl',
} as const

/**
 * 账本头：把记录按顺序串成哈希链，返回最终哈希。
 * 用于汇报的审计锚点——任何一条历史记录被篡改，账本头都会变。
 *
 * @param records 账本记录（按时间顺序）
 * @returns 64 位十六进制哈希；空账本返回空串的 sha256
 */
export function ledgerHead(records: LedgerRecord[]): string {
  let head = ''
  for (const record of records) {
    head = sha256(`${head}\n${stableStringify(record)}`)
  }
  return head || sha256('')
}

/**
 * 追加一条账本记录到对应 jsonl 文件（自动建目录）。
 * @param paths  记忆路径集合
 * @param record 账本记录（kind 决定写入哪个文件）
 */
export async function appendLedger(paths: MemoryPaths, record: LedgerRecord): Promise<void> {
  const file = path.join(paths.ledgers, LEDGER_FILES[record.kind])
  await fs.mkdir(paths.ledgers, { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * 读取 rings.jsonl 中的全部年轮账本记录。
 * 文件缺失返回空数组；损坏行（半行/非 JSON/kind 不符）被跳过，不阻断读取。
 *
 * @param paths 记忆路径集合
 */
export async function readRingsLedger(paths: MemoryPaths): Promise<RingLedgerRecord[]> {
  const file = path.join(paths.ledgers, LEDGER_FILES.ring)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const records: RingLedgerRecord[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<RingLedgerRecord>
      if (parsed.kind === 'ring' && typeof parsed.ring === 'string') {
        records.push(parsed as RingLedgerRecord)
      }
    } catch {
      // 半行/损坏行：跳过（追加写中断的残留）
    }
  }
  return records
}
