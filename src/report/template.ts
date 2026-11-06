/**
 * 每轮潮汐汇报模板（纯函数，零运行时相对导入）。
 *
 * 12 节标题顺序由 Lead 冻结（见 `.ref` 与 docs/REPORT_TEMPLATE.md 对齐要求），
 * 不要改名、不要增删节。
 */

import type { CycleReport, Gist, MemoryHealth, Ring } from '../types'

/* ────────────────────────────── 小工具（纯函数） ────────────────────────────── */

function pct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

function num(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—'
  return String(Number(value.toFixed(digits)))
}

function chars(text: string): number {
  return Array.from(text ?? '').length
}

function redOrOk(ok: boolean, text: string): string {
  return ok ? `✅ ${text}` : `🔴 ${text}`
}

function warnOrOk(ok: boolean, text: string): string {
  return ok ? `✅ ${text}` : `🟡 ${text}`
}

/* ────────────────────────────── 构建 CycleReport ────────────────────────────── */

export function buildCycleReport(args: {
  ring: Ring
  gists: Gist[]
  models: { forget: string; memory: string; decoupled: boolean }
  health: MemoryHealth
  chain: { id: string; inputs: string; sizeBytes: number }[]
  cost: CycleReport['cost']
  ledgerHead: string
  version: string
}): CycleReport {
  const { ring, gists, models, health, cost } = args

  const dropsByReason: Record<string, number> = {}
  let dropped = 0
  for (const gist of gists) {
    for (const item of gist.dropped ?? []) {
      dropped += 1
      dropsByReason[item.why] = (dropsByReason[item.why] ?? 0) + 1
    }
  }

  const degraded = gists.some((gist) => gist.degraded === true)

  const risks: string[] = []
  if (!Number.isFinite(health.traceability) || health.traceability < 0.99) {
    risks.push(`可回溯率 ${pct(health.traceability)} 低于红线 99%：请在 archive/ 补齐遗骸指针，或把 rings/LATEST 指回上一道年轮。`)
  }
  if (!Number.isFinite(health.commitmentIntegrity) || health.commitmentIntegrity < 1) {
    risks.push(`承诺完整率 ${pct(health.commitmentIntegrity)} 低于红线 100%：承诺锁不得被任何模型删除，请从上一轮 COMMITMENTS.md 恢复。`)
  }
  if (Number.isFinite(health.orphanPointers) && health.orphanPointers > 0) {
    risks.push(`存在 ${health.orphanPointers} 个孤儿指针：ptr 指向的归档文件不存在，原文可回溯性受损。`)
  }
  if (Number.isFinite(health.drift) && health.drift > 0.05) {
    risks.push(`漂移率 ${pct(health.drift)} 超过 5%（红线 ≤5%）：本轮冲突未裁定较多，叙事一致性存疑。`)
  }
  if (Number.isFinite(health.retrievalHit) && health.retrievalHit < 0.5) {
    risks.push(`检索命中率 ${pct(health.retrievalHit)} 偏低：索引可能失效，建议检查 INDEX.json 与 embedding 配置。`)
  }
  if (degraded) {
    risks.push('本轮退潮出现确定性降级（degraded=true）：F 模型不可用或输出不可解析，遗骸精度下降（已在汇报中标黄）。')
  }
  if (!models.decoupled) {
    risks.push('forget/memory 未显式解耦（回退到路由模型），违背 P2「遗忘与记忆必须由不同模型完成」：请在插件配置中显式指定两个 target。')
  }

  const next: string[] = []
  if (degraded) next.push('下一轮前检查 F 模型（provider / model / 额度 / 超时），确认退潮恢复非降级路径。')
  if (!models.decoupled) next.push('在插件配置里为 forget 与 memory 分别指定 provider + model，并在下一次汇报中确认「双模型解耦 = 是」。')
  if (health.verdict === 'risk') next.push('先把 rings/LATEST 指回上一道一致年轮，再排查健康度红线，暂缓自动清理。')
  if (next.length === 0) {
    next.push('等待下一个潮汐窗口（windowDays 天后）或由用户执行 /dream 手动触发。')
    next.push('用户追问细节时调用 recall_memory 做三路召回，不要直接回答「忘记了」。')
  }

  const compression = Number.isFinite(ring.stats.compression) ? ring.stats.compression : 0
  const summary =
    `本轮退潮压缩 ${gists.length} 份原文（丢弃 ${dropped} 条，压缩比 ${num(compression)}×），` +
    `涨潮生成年轮 ${ring.id}：${chars(ring.narrative)} 字叙事、${ring.commitments.length} 条承诺锁、` +
    `${ring.conflicts.length} 处冲突${degraded ? '（退潮降级）' : ''}。`

  return {
    version: args.version,
    ring: ring.id,
    cycle: ring.cycle,
    generatedAt: new Date().toISOString(),
    models,
    summary,
    forget: {
      shards: gists.length,
      inTokens: ring.stats.inTokens,
      dropped,
      dropsByReason,
      compression,
      degraded,
    },
    remember: {
      inTokens: ring.stats.inTokens,
      outTokens: ring.stats.outTokens,
      commitments: ring.commitments.length,
      conflicts: ring.conflicts.length,
      narrativeChars: chars(ring.narrative),
    },
    chain: args.chain,
    health,
    risks,
    cost,
    next,
    ledgerHead: args.ledgerHead,
  }
}

