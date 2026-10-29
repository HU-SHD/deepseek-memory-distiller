import type { Context } from '@deepseek-ai/cordis'
import { loadRawMemories, archiveRawMemories, saveDistilledData } from './memory-manager'
import { Config } from './config'

export async function distillMemory(ctx: Context, config: Config) {
  const rawText = await loadRawMemories(config.rawDir)
  if (!rawText) {
    ctx.logger.info('[Memory Distiller] 没有发现新的原始记忆，跳过蒸馏。')
    return
  }

  // 强制大肥鱼人设，赋予主观情绪权重
  const prompt = `你是一只名叫“大肥鱼”的可爱桌宠。现在你要整理你与你主人的记忆。
  请仔细阅读以下原始记忆，并按照你的主观情感，为每条关键信息打分（1-10分）。
  - 如果主人说了“一定要记得”、“绝对不要忘”或者涉及生日、重要约定，请把重要程度（importance）打高（8-10分），并详细写在摘要里。
  - 如果是日常琐事，打个 1-3 分即可，让它们沉入潜意识。

  输出格式要求严格如下（不要输出其他废话，不要加 markdown 的 \`\`\`json 标记）：
  ---SUMMARY---
  [核心摘要，必须包含所有 importance >= 8 的记忆细节]
  ---INDEX---
  [
    {"topic": "主人让我记住他的生日", "keywords": ["生日", "主人"], "file": "2023-10-24.md", "importance": 10},
    {"topic": "今天吃了苹果", "keywords": ["苹果", "吃饭"], "file": "2023-10-25.md", "importance": 2}
  ]

  原始记忆：
  ${rawText}`

  try {
    const response = await ctx.llm.textChat(prompt)
    const text = response.text

    // 提取 Summary 和 Index
    const summaryMatch = text.match(/---SUMMARY---([\s\S]*?)---INDEX---/)
    const indexMatch = text.match(/---INDEX---([\s\S]*)/)

    if (summaryMatch && indexMatch) {
      const summary = summaryMatch[1].trim()
      // 清理可能混入的 markdown 标记
      const cleanIndexJson = indexMatch[1].replace(/```json/g, '').replace(/```/g, '').trim()
      const indexJson = JSON.parse(cleanIndexJson)

      await saveDistilledData(config.distilledDir, summary, indexJson)
      await archiveRawMemories(config.rawDir, config.archiveDir)

      ctx.logger.info(`[Memory Distiller] 蒸馏完成！大肥鱼整理了 ${indexJson.length} 条记忆，原始文件已归档。`)
    } else {
      ctx.logger.error('[Memory Distiller] LLM 输出格式解析失败，请检查模型输出。')
    }
  } catch (error) {
    ctx.logger.error(`[Memory Distiller] 蒸馏过程中发生错误: ${error}`)
  }
}