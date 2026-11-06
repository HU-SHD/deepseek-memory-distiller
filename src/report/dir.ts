/**
 * 汇报输出目录解析。
 *
 * 优先级（INTERFACES / README 一致）：
 * 1. `config.report.outputDir` 显式配置（≠ Schema 默认值、非空）→ 按进程 cwd 解析；
 * 2. 否则 → `<memoryRoot>/reports`。
 *
 * 关键点：ConfigSchema 里 outputDir 的默认值是 `'./data/memory/reports'`，它只与**默认**
 * memoryRoot 等价。用户改 memoryRoot 而未改 outputDir 时，必须视为「未配置」，否则汇报会
 * 跑偏到 cwd 下的 ./data/memory/reports。因此这里把空串 / 默认字面量（含等价写法）都当未配置。
 */

import path from 'node:path'
import type { Config } from '../types'
import type { MemoryPaths } from '../paths'

const SCHEMA_DEFAULT_OUTPUT_DIR = normalizeDir('./data/memory/reports')

/** 归一化比较：兼容 `./`、Windows 反斜杠、尾部斜杠等等价写法。 */
function normalizeDir(value: string): string {
  const normalized = path.normalize(value.trim())
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, '') : normalized
}

export function resolveReportDir(config: Config, paths: MemoryPaths): string {
  const configured = (config.report?.outputDir ?? '').trim()
  if (!configured) return paths.reports
  // 默认值视为未配置（用户改 memoryRoot 没改 outputDir 时，汇报不能跑偏到 cwd）。
  if (normalizeDir(configured) === SCHEMA_DEFAULT_OUTPUT_DIR) return paths.reports
  return path.resolve(configured)
}