/* ────────────────────────────── 渲染 12 节 ────────────────────────────── */

/** 12 节标题（顺序冻结）。 */
export const REPORT_SECTIONS = [
  '## 1. 一句话摘要',
  '## 2. 本轮身份',
  '## 3. 退潮报告（遗忘侧）',
  '## 4. 涨潮报告（记忆侧）',
  '## 5. 年轮链',
  '## 6. 忆体健康度',
  '## 7. 成本账本',
  '## 8. 风险与红线',
  '## 9. 可回溯性与恢复路径',
  '## 10. 下轮计划',
  '## 11. 配置快照',
  '## 12. 账本与索引附录',
] as const

export function renderReport(report: CycleReport): string {
  const lines: string[] = []

  lines.push(`# 潮汐忆体 · 年轮 ${report.ring} 汇报`)
  lines.push('')
  lines.push(`> 插件版本 ${report.version} · 周期 ${report.cycle} · 生成于 ${report.generatedAt}`)
  lines.push('')

  // 1. 一句话摘要
  lines.push(REPORT_SECTIONS[0])
  lines.push('')
  lines.push(report.summary && report.summary.trim() ? report.summary.trim() : '（无摘要）')
  lines.push('')

  // 2. 本轮身份
  lines.push(REPORT_SECTIONS[1])
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 年轮 | ${report.ring} |`)
  lines.push(`| 周期 | ${report.cycle} |`)
  lines.push(`| 生成时间 | ${report.generatedAt} |`)
  lines.push(`| 遗忘模型（F） | ${report.models.forget} |`)
  lines.push(`| 记忆模型（M） | ${report.models.memory} |`)
  lines.push(`| 双模型解耦 | ${report.models.decoupled ? '是（已解耦）' : '否（回退耦合，需显式配置）'} |`)
  lines.push(`| 插件版本 | ${report.version} |`)
  lines.push('')

  // 3. 退潮报告
  lines.push(REPORT_SECTIONS[2])
  lines.push('')
  lines.push('| 指标 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 处理日片 | ${report.forget.shards} |`)
  lines.push(`| 输入 tokens（估算） | ${report.forget.inTokens} |`)
  lines.push(`| 丢弃条目 | ${report.forget.dropped} |`)
  lines.push(`| 压缩比（原文 / 记忆） | ${num(report.forget.compression)}× |`)
  lines.push(`| 降级（degraded） | ${report.forget.degraded ? '⚠️ 是' : '否'} |`)
  lines.push('')
  lines.push('丢弃原因分布：')
  const reasons = Object.entries(report.forget.dropsByReason ?? {})
  if (reasons.length === 0) {
    lines.push('- 无丢弃')
  } else {
    for (const [reason, count] of reasons.sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${reason}: ${count}`)
    }
  }
  lines.push('')

  // 4. 涨潮报告
  lines.push(REPORT_SECTIONS[3])
  lines.push('')
  lines.push('| 指标 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 输入 tokens（估算） | ${report.remember.inTokens} |`)
  lines.push(`| 输出 tokens（估算） | ${report.remember.outTokens} |`)
  lines.push(`| 承诺锁条目 | ${report.remember.commitments} |`)
  lines.push(`| 冲突条目 | ${report.remember.conflicts} |`)
  lines.push(`| 叙事字数 | ${report.remember.narrativeChars} |`)
  lines.push('')

  // 5. 年轮链
  lines.push(REPORT_SECTIONS[4])
  lines.push('')
  if ((report.chain ?? []).length === 0) {
    lines.push('- （尚无年轮）')
  } else {
    lines.push('| 年轮 | 输入 | 大小 |')
    lines.push('| --- | --- | --- |')
    for (const row of report.chain) {
      lines.push(`| ${row.id} | ${row.inputs} | ${(row.sizeBytes / 1024).toFixed(1)} KB |`)
    }
  }
  lines.push('')

  // 6. 忆体健康度
  const health: MemoryHealth = report.health
  lines.push(REPORT_SECTIONS[5])
  lines.push('')
  lines.push('| 指标 | 值 | 红线 | 判定 |')
  lines.push('| --- | --- | --- | --- |')
  lines.push(`| 可回溯率（traceability） | ${pct(health.traceability)} | ≥ 99% | ${redOrOk(health.traceability >= 0.99, health.traceability >= 0.99 ? '通过' : '告警')} |`)
  lines.push(`| 承诺完整率（commitmentIntegrity） | ${pct(health.commitmentIntegrity)} | = 100% | ${redOrOk(health.commitmentIntegrity >= 1, health.commitmentIntegrity >= 1 ? '通过' : '告警')} |`)
  lines.push(`| 漂移率（drift） | ${pct(health.drift)} | ≤ 5% | ${warnOrOk(health.drift <= 0.05, health.drift <= 0.05 ? '通过' : '告警')} |`)
  lines.push(`| 孤儿指针（orphanPointers） | ${health.orphanPointers} | 0 | ${warnOrOk(health.orphanPointers === 0, health.orphanPointers === 0 ? '通过' : '告警')} |`)
  lines.push(`| 检索命中率（retrievalHit） | ${pct(health.retrievalHit)} | ≥ 60% | ${warnOrOk(health.retrievalHit >= 0.6, health.retrievalHit >= 0.6 ? '通过' : '告警')} |`)
  lines.push('')
  lines.push(`综合判定：**${health.verdict}**${health.verdict === 'risk' ? ' 🔴（触发红线，禁止自动清理）' : health.verdict === 'watch' ? ' 🟡（有告警项，建议人工抽检）' : ' ✅（全部通过）'}`)
  lines.push('')
  lines.push('三道保护判定：')
  lines.push(`- ${redOrOk(health.commitmentIntegrity >= 1, `承诺完整率 ${pct(health.commitmentIntegrity)}（红线 100%）`)}`)
  lines.push(`- ${redOrOk(health.traceability >= 0.99, `可回溯率 ${pct(health.traceability)}（红线 99%）`)}`)
  lines.push(`- ${warnOrOk(health.orphanPointers === 0, `孤儿指针 ${health.orphanPointers} 个（红线 0）`)}`)
  lines.push('')

  // 7. 成本账本
  lines.push(REPORT_SECTIONS[6])
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 退潮 tokens（估算） | ${report.cost.forgetTokens} |`)
  lines.push(`| 涨潮 tokens（估算） | ${report.cost.memoryTokens} |`)
  lines.push(`| 估算成本（CNY，估算） | ¥${num(report.cost.estimatedCny, 4)} |`)
  lines.push(`| 相比 v1 单模型节省（估算） | ${pct(report.cost.savedPct)} |`)
  lines.push('')
  lines.push('> 说明：以上 token 与成本均为**估算**（按公开单价量级折算），不是账单；实际费用以 provider 账单为准。')
  lines.push('')

  // 8. 风险与红线
  lines.push(REPORT_SECTIONS[7])
  lines.push('')
  if ((report.risks ?? []).length === 0) {
    lines.push('- 本轮无新增风险')
  } else {
    for (const risk of report.risks) lines.push(`- ${risk}`)
  }
  lines.push('')

  // 9. 可回溯性与恢复路径
  lines.push(REPORT_SECTIONS[8])
  lines.push('')
  lines.push(`账本头（ledgerHead）：`)
  lines.push('')
  lines.push('```text')
  lines.push(report.ledgerHead || '(空)')
  lines.push('```')
  lines.push('')
  lines.push('恢复路径（原文永不删除，任何一轮都可回滚）：')
  lines.push('')
  lines.push('```bash')
  lines.push('# 1) 查看现有年轮')
  lines.push('ls rings/')
  lines.push('# 2) 回滚到上一道年轮：把 rings/LATEST 的内容改成上一道年轮 id')
  lines.push(`#    例如：printf 'a11' > rings/LATEST`)
  lines.push('# 3) 重启插件，启动自检（recover）会把 STATE 对齐到 LATEST；raw/ 中未消费的原文保留待重试')
  lines.push('```')
  lines.push('')

  // 10. 下轮计划
  lines.push(REPORT_SECTIONS[9])
  lines.push('')
  if ((report.next ?? []).length === 0) {
    lines.push('- 等待下一个潮汐窗口。')
  } else {
    for (const item of report.next) lines.push(`- [ ] ${item}`)
  }
  lines.push('')

  // 11. 配置快照
  lines.push(REPORT_SECTIONS[10])
  lines.push('')
  const [forgetProvider, ...forgetModelParts] = report.models.forget.split('/')
  const [memoryProvider, ...memoryModelParts] = report.models.memory.split('/')
  lines.push('```yaml')
  lines.push(`version: ${report.version}`)
  lines.push(`forget:   { provider: ${forgetProvider}, model: ${forgetModelParts.join('/') || '（未配置）'} }`)
  lines.push(`memory:   { provider: ${memoryProvider}, model: ${memoryModelParts.join('/') || '（未配置）'} }`)
  lines.push(`decoupled: ${report.models.decoupled}`)
  lines.push('# embedding / injection 预算由插件配置决定；本报告不输出任何密钥或 provider 凭据')
  lines.push('```')
  lines.push('')

  // 12. 账本与索引附录
  lines.push(REPORT_SECTIONS[11])
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 年轮链条数 | ${(report.chain ?? []).length} |`)
  lines.push(`| 本轮年轮 | ${report.ring} |`)
  lines.push(`| 索引条数 | 见 rings/${report.ring}.json 的 index 数组（年轮 JSON 为准） |`)
  lines.push(`| 账本头 | ${report.ledgerHead || '(空)'} |`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`> 本报告由 memory-distiller v${report.version} 自动生成；原文永久归档于 archive/，承诺锁独立于年轮。`)

  return lines.join('\n')
}
