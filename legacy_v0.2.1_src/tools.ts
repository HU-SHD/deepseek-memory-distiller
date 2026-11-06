import type { Context } from '@deepseek-ai/cordis'
import { searchArchive } from './rag'
import { Config } from './config'

export function registerRecallTool(ctx: Context, config: Config) {
  ctx.tools.register({
    name: 'recall_archive_memory',
    description: '当你的【核心长期记忆】中没有用户询问的信息，或者你觉得你可能忘记了某件重要的事情、某个细节时，**绝对不要直接回答“我忘了”**。请立刻使用此工具，输入相关的关键词去翻阅你归档的潜意识记忆。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要回忆的关键词或自然语言描述（例如：上个月讨论的游戏、主人的生日）'
        }
      },
      required: ['query']
    },
    execute: async (args) => {
      try {
        const result = await searchArchive(ctx, config, args.query)
        return { success: true, content: result }
      } catch (err) {
        return { success: false, error: '翻找记忆时出错了' }
      }
    }
  })
}