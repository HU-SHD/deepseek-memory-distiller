/**
 * 迁移映射测试：v0.2.1 INDEX/MEMORY → v2 年轮 a11 的纯逻辑映射（不碰文件系统、不调模型）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  legacyInputHash,
  legacyNarrative,
  legacyPointer,
  mapLegacyIndex,
  parseLegacyIndex,
} from '../src/migrate.ts'

test('parseLegacyIndex：容忍 ```json 围栏、裸数组、对象容器', () => {
  const fenced = '这是模型输出：\n```json\n[{"topic":"生日","keywords":["生日"],"file":"2023-10-24.md","importance":10}]\n```\n完毕'
  const entries = parseLegacyIndex(fenced)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].topic, '生日')

  const bare = '[{"topic":"游戏","importance":3}]'
  assert.deepEqual(parseLegacyIndex(bare), [{ topic: '游戏', importance: 3 }])

  const objectForm = JSON.stringify({ index: [{ topic: 'A' }, { topic: 'B' }] })
  assert.equal(parseLegacyIndex(objectForm).length, 2)

  assert.deepEqual(parseLegacyIndex('不是 JSON'), [])
  assert.deepEqual(parseLegacyIndex(''), [])
})

test('mapLegacyIndex：输入输出映射（ring / importance 裁剪 / ptr / decay）', () => {
  const legacy = [
    { topic: '生日约定', keywords: ['生日', '约定'], file: '2023-10-24.md', importance: 12 },
    { topic: '游戏', keywords: ['游戏'], file: '2023-10-25.md', importance: 3 },
    { topic: '未知文件', keywords: [], file: '不存在.md', importance: 5 },
  ]
  const moved = new Map([
    ['2023-10-24.md', 'archive/2023-10/2023-10-24.md'],
    ['2023-10-25.md', 'archive/2023-10/2023-10-25.md'],
  ])
  const resolve = (file: string | undefined): string =>
    (file && moved.get(file)) ?? 'rings/a11.md'

  const index = mapLegacyIndex(legacy, resolve)
  assert.equal(index.length, 3)
  assert.equal(index[0].ring, 'a11')
  assert.equal(index[0].importance, 10) // 12 → 裁剪到 10
  assert.equal(index[0].decay, 1)
  assert.equal(index[0].ptr, 'archive/2023-10/2023-10-24.md')
  assert.deepEqual(index[0].keywords, ['生日', '约定'])
  assert.equal(index[1].importance, 3)
  assert.equal(index[2].ptr, 'rings/a11.md') // 文件不认识 → 回退年轮
})

test('mapLegacyIndex：空条目/缺字段的容错', () => {
  const index = mapLegacyIndex([{}, { topic: '', keywords: [] }, { topic: '只有主题' }], () => 'rings/a11.md')
  assert.equal(index.length, 1)
  assert.equal(index[0].topic, '只有主题')
  assert.equal(index[0].importance, 5)
  assert.deepEqual(index[0].keywords, [])
})

test('legacyPointer：优先 raw→archive，其次旧扁平 archive，最后回退年轮', () => {
  const resolve = (file: string): string | undefined =>
    file === 'a.md' ? 'archive/2026-11/a.md' : file === 'b.md' ? 'archive/b.md' : undefined
  assert.equal(legacyPointer('a.md', resolve), 'archive/2026-11/a.md')
  assert.equal(legacyPointer('b.md', resolve), 'archive/b.md')
  assert.equal(legacyPointer('c.md', resolve), 'rings/a11.md')
  assert.equal(legacyPointer(undefined, resolve), 'rings/a11.md')
  assert.equal(legacyPointer('', resolve, 'rings/custom.md'), 'rings/custom.md')
})

test('legacyNarrative：折叠空白、超长截断、空 MEMORY 时给出迁移说明', () => {
  const narrative = legacyNarrative('第一行\n\n  第二行  \n第三行')
  assert.equal(narrative, '第一行 第二行 第三行')

  const long = '字'.repeat(2000)
  const truncated = legacyNarrative(long, 800)
  assert.ok(Array.from(truncated).length <= 801)
  assert.ok(truncated.endsWith('…'))

  const fallback = legacyNarrative('', 800, 7)
  assert.ok(fallback.includes('7 条索引'))
  assert.ok(fallback.includes('a11'))
})

test('legacyInputHash：确定、可复现、随内容变化', () => {
  const a = legacyInputHash('memory', '[{"topic":"x"}]', 'fp1')
  const b = legacyInputHash('memory', '[{"topic":"x"}]', 'fp1')
  const c = legacyInputHash('memory2', '[{"topic":"x"}]', 'fp1')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(a.length, 64)
})
