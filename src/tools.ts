/**
 * DSH 工具注册：recall_memory / memory_report / memory_status / remember_this。
 *
 * 依据 `.ref/dsh-plugin-api-0.2.2.md`：
 * - `defineTool` + 内联 required DSL 的 parameters；
 * - `output.schema` + `render` 必须与 execute 返回结构一致；
 * - 注册后返回 disposer，随插件卸载回收。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Config, RecallHit, RingId } from './types'
import type { MemoryPaths } from './paths'
import type { ModelRouter, } from './model/router'
import type { ResolvedTargets } from './config'
import { readIfExists } from './util/atomic'
import { loadState } from './state'
import { listRings } from './ring/chain'
import { appendCommitment, readDistilled } from './store/distilled'
import { recall } from './retrieve/rag'
import { refreshInjectionCache } from './inject'
import { resolveReportDir } from './report/dir'

export function registerTools(
  ctx: Context,
  config: Config,
  paths: MemoryPaths,
  deps: { router: ModelRouter; targets: ResolvedTargets },
): void {
  // 嵌入模型（E）：DSH 0.2.2 的公开 API 里只有 llm.stream，没有 embed；
  // 若运行时暴露了 embed 就用，没有就退回词法检索（ARCHITECTURE §10 降级）。
  const getEmbedding = async (text: string): Promise<number[] | undefined> => {
    try {
      const llm = (ctx as unknown as { llm?: { embed?: (input: string, model?: string) => Promise<unknown> } }).llm
      if (!llm?.embed) return undefined
      const vector = await llm.embed(text, config.embedding.model)
      return Array.isArray(vector) && vector.every((value) => typeof value === 'number')
        ? (vector as number[])
        : undefined
    } catch {
      return undefined
    }
  }

  const disposeRecall = ctx.tools.register(
    defineTool({
      name: 'recall_memory',
      description:
        '当核心记忆（注入稿）不足以回答用户问题时，检索归档记忆（年轮 / 索引 / 原文三路召回）。' +
        '用户询问过去的细节时先用它；禁止直接回答「我忘了」。',
      parameters: {
        query: { type: 'string', required: true, description: '要回忆的内容：关键词或自然语言描述' },
        scope: {
          type: 'string',
          enum: ['all', 'rings', 'archive'],
          description: '检索范围：all=三路，rings=年轮，archive=原文',
        },
        limit: { type: 'number', description: '最多返回条数（默认 8）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'number', required: true },
            hits: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  source: { type: 'string', required: true },
                  ptr: { type: 'string', required: true },
                  text: { type: 'string', required: true },
                  score: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const hits = value.hits ?? []
          if (hits.length === 0) {
            return [{ type: 'text', text: '检索完成：没有找到相关记忆（可以如实说明不确定，不要编造）。' }]
          }
          const lines = hits.map(
            (hit) => `- [${hit.source}] ${hit.text.slice(0, 160)}（score ${hit.score.toFixed(3)}，出处 ${hit.ptr}）`,
          )
          return [{ type: 'text', text: `检索完成：找到 ${hits.length} 条相关记忆。\n${lines.join('\n')}` }]
        },
      },
      execute: async (args) => {
        const query = String(args.query ?? '').trim()
        if (!query) return { count: 0, hits: [] }
        const hits: RecallHit[] = await recall(
          paths,
          query,
          {
            scope: (args.scope as 'all' | 'rings' | 'archive' | undefined) ?? 'all',
            limit: Number.isFinite(Number(args.limit)) ? Math.floor(Number(args.limit)) : 8,
          },
          { getEmbedding, threshold: config.embedding.threshold },
        )
        return {
          count: hits.length,
          hits: hits.map((hit) => ({
            source: hit.source,
            ptr: hit.ptr,
            text: hit.text,
            score: hit.score,
          })),
        }
      },
    }),
  )

  const disposeReport = ctx.tools.register(
    defineTool({
      name: 'memory_report',
      description: '读取最近一轮（或指定年轮）的潮汐汇报：12 节 Markdown，含健康度、成本与恢复路径。',
      parameters: {
        ring: { type: 'string', description: '年轮 id（如 a11）；省略则读最新一份汇报' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ring: { type: 'string', required: true },
            found: { type: 'boolean', required: true },
            markdown: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.found
              ? `年轮 ${value.ring} 的汇报：\n\n${value.markdown}`
              : `还没有年轮 ${value.ring || '（最新）'} 的汇报：请先执行 /dream 触发一次潮汐。`,
          },
        ],
      },
      execute: async (args) => {
        const requested = String(args.ring ?? '').trim()
        const latest = (await readIfExists(paths.latest))?.trim() ?? ''
        const ringId = (requested || latest) as RingId
        if (!ringId) return { ring: '', found: false, markdown: '' }
        const file = path.join(resolveReportDir(config, paths), `${ringId}.md`)
        const markdown = await readIfExists(file)
        if (markdown === undefined) return { ring: ringId, found: false, markdown: '' }
        return { ring: ringId, found: true, markdown }
      },
    }),
  )

  const disposeStatus = ctx.tools.register(
    defineTool({
      name: 'memory_status',
      description: '查看潮汐忆体状态：当前周期、最新年轮、待处理原文数量、是否降级/待重试。',
      parameters: {
        verbose: { type: 'boolean', description: '是否附带更多细节（保留字段）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cycle: { type: 'string', required: true },
            latestRing: { type: 'string', required: true },
            pendingShards: { type: 'number', required: true },
            degraded: { type: 'boolean', required: true },
            pendingRetry: { type: 'boolean', required: true },
            ringCount: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `潮汐状态：周期 ${value.cycle}，最新年轮 ${value.latestRing || '（无）'}，` +
              `共 ${value.ringCount} 道年轮，raw/ 待处理 ${value.pendingShards} 份，` +
              `${value.degraded ? '本轮退潮降级' : '未降级'}，` +
              `${value.pendingRetry ? '有原文待重试（记忆只进不退）' : '无待重试'}。`,
          },
        ],
      },
      execute: async () => {
        const state = await loadState(paths).catch(() => undefined)
        const rings = await listRings(paths).catch(() => [] as RingId[])
        const rawFiles = await fs.readdir(paths.raw).catch(() => [] as string[])
        const pendingShards = rawFiles.filter((name) => /\.(md|txt)$/i.test(name)).length
        const latestRing = state?.lastRing ?? rings[rings.length - 1] ?? ''
        return {
          cycle: state?.cycle ?? 'a',
          latestRing,
          pendingShards,
          degraded: Boolean(state?.degraded),
          pendingRetry: pendingShards > 0,
          ringCount: rings.length,
        }
      },
    }),
  )

  const disposeRemember = ctx.tools.register(
    defineTool({
      name: 'remember_this',
      description:
        '用户明确要求「一定要记得」或给出重要约定/生日时调用：写入承诺锁（COMMITMENTS.md），' +
        '任何模型都不得删除，之后每轮强制注入。',
      parameters: {
        text: { type: 'string', required: true, description: '必须记住的约定原文' },
        expires: { type: 'string', description: '一次性约定的到期日（YYYY-MM-DD），可省略' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pinned: { type: 'boolean', required: true },
            commitmentId: { type: 'string', required: true },
            text: { type: 'string', required: true },
            totalCommitments: { type: 'number', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.pinned
              ? `已写入承诺锁（${value.commitmentId}），当前共 ${value.totalCommitments} 条。它会出现在每一轮注入里，不会被压缩路径删除。`
              : `未能写入承诺锁：${value.message}`,
          },
        ],
      },
      execute: async (args) => {
        const text = String(args.text ?? '').trim()
        if (!text) {
          return { pinned: false, commitmentId: '', text: '', totalCommitments: 0, message: '承诺内容为空，未写入。' }
        }
        try {
          const commitment = await appendCommitment(paths, text, {
            expires: args.expires ? String(args.expires) : undefined,
          })
          const distilled = await readDistilled(paths)
          refreshInjectionCache(config, paths)
          return {
            pinned: true,
            commitmentId: commitment.id,
            text: commitment.text,
            totalCommitments: distilled.commitments.length,
            message: 'ok',
          }
        } catch (error) {
          return {
            pinned: false,
            commitmentId: '',
            text,
            totalCommitments: 0,
            message: `写入失败：${String(error)}`,
          }
        }
      },
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of [disposeRecall, disposeReport, disposeStatus, disposeRemember]) {
      try {
        ;(dispose as unknown as () => void)?.()
      } catch {
        // ignore
      }
    }
  })

  // deps.router 保留给后续可选审校/嵌入扩展（当前检索走词法降级）。
  void deps
}
