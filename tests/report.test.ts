/**
 * 汇报渲染测试：12 节齐全、顺序固定、关键字段齐全（纯逻辑，无外部依赖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { REPORT_SECTIONS, buildCycleReport, renderReport } from '../src/report/template.ts'
import type { CycleReport, Gist, MemoryHealth, Ring } from '../src/types.ts'

function makeRing(): Ring {
  return {
    id: 'a11',
    cycle: 'a',
    inputs: { shards: ['a1', 'a2', 'a3'], inputHash: 'hash-abc' },
    narrative: '这三天主人和我聊了潮汐忆体的设计，还约定要记得他的生日。',
    memoryMd: '主人喜欢深夜写代码。重要的约定：生日 3 月 14 日。',
    index: [
      { topic: '生日约定', keywords: ['生日', '约定'], ring: 'a11', importance: 10, decay: 1, ptr: 'archive/2026-11/a1.md#L12' },
    ],
    commitments: [
      { id: 'c1', text: '记住生日 3 月 14 日', createdAt: '2026-11-01T00:00:00.000Z', sourceShard: 'a1' },
    ],
    conflicts: [
      { a: '旧说法', b: '新说法', resolution: 'kept-new' },
      { a: '未定', b: '未定', resolution: 'open' },
    ],
    stats: { inTokens: 3000, outTokens: 450, compression: 6.67 },
    createdAt: '2026-11-03T23:00:00.000Z',
  }
}

function makeGists(): Gist[] {
  return [
    {
      shard: 'a1',
      hash: 'h1',
      events: [],
      facts: [],
      entities: [],
      dropped: [
        { what: '日常闲聊', why: 'routine', ref: 'archive/2026-11/a1.md#L3' },
        { what: '重复内容', why: 'duplicate', ref: 'archive/2026-11/a1.md#L8' },
      ],
      openLoops: [],
      index: [],
      degraded: true,
    },
    {
      shard: 'a2',
      hash: 'h2',
      events: [],
      facts: [],
      entities: [],
      dropped: [{ what: '日常闲聊', why: 'routine', ref: 'archive/2026-11/a2.md#L5' }],
      openLoops: [],
      index: [],
      degraded: false,
    },
  ]
}

function makeHealth(): MemoryHealth {
  return {
    traceability: 0.995,
    commitmentIntegrity: 1,
    drift: 0.5,
    orphanPointers: 2,
    retrievalHit: 0.9,
    verdict: 'watch',
  }
}

function makeReport(): CycleReport {
  return buildCycleReport({
    ring: makeRing(),
    gists: makeGists(),
    models: { forget: 'deepseek/deepseek-v4-flash', memory: 'deepseek/deepseek-v4', decoupled: false },
    health: makeHealth(),
    chain: [
      { id: 'a11', inputs: '∅ ← a1+a2+a3', sizeBytes: 4096 },
    ],
    cost: { forgetTokens: 9000, memoryTokens: 3450, estimatedCny: 0.0123, savedPct: 0.62 },
    ledgerHead: 'head-a11-abc123',
    version: '2.0.0',
  })
}

test('renderReport 恰好渲染 12 节，标题顺序冻结', () => {
  const markdown = renderReport(makeReport())
  const headings = markdown.split('\n').filter((line) => /^## \d+\./.test(line))
  assert.equal(headings.length, 12)
  assert.deepEqual(headings, [...REPORT_SECTIONS])
})

test('renderReport 包含全部关键字段', () => {
  const report = makeReport()
  const markdown = renderReport(report)

  // 1 摘要 / 2 身份 / 3 退潮 / 4 涨潮
  assert.ok(markdown.includes(report.summary))
  assert.ok(markdown.includes('a11'))
  assert.ok(markdown.includes('deepseek/deepseek-v4-flash'))
  assert.ok(markdown.includes('deepseek/deepseek-v4'))
  assert.ok(markdown.includes('未显式解耦') || markdown.includes('回退耦合'))
  assert.ok(markdown.includes('routine: 2'))
  assert.ok(markdown.includes('duplicate: 1'))
  assert.ok(markdown.includes('degraded'))
  assert.ok(markdown.includes('3000'))
  assert.ok(markdown.includes('450'))
  // 5 年轮链表格
  assert.ok(markdown.includes('| 年轮 | 输入 | 大小 |'))
  assert.ok(markdown.includes('∅ ← a1+a2+a3'))
  assert.ok(markdown.includes('4.0 KB'))
  // 6 健康度全字段与三道保护
  for (const field of ['99.5%', '100.0%', '50.0%', '90.0%', 'watch']) assert.ok(markdown.includes(field), field)
  assert.ok(markdown.includes('承诺完整率'))
  assert.ok(markdown.includes('可回溯率'))
  assert.ok(markdown.includes('孤儿指针'))
  // 7 成本
  assert.ok(markdown.includes('0.0123'))
  assert.ok(markdown.includes('62.0%'))
  assert.ok(markdown.includes('估算'))
  // 8 风险（degraded + 未解耦 + 孤儿指针 + 漂移）
  assert.ok(markdown.includes('确定性降级'))
  assert.ok(markdown.includes('未显式解耦'))
  // 9 可回溯性与恢复路径
  assert.ok(markdown.includes('head-a11-abc123'))
  assert.ok(markdown.includes('rings/LATEST'))
  // 10 下轮计划
  assert.ok(markdown.includes('下一轮前检查 F 模型'))
  // 11 配置快照（无密钥）
  assert.ok(markdown.includes('配置快照') || markdown.includes('模型 target'))
  // 12 附录
  assert.ok(markdown.includes('年轮链条数'))
})

test('buildCycleReport 聚合丢弃原因、降级与风险', () => {
  const report = makeReport()
  assert.equal(report.ring, 'a11')
  assert.equal(report.cycle, 'a')
  assert.equal(report.forget.shards, 2)
  assert.equal(report.forget.dropped, 3)
  assert.deepEqual(report.forget.dropsByReason, { routine: 2, duplicate: 1 })
  assert.equal(report.forget.degraded, true)
  assert.equal(report.remember.commitments, 1)
  assert.equal(report.remember.conflicts, 2)
  assert.ok(report.remember.narrativeChars > 0)
  assert.ok(report.risks.some((risk) => risk.includes('确定性降级')))
  assert.ok(report.risks.some((risk) => risk.includes('孤儿指针')))
  assert.ok(report.risks.some((risk) => risk.includes('解耦')))
  assert.ok(report.next.length > 0)
  assert.equal(report.ledgerHead, 'head-a11-abc123')
  assert.equal(report.version, '2.0.0')
})

test('renderReport 空 risks / 空 chain 时给出占位而不掉节', () => {
  const base = makeReport()
  const report: CycleReport = {
    ...base,
    risks: [],
    chain: [],
    health: { traceability: 1, commitmentIntegrity: 1, drift: 0, orphanPointers: 0, retrievalHit: 1, verdict: 'healthy' },
  }
  const markdown = renderReport(report)
  const headings = markdown.split('\n').filter((line) => /^## \d+\./.test(line))
  assert.equal(headings.length, 12)
  assert.ok(markdown.includes('本轮无新增风险'))
  assert.ok(markdown.includes('（尚无年轮）'))
  assert.ok(markdown.includes('healthy'))
})
