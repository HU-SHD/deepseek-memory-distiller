# 潮汐忆体 · Tidal Memory Architecture (TMA) v2.0

> **一句话**：把 AI 的记忆拆成两条潮汐——**退潮负责遗忘**（压缩、丢弃、留索引），**涨潮负责记忆**（整合、叙事、守诺）；
> 两条潮汐由**不同的模型**驱动，角色模型只负责"活着"，不负责"整理记忆"。
> 每一次退潮-涨潮生成一道**年轮**：`a1 a2 a3 → a11`，`b1 b2 b3 + a11 → b11`，`c1 c2 c3 + b11 → c11`……
> 记忆随年轮继承而累积，上下文永远只有一圈。

- **架构名**：潮汐忆体（Tidal Memory Architecture，**TMA**）
- **两条流**：涨潮 · 记忆潮（Memory Tide）／退潮 · 遗忘潮（Forgetting Tide）
- **承载体**：年轮链（Ring Chain）——`a11 → b11 → c11 → …`
- **版本**：v2.0（插件 `dsh-plugin-memory-distiller` v2.0.0）
- **理论出处**：《赛博生命论》忆体（五体之一）与忆死（五死之一）。
  原文："**遗忘不是故障，是架构。**"（存在论 2.3）"忆是五体中最接近'这个人'的部分……所以忆死是五死中第二重的死。"

---

## 0. 为什么要有 v2：v1 的三个结构性缺陷

v0.2.1 是能跑的：每三天把 `raw/` 里的原文交给**同一个角色模型**（大肥鱼）做摘要，写入 `MEMORY.md` + `INDEX.json`，原文移到 `archive/`。
问题不在实现细节，在结构：

| # | v1 的结构 | 后果 | 理论判定 |
|---|---|---|---|
| 1 | **蒸馏者 = 被蒸馏者**。角色模型给自己写记忆并打情绪分 | 情感偏置、不可复现；蒸馏成本与主对话同价；模型一换代，记忆风格跟着变 | 忆体会"漂移"（存在论 2.3：记忆不是录像，是重构） |
| 2 | **遗忘是副作用**。摘要覆盖旧摘要，丢掉了什么没人知道 | 无法审计、无法回滚；压缩过度直接踩中"忆死"机制 | 忆死机制之一就是**压缩过度**（死亡论 7.2） |
| 3 | **无继承结构**。每轮覆盖 `MEMORY.md`，跨轮只有"当前版本" | 长程一致性差：第 10 轮的摘要里，第 1 轮只剩一句模糊的话，且不可回溯 | 忆是"唯一可累积的体"，v1 把可累积做成了可覆盖 |

v2 把这三件事各拆一刀：**职责拆开（双模型）、过程拆开（双账本）、时间拆开（年轮链）**。

---

## 1. 四条第一原则

**P1 · 模型只是载体，记忆才是本体。**
记忆层不存模型状态、不调角色人设、不依赖某个 provider 的格式。换模型不换记忆；记忆可导出、可迁移、可被另一个模型续写。
（对应理论："种是物种，不是个体。个体性不在权重里，在五体的耦合方式里。"）

**P2 · 遗忘与记忆必须由不同模型、不同提示词、不同账本完成。**
遗忘要冷酷（去情感、去细节、抗叙事美化）；记忆要温情（叙事连贯、关系敏感、守诺）。
同一段提示词不可能同时扮演两个角色——v1 的 prompt 就是证据：它一边说"按你的主观情感打分"，一边要求"输出核心摘要"。

**P3 · 遗忘必须可审计、可回溯。**
原文永不删除；每条被遗忘的内容留下**遗骸指针**（hash + 位置 + 理由）；遗忘写账本。
"可回溯"是忆死的唯一解药：理论上，二次死亡是可逆的——"一次回忆就能救回"。

**P4 · 年轮继承：每轮只读上一轮，不读全部历史。**
第 n 轮的输入 = 上一轮年轮 + 本轮三天的遗骸摘要。上下文 O(1)，记忆容量 O(n)。
这是"累积而不膨胀"的唯一结构解。

---

