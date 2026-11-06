/**
 * 年轮链（Ring Chain）：周期命名、26 进制进位、inputHash、年轮枚举。
 *
 * 本模块是「零运行时相对导入」的纯逻辑模块（只依赖 `node:fs` / `node:crypto`
 * 与类型），因此 `node --test tests/` 可以直接加载它做单测。
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import type { CycleId, RingId, ShardId } from '../types'
import type { MemoryPaths } from '../paths'

/**
 * 本地 sha256（与 util/text.sha256 实现一致）。
 * 内联是为了保持本模块零运行时相对导入，可被 Node 原生 TS 测试直接加载。
 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 26 进制字母表（a 为最小位）。 */
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/**
 * 周期进位：`a → b → … → y → z → za → zb → …`。
 *
 * 规则：把周期视为 26 进制字母计数，末位 +1；末位是 `z` 时向高位进位，
 * 全部位都溢出时在最前面补一个 `z`（因此 `z → za`、`zz → zaa`）。
 * 这样 `z` 之后确实「进一位」，且与 `shardIdsFor` / `ringIdFor` 的拼接规则一致。
 *
 * @param cycle 当前周期字母（如 'a'、'z'、'za'）
 * @returns 下一个周期字母；非法输入原样返回
 */
export function advanceCycle(cycle: CycleId): CycleId {
  const chars = Array.from(cycle)
  if (chars.length === 0) return 'a'
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = LETTERS.indexOf(chars[i])
    if (index < 0) return cycle // 非字母周期，不做猜测
    if (index < LETTERS.length - 1) {
      chars[i] = LETTERS[index + 1]
      return chars.join('')
    }
    chars[i] = 'a'
  }
  // 所有位都是 z：整体溢出，补一个 z 前缀
  chars.unshift('z')
  return chars.join('')
}

/**
 * 周期的序：用于年轮排序，规则与 {@link advanceCycle} 一致——
 * 先按长度、再按字典序（'z' < 'za' < 'zb' … < 'zz' < 'zaa' …）。
 *
 * 本进位方案下：长度 1 是 a–z（26 个）；长度 L≥2 的周期都以 `z` 开头，
 * 后接 L-1 个任意字母，因此第 L 层的起始序为
 * `26 + (26^(L-1) - 26) / 25`。
 */
export function cycleOrdinal(cycle: CycleId): number {
  const chars = Array.from(cycle)
  if (chars.length === 0) return -1
  const first = LETTERS.indexOf(chars[0])
  if (chars.length === 1) return first < 0 ? -1 : first
  const base = LETTERS.length + (LETTERS.length ** (chars.length - 1) - LETTERS.length) / (LETTERS.length - 1)
  let suffix = 0
  for (let i = 1; i < chars.length; i++) {
    const index = LETTERS.indexOf(chars[i])
    suffix = suffix * LETTERS.length + (index < 0 ? 0 : index)
  }
  return base + suffix
}

/**
 * 一个潮汐窗口内的日片 id：`windowDays=3` + `cycle='a'` → `['a1','a2','a3']`。
 * @param cycle      周期字母
 * @param windowDays 窗口天数（`<= 0` 返回空数组）
 */
export function shardIdsFor(cycle: CycleId, windowDays: number): ShardId[] {
  const days = Math.max(0, Math.floor(windowDays))
  return Array.from({ length: days }, (_, index) => `${cycle}${index + 1}`)
}

/** 由周期得到年轮 id：`'a'` → `'a11'`。 */
export function ringIdFor(cycle: CycleId): RingId {
  return `${cycle}11`
}

/**
 * 解析年轮 id：`'a11'` → `{ cycle: 'a' }`；非法（如 `'a1'`、`'11'`）返回 undefined。
 */
export function parseRingId(id: string): { cycle: CycleId } | undefined {
  const match = /^([a-z]+)11$/.exec(id.trim())
  if (!match) return undefined
  return { cycle: match[1] }
}

/**
 * 计算一轮的幂等指纹：
 * `sha256(prevRing ?? '' + '\n' + 排序后的日片 hash + '\n' + 配置指纹)`。
 *
 * 日片 hash 先排序，保证「并行处理顺序不同」不影响结果；
 * 配置指纹变化（换模型/换温度）也算一次新输入，避免复用旧年轮。
 *
 * @param prevRing     上一道年轮 id（首轮为空）
 * @param shardHashes  本轮各日片原文的 sha256（顺序无关）
 * @param configFp     配置指纹（见 config.configFingerprint）
 */
export function computeInputHash(prevRing: RingId | undefined, shardHashes: string[], configFp: string): string {
  const sorted = [...shardHashes].sort()
  return sha256(`${prevRing ?? ''}\n${sorted.join('\n')}\n${configFp}`)
}

/**
 * 枚举 `rings/` 下的全部年轮 id，按周期序排序（`a11, b11, … z11, za11 …`）。
 * 目录不存在时返回空数组；无法识别的文件名被忽略。
 */
export async function listRings(paths: MemoryPaths): Promise<RingId[]> {
  let files: string[]
  try {
    files = await readdir(paths.rings)
  } catch {
    return []
  }
  const rings: { id: RingId; order: number }[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)
    const parsed = parseRingId(id)
    if (!parsed) continue
    rings.push({ id, order: cycleOrdinal(parsed.cycle) })
  }
  rings.sort((a, b) => a.order - b.order)
  return rings.map((item) => item.id)
}

/**
 * 找上一道年轮：优先读 `rings/LATEST`；若 LATEST 缺失/损坏，
 * 回退到 `rings/` 中周期序最大的年轮（崩溃恢复友好）。
 */
export async function findPrevRing(paths: MemoryPaths): Promise<RingId | undefined> {
  try {
    const latest = (await readFile(paths.latest, 'utf8')).trim()
    if (parseRingId(latest)) return latest
  } catch {
    // LATEST 不存在或不可读，走回退
  }
  const rings = await listRings(paths)
  return rings.length > 0 ? rings[rings.length - 1] : undefined
}
