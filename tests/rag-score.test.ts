/**
 * 检索打分测试：ARCHITECTURE §8 的数值公式 + 召回加固上限。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_REINFORCE,
  SCORE_WEIGHTS,
  clamp,
  clamp01,
  combineScore,
  cosineSimilarity,
  extractKeywords,
  keywordOverlapScore,
  lexicalSimilarity,
  passesThreshold,
  recencyWeight,
  reinforceImportance,
  tokenize,
} from '../src/retrieve/score.ts'

test('权重符合 ARCHITECTURE §8', () => {
  assert.equal(SCORE_WEIGHTS.semantic, 0.45)
  assert.equal(SCORE_WEIGHTS.keyword, 0.25)
  assert.equal(SCORE_WEIGHTS.importance, 0.2)
  assert.equal(SCORE_WEIGHTS.decay, 0.1)
  assert.ok(Math.abs(SCORE_WEIGHTS.semantic + SCORE_WEIGHTS.keyword + SCORE_WEIGHTS.importance + SCORE_WEIGHTS.decay - 1) < 1e-12)
})

test('combineScore 数值：满分 = 1，半重要度半衰减 = 0.15', () => {
  assert.equal(combineScore({ semantic: 1, keyword: 1, importance: 10, decay: 1 }), 1)
  assert.equal(combineScore({ semantic: 0, keyword: 0, importance: 0, decay: 0 }), 0)
  assert.equal(combineScore({ semantic: 0, keyword: 0, importance: 5, decay: 0.5 }), 0.15)
  // 越界值先归一化：importance 20 视作 10，semantic -1 视作 0。
  assert.equal(combineScore({ semantic: -1, keyword: 0, importance: 20, decay: 0 }), 0.2)
})

test('clamp / clamp01', () => {
  assert.equal(clamp(5, 0, 3), 3)
  assert.equal(clamp(-1, 0, 3), 0)
  assert.equal(clamp(Number.NaN, 2, 3), 2)
  assert.equal(clamp01(2), 1)
  assert.equal(clamp01(-2), 0)
})

test('召回加固：命中次数提升 importance，最多 +2、封顶 10', () => {
  assert.equal(MAX_REINFORCE, 2)
  assert.equal(reinforceImportance(5, 0), 5)
  assert.equal(reinforceImportance(5, 1), 6)
  assert.equal(reinforceImportance(5, 3), 7)
  assert.equal(reinforceImportance(5, 100), 7)
  assert.equal(reinforceImportance(9, 5), 10)
  assert.equal(reinforceImportance(10, 5), 10)
})

test('tokenize：中文 bigram + 英文词，去重', () => {
  const tokens = tokenize('主人的生日，Happy Birthday 生日快乐')
  assert.ok(tokens.includes('主人'))
  assert.ok(tokens.includes('生日'))
  assert.ok(tokens.includes('happy'))
  assert.ok(tokens.includes('birthday'))
  assert.equal(new Set(tokens).size, tokens.length)
  assert.deepEqual(tokenize(''), [])
})

test('keywordOverlapScore：覆盖率 = 命中 / query 数', () => {
  assert.equal(keywordOverlapScore(['生日', '约定'], ['生日', '约定', '其他']), 1)
  assert.equal(keywordOverlapScore(['生日', '约定'], ['生日']), 0.5)
  assert.equal(keywordOverlapScore([], ['生日']), 0)
  assert.equal(keywordOverlapScore(['生日'], []), 0)
})

test('lexicalSimilarity / extractKeywords', () => {
  assert.ok(lexicalSimilarity('生日 约定', '生日 约定 那天的蛋糕') > 0.9)
  assert.equal(lexicalSimilarity('完全无关', '生日 约定'), 0)
  const keywords = extractKeywords('潮汐忆体的年轮链与承诺锁', 5)
  assert.ok(keywords.length <= 5)
  assert.ok(keywords.every((keyword) => keyword.length >= 1))
})

test('cosineSimilarity：同向 1、正交 0、零向量 0', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0)
})

test('recencyWeight：最新 1，最老 0.5', () => {
  assert.equal(recencyWeight(0, 5), 1)
  assert.equal(recencyWeight(4, 5), 0.5)
  assert.equal(recencyWeight(2, 5), 0.75)
  assert.equal(recencyWeight(0, 1), 1)
})

test('passesThreshold：无 embedding 走关键词门槛，有 embedding 走语义门槛', () => {
  assert.equal(passesThreshold({ keyword: 0.2, threshold: 0.6, embeddingUsed: false }), true)
  assert.equal(passesThreshold({ keyword: 0.1, threshold: 0.6, embeddingUsed: false }), false)
  // 语义门槛 = threshold × 0.9 = 0.54
  assert.equal(passesThreshold({ keyword: 0, semantic: 0.54, threshold: 0.6, embeddingUsed: true }), true)
  assert.equal(passesThreshold({ keyword: 0, semantic: 0.53, threshold: 0.6, embeddingUsed: true }), false)
  assert.equal(passesThreshold({ keyword: 0.25, semantic: 0, threshold: 0.6, embeddingUsed: true }), true)
})