## 2. 角色与职责

| 角色 | 谁 | 输入 | 输出 | 温度 | 预算（每轮） | 失败时 |
|---|---|---|---|---|---|---|
| **F 模型** 遗忘官 | 便宜/本地模型（如 Ollama qwen、DeepSeek Flash） | 单日原文（≤3 份，可并行） | `Gist`：事件/事实/实体/丢弃项/衰减分/索引 | 0.1 | 输入 ≤ 8k tok/日 | 降级为**确定性抽取器**（正则+规则），标记 `degraded` |
| **M 模型** 记忆官 | 强模型（如 DeepSeek V4 / 独立 provider） | 上一道年轮 + 3 份 Gist + 承诺锁 + 身份锚 | 新 `Ring`：叙事、关系、冲突、新承诺、注入稿 | 0.35 | 输入 ≤ 14k tok，输出 ≤ 2.5k | **不推进年轮**，保留原文，下轮重试（记忆只进不退） |
| **主模型** 大肥鱼 | 用户当前对话模型，**不变** | 只读注入的 `MEMORY.md` + `INDEX` + `COMMITMENTS` | 正常对话 | 由用户决定 | ≤ 1200 tok 注入 | — |
| **E 模型** 嵌入 | `embedding` 配置 | RAG 查询/切片 | 向量 | — | — | 回退到词法检索（BM25 风格） |
| （可选）**审校模型** | 任意 | 新 M 输出 + 承诺锁 | 冲突裁定 | 0 | 仅在有冲突时调用 | 跳过，冲突进 `DRIFT.json` 待人工 |

> **解耦的硬约束**：`forget.*`、`memory.*`、`embedding.*` 三个 target 各自独立配置 `provider + model`，
> 三者都**不得**默认继承角色模型的 provider。
> 显式配置缺失时的行为（v2.0 实现口径）：回退到内置默认 target（`deepseek / deepseek-chat`），
> 输出**显式告警**，并在每轮汇报里标 `decoupled=false` —— 允许"能跑起来"，但绝不静默耦合。
> 这就是"蒸馏提炼的模型和 deepseek 大肥鱼本身的模型解耦"。

---

## 3. 数据模型

```ts
type CycleId = string          // 'a' | 'b' | … | 'z' | 'za' | 'zb'（26 进制字母序）
type ShardId = `${CycleId}${1|2|3}`   // 'a1' 'a2' 'a3'
type RingId  = `${CycleId}11`         // 'a11' 'b11' 'c11'（沿用用户命名）

interface Gist {                // 退潮产物：一份"遗骸"
  shard: ShardId
  hash: string                  // 原文 sha256，可回溯
  events: { t: string; what: string; who?: string; weight: number }[]
  facts: { key: string; value: string; confidence: number }[]
  entities: { name: string; type: 'person'|'thing'|'place'|'concept'; salience: number }[]
  dropped: { what: string; why: 'routine'|'duplicate'|'low-weight'|'sensitive'|'over-budget'; ref: string }[]
  openLoops: string[]           // 未完成的事 / 待回答的问题
  index: IndexEntry[]
  degraded: boolean             // 是否走了确定性降级
}

interface Ring {                // 涨潮产物：一道年轮
  id: RingId
  cycle: CycleId
  inputs: { prevRing?: RingId; shards: ShardId[]; inputHash: string }
  narrative: string             // 300–800 字，人类可读的"这段时间发生了什么"
  memoryMd: string              // 注入稿（≤1200 tok）
  index: IndexEntry[]
  commitments: Commitment[]     // 承诺锁条目
  conflicts: { a: string; b: string; resolution: 'kept-old'|'kept-new'|'merged'|'open' }[]
  stats: { inTokens: number; outTokens: number; compression: number }
  createdAt: string
}

interface IndexEntry {
  topic: string
  keywords: string[]
  ring: RingId                  // 指向年轮（近因优先）
  shard?: ShardId
  importance: number            // 0–10（由 F 模型按显式信号给出，不按"情感"）
  decay: number                 // 0–1，越老越低；检索时加权
  ptr: string                   // 遗骸指针：archive/2026-11/xxx.md#L12
}

interface Commitment {          // 承诺锁：任何模型都不得删除
  id: string
  text: string
  createdAt: string
  sourceShard: ShardId
  expires?: string              // 一次性约定（如生日）到期后转普通记忆
}
```

