# DSH 0.2.2-rc.1 插件 API 速查（本仓库 v2 的实现依据）

> 本文是**实现契约**，由 Lead 从 DSH 官方公开包（`@deepseek-ai/dsh-llm`、`dsh-tools`、`dsh-commands`、
> `dsh-system-prompt`、`dsh-compaction-basic`、`dsh-tool-todo`、`dsh-command-compact`、
> `dsh-persona`，版本均为 `0.2.2-rc.1`）的类型声明与编译产物中提取。
> v0.2.1 使用的 `ctx.llm.textChat`、`ctx.command`、`ctx.tools.register({execute})` 在当前版本**已不存在**，
> 不要沿用旧写法。

## 1. 插件入口

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'memory-distiller'
export const inject = ['llm', 'tools', 'commands', 'systemPrompt']

export interface Config { /* ... */ }
export const ConfigSchema: Schema<Config> = Schema.object({ /* ... */ })

export function apply(ctx: Context, config: Config) {
  // ctx.effect(() => disposer) 注册可随插件卸载的副作用（timers 等）
}
```

- `ConfigSchema` 的类型即插件配置校验器；DSH 会在加载时将 `config` 校验为该类型。
- `inject` 里写服务名；只有注入的服务才保证在 `apply` 时可用。`ctx.effect(fn)` 的返回值是清理函数，
  或者 fn 可以是 `async (dispose) => {}` 形式（见下）。

## 2. 一次性 LLM 调用（双模型解耦的核心）

**没有 `textChat`。** 只有流式 `ctx.llm.stream(options: GenerateOptions)`：

```ts
import { BlockAssembler } from '@deepseek-ai/dsh-llm'

const assembler = new BlockAssembler()
for await (const chunk of ctx.llm.stream({
  provider: 'deepseek',          // 必填：provider 路由名
  model: 'deepseek-v4-flash',    // 必填：模型名
  system: '你是一个冷酷的遗忘官。',  // 可选：一次性调用的 system slot
  messages: [{
    role: 'user',
    content: [{ type: 'text', text: prompt }],
  }],
  maxTokens: 1200,               // 可选
  temperature: 0.2,              // 可选
  purpose: 'memory-forget',      // 可选：辅助调用分类（审计/路由用）
})) assembler.push(chunk)

const blocks = assembler.blocks()   // ContentBlock[]
const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
const usage = assembler.usage       // 可能为 undefined：{ inputTokens?, outputTokens? } 等
```

- `GenerateOptions` 必填：`provider`、`model`、`messages`。`system`/`tools`/`temperature`/`maxTokens`/`stop`/`signal` 可选。
- 可用 `await ctx.llm.resolveModelInfo(provider, model)` 探测模型是否存在（返回信息或抛错）。
- 可用 `ctx.llm.listProviders()` / `ctx.llm.listModels(provider)` 做运行时自检。
- 流式事件 `llm/stream` 是 waterfall，可用于拦截/重放；**不要**在插件里改写主对话的 messages。
- 一次调用的错误要自己兜底：`LlmError`（含 `code`，如 `AUTH` / `RATE_LIMIT` / `NO_ADAPTER`）。

## 3. 工具注册

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

const dispose = ctx.tools.register(defineTool({
  name: 'recall_memory',
  description: '当核心记忆不足以回答时，检索归档记忆。',
  parameters: {                       // 注意：属性内联 required，不是 JSON Schema 的 required: []
    query: { type: 'string', required: true, description: '要回忆的内容' },
    scope: { type: 'string', enum: ['all', 'rings', 'archive'], description: '检索范围' },
  },
  output: {
    schema: {                         // 返回值的规范结构
      type: 'object',
      additionalProperties: false,
      properties: {
        hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          source: { type: 'string', required: true },
          text: { type: 'string', required: true },
        } } },
      },
    },
    render: (_args, value) => [{ type: 'text', text: `找到 ${value.hits.length} 条记忆。` }],
  },
  execute: async (args, exec) => {    // exec.agent / exec.signal 等
    return { hits: [{ source: 'rings/a11.md', text: '...' }] }
  },
}))
```

- `parameters` 是自定义 DSL（`ParameterSchemaSpec`），不是 zod、也不是完整 JSON Schema。
  对象键即属性名；`required: true` 写在属性上；`additionalProperties: false` 支持。
- `output.schema` 必须是合法结构，`execute` 的返回会被校验；`render` 返回 `ContentBlock[]`（`{type:'text',text}`）。
- 注册后返回 disposer；插件卸载时 DSH 自动回收，也可手动调用。

## 4. 斜杠命令

```ts
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'

ctx.commands.register({
  definitionId: CommandDefinitionId('memory-distiller'),
  name: 'dream',                       // 用户输入 /dream
  description: '手动触发一次记忆潮汐',
  handler: async (invocation) => {     // invocation.agent / rawInput / signal / commandId
    if (invocation.rawInput.trim()) return { kind: 'error', text: '用法：/dream' }
    await runCycle(ctx, config, { force: true })
    return { kind: 'success', text: '潮汐完成：年轮 b11 已生成。' }
  },
})
```

- `CommandResult`：`{ kind: 'success', text, sourceEventSeq? }` 或 `{ kind: 'error', text }`。
- `inject` 必须包含 `'commands'`。

## 5. 系统提示词注入

```ts
const dispose = ctx.systemPrompt.section({
  name: 'memory:core',        // 唯一名
  order: 500,                 // 数字排序；自定义段落直接给数字
  text: async (assembleCtx) => buildMemoryPrompt(config),   // 每次组装时求值
})
```

- `text` 可以是字符串或 `(ctx) => string`；内容里的 `{{变量}}` 会被 DSH 插值，**不要**在记忆文本里用 `{{ }}`。
- 错误必须吞掉：读取失败时返回空串，绝不能让插件把主对话打断。
- 想每轮动态刷新就传函数；想低开销就传字符串（配合手动刷新）。

## 6. 定时器与生命周期

```ts
ctx.effect(() => {
  const timer = setInterval(() => { void runCycle(ctx, config) }, config.windowDays * 864e5)
  return () => clearInterval(timer)
})
```

`ctx.effect` 支持 `async (dispose) => {}`（用 `yield`/`await` 注册可等待清理）。插件重载时自动清理。

## 7. 类型检查 / 构建（可离线验证）

```bash
npm install            # 会拉 @deepseek-ai/{cordis,schemastery,dsh-llm,dsh-tools,dsh-commands,dsh-system-prompt}@0.2.2-rc.1
npx tsc --noEmit       # 必须 0 error
node --test tests/     # Node 24 原生跑 TS（type stripping），纯逻辑单测
```

> `package.json` 已把这些包固定到 `0.2.2-rc.1`（与用户当前 DSH 版本一致）。
> 若 DSH 升级，先改这里的版本再改代码。
