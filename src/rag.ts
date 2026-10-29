import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Config } from './config'

// 计算余弦相似度
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] ** 2;
    normB += vecB[i] ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function searchArchive(ctx: Context, config: Config, query: string): Promise<string> {
  try {
    const files = await fs.readdir(config.archiveDir)
    if (files.length === 0) return '大肥鱼的潜意识里一片空白，没有找到任何记忆。'

    const queryEmbed = await ctx.llm.embed(query, config.embeddingModel)

    let bestScore = -1
    let bestContent = ''
    let bestFile = ''

    // 遍历归档文件计算相似度
    for (const file of files) {
      if (!file.endsWith('.md')) continue

      const filePath = path.join(config.archiveDir, file)
      const content = await fs.readFile(filePath, 'utf-8')

      // 简单切片策略：每次取前 512 个字符计算向量（按实际情况可优化为滑动窗口）
      const chunk = content.slice(0, 512)
      const chunkEmbed = await ctx.llm.embed(chunk, config.embeddingModel)

      const score = cosineSimilarity(queryEmbed, chunkEmbed)

      if (score > bestScore) {
        bestScore = score
        bestContent = content
        bestFile = file
      }
    }

    if (bestScore >= config.ragThreshold) {
      return `在档案 [${bestFile}] 中找到了相关记忆：\n${bestContent}`
    } else {
      return '大肥鱼在潜意识里翻找了好久，似乎找不到相关的详细记忆了。'
    }
  } catch (error) {
    ctx.logger.error(`[Memory Distiller] RAG 检索出错: ${error}`)
    return '大肥鱼尝试回忆，但是脑袋卡壳了（检索异常）。'
  }
}