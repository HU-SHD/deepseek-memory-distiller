/**
 * 深海（archive/）：原文永久归档 + 遗骸指针解析 + 可回溯性核查。
 *
 * 约定：
 * - 按 `archive/<YYYY-MM>/` 分桶，桶内 `MANIFEST.json` 记录 sha256 清单；
 * - 遗骸指针格式 `archive/2026-11/a1.md#L12`（`#L12-L20` 支持行区间）；
 * - v0.2.1 遗留的扁平归档（`archive/*.md`）仍可解析，迁移时不动旧文件。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { IndexEntry, RingId, ShardId } from '../types'
import type { MemoryPaths } from '../paths'
import { writeAtomic, readIfExists } from '../util/atomic'

export interface ArchiveManifestEntry {
  shard: ShardId
  /** 归档后的相对路径（archive/YYYY-MM/a1.md）。 */
  file: string
  hash: string
  size: number
  ring: RingId
  archivedAt: string
  ptr: string
}

export interface ArchivedFile {
  /** 指向 archive 内文件的指针（archive/YYYY-MM/x.md）。 */
  ptr: string
  /** 绝对路径。 */
  file: string
}

/** `2026-11`。 */
export function monthBucket(date: Date = new Date()): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}`
}

/** 文件内容的 sha256（按字节，hex）。 */
export async function sha256File(file: string): Promise<string> {
  const buffer = await fs.readFile(file)
  return createHash('sha256').update(buffer).digest('hex')
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/**
 * 归档本轮日片：把 raw 文件搬进 archive/<YYYY-MM>/，写 sha256 清单。
 * 先复制后删除，保证崩溃时原文至少存在于一侧。
 */
export async function archiveShards(
  paths: MemoryPaths,
  shards: { id: ShardId; file: string }[],
  ring: RingId,
): Promise<void> {
  await fs.mkdir(paths.archive, { recursive: true })
  const bucket = monthBucket()
  const bucketDir = path.join(paths.archive, bucket)
  await fs.mkdir(bucketDir, { recursive: true })

  const manifestFile = path.join(bucketDir, 'MANIFEST.json')
  let manifest: ArchiveManifestEntry[] = []
  const manifestRaw = await readIfExists(manifestFile)
  if (manifestRaw) {
    try {
      const parsed = JSON.parse(manifestRaw)
      if (Array.isArray(parsed)) manifest = parsed as ArchiveManifestEntry[]
    } catch {
      manifest = []
    }
  }

  for (const shard of shards) {
    const source = path.isAbsolute(shard.file) ? shard.file : path.join(paths.raw, shard.file)
    const content = await fs.readFile(source).catch(() => undefined)
    if (!content) continue

    const hash = createHash('sha256').update(content).digest('hex')
    // 固定文件名：F 模型产出的 ptr 是 archive/<YYYY-MM>/<shard>.md#L<n>，改名会让指针失配。
    const targetName = `${shard.id}.md`
    const target = path.join(bucketDir, targetName)
    const existingHash = (await exists(target)) ? await sha256File(target) : undefined

    if (existingHash === hash) {
      // 正常重试：原文完全一致 → 跳过写入（保持文件 mtime 与原子性）。
    } else {
      if (existingHash !== undefined) {
        console.warn(
          `[memory-distiller] archive 同名不同内容，原子覆盖：archive/${bucket}/${targetName}（旧 ${existingHash.slice(0, 8)} → 新 ${hash.slice(0, 8)}）`,
        )
      }
      await writeAtomic(target, content.toString('utf-8'))
    }

    // 清单按文件路径 upsert（重试不产生重复条目）。
    const ptr = `archive/${bucket}/${targetName}#L1`
    manifest = manifest.filter((entry) => entry.file !== `archive/${bucket}/${targetName}`)
    manifest.push({
      shard: shard.id,
      file: `archive/${bucket}/${targetName}`,
      hash,
      size: content.byteLength,
      ring,
      archivedAt: new Date().toISOString(),
      ptr,
    })
    // 双写完成后再删除 raw 原文；失败时原文仍在 raw/，下轮可重试。
    await fs.unlink(source).catch(() => undefined)
  }

  await writeAtomic(manifestFile, JSON.stringify(manifest, null, 2))
}

function resolveFromRoot(paths: MemoryPaths, rel: string): string {
  if (path.isAbsolute(rel)) return rel
  return path.join(paths.root, rel)
}

/**
 * 解析遗骸指针，返回原文片段。
 * - `archive/2026-11/a1.md#L12` → 第 12 行（含上下文 ±2 行）
 * - `archive/2026-11/a1.md#L12-L20` → 行区间
 * - 无行号 → 返回前 1200 字符
 * - 文件不存在 → undefined（调用方据此计孤儿指针）
 */
export async function resolvePointer(paths: MemoryPaths, ptr: string): Promise<string | undefined> {
  if (!ptr || typeof ptr !== 'string') return undefined
  const hashIndex = ptr.indexOf('#')
  const rel = (hashIndex >= 0 ? ptr.slice(0, hashIndex) : ptr).trim()
  const fragment = hashIndex >= 0 ? ptr.slice(hashIndex + 1) : ''

  if (!rel) return undefined

  const target = resolveFromRoot(paths, rel)
  const content = await readIfExists(target)
  if (content === undefined) return undefined

  const lines = content.split(/\r?\n/)
  const range = /^L(\d+)(?:-L?(\d+))?$/.exec(fragment.trim())
  if (!range) {
    return content.length > 1200 ? `${content.slice(0, 1200)}…` : content
  }

  const start = Math.max(1, Number(range[1]))
  const end = range[2] ? Math.max(start, Number(range[2])) : start
  const from = Math.max(0, start - 3)
  const to = Math.min(lines.length, end + 2)
  const snippet = lines.slice(from, to).join('\n').trim()
  return snippet || undefined
}

/** 校验索引条目的可回溯性：能找到原文的比例（无 ptr 条目不计入）。 */
export async function verifyTraceability(paths: MemoryPaths, index: IndexEntry[]): Promise<number> {
  const withPtr = (index ?? []).filter((entry) => typeof entry.ptr === 'string' && entry.ptr.length > 0)
  if (withPtr.length === 0) return 1
  let found = 0
  for (const entry of withPtr) {
    const resolved = await resolvePointer(paths, entry.ptr)
    if (resolved !== undefined) found += 1
  }
  return Math.round((found / withPtr.length) * 10000) / 10000
}

/** 孤儿指针数量（ptr 指向的文件不存在）。 */
export async function countOrphanPointers(paths: MemoryPaths, index: IndexEntry[]): Promise<number> {
  const withPtr = (index ?? []).filter((entry) => typeof entry.ptr === 'string' && entry.ptr.length > 0)
  let orphans = 0
  for (const entry of withPtr) {
    const resolved = await resolvePointer(paths, entry.ptr)
    if (resolved === undefined) orphans += 1
  }
  return orphans
}

/** 递归列出 archive/ 下的原文文件（跳过清单文件）。 */
export async function listArchiveFiles(paths: MemoryPaths): Promise<ArchivedFile[]> {
  const result: ArchivedFile[] = []
  async function walk(dir: string, relDir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'MANIFEST.json') continue
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
      const childAbs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(childAbs, childRel)
      } else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
        result.push({ ptr: `archive/${childRel}`, file: childAbs })
      }
    }
  }
  await walk(paths.archive, '')
  return result
}
