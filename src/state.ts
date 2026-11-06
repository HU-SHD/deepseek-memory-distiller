/**
 * 周期状态（STATE.json）。
 *
 * STATE 记录「当前周期 / 上一道年轮 / 上一轮的 inputHash」，是幂等与崩溃恢复的锚点：
 * - `lastInputHash` 与本轮相同 → runCycle 直接跳过（不重复烧钱）；
 * - `cycle` 决定下一道年轮是 `b11` 还是 `c11`；
 * - `LATEST` 与年轮文件不一致时，由调用方（index.ts 的 recover）回滚。
 *
 * `advanceCycle` 的实现在 `ring/chain.ts`（纯逻辑、可单测），这里只做再导出，
 * 保证 INTERFACES 规定的 `from './state'` 导入路径可用。
 */
import type { CycleId, RingId } from './types'
import type { MemoryPaths } from './paths'
import { readIfExists, writeAtomic } from './util/atomic'
import { advanceCycle, findPrevRing, parseRingId } from './ring/chain'

export { advanceCycle } from './ring/chain'

/** 持久化到 `<memoryRoot>/STATE.json` 的周期状态。 */
export interface MemoryState {
  /** 状态文件版本，固定 2。 */
  schemaVersion: 2
  /** 当前周期字母：下一道年轮 = ringIdFor(cycle)。 */
  cycle: CycleId
  /** 上一道年轮 id。 */
  lastRing?: RingId
  /** 上一轮计算出的 inputHash，用于幂等跳过。 */
  lastInputHash?: string
  /** 上一轮是否发生过降级（F 模型不可用）。 */
  degraded?: boolean
  /** ISO 时间戳。 */
  updatedAt: string
}

/** 全新状态的默认值（首轮从 a 开始）。 */
function freshState(cycle: CycleId, lastRing?: RingId): MemoryState {
  return {
    schemaVersion: 2,
    cycle,
    ...(lastRing ? { lastRing } : {}),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 读取周期状态。
 *
 * 容错策略（绝不因状态文件损坏阻断记忆主流程）：
 * - 文件缺失 / JSON 损坏 / 版本不符 → 从 `rings/` 推导：有上一道年轮则 cycle 前进一位，
 *   否则从 `a` 开始；
 * - 正常情况下直接返回文件内容（保留 lastInputHash，保证幂等）。
 *
 * @param paths 记忆路径集合
 */
export async function loadState(paths: MemoryPaths): Promise<MemoryState> {
  const raw = await readIfExists(paths.state)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<MemoryState>
      if (parsed.schemaVersion === 2 && typeof parsed.cycle === 'string' && parsed.cycle.length > 0) {
        return {
          schemaVersion: 2,
          cycle: parsed.cycle,
          ...(typeof parsed.lastRing === 'string' ? { lastRing: parsed.lastRing } : {}),
          ...(typeof parsed.lastInputHash === 'string' ? { lastInputHash: parsed.lastInputHash } : {}),
          ...(parsed.degraded === true ? { degraded: true } : {}),
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        }
      }
    } catch {
      // 落到推导逻辑
    }
  }

  // 状态文件缺失/损坏：用年轮目录恢复（崩溃后继续往下走，而不是从头覆盖）
  const lastRing = await findPrevRing(paths)
  const parsedRing = lastRing ? parseRingId(lastRing) : undefined
  const cycle = parsedRing ? advanceCycle(parsedRing.cycle) : 'a'
  return freshState(cycle, lastRing)
}

/**
 * 原子写入周期状态（自动刷新 updatedAt）。
 * @param paths 记忆路径集合
 * @param state 新状态
 */
export async function saveState(paths: MemoryPaths, state: MemoryState): Promise<void> {
  const next: MemoryState = {
    schemaVersion: 2,
    cycle: state.cycle,
    ...(state.lastRing ? { lastRing: state.lastRing } : {}),
    ...(state.lastInputHash ? { lastInputHash: state.lastInputHash } : {}),
    ...(state.degraded ? { degraded: true } : {}),
    updatedAt: new Date().toISOString(),
  }
  await writeAtomic(paths.state, `${JSON.stringify(next, null, 2)}\n`)
}
