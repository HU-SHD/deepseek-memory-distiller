# v2 内部接口契约（Lead 冻结）

> 两个实现 owner 并行开发时的**唯一对接面**。签名不可擅自改；确实需要改动，先发消息给 Lead 或在任务里写明，Lead 统一改本文件。
> 领域类型一律来自 `src/types.ts`（已冻结）。所有路径参数都是 `MemoryPaths`，不要各自拼路径。

## 0. 两个 owner 的边界

| owner | 拥有文件 |
|---|---|
| **core-pipeline** | `src/config.ts` `src/paths.ts` `src/state.ts` `src/ledger.ts` `src/model/**` `src/ring/**` `src/forget/**` `src/remember/**` `src/util/**` |
| **core-surface** | `src/index.ts` `src/inject.ts` `src/tools.ts` `src/commands.ts` `src/store/**` `src/retrieve/**` `src/report/**` `src/migrate.ts` |

两侧都**只读** `src/types.ts`；`docs/ARCHITECTURE.md` 是行为规格；`.ref/dsh-plugin-api-0.2.2.md` 是 DSH API 依据。

## 1. core-pipeline 导出

```ts
// src/paths.ts
export interface MemoryPaths {
  root: string; raw: string; archive: string; rings: string;
  distilled: string; reports: string; ledgers: string;
  state: string; latest: string;              // STATE.json / rings/LATEST
}
export function resolvePaths(memoryRoot: string): MemoryPaths
export async function ensureLayout(paths: MemoryPaths): Promise<void>

// src/config.ts
export const ConfigSchema: Schema<Config>        // 与 types.ts 的 Config 完全一致
export interface ResolvedTargets {
  forget: ModelTarget; memory: ModelTarget; embedding: Config['embedding'];
  /** 两个 target 是否都显式配置（false 表示回退到路由模型，汇报里要标 coupled） */
  decoupled: boolean
}
export function resolveTargets(config: Config): ResolvedTargets
export function configFingerprint(targets: ResolvedTargets): string

// src/state.ts
export interface MemoryState {
  schemaVersion: 2; cycle: CycleId; lastRing?: RingId;
  lastInputHash?: string; degraded?: boolean; updatedAt: string
}
export async function loadState(paths: MemoryPaths): Promise<MemoryState>
export async function saveState(paths: MemoryPaths, state: MemoryState): Promise<void>
export function advanceCycle(cycle: CycleId): CycleId     // 'a'→'b'…'z'→'za'

// src/ledger.ts
export function ledgerHead(records: LedgerRecord[]): string
export async function appendLedger(paths: MemoryPaths, record: LedgerRecord): Promise<void>
export async function readRingsLedger(paths: MemoryPaths): Promise<RingLedgerRecord[]>

// src/ring/chain.ts
export function shardIdsFor(cycle: CycleId, windowDays: number): ShardId[]  // ['a1','a2','a3']
export function ringIdFor(cycle: CycleId): RingId                          // 'a11'
export function parseRingId(id: string): { cycle: CycleId } | undefined
export function computeInputHash(prevRing: RingId | undefined, shardHashes: string[], configFp: string): string
export async function findPrevRing(paths: MemoryPaths): Promise<RingId | undefined>
export async function listRings(paths: MemoryPaths): Promise<RingId[]>

// src/model/gateway.ts
export interface ChatRequest {
  system?: string; prompt: string; temperature: number; maxTokens: number;
  timeoutMs: number; purpose: string
}
export interface ChatResult { text: string; inputTokens?: number; outputTokens?: number }
export interface LlmGateway { chat(target: ModelTarget, req: ChatRequest): Promise<ChatResult> }
export function createDshGateway(ctx: Context): LlmGateway
export interface ModelUsage { role: 'forget'|'memory'; inputTokens: number; outputTokens: number; calls: number }
export class UsageMeter { add(role: 'forget'|'memory', r: ChatResult): void; snapshot(): ModelUsage[]; reset(): void }

// src/model/json.ts
export function extractJson<T>(text: string): T          // 容忍 ```json 围栏、前后废话；失败抛 JsonParseError
export class JsonParseError extends Error { raw: string }

// src/model/router.ts
export interface ModelRouter {
  forget: LlmGateway; memory: LlmGateway; meter: UsageMeter;
  probe(): Promise<{ ok: boolean; detail: string }>
}
export function createRouter(ctx: Context, targets: ResolvedTargets): ModelRouter

// src/util/tokens.ts
export function estimateTokens(text: string): number      // 中文≈1字1token，英文≈4字符1token，混合估算
export function truncateToTokens(text: string, max: number): string

// src/util/atomic.ts
export async function writeAtomic(file: string, data: string): Promise<void>
export async function readIfExists(file: string): Promise<string | undefined>

// src/util/text.ts
export function sha256(text: string): string
export function normalizeText(text: string): string
export function bulletize(lines: string[], max: number): string

// src/forget/deterministic.ts
export function extractDeterministic(shard: ShardId, raw: string, ring: RingId): Gist

// src/forget/forgetter.ts
export interface ForgetDeps { router: ModelRouter; paths: MemoryPaths }
export async function forgetShard(deps: ForgetDeps, shard: ShardId, raw: string): Promise<Gist>
  // 失败时不得抛出：内部降级为 extractDeterministic + degraded=true，并记日志

// src/remember/integrator.ts
export interface AnchorSet { identity: string; commitments: Commitment[] }
export interface RememberDeps { router: ModelRouter; paths: MemoryPaths }
export async function integrate(deps: RememberDeps, args: {
  prevRing?: Ring; gists: Gist[]; anchors: AnchorSet; cycle: CycleId; config: Config
}): Promise<Ring>   // 解析失败抛错（由调用方决定不推进）
```

## 2. core-surface 导出

```ts
// src/report/template.ts
export function renderReport(report: CycleReport): string   // 12 节 Markdown，纯函数
export function buildCycleReport(args: {
  ring: Ring; gists: Gist[]; models: { forget: string; memory: string; decoupled: boolean };
  health: MemoryHealth; chain: { id: RingId; inputs: string; sizeBytes: number }[];
  cost: CycleReport['cost']; ledgerHead: string; version: string
}): CycleReport

// src/report/health.ts
export async function computeHealth(paths: MemoryPaths, ring: Ring, ringCtx: {
  commitments: Commitment[]; conflicts: Conflict[]
}): Promise<MemoryHealth>

// src/store/distilled.ts
export async function writeDistilled(paths: MemoryPaths, ring: Ring, config: Config): Promise<void>
export async function readDistilled(paths: MemoryPaths): Promise<{
  memory: string; index: IndexEntry[]; commitments: Commitment[]; identity: string
}>
export async function readAnchors(paths: MemoryPaths, config: Config): Promise<AnchorSet>

// src/store/archive.ts
export async function archiveShards(paths: MemoryPaths, shards: { id: ShardId; file: string }[], ring: RingId): Promise<void>
export async function resolvePointer(paths: MemoryPaths, ptr: string): Promise<string | undefined>
export async function verifyTraceability(paths: MemoryPaths, index: IndexEntry[]): Promise<MemoryHealth['traceability']>

// src/retrieve/rag.ts
export interface RagDeps {
  getEmbedding?: (text: string) => Promise<number[] | undefined>
  threshold: number
}
export async function recall(paths: MemoryPaths, query: string, opts: RecallOptions, deps: RagDeps): Promise<RecallHit[]>

// src/migrate.ts
export interface MigrateResult { migrated: boolean; message: string; ring?: RingId }
export async function migrateFromV1(paths: MemoryPaths, config: Config, models: {
  forget: string; memory: string
}): Promise<MigrateResult>

// src/inject.ts
export function buildMemoryPrompt(distilled: Awaited<ReturnType<typeof readDistilled>>, config: Config): string
export function registerInjection(ctx: Context, config: Config, paths: MemoryPaths): void

// src/tools.ts
export function registerTools(ctx: Context, config: Config, paths: MemoryPaths, deps: {
  router: ModelRouter; targets: ResolvedTargets
}): void

// src/commands.ts
export function registerCommands(ctx: Context, config: Config, paths: MemoryPaths, deps: {
  runCycle: (opts: { force?: boolean; dryRun?: boolean }) => Promise<{ ring?: RingId; skipped: string }>
  router: ModelRouter
}): void

// src/index.ts
export const name = 'memory-distiller'
export const inject: string[]
export function apply(ctx: Context, config: Config): void
```

## 3. 耦合点提醒

- `index.ts` 自己实现 `runCycle()`（调度器），内部按顺序调用：`loadState → 读 raw → forgetShard×N → integrate → writeDistilled/archive → appendLedger → renderReport → saveState`。它属于 core-surface。
- `report` 的 `CycleReport.chain` 由 index 从 `listRings()` 统计；`health` 由 `computeHealth()` 给。
- 双方都把 `ctx.logger.info/warn/error` 当可选依赖：纯逻辑函数不接 ctx，便于单测。

## 4. 已冻结的实现细节（v2.0 定稿）

- **遗骸指针格式**：`archive/<YYYY-MM>/<shard>.md#L<行号>`（UTC 月桶；行号从 1 开始）。
  F 模型只可信 `#L行号`，路径由 `ring/chain` + `store/archive` 按同一规则拼，不得出现别的形状。
- **归档同名策略**：同一 `shard` 在同月桶再次归档时**原子覆盖**（不追加 hash 后缀），
  保证指针可预测；覆盖前若内容 hash 不同，记一条 warn（正常重试内容应完全一致）。
- **年轮进位**：`a→b→…→z→za→zb→…→zz→zaa`（逢 z 进位；排序先长度后字典序）。
- **循环依赖处理**：`advanceCycle` 实现在 `ring/chain.ts`，由 `state.ts` re-export；
  `state.ts` 的对外导入路径保持不变。
- **router 的 target 回填**：`ForgetDeps`/`RememberDeps` 不携带 config，target 由
  `createRouter` 绑定的 WeakMap 取回（`targetsOf(router)`）；手工构造 router 时回退
  规范默认（forget 0.1/900/60s，memory 0.35/2500/120s）。

