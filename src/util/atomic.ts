/**
 * 原子写 / 条件读。
 *
 * 所有落盘（年轮、注入稿、STATE、LATEST、账本快照）都必须走 `tmp + fsync + rename`：
 * 崩溃时读者要么看到旧文件、要么看到新文件，不会看到写了一半的内容。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * 原子写文本：写入同目录临时文件 → fsync → rename 覆盖目标。
 * 目录不存在时自动创建；失败时清理临时文件并抛出原始错误。
 *
 * @param file 目标文件绝对路径
 * @param data UTF-8 文本内容
 */
export async function writeAtomic(file: string, data: string): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const suffix = `${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`
  const tmp = path.join(dir, `.${path.basename(file)}.${suffix}.tmp`)
  try {
    await fs.writeFile(tmp, data, 'utf8')
    // fsync：确保数据真正落到磁盘后再 rename（Windows 上 rename 覆盖已存在文件是原子的）
    const handle = await fs.open(tmp, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * 读取文件；文件不存在（ENOENT）时返回 undefined，其余错误照常抛出。
 * @param file 目标文件绝对路径
 */
export async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
