/**
 * DSH 服务类型增强。
 *
 * @deepseek-ai/dsh-* 各包通过 `declare module '@deepseek-ai/cordis'` 给 Context 增补
 * `llm` / `tools` / `commands` / `systemPrompt` 等成员，但这些声明只有在对应包被
 * 引入（import）时才会进入编译单元。这里集中引入一次，避免每个文件各写一遍。
 */
import '@deepseek-ai/dsh-commands'
import '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-tools'
