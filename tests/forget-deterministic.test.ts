/**
 * 确定性抽取器单测（退潮降级路径）。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { extractDeterministic } from '../src/forget/deterministic.ts'

const SAMPLE = [
  '2026-11-06 主人：我今天有点累，晚上想吃火锅。',
  '主人：一定要记得我的生日是 11 月 20 日，别忘了！',
  '我：好的',
  '主人：我的手机号是 13800001111，不要告诉别人。',
  '主人：我们在讨论《三体》里的黑暗森林。',
  '主人：下次要一起去看电影吗？',
].join('\n')

test('extractDeterministic：基本结构与 hash 可回溯', () => {
  const gist = extractDeterministic('a1', SAMPLE, 'a11')
  assert.equal(gist.shard, 'a1')
  assert.equal(gist.degraded, false)
  assert.equal(gist.hash, createHash('sha256').update(SAMPLE, 'utf8').digest('hex'))
  assert.ok(gist.events.length > 0)
  assert.ok(gist.index.length > 0)
  // 指针格式：archive/<YYYY-MM>/<日片>.md#L<行号>（与 store/archive 的月桶布局一致）
  for (const entry of gist.index) {
    assert.equal(entry.ring, 'a11')
    assert.equal(entry.shard, 'a1')
    assert.match(entry.ptr, /^archive\/\d{4}-\d{2}\/a1\.md#L\d+$/)
  }
})

test('extractDeterministic：隐私命中只留指针，正文不落摘要', () => {
  const gist = extractDeterministic('a1', SAMPLE, 'a11')
  const sensitive = gist.dropped.filter((item) => item.why === 'sensitive')
  assert.equal(sensitive.length, 1)
  assert.match(sensitive[0].ref, /^archive\/\d{4}-\d{2}\/a1\.md#L\d+$/)
  // 手机号不得出现在任何摘要字段里
  const serialized = JSON.stringify({ events: gist.events, facts: gist.facts, index: gist.index })
  assert.ok(!serialized.includes('13800001111'))
})

test('extractDeterministic：寒暄/重复进入 dropped', () => {
  const raw = '好的\n主人：今天去了公园。\n主人：今天去了公园。'
  const gist = extractDeterministic('a2', raw, 'a11')
  const reasons = gist.dropped.map((item) => item.why)
  assert.ok(reasons.includes('routine'))
  assert.ok(reasons.includes('duplicate'))
})

test('extractDeterministic：事实 / 实体 / 未完成事项', () => {
  const gist = extractDeterministic('a1', SAMPLE, 'a11')
  assert.ok(gist.facts.some((fact) => fact.key === '生日'))
  assert.ok(gist.entities.some((entity) => entity.name === '主人' && entity.type === 'person'))
  assert.ok(gist.entities.some((entity) => entity.name === '三体'))
  assert.ok(gist.openLoops.some((loop) => loop.includes('电影')))
  // 显式信号（生日/别忘了）应得到高 importance
  assert.ok(gist.index.some((entry) => entry.importance >= 8))
})

test('extractDeterministic：确定性（同输入同输出）与空输入', () => {
  assert.deepEqual(extractDeterministic('a1', SAMPLE, 'a11'), extractDeterministic('a1', SAMPLE, 'a11'))

  const empty = extractDeterministic('a3', '', 'a11')
  assert.deepEqual(empty.events, [])
  assert.deepEqual(empty.dropped, [])
  assert.equal(empty.hash, createHash('sha256').update('', 'utf8').digest('hex'))
})
