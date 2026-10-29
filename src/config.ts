import Schema from '@deepseek-ai/schemastery'

export interface Config {
  rawDir: string
  archiveDir: string
  distilledDir: string
  intervalDays: number
  embeddingModel: string
  ragThreshold: number
}

export const ConfigSchema: Schema<Config> = Schema.object({
  rawDir: Schema.string().default('./data/memory/raw/').description('短期/未蒸馏记忆存放目录'),
  archiveDir: Schema.string().default('./data/memory/archive/').description('归档的原始记忆存放目录'),
  distilledDir: Schema.string().default('./data/memory/distilled/').description('蒸馏后的摘要和索引存放目录'),
  intervalDays: Schema.number().default(3).description('自动蒸馏间隔天数'),
  embeddingModel: Schema.string().default('text-embedding-3-small').description('RAG 使用的向量模型'),
  ragThreshold: Schema.number().default(0.6).description('RAG 检索相似度阈值 (0-1)'),
})