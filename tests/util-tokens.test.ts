/**
 * Token 估算与预算裁剪单测。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, takeWithinBudget, truncateToTokens } from '../src/util/tokens.ts'

test('estimateTokens：中文 1 字 1 token，英文约 4 字符 1 token', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('hello world'), 3) // 11 字符 / 4 → 向上取整 3
  assert.equal(estimateTokens('你好hello'), 4) // 2 中文 + ceil(5/4)
  assert.ok(estimateTokens('你好，世界！') >= 6) // 全角标点也按 1 token
})

test('truncateToTokens：截断后不超预算，且带省略号', () => {
  const text = '这是一段很长的中文文本，用来测试按 token 预算截断是否严格生效。'.repeat(10)
  const max = 40
  const truncated = truncateToTokens(text, max)
  assert.ok(estimateTokens(truncated) <= max)
  assert.ok(truncated.endsWith('…'))
  assert.ok(truncated.length < text.length)

  // 预算内原样返回
  assert.equal(truncateToTokens('短文本', 100), '短文本')
  // 边界：0 预算返回空串
  assert.equal(truncateToTokens(text, 0), '')
})

test('truncateToTokens：极小预算也严格生效', () => {
  const text = 'abcdefghij'.repeat(20)
  for (const max of [1, 2, 3, 5, 10]) {
    assert.ok(estimateTokens(truncateToTokens(text, max)) <= max, `max=${max} 时超预算`)
  }
})

test('takeWithinBudget：按顺序保留条目直到预算用尽（预算裁剪）', () => {
  const items = ['aaaa', 'bbbb', 'cccc', 'dddd']
  // 每条 'aaaa' = ceil(4/4)=1 token，+1 结构开销 = 2；预算 4 只留 2 条
  assert.deepEqual(takeWithinBudget(items, 4, (item) => item), ['aaaa', 'bbbb'])
  assert.deepEqual(takeWithinBudget(items, 100, (item) => item), items)
  assert.deepEqual(takeWithinBudget(items, 0, (item) => item), [])
})

test('takeWithinBudget：按渲染文本估算（对象条目）', () => {
  const items = [{ text: '短' }, { text: '长'.repeat(400) }, { text: '短' }]
  const kept = takeWithinBudget(items, 30, (item) => JSON.stringify(item))
  assert.equal(kept.length, 1)
  assert.equal(kept[0].text, '短')
})
