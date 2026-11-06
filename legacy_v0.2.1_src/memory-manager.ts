import fs from 'node:fs/promises'
import path from 'node:path'

export async function loadRawMemories(rawDir: string): Promise<string> {
  try {
    await fs.mkdir(rawDir, { recursive: true })
    const files = await fs.readdir(rawDir)
    const parts: string[] = []
    for (const file of files) {
      if (file.endsWith('.md')) {
        const content = await fs.readFile(path.join(rawDir, file), 'utf-8')
        parts.push(`### 文件: ${file}\n${content}`)
      }
    }
    return parts.join('\n\n')
  } catch (error) {
    return ''
  }
}

export async function archiveRawMemories(rawDir: string, archiveDir: string) {
  await fs.mkdir(archiveDir, { recursive: true })
  try {
    const files = await fs.readdir(rawDir)
    for (const file of files) {
      if (file.endsWith('.md')) {
        // 移动到归档目录
        await fs.rename(path.join(rawDir, file), path.join(archiveDir, file))
      }
    }
  } catch (error) {
    console.error('[Memory Distiller] 归档文件失败:', error)
  }
}

export async function saveDistilledData(distilledDir: string, summary: string, index: any[]) {
  await fs.mkdir(distilledDir, { recursive: true })
  await fs.writeFile(path.join(distilledDir, 'MEMORY.md'), summary, 'utf-8')
  await fs.writeFile(path.join(distilledDir, 'INDEX.json'), JSON.stringify(index, null, 2), 'utf-8')
}