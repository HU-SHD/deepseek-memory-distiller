/**
 * 记忆根目录布局。
 *
 * 所有模块都通过 {@link MemoryPaths} 取路径，不要各自拼字符串——
 * 这样目录结构只在一处定义，迁移/测试也只需替换 `memoryRoot`。
 *
 * 目录结构（与 ARCHITECTURE 第 4 节一致）：
 * ```
 * <memoryRoot>/
 *   raw/         潮间带：尚未处理的日片原文 a1.md / a2.md / a3.md
 *   archive/     深海：永久归档的原文
 *   rings/       年轮：a11.md / a11.json / LATEST
 *   distilled/   注入稿：MEMORY.md / INDEX.json / COMMITMENTS.md / IDENTITY.md
 *   reports/     每轮汇报
 *   ledgers/     账本：rings.jsonl / forget.jsonl / recall.jsonl
 *   STATE.json   当前周期、lastRing、lastInputHash
 * ```
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** 记忆根目录下的全部固定路径。 */
export interface MemoryPaths {
  /** 记忆根目录。 */
  root: string
  /** 潮间带：未处理原文。 */
  raw: string
  /** 深海：永久归档原文。 */
  archive: string
  /** 年轮目录（`a11.json`、`LATEST`）。 */
  rings: string
  /** 注入稿目录（MEMORY.md / INDEX.json / COMMITMENTS.md / IDENTITY.md）。 */
  distilled: string
  /** 汇报目录。 */
  reports: string
  /** 账本目录。 */
  ledgers: string
  /** STATE.json 的绝对路径。 */
  state: string
  /** rings/LATEST 的绝对路径。 */
  latest: string
}

/**
 * 由记忆根目录推导全部固定路径（相对路径按进程 cwd 解析）。
 * @param memoryRoot 配置里的记忆根目录
 */
export function resolvePaths(memoryRoot: string): MemoryPaths {
  const root = path.resolve(memoryRoot)
  const rings = path.join(root, 'rings')
  return {
    root,
    raw: path.join(root, 'raw'),
    archive: path.join(root, 'archive'),
    rings,
    distilled: path.join(root, 'distilled'),
    reports: path.join(root, 'reports'),
    ledgers: path.join(root, 'ledgers'),
    state: path.join(root, 'STATE.json'),
    latest: path.join(rings, 'LATEST'),
  }
}

/**
 * 创建布局所需的全部目录（幂等）。文件（STATE.json / LATEST）由各自模块按需写入。
 * @param paths 由 {@link resolvePaths} 得到的路径集合
 */
export async function ensureLayout(paths: MemoryPaths): Promise<void> {
  const dirs = [paths.root, paths.raw, paths.archive, paths.rings, paths.distilled, paths.reports, paths.ledgers]
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true })
  }
}
