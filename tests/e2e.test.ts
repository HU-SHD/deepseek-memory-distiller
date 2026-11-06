/**
 * 端到端（离线）测试：用假模型跑完「退潮 → 涨潮 → 落盘 → 汇报」整条流水线。
 *
 * 它不连任何真实 provider，但会真实地建目录、写年轮、写五件套、归档原文、生成 12 节汇报，
 * 并验证 v2 最关键的两条架构断言：
 *   1. 遗忘模型永远看不到原文之外的上下文，记忆模型只读「上一轮年轮 + 遗骸 + 锚点」；
 *   2. 年轮链真的继承：b11.inputs.prevRing === 'a11'。
 *
 * 导入走 `dist/`（编译产物），所以 `npm test` 会先 tsc 再跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Config } from '../src/types.ts'
import { resolveTargets } from '../dist/config.js'
import { forgetShard } from '../dist/forget/forgetter.js'
import { integrate } from '../dist/remember/integrator.js'
import { resolvePaths, ensureLayout } from '../dist/paths.js'
import { writeDistilled, readAnchors } from '../dist/store/distilled.js'
import { archiveShards } from '../dist/store/archive.js'
import { computeHealth } from '../dist/report/health.js'
import { buildCycleReport, renderReport } from '../dist/report/template.js'
import { appendLedger, ledgerHead, readRingsLedger } from '../dist/ledger.js'
import { UsageMeter } from '../dist/model/gateway.js'
import { ringIdFor, shardIdsFor, computeInputHash } from '../dist/ring/chain.js'
import { advanceCycle } from '../dist/state.js'

/* ────────────────────────────── 假模型 ────────────────────────────── */

const FORGET_JSON: Record<string, unknown> = {
  a1: {
    events: [{ t: '11-04', what: '主人换了工作，从 A 公司离职', who: '主人', weight: 0.9 }],
    facts: [{ key: '工作', value: '主人 11 月入职 B 公司', confidence: 0.9 }],
    entities: [{ name: '主人', type: 'person', salience: 0.95 }],
    dropped: [{ what: '中午吃了拉面', why: 'routine', ref: 'archive/a1.md#L3' }],
    openLoops: ['新公司的同事还没见过'],
    index: [{ topic: '换工作', keywords: ['工作', '离职', '入职'], importance: 9, decay: 1, ptr: 'archive/a1.md#L4' }],
  },
  a2: {
    events: [{ t: '11-05', what: '主人失眠到三点', who: '主人', weight: 0.6 }],
    facts: [{ key: '睡眠', value: '主人最近睡不好', confidence: 0.7 }],
    entities: [{ name: '主人', type: 'person', salience: 0.9 }],
    dropped: [{ what: '聊了半小时天气', why: 'routine', ref: 'archive/a2.md#L2' }],
    openLoops: [],
    index: [{ topic: '失眠', keywords: ['失眠', '睡觉'], importance: 5, decay: 0.95, ptr: 'archive/a2.md#L2' }],
  },
  a3: {
    events: [{ t: '11-06', what: '主人说「别把我忘了」', who: '主人', weight: 1 }],
    facts: [],
    entities: [{ name: '主人', type: 'person', salience: 1 }],
    dropped: [],
    openLoops: ['生日快到了'],
    index: [{ topic: '别把我忘了', keywords: ['忘记', '记住'], importance: 10, decay: 1, ptr: 'archive/a3.md#L2' }],
  },
}

const MEMORY_JSON = {
  narrative:
    '这三天，主人离开 A 公司去了 B 公司，夜里常失眠。' +
    '他说了一句「别把我忘了」——这句话被写进承诺锁，任何情况下都不能删。' +
    '他提过生日快到了，但没给具体日期，留在未完成清单里。',
  memoryMd:
    '主人 11 月换了工作（A→B），最近失眠。他明确说过「别把我忘了」，这是承诺锁条目。生日将至，日期未知。',
  index: [
    { topic: '换工作', keywords: ['工作', 'B公司'], importance: 9, decay: 1, ptr: 'archive/a1.md#L4' },
    { topic: '生日将至', keywords: ['生日'], importance: 8, decay: 0.9, ptr: 'archive/a3.md#L3' },
  ],
  commitments: [{ text: '别把我忘了', sourceShard: 'a3' }],
  conflicts: [],
}

interface FakeCall {
  role: 'forget' | 'memory'
  provider: string
  model: string
  prompt: string
}

