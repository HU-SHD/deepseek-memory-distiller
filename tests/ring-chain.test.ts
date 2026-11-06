/**
 * 年轮链单测：命名 / 进位 / inputHash / 年轮枚举。
 *
 * 运行：node --test tests/
 * 说明：被测试模块保持「零运行时相对导入」，因此 Node 原生 TS 可直接加载。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  advanceCycle,
  computeInputHash,
  cycleOrdinal,
  findPrevRing,
  listRings,
  parseRingId,
  ringIdFor,
  shardIdsFor,
} from '../src/ring/chain.ts'
import { resolvePaths } from '../src/paths.ts'

test('advanceCycle：a→b、y→z、z→za（26 进制进位）', () => {
  assert.equal(advanceCycle('a'), 'b')
  assert.equal(advanceCycle('y'), 'z')
  assert.equal(advanceCycle('z'), 'za')
  assert.equal(advanceCycle('za'), 'zb')
  assert.equal(advanceCycle('zz'), 'zaa')
  // 非法输入原样返回，不制造脏周期
  assert.equal(advanceCycle(''), 'a')
  assert.equal(advanceCycle('a1'), 'a1')
})

test('cycleOrdinal：周期序与进位顺序一致', () => {
  const order = ['a', 'b', 'z', 'za', 'zb', 'zz', 'zaa']
  for (let i = 1; i < order.length; i++) {
    assert.ok(cycleOrdinal(order[i - 1]) < cycleOrdinal(order[i]), `${order[i - 1]} 应排在 ${order[i]} 之前`)
  }
})

test('ringIdFor / parseRingId：年轮命名', () => {
  assert.equal(ringIdFor('a'), 'a11')
  assert.equal(ringIdFor('b'), 'b11')
  assert.equal(ringIdFor('za'), 'za11')
  assert.deepEqual(parseRingId('a11'), { cycle: 'a' })
  assert.deepEqual(parseRingId('za11'), { cycle: 'za' })
  assert.equal(parseRingId('a1'), undefined)
  assert.equal(parseRingId('11'), undefined)
  assert.equal(parseRingId('a11x'), undefined)
})

test('shardIdsFor：窗口天数决定日片', () => {
  assert.deepEqual(shardIdsFor('a', 3), ['a1', 'a2', 'a3'])
  assert.deepEqual(shardIdsFor('b', 3), ['b1', 'b2', 'b3'])
  assert.deepEqual(shardIdsFor('a', 0), [])
})

test('computeInputHash：确定性、日片顺序无关、输入变化则变化', () => {
  const hashes = ['h1', 'h2', 'h3']
  const a = computeInputHash(undefined, hashes, 'cfg')
  const b = computeInputHash(undefined, [...hashes].reverse(), 'cfg')
  assert.equal(a, b, '日片 hash 排序后应得到同一个 inputHash')
  assert.match(a, /^[0-9a-f]{64}$/)

  assert.notEqual(a, computeInputHash('a11', hashes, 'cfg'), 'prevRing 变化应改变 inputHash')
  assert.notEqual(a, computeInputHash(undefined, hashes, 'cfg2'), '配置指纹变化应改变 inputHash')
  assert.notEqual(a, computeInputHash(undefined, ['h1', 'h2'], 'cfg'), '日片数量变化应改变 inputHash')
})

test('listRings / findPrevRing：年轮枚举与 LATEST 回退', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tma-chain-'))
  const paths = resolvePaths(root)
  try {
    await mkdir(paths.rings, { recursive: true })
    assert.deepEqual(await listRings(paths), [])

    await writeFile(path.join(paths.rings, 'a11.json'), '{}', 'utf8')
    await writeFile(path.join(paths.rings, 'za11.json'), '{}', 'utf8')
    await writeFile(path.join(paths.rings, 'b11.json'), '{}', 'utf8')
    await writeFile(path.join(paths.rings, 'junk.json'), '{}', 'utf8')
    await writeFile(path.join(paths.rings, 'notes.txt'), 'x', 'utf8')

    assert.deepEqual(await listRings(paths), ['a11', 'b11', 'za11'])
    // LATEST 缺失 → 回退到周期序最大的年轮
    assert.equal(await findPrevRing(paths), 'za11')

    await writeFile(paths.latest, 'b11\n', 'utf8')
    assert.equal(await findPrevRing(paths), 'b11')

    await writeFile(paths.latest, '损坏的指针\n', 'utf8')
    assert.equal(await findPrevRing(paths), 'za11')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