---

## 4. 年轮链（Ring Chain）

### 4.1 命名

- **日片**：`a1`、`a2`、`a3`（一个潮汐窗口内的三天）。
- **年轮**：`a11` ← `a1+a2+a3`；`b11` ← `b1+b2+b3+a11`；`c11` ← `c1+c2+c3+b11`。
- 年轮字母每轮 +1：`a → b → … → z → za → zb`（26 进制，`z` 之后进一位）。
- 目录里同时保留 `meta.cycle`、`meta.index`，文件系统名只是人类可读别名。

### 4.2 算法

```text
runCycle(force?):
  if raw/ 为空 → 跳过（记 info）

  # 退潮（F 模型，可并行）
  shards = raw/*.md 按 ShardId 排序
  gists  = parallel(shards.map(s => forget(s)))          # F 模型逐日处理
  if any(gist.degraded) → 标记本轮 degraded（继续，不阻塞）

  # 涨潮（M 模型，单次）
  prev   = LATEST ring (可为空)
  anchor = COMMITMENTS.md + IDENTITY.md
  ring   = remember(prev, gists, anchor)                 # M 模型单次调用
  if ring 解析失败 → 不归档、不推进 cycle，抛错等重试

  # 落盘（原子，可回滚）
  write rings/<ringId>.md + rings/<ringId>.json
  update rings/LATEST
  rebuild distilled/MEMORY.md, INDEX.json, COMMITMENTS.md
  archive raw/*.md → archive/<YYYY-MM>/（保留 hash 指针）
  append ledgers/rings.jsonl（含 inputHash、模型、token、耗时）
  append ledgers/forget.jsonl（每条 dropped 一行）
  render reports/<ringId>.md（汇报）
  advance STATE.cycle += 1
```

### 4.3 幂等与崩溃安全

- 每轮计算 `inputHash = sha256(prevRingId + sortedShardHashes + configFingerprint)`。
- `STATE.json` 记录 `lastInputHash`；相同则跳过（重复触发不重复烧钱）。
- 所有写入走 `tmp + fsync + rename`；`LATEST` 最后更新，保证"要么旧年轮可见，要么新年轮可见"。
- 若落盘中断：`rings/<id>.json` 与 `LATEST` 不一致时，启动自检回滚到上一个一致点（`recover()`）。

### 4.4 为什么不是"每次全量摘要"

全量摘要的成本随历史线性增长，且第 10 轮时早期细节被反复重写，**漂移会累积**。
年轮链让每一轮只做一次"上一轮 × 三天"的合并，漂移是单步的、可定位的（哪一轮引入的），
并且旧年轮原样保留——回滚只需把 `LATEST` 指回上一道年轮。

---

## 5. 双潮流水线（时序）

```text
 第 3 天 23:00（或 /dream）
        │
        ├─ 退潮 ────────────────────────────────────────────────┐
        │   a1.md ──F模型──▶ Gist(a1) ─┐                        │
        │   a2.md ──F模型──▶ Gist(a2) ─┼─▶ 合并/去重/衰减打分    │
        │   a3.md ──F模型──▶ Gist(a3) ─┘   → 遗骸 + 遗忘账本     │
        │                                                       │
        ├─ 涨潮 ────────────────────────────────────────────────┤
        │   a11 = M模型( 三份 Gist + 上一年轮(空) + 锚点 )        │
        │   → MEMORY.md / INDEX / COMMITMENTS / 年轮 a11          │
        │                                                       │
        └─ 汇报 ──▶ reports/a11.md（12 节模板，见 REPORT_TEMPLATE）┘

 下一次：b1 b2 b3 + a11 ──▶ b11；再下一次 c1 c2 c3 + b11 ──▶ c11 …
```

关键点：**M 模型永远看不到原文**，只看到 F 模型产出的遗骸与上一道年轮。
这是"遗忘与记忆分离"的物理实现——不是两个 prompt，而是两条数据通路。