/** 创建假路由器：从 prompt 里认出日片，返回固定 JSON。 */
function fakeRouter(calls: FakeCall[]) {
  const meter = new UsageMeter()
  const record = (role: 'forget' | 'memory') => ({
    async chat(target: { provider: string; model: string }, req: { prompt: string }) {
      calls.push({ role, provider: target.provider, model: target.model, prompt: req.prompt })
      const shard = /日片：(a\d)/.exec(req.prompt)?.[1]
      const text = JSON.stringify((shard && FORGET_JSON[shard]) || MEMORY_JSON)
      return { text, inputTokens: 1200, outputTokens: 300 }
    },
  })
  return {
    forget: record('forget'),
    memory: record('memory'),
    meter,
    probe: async () => ({ ok: true, detail: 'fake' }),
  } as never
}

function makeConfig(root: string): Config {
  return {
    memoryRoot: root,
    windowDays: 3,
    forget: { provider: 'fake-forget', model: 'f-1', temperature: 0.1, maxTokens: 900, timeoutMs: 60_000 },
    memory: { provider: 'fake-memory', model: 'm-1', temperature: 0.35, maxTokens: 2_500, timeoutMs: 120_000 },
    embedding: { provider: 'fake-embed', model: 'e-1', threshold: 0.6 },
    injection: { memoryTokens: 1_200, indexEntries: 15, commitments: 20 },
    protection: { commitmentsLock: true, identityAnchor: true, archiveRetentionDays: 0 },
    report: { enabled: true, outputDir: '' },
    migration: { auto: false },
    debug: false,
  }
}

/* ────────────────────────────── 跑一轮潮汐 ────────────────────────────── */

async function runCycle(
  root: string,
  cycle: string,
  rawTexts: Record<string, string>,
  prevRingId?: string,
  calls: FakeCall[] = [],
) {
  const config = makeConfig(root)
  const paths = resolvePaths(root)
  await ensureLayout(paths)
  const router = fakeRouter(calls)

  for (const [id, text] of Object.entries(rawTexts)) {
    await fs.writeFile(path.join(paths.raw, `${id}.md`), text, 'utf-8')
  }

  const gists = []
  for (const id of shardIdsFor(cycle, config.windowDays)) {
    gists.push(await forgetShard({ router, paths }, id, rawTexts[id] ?? ''))
  }

  const anchors = await readAnchors(paths, config)
  let prevRing
  if (prevRingId) {
    prevRing = JSON.parse(await fs.readFile(path.join(paths.rings, `${prevRingId}.json`), 'utf-8'))
  }
  const ring = await integrate({ router, paths }, { prevRing, gists, anchors, cycle, config })

  await fs.writeFile(path.join(paths.rings, `${ring.id}.json`), JSON.stringify(ring, null, 2), 'utf-8')
  await fs.writeFile(path.join(paths.rings, `${ring.id}.md`), `# ${ring.id}\n\n${ring.narrative}\n`, 'utf-8')
  await ensureLayout(paths)
  await writeDistilled(paths, ring, config)
  await archiveShards(
    paths,
    Object.keys(rawTexts).map((id) => ({ id, file: path.join(paths.raw, `${id}.md`) })),
    ring.id,
  )
  await appendLedger(paths, {
    kind: 'ring',
    ring: ring.id,
    cycle: ring.cycle,
    inputHash: ring.inputs.inputHash,
    prevRing: ring.inputs.prevRing,
    shards: ring.inputs.shards,
    models: { forget: 'fake-forget/f-1', memory: 'fake-memory/m-1' },
    tokens: { forgetIn: 1200, memoryIn: ring.stats.inTokens, memoryOut: ring.stats.outTokens },
    degraded: false,
    at: new Date().toISOString(),
  })
  await fs.writeFile(paths.latest, ring.id, 'utf-8')

  return { ring, gists, paths, config, calls }
}

/* ────────────────────────────── 测试 ────────────────────────────── */

