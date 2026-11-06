/**
 * 注入预算测试：五段齐全、总预算截断、承诺条数上限、空数据不炸。
 * 纯逻辑（inject.ts 顶层只有 node 内置依赖），可直接用 node --test 跑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMemoryPrompt,
  estimateBudgetTokens,
  truncateBudgetTokens,
} from '../src/inject.ts'
import type { Config } from '../src/types.ts'
import type { DistilledData } from '../src/store/distilled.ts'

function makeConfig(memoryTokens = 1200, indexEntries = 15, commitments = 20): Config {
  return {
    memoryRoot: './data/memory',
    windowDays: 3,
    forget: { provider: 'ollama', model: 'qwen2.5:3b', temperature: 0.1, maxTokens: 900, timeoutMs: 60000 },
    memory: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.35, maxTokens: 2500, timeoutMs: 120000 },
    embedding: { provider: 'deepseek', model: 'text-embedding-3-small', threshold: 0.6 },
    injection: { memoryTokens, indexEntries, commitments },
    protection: { commitmentsLock: true, identityAnchor: true, archiveRetentionDays: 0 },
    report: { enabled: true, outputDir: './data/memory/reports' },
    migration: { auto: true },
    debug: false,
  }
}

const LABELS = ['【你是谁】', '【不可遗忘的约定】', '【核心记忆】', '【潜意识索引】', '【检索准则】']

function makeDistilled(): DistilledData {
  return {
    memory: '记忆头{{user}}' + '乙'.repeat(3000) + '记忆尾部标记',
    identity: '身份头' + '甲'.repeat(400) + '身份尾部标记',
    index: Array.from({ length: 40 }, (_, i) => ({
      topic: `索引主题${i}`,
      keywords: ['关键词A', '关键词B'],
      ring: 'a11',
      importance: (i % 10) + 1,
      decay: 1,
      ptr: `archive/2026-11/a1.md#L${i + 1}`,
    })),
    commitments: Array.from({ length: 30 }, (_, i) => ({
      id: `c${i + 1}`,
      text: `承诺${i + 1}`,
      createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      sourceShard: 'a1',
    })),
  }
}

test('estimateBudgetTokens：中文 1 字 1 token，英文 4 字符 1 token', () => {
  assert.equal(estimateBudgetTokens(''), 0)
  assert.equal(estimateBudgetTokens('潮汐忆体'), 4)
  assert.equal(estimateBudgetTokens('abcd'), 1)
  assert.equal(estimateBudgetTokens('abcdefgh'), 2)
})

test('truncateBudgetTokens：结果估算 ≤ max 且带省略号', () => {
  const text = '甲乙丙丁'.repeat(100)
  const truncated = truncateBudgetTokens(text, 50)
  assert.ok(estimateBudgetTokens(truncated) <= 50)
  assert.ok(truncated.endsWith('…'))
  assert.equal(truncateBudgetTokens('短文本', 100), '短文本')
  assert.equal(truncateBudgetTokens('任意文本', 0), '…')
})

test('buildMemoryPrompt：五段齐全，总预算 ≤ memoryTokens', () => {
  const config = makeConfig(1200)
  const prompt = buildMemoryPrompt(makeDistilled(), config)

  for (const label of LABELS) assert.ok(prompt.includes(label), label)
  assert.ok(estimateBudgetTokens(prompt) <= 1200, `tokens=${estimateBudgetTokens(prompt)}`)

  // 记忆侧被截断（3000 字 → memoryCap 以内）
  assert.ok(prompt.includes('…'))
  assert.ok(!prompt.includes('记忆尾部标记'))

  // 身份锚截断到 ≤120 token 附近
  assert.ok(!prompt.includes('身份尾部标记'))

  // 花括号被消毒，不会触发 DSH 插值
  assert.ok(!prompt.includes('{{'))
  assert.ok(prompt.includes('｛｛'))

  // 承诺锁条数上限 20：最新 20 条（承诺 11..30），更老的 10 条被裁掉
  assert.ok(prompt.includes('承诺11'))
  assert.ok(prompt.includes('承诺30'))
  assert.ok(!prompt.includes('承诺10'))
})

test('buildMemoryPrompt：小预算（300）时仍保留五段标签且不超预算', () => {
  const config = makeConfig(300, 5, 3)
  const prompt = buildMemoryPrompt(makeDistilled(), config)
  for (const label of LABELS) assert.ok(prompt.includes(label), label)
  assert.ok(estimateBudgetTokens(prompt) <= 300, `tokens=${estimateBudgetTokens(prompt)}`)
})

test('buildMemoryPrompt：空数据时只输出标签与检索准则，不抛错', () => {
  const prompt = buildMemoryPrompt({ memory: '', index: [], commitments: [], identity: '' }, makeConfig(1200))
  for (const label of LABELS) assert.ok(prompt.includes(label), label)
  assert.ok(prompt.includes('recall_memory'))
  assert.ok(estimateBudgetTokens(prompt) <= 1200)
})

test('buildMemoryPrompt：索引条数上限生效', () => {
  const config = makeConfig(1200, 3, 20)
  const prompt = buildMemoryPrompt(makeDistilled(), config)
  const indexLines = prompt.split('\n').filter((line) => line.startsWith('- 索引主题'))
  assert.equal(indexLines.length, 3)
})