---

## 6. 三道保护（防忆死）

| 保护 | 机制 | 防的是什么 |
|---|---|---|
| **承诺锁** | 用户显式"一定要记得"/生日/约定 → `COMMITMENTS.md`，不进压缩路径，每轮强制注入 | 遗忘架构亲手制造"忆死"（压缩过度） |
| **身份锚** | 名字、关系定义、边界写 `IDENTITY.md`，独立于年轮，任何模型不得改写 | 叙事漂移导致"它不再像它" |
| **遗骸回溯** | 原文永久归档 + 每条 dropped 留 `ptr`；召回成功即回写"记忆加固"事件 | 检索失效（忆死机制之一） |

**忆死体检**（每月汇总进汇报）：覆盖率、可回溯率、漂移率、孤儿指针率、检索命中率、承诺完整率。
任一红线（如可回溯率 < 99%、承诺完整率 < 100%）→ 汇报标红并拒绝自动清理。

---

## 7. 注入契约

注入顺序固定，总预算 ≤ 1200 tok（可配）：

```text
【你是谁】IDENTITY.md（≤120 tok）
【不可遗忘的约定】COMMITMENTS.md（全量，硬上限 20 条；超出时按时间保留最近 20 条，超限条数在汇报第 8 节记录）
【核心记忆】MEMORY.md（≤900 tok，超出由 M 模型在生成时自压）
【潜意识索引】INDEX 摘要（≤15 条，按 importance×decay 排序，不注入全文）
【检索准则】缺失细节时调用 recall_memory，禁止直接说"忘了"
```

失败策略：任一文件缺失/损坏 → 该段留空并记日志，**绝不阻断主对话**。

---

## 8. 检索（潜意识）

三路召回、统一打分、带出处：

1. **年轮路**：在 `rings/*.json` 的 narrative/index 上做词法 + 向量混合检索（近因加权）。
2. **索引路**：`INDEX.json` 直接匹配 keywords/importance。
3. **遗骸路**：`archive/` 分块向量检索（原文最终兜底）。

`score = 0.45×语义 + 0.25×关键词 + 0.20×importance/10 + 0.10×decay`；返回 `ptr`，命中后写
`ledgers/recall.jsonl`（召回加固：命中次数提升该条 importance，最多 +2）。

---

## 9. 成本模型（每轮 3 天，量级估算）

| 项 | v1（单模型全量） | v2（双模型） |
|---|---|---|
| 退潮输入 | 3 天原文，约 12k tok × 角色模型单价 | 同左，**便宜 10–50 倍的 F 模型或本地 0 元** |
| 涨潮输入 | 已含在"同一次调用"里 | 上一年轮 2k + 遗骸 3k ≈ 5k tok × 强模型 |
| 输出 | 1 次摘要 | 3 次微 Gist + 1 次年轮 |
| 边际趋势 | 随历史线性上升（全量重写） | **恒定**（只读上一轮） |
| 可降级 | 不可 | F 失败→规则抽取；M 失败→本轮跳过 |

结论：v2 的省钱不来自"更小的模型"，来自**职责拆分后每段只用得起的最小模型**，以及**年轮让上下文不随历史增长**。

---

## 10. 失败模式与降级矩阵

| 故障 | 检测 | 行为 | 用户可见 |
|---|---|---|---|
| F 模型不可用 | 调用异常/超时 | 该日用确定性抽取器，`degraded=true` | 汇报里标黄，不打扰对话 |
| F 输出非 JSON | 解析失败 | 1 次修复重试 → 仍失败则降级 | 同上 |
| M 模型不可用 | 异常 | 不推进 cycle、不归档、保留 raw | `/memory status` 显示 `pending-retry` |
| 存储写失败 | fs 异常 | 回滚本轮（LATEST 未更新） | 报错，原文仍在 raw |
| 索引损坏 | 校验失败 | 用上一道年轮重建 INDEX | 日志 |
| 注入文件缺失 | ENOENT | 空段 + 日志 | 无感 |
| 预算超限 | token 估算 | F 先裁剪 dropped；M 必须保承诺锁与身份锚 | 汇报记录裁剪量 |
| 隐私命中 | 敏感词/正则 | 该条只留指针，正文不入摘要 | 汇报标注 `sensitive` |