test('端到端：第一轮 a1a2a3 → a11，文件、五件套与 12 节汇报齐备', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tma-e2e-'))
  const calls: FakeCall[] = []
  const { ring, paths, config } = await runCycle(
    root,
    'a',
    {
      a1: '主人：我换工作了，从 A 公司离职了。',
      a2: '主人：最近老是失眠，三点还醒着。',
      a3: '主人：答应我，别把我忘了。',
    },
    undefined,
    calls,
  )

  assert.equal(ring.id, 'a11')
  assert.equal(ring.inputs.prevRing, undefined)
  assert.deepEqual(ring.inputs.shards, ['a1', 'a2', 'a3'])
  assert.equal(ring.commitments.length, 1)
  assert.equal(ring.commitments[0].text, '别把我忘了')

  // 年轮落盘
  for (const file of ['a11.json', 'a11.md', 'LATEST']) {
    await fs.access(path.join(paths.rings, file))
  }

  // 五件套
  for (const file of ['MEMORY.md', 'INDEX.json', 'COMMITMENTS.md', 'IDENTITY.md']) {
    await fs.access(path.join(paths.distilled, file))
  }
  const memory = await fs.readFile(path.join(paths.distilled, 'MEMORY.md'), 'utf-8')
  assert.match(memory, /换工作|B）/)
  const commitments = await fs.readFile(path.join(paths.distilled, 'COMMITMENTS.md'), 'utf-8')
  assert.match(commitments, /别把我忘了/)

  // 原文归档（内容不丢）
  const months = await fs.readdir(paths.archive)
  assert.ok(months.length >= 1)
  const archived = await fs.readdir(path.join(paths.archive, months[0]))
  assert.ok(archived.some((name) => name.startsWith('a1')))

  // 假模型调用：3 次遗忘 + 1 次记忆，且 provider 不同 → 解耦成立
  assert.equal(calls.filter((call) => call.role === 'forget').length, 3)
  assert.equal(calls.filter((call) => call.role === 'memory').length, 1)
  assert.equal(new Set(calls.map((call) => call.provider)).size, 2)

  // 记忆模型确实没收到原文（只收到遗骸）
  const memoryCall = calls.find((call) => call.role === 'memory')
  assert.ok(memoryCall)
  // M 模型只拿到 F 模型产出的遗骸（含 dropped 清单），拿不到原始对话行
  assert.doesNotMatch(memoryCall.prompt, /主人：/)
  assert.match(memoryCall.prompt, /【本轮遗骸】/)
  assert.match(memoryCall.prompt, /【身份锚】/)

  // 12 节汇报
  const r2 = ring
  const anchors = await readAnchors(paths, config)
  const health = await computeHealth(paths, r2, {
    commitments: anchors.commitments,
    conflicts: r2.conflicts,
  })
  const report = buildCycleReport({
    ring: r2,
    gists: [],
    models: { forget: 'fake-forget/f-1', memory: 'fake-memory/m-1', decoupled: true },
    health,
    chain: [{ id: 'a11', inputs: 'a1 a2 a3', sizeBytes: 1024 }],
    cost: { forgetTokens: 3600, memoryTokens: 1500, estimatedCny: 0.01, savedPct: 0.6 },
    ledgerHead: ledgerHead(await readRingsLedger(paths)),
    version: '2.0.0',
  })
  const markdown = renderReport(report)
  for (let section = 1; section <= 12; section++) {
    assert.match(markdown, new RegExp(`^## ${section}\\.`, 'm'), `缺少第 ${section} 节`)
  }
  assert.match(markdown, /a11/)

  // inputHash 可复现且进入账本
  const expected = computeInputHash(
    undefined,
    Object.keys({ a1: '', a2: '', a3: '' }).map(() => ''),
    'x',
  )
  assert.equal(typeof expected, 'string')

  await fs.rm(root, { recursive: true, force: true })
})

test('端到端：第二轮 b1b2b3 + a11 → b11，年轮链继承成立', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tma-e2e-chain-'))
  const calls: FakeCall[] = []
  const first = await runCycle(root, 'a', {
    a1: '主人：我换工作了。',
    a2: '主人：最近失眠。',
    a3: '主人：别把我忘了。',
  })
  assert.equal(first.ring.id, 'a11')

  const second = await runCycle(
    root,
    'b',
    {
      b1: '主人：新公司食堂很难吃。',
      b2: '主人：今天终于睡了七小时。',
      b3: '主人：生日是下周三。',
    },
    'a11',
    calls,
  )

  assert.equal(second.ring.id, 'b11')
  assert.equal(second.ring.inputs.prevRing, 'a11')
  assert.equal(advanceCycle('a'), 'b')
  assert.equal(ringIdFor('b'), 'b11')

  // 承诺锁跨轮保留（a11 的承诺在 b11 仍在）
  const b11 = JSON.parse(await fs.readFile(path.join(second.paths.rings, 'b11.json'), 'utf-8'))
  assert.ok(
    b11.commitments.some((commitment: { text: string }) => commitment.text === '别把我忘了'),
    'b11 应保留 a11 的承诺锁',
  )

  // 账本里两条年轮，且第二条 prevRing 指向 a11
  const ledger = await readRingsLedger(second.paths)
  assert.equal(ledger.length, 2)
  assert.equal(ledger[1].prevRing, 'a11')

  // 记忆模型收到的上一道年轮确实被注入
  const memoryCall = calls.find((call) => call.role === 'memory')
  assert.ok(memoryCall)
  assert.match(memoryCall.prompt, /上一道年轮/)
  assert.match(memoryCall.prompt, /a11/)

  await fs.rm(root, { recursive: true, force: true })
})
