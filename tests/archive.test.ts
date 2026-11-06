/**
 * archive 归档与遗骸指针测试（导入 dist/ 编译产物，npm test 会先 tsc）。
 *
 * 重点验证 Lead 冻结的「同名归档」规则：
 * - hash 相同 → 跳过写入（正常重试幂等）；
 * - hash 不同 → 原子覆盖（不改文件名，否则 F 模型的 ptr 会失配）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ensureLayout, resolvePaths } from '../dist/paths.js'
import {
  archiveShards,
  countOrphanPointers,
  monthBucket,
  resolvePointer,
  verifyTraceability,
} from '../dist/store/archive.js'

async function makeRoot(): Promise<ReturnType<typeof resolvePaths>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tma-archive-'))
  const paths = resolvePaths(root)
  await ensureLayout(paths)
  return paths
}

test('archiveShards：同名同 hash 幂等，同名不同 hash 原子覆盖且文件名不变', async () => {
  const paths = await makeRoot()
  const rawFile = path.join(paths.raw, 'a1.md')
  await fs.writeFile(rawFile, '# a1\n第一行\n第二行 生日\n', 'utf8')

  await archiveShards(paths, [{ id: 'a1', file: rawFile }], 'a11')
  const bucketDir = path.join(paths.archive, monthBucket())
  const archived = path.join(bucketDir, 'a1.md')
  const first = await fs.readFile(archived, 'utf8')
  assert.ok(first.includes('第二行 生日'))
  assert.equal((await fs.readdir(bucketDir)).filter((name) => name.endsWith('.md')).length, 1)

  // 模拟重试：raw 再次出现同样内容 → 跳过写入，清单不重复。
  await fs.writeFile(rawFile, first, 'utf8')
  await archiveShards(paths, [{ id: 'a1', file: rawFile }], 'a11')
  const manifestSame = JSON.parse(await fs.readFile(path.join(bucketDir, 'MANIFEST.json'), 'utf8'))
  assert.equal(manifestSame.filter((entry: { file: string }) => entry.file.endsWith('/a1.md')).length, 1)
  assert.equal(JSON.parse(await fs.readFile(path.join(bucketDir, 'MANIFEST.json'), 'utf8')).length, 1)

  // 同名不同内容 → 覆盖同一个文件名（不产生 a1-<hash>.md 这种断指针的新文件）。
  await fs.writeFile(rawFile, '# a1\n内容变了\n', 'utf8')
  await archiveShards(paths, [{ id: 'a1', file: rawFile }], 'a11')
  const after = await fs.readFile(archived, 'utf8')
  assert.ok(after.includes('内容变了'))
  const mdFiles = (await fs.readdir(bucketDir)).filter((name) => name.endsWith('.md'))
  assert.deepEqual(mdFiles, ['a1.md'])
  const manifestAfter = JSON.parse(await fs.readFile(path.join(bucketDir, 'MANIFEST.json'), 'utf8'))
  assert.equal(manifestAfter.length, 1)
})

test('resolvePointer：解析 archive/<YYYY-MM>/a1.md#L2 与行区间，缺失文件返回 undefined', async () => {
  const paths = await makeRoot()
  const rawFile = path.join(paths.raw, 'a1.md')
  await fs.writeFile(rawFile, '# a1\n第一行\n第二行 生日\n第三行\n第四行\n', 'utf8')
  await archiveShards(paths, [{ id: 'a1', file: rawFile }], 'a11')

  const ptr = `archive/${monthBucket()}/a1.md#L2`
  const line = await resolvePointer(paths, ptr)
  assert.ok(line?.includes('第一行')) // L2 含上下文 ±2 行
  assert.ok(line?.includes('第二行 生日'))

  const range = await resolvePointer(paths, `archive/${monthBucket()}/a1.md#L2-L3`)
  assert.ok(range?.includes('第二行') && range?.includes('第三行'))

  assert.equal(await resolvePointer(paths, 'archive/1999-01/none.md#L1'), undefined)
})

test('verifyTraceability / countOrphanPointers：指针存在率与孤儿计数', async () => {
  const paths = await makeRoot()
  const rawFile = path.join(paths.raw, 'a1.md')
  await fs.writeFile(rawFile, '第一行\n第二行\n', 'utf8')
  await archiveShards(paths, [{ id: 'a1', file: rawFile }], 'a11')

  const good = { topic: '好指针', keywords: ['生日'], ring: 'a11', importance: 9, decay: 1, ptr: `archive/${monthBucket()}/a1.md#L1` }
  const bad = { topic: '孤儿', keywords: [], ring: 'a11', importance: 5, decay: 1, ptr: 'archive/1999-01/none.md#L1' }

  assert.equal(await verifyTraceability(paths, [good]), 1)
  assert.equal(await verifyTraceability(paths, [good, bad]), 0.5)
  assert.equal(await countOrphanPointers(paths, [good, bad]), 1)
  assert.equal(await verifyTraceability(paths, []), 1)
})