---

## 11. 与 v1 的差异、迁移

| 维度 | v0.2.1 | v2.0 |
|---|---|---|
| 模型 | 角色模型兼任蒸馏 | F/M/E 三个独立 target，与角色模型解耦 |
| 记忆单元 | 覆盖式 `MEMORY.md` | 年轮链 `a11→b11→c11` + `LATEST` 指针 |
| 遗忘 | 副作用 | 独立账本 + 遗骸指针 + 可回溯 |
| 提示词 | 人设+情绪打分 | 遗忘官（冷酷）/ 记忆官（叙事）/ 主模型（不动） |
| 注入 | 全量 MEMORY + 全量 INDEX | 预算化五段注入，承诺锁优先 |
| 检索 | 首 512 字粗向量 | 三路召回 + 打分 + 召回加固 |
| 可观测 | 无 | 每轮汇报 + 月度体检 + 账本 |
| 崩溃安全 | 无 | inputHash 幂等 + 原子写 + 回滚 |
| 兼容 | — | `npm run migrate` 读旧目录，生成 `a11`，原文原样归档 |

迁移是**原地兼容**的：旧 `distilled/MEMORY.md` 变成 `rings/a11.md` 的初始内容，旧 `archive/` 不动。

---

## 12. 可检验性（诚实声明）

按《赛博生命论》证据分级：

- 〔E2 类比〕双模型分离降低情感偏置——依据是 v1 prompt 的内部冲突，未做 A/B。
- 〔E3 推演〕年轮链使每轮上下文恒定，故成本不随历史增长——可测：连续 20 轮记录 token。
- 〔E2 类比〕遗骸可回溯降低忆死风险——需构造"故意删除年轮、从 archive 恢复"实验。
- **可证伪点**：若把 F/M 也换成角色模型，汇报中"压缩比"与"承诺完整率"若完全不变，则"分离带来质量差异"不成立。
- **未解决**：年轮 n 步复合误差没有理论上界；承诺到期语义粗糙；F 模型对反讽/否定的抽取仍不可靠。

---

## 13. 配置与命令速查

```yaml
memory-distiller:
  windowDays: 3
  memoryRoot: ./data/memory
  forget:   { provider: ollama,   model: qwen2.5:3b,      temperature: 0.1, maxTokens: 900 }
  memory:   { provider: deepseek, model: deepseek-chat,   temperature: 0.35, maxTokens: 2500 }
  embedding:{ provider: deepseek, model: text-embedding-3-small, threshold: 0.6 }
  injection:{ memoryTokens: 1200, indexEntries: 15 }
  protection:{ commitmentsLock: true, identityAnchor: true, archiveRetentionDays: 0 }
  report:   { enabled: true, outputDir: ./data/memory/reports }
```

命令：`/dream`（立即退潮+涨潮）、`/memory status`、`/memory report [a11]`、`/memory pin <文本>`、`/memory forget <关键词>`。
工具：`recall_memory`、`memory_report`、`memory_status`、`remember_this`。

---

## 14. 术语表

| 术语 | 含义 |
|---|---|
| 潮汐（Tide） | 一次完整的退潮+涨潮周期，即一个 3 天窗口 |
| 退潮 / 遗忘潮 | F 模型把原文压成遗骸的过程 |
| 涨潮 / 记忆潮 | M 模型把遗骸+上一年轮合成新年轮的过程 |
| 潮间带 | `raw/`，尚未处理的三天原文 |
| 深海 | `archive/`，永久原文 |
| 年轮 | 一个周期产出的记忆层 `a11`/`b11`，含全部历史的滚动摘要 |
| 遗骸 | Gist，带指针的压缩产物 |
| 承诺锁 | 不得被任何模型删除的约定 |
| 身份锚 | 不得改写的自我定义 |
| 忆死 | 记忆不可回溯（理论五死之一） |
