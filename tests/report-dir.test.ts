/**
 * outputDir 优先级测试（纯逻辑，只依赖 node:path）。
 * 规则：默认字面量/空串视为未配置 → <memoryRoot>/reports；显式配置 → 按 cwd 解析。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveReportDir } from '../src/report/dir.ts'
import type { Config } from '../src/types.ts'
import type { MemoryPaths } from '../src/paths.ts'

const paths: MemoryPaths = {
  root: path.resolve('/tmp/custom-memory'),
  raw: path.resolve('/tmp/custom-memory/raw'),
  archive: path.resolve('/tmp/custom-memory/archive'),
  rings: path.resolve('/tmp/custom-memory/rings'),
  distilled: path.resolve('/tmp/custom-memory/distilled'),
  reports: path.resolve('/tmp/custom-memory/reports'),
  ledgers: path.resolve('/tmp/custom-memory/ledgers'),
  state: path.resolve('/tmp/custom-memory/STATE.json'),
  latest: path.resolve('/tmp/custom-memory/rings/LATEST'),
}

function makeConfig(outputDir: string): Config {
  return {
    memoryRoot: '/tmp/custom-memory',
    windowDays: 3,
    forget: { provider: 'a', model: 'a', temperature: 0.1, maxTokens: 100, timeoutMs: 1000 },
    memory: { provider: 'b', model: 'b', temperature: 0.35, maxTokens: 100, timeoutMs: 1000 },
    embedding: { provider: 'c', model: 'c', threshold: 0.6 },
    injection: { memoryTokens: 1200, indexEntries: 15, commitments: 20 },
    protection: { commitmentsLock: true, identityAnchor: true, archiveRetentionDays: 0 },
    report: { enabled: true, outputDir },
    migration: { auto: true },
    debug: false,
  }
}

test('outputDir 为默认值 / 空串时视为未配置 → memoryRoot/reports', () => {
  assert.equal(resolveReportDir(makeConfig('./data/memory/reports'), paths), paths.reports)
  assert.equal(resolveReportDir(makeConfig('data/memory/reports'), paths), paths.reports)
  assert.equal(resolveReportDir(makeConfig('./data/memory/reports/'), paths), paths.reports)
  assert.equal(resolveReportDir(makeConfig(''), paths), paths.reports)
})

test('outputDir 显式配置时按 cwd 解析', () => {
  const resolved = resolveReportDir(makeConfig('./custom/reports'), paths)
  assert.equal(resolved, path.resolve('./custom/reports'))
  assert.notEqual(resolved, paths.reports)
})
