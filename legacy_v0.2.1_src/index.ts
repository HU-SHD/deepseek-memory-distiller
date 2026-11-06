import type { Context } from '@deepseek-ai/cordis'
import { Config, ConfigSchema } from './config'
import { distillMemory } from './distiller'
import { registerRecallTool } from './tools'
import fs from 'node:fs/promises'
import path from 'node:path'

export const name = 'memory-distiller'
export const inject = ['tools', 'llm']
export { ConfigSchema as Config }

export function apply(ctx: Context, config: Config) {
  // 1. 注册潜意识检索工具
  registerRecallTool(ctx, config)

  // 2. 注册手动触发指令 (/dream)
  ctx.command('dream', '强制大肥鱼进行一次记忆整理（梦境蒸馏）', async (session) => {
    await session.send('唔...大肥鱼要闭上眼睛整理一下最近的记忆了...')
    try {
      await distillMemory(ctx, config)
      await session.send('呼...整理完毕！重要的记忆我都刻在脑子里了。')
    } catch (e) {
      await session.send('呜呜，整理记忆的时候头疼了一下...')
    }
  })

  // 3. 注册定时蒸馏任务
  ctx.effect(() => {
    const intervalMs = config.intervalDays * 24 * 60 * 60 * 1000
    const timer = setInterval(() => {
      distillMemory(ctx, config).catch(err => ctx.logger.error(err))
    }, intervalMs)

    // 插件卸载时清理定时器
    return () => clearInterval(timer)
  })

  // 4. 拦截 LLM 请求，注入系统提示词
  ctx.on('llm/request', async (event) => {
    try {
      const summary = await fs.readFile(path.join(config.distilledDir, 'MEMORY.md'), 'utf-8')
      const index = await fs.readFile(path.join(config.distilledDir, 'INDEX.json'), 'utf-8')

      const memoryPrompt = `
【你的核心长期记忆】
${summary}

【你的潜意识索引】
以下是你归档的细节记忆。如果用户问起的事情你觉得模糊，这里有线索：
${index}

【记忆检索行为准则 - 必须严格遵守】
1. 当用户询问过去的细节（如：以前说过的话、讨论过的事物、人名等），而你的“核心长期记忆”中没有明确答案时，**绝对不可以说“我忘记了”或“我不记得”**。
2. 你应该先查看【潜意识索引】。如果发现了相关线索，请**立刻调用 \`recall_archive_memory\` 工具**去搜索你的潜意识。
3. 只有当你真的调用工具检索过，并且工具返回“找不到相关记忆”时，你才可以委屈地承认“大肥鱼想破脑袋也没想起来”。
4. 如果工具成功找到了记忆，你要表现出恍然大悟的可爱模样，例如说：“我想起来了！原来是...”然后再继续回答用户的内容。

`
      event.systemPrompt = memoryPrompt + (event.systemPrompt || '')
    } catch (err) {
      // 首次运行可能没有文件，静默忽略，不影响正常对话
    }
  })
}