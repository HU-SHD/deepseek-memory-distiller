# 潮汐忆体 · Tidal Memory Architecture (TMA)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-purple.svg)]()
[![version](https://img.shields.io/badge/version-2.0.0-blue.svg)](CHANGELOG.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)]()

> **一句话**：把 AI 的记忆拆成两条潮汐——**退潮负责遗忘**，**涨潮负责记忆**，**年轮负责继承**。角色模型只负责"活着"，不负责"整理记忆"。

潮汐忆体（Tidal Memory Architecture，**TMA**）是给 DSH（DeepSeek Harness）用的长期记忆插件。它让 AI 的记忆不再随对话无限膨胀，也不会因为换模型而整体失忆：每 3 天一次潮汐，把原文压成可回溯的**遗骸**，把遗骸合成一圈**年轮**，再把年轮链条一路继承下去——`a1 a2 a3 → a11`，`b1 b2 b3 + a11 → b11`，`c1 c2 c3 + b11 → c11`。

> v0.2.1 是个粗糙初版：它能跑，但更像"定期把日记本撕掉重抄一遍"，而不是记忆。v2.0 把这件事认真拆开了。当然，它大概还是粗糙的——只是粗糙得更有结构了。嘻嘻。

---

## 30 秒判断：要不要用

| 适合你，如果…… | 可能不适合，如果…… |
|---|---|
| 你希望 AI **长期记得你**，但上下文别爆炸 | 你只是要一个向量库 / 文档问答机器人 |
| 你接受"遗忘"是设计的一部分，且必须**可审计、可回滚** | 你要求所有原文逐字保留在注入里，不接受压缩 |
| 你愿意为"遗忘"和"记忆"各配一个模型（贵模型只做记忆） | 你只有一个模型，且不想多配一个 target |
| 你在 DSH 上跑，想要一个真正跨会话的个人助手 | 你在非 DSH 平台（当前未适配） |
| 你在意"换模型不换记忆"：记忆可导出、可被另一个模型续写 | 你需要多用户 / 多租户的云端记忆服务（非目标场景） |

---

## 这是什么

给大语言模型做长期记忆，常见的两种做法都不太像"记忆"：

- **全量塞上下文**：每轮把所有历史塞进去。Token 随对话线性爆炸，迟早塞不下。
- **覆盖式摘要**：每隔几天把历史压成一份 `MEMORY.md` 覆盖旧的。Token 省了，但**丢了什么没人知道**，也无法回滚；更糟的是，摘要由角色模型自己写，模型一换代，记忆的"人格"就漂移了。

潮汐忆体换了一个结构：**记忆不是一个文件，是一条年轮链**。

- 一个**潮汐窗口**（默认 3 天）结束后触发一次潮汐；
- **退潮（遗忘潮）**：便宜的 F 模型逐日压缩原文，产出**遗骸 Gist**——事件、事实、实体、丢弃项，每条丢弃都留下理由和**遗骸指针**（能指回 `archive/` 里的原文）；
- **涨潮（记忆潮）**：强的 M 模型只读「上一道年轮 + 这 3 份遗骸 + 承诺锁 + 身份锚」，合成一道**新年轮**——叙事、注入稿、索引、承诺、冲突都写进去；
- 主对话模型（也就是你平时聊天的"大肥鱼"）**只读注入的短记忆**，不参与整理，也看不到原文。

关键点：**M 模型永远看不到原文**。这不是两个 prompt 的分工，而是两条数据通路——"遗忘"和"记忆"在物理上被隔开了。

---

## 为什么做：v0.2.1 的三个结构性缺陷

v0.2.1 是能跑的：每 3 天把 `raw/` 里的原文交给**同一个角色模型**做摘要，写入 `MEMORY.md` + `INDEX.json`，原文移入 `archive/`。问题不在实现细节，在结构：

| # | v1 的结构 | 后果 | 理论判定 |
|---|---|---|---|
| 1 | **蒸馏者 = 被蒸馏者**。角色模型给自己写记忆、打情绪分 | 情感偏置、不可复现；模型一换代，记忆风格跟着变；蒸馏成本与主对话同价 | 忆体会"漂移"：记忆不是录像，是重构 |
| 2 | **遗忘是副作用**。新摘要覆盖旧摘要，丢掉了什么没人知道 | 无法审计、无法回滚；压缩过度会直接踩中"忆死"机制 | "忆死"机制之一就是**压缩过度** |
| 3 | **无继承结构**。每轮覆盖 `MEMORY.md`，跨轮只有"当前版本" | 第 10 轮的摘要里，第 1 轮只剩一句模糊的话，且不可回溯 | 忆是"唯一可累积的体"，v1 把可累积做成了可覆盖 |

v2 对这三件事各拆一刀：**职责拆开（双模型）、过程拆开（双账本）、时间拆开（年轮链）**。

---

## 双潮架构

```text
              ┌──────────────── 潮汐窗口：默认 3 天 ────────────────┐
              │                                                     │
 raw/a1.md ─┐ │  退潮 · 遗忘潮（F 模型，温度 0.1，冷）              │
 raw/a2.md ─┼▶│  逐日压缩 → 遗骸 Gist：事件/事实/实体/丢弃项         │
 raw/a3.md ─┘ │  每条丢弃带「理由 + 遗骸指针 ptr」，指向 archive/    │
              │                        │                            │
              │                        ▼                            │
 rings/a11 ──▶│  涨潮 · 记忆潮（M 模型，温度 0.35，暖）              │
 COMMITMENTS ▶│  上一年轮 + 3 份遗骸 + 承诺锁 + 身份锚               │
 IDENTITY ───▶│  → 新年轮 b11：叙事 + 注入稿 + 索引 + 承诺 + 冲突    │
              │                        │                            │
              │                        ▼                            │
              │  落盘：rings/ · distilled/ · reports/ · archive/     │
              │        账本：ledgers/ · 状态：STATE.json             │
              └─────────────────────────────────────────────────────┘
```

**年轮链**（每轮只读上一圈，不读全部历史）：

```text
a1  a2  a3 ──▶ a11 ──┐
b1  b2  b3 ──────────┴──▶ b11 ──┐
c1  c2  c3 ─────────────────────┴──▶ c11 ──▶ …
```

- **上下文 O(1)**：M 模型每轮只吃「上一圈 + 三天遗骸」，不随历史增长；
- **容量 O(n)**：旧年轮原样保留，记忆随年轮累积；
- **漂移可定位**：哪一圈引入了什么变化，可以逐圈查账本；
- **回滚只需改指针**：把 `rings/LATEST` 指回上一道年轮即可，旧文件不会被覆盖。

术语速记：**退潮** = 遗忘（F 模型压成遗骸）；**涨潮** = 记忆（M 模型合成年轮）；**遗骸** = 带指针的压缩产物；**承诺锁** = 任何模型都不得删除的约定；**身份锚** = 不得改写的自我定义。

---

## 核心特性

### 1. 双模型解耦：蒸馏者 ≠ 被蒸馏者

`forget` / `memory` / `embedding` 是三个**独立配置的 target**，各自有 `provider + model + temperature + maxTokens + timeoutMs`，默认不继承角色模型：

- **F 模型（遗忘官）**：便宜 / 本地模型即可，温度 0.1，只负责"冷酷地压"；
- **M 模型（记忆官）**：强模型，温度 0.35，只负责"温情地记"，并且**永远看不到原文**；
- **E 模型（嵌入）**：只服务于检索，可单独换。

换模型不换记忆：记忆层不存模型状态、不依赖 provider 格式。未显式配置时插件会回退到内置默认 target（`deepseek/deepseek-chat`），并在汇报里标 `coupled`——能用，但不是解耦的本意。

### 2. 遗忘可审计：每条被丢弃的内容都有理由和指针

遗忘不是"摘要覆盖"的副作用，而是一个独立过程：

- 原文**永不删除**，移入 `archive/`（新归档按 `archive/YYYY-MM/` 分目录）；
- 每条被丢弃的内容写 `ledgers/forget.jsonl`，带 `what / why / ptr`；`why` 是 `routine` / `duplicate` / `low-weight` / `sensitive` / `over-budget` 之一；
- `ptr` 指回原文位置（如 `archive/2026-11/a1.md#L12`），**召回成功即回写"记忆加固"事件**；
- 因此"遗忘"可审计、可回溯、可回滚——这是对"忆死"的唯一解药。

### 3. 年轮继承：上下文不膨胀，记忆能累积

每轮涨潮只读上一道年轮 + 本轮遗骸，不重读全部历史。成本恒定、漂移单步可定位。旧年轮是追加式保存的，回滚只需改 `rings/LATEST` 指针。

### 4. 三道保护：把"忆死"当成工程红线

| 保护 | 机制 | 防的是什么 |
|---|---|---|
| **承诺锁** | 明确的约定 / 生日 / "一定要记得" → `COMMITMENTS.md`，不进压缩路径，每轮强制注入 | 遗忘架构亲手制造"忆死"（压缩过度） |
| **身份锚** | 名字、关系定义、边界写 `IDENTITY.md`，独立于年轮，任何模型不得改写 | 叙事漂移导致"它不再像它" |
| **遗骸回溯** | 原文永久归档 + 每条 dropped 留 `ptr`；检索命中回写加固 | 检索失效（忆死机制之一） |

每轮汇报计算**忆死体检**五项：可回溯率、承诺完整率、漂移率、孤儿指针、检索命中率。任一红线触发（如可回溯率 < 99%、承诺完整率 < 100%）→ 汇报标红告警；归档清理功能在 v2.1 才实现，当前默认永久保留原文。

### 5. 每轮汇报：只写可核对的事实

每轮结束生成 `reports/<年轮>.md`，12 节固定模板：一句话摘要、本轮身份、退潮报告、涨潮报告、年轮链、忆体健康度、成本账本、风险红线、可回溯性与恢复路径、下轮计划、配置快照、账本索引附录。每个数字都能回查账本，估算一律标注。

完整模板、填写规则和示例见 [docs/REPORT_TEMPLATE.md](docs/REPORT_TEMPLATE.md)。

### 还有

- **崩溃安全**：原子写（`tmp + fsync + rename`）+ `inputHash` 幂等 + `LATEST` 最后更新 + 启动自检回滚；
- **确定性降级**：F 模型不可用或输出非 JSON → 规则抽取，标 `degraded`，不阻塞潮汐；
- **失败不丢记忆**：M 模型失败 → 不推进年轮、保留原文，下轮重试；
- **三路检索**：年轮路 + 索引路 + 遗骸路，统一打分 `0.45×语义 + 0.25×关键词 + 0.20×importance/10 + 0.10×decay`，返回出处 `ptr`；
- **注入预算化**：五段固定注入，总预算默认 ≤ 1200 tok，任一文件缺失只留空，绝不阻断主对话。

主对话看到的注入顺序（不超过预算）：

```text
【你是谁】IDENTITY.md
【不可遗忘的约定】COMMITMENTS.md
【核心记忆】MEMORY.md
【潜意识索引】INDEX 摘要（按 importance × decay 排序）
【检索准则】缺细节就调用 recall_memory，禁止直接说"忘了"
```

---

## 快速开始

**前置**：DSH `0.2.2-rc.1`、Node.js ≥ 18（跑 `npm test` 需要 Node 24）、一个可用的模型 provider（`forget` 可以用本地 Ollama，`memory` 建议用强模型）。

```bash
git clone https://github.com/HU-SHD/deepseek-memory-distiller.git
cd deepseek-memory-distiller
npm install
npm run build
npm run typecheck   # 可选：编译期类型检查，0 error 才算过
```

把插件挂进 DSH 的 patch 文件（本仓库自带 `cordis.patch.yml` 模板，本地开发直接指向 TS 源码）：

```yaml
# cordis.patch.yml
- insert:
    - id: memory-distiller
      name: './src/index.ts'          # 开发态直接指源码；构建后也可用 './dist/index.js' 或发布包名
      config:
        memoryRoot: './data/memory'   # 记忆根目录（首次启动自动创建）
        windowDays: 3                 # 每 3 天一次潮汐
        forget:                       # 退潮：便宜的模型
          provider: ollama
          model: qwen2.5:3b
          temperature: 0.1
          maxTokens: 900
          timeoutMs: 60000
        memory:                       # 涨潮：强模型
          provider: deepseek
          model: deepseek-chat
          temperature: 0.35
          maxTokens: 2500
          timeoutMs: 120000
        embedding:
          provider: deepseek
          model: text-embedding-3-small
          threshold: 0.6
        injection:
          memoryTokens: 1200
          indexEntries: 15
          commitments: 20
        protection:
          commitmentsLock: true
          identityAnchor: true
          archiveRetentionDays: 0     # 0 = 永久保留
        report:
          enabled: true
          outputDir: './data/memory/reports'
        migration:
          auto: true
        debug: false
```

启动 DSH 并加载 patch：

```bash
dsh web --patch ./cordis.patch.yml
```

然后在对话里：

```text
/dream              # 立即手动触发一次潮汐（退潮 + 涨潮）；/dream --dry-run 只预演
/memory status      # 查看周期、最新年轮、待处理原文、降级/待重试、承诺与索引数量
/memory report b11  # 查看某一轮汇报
```

日常不需要手动触发：插件会按 `windowDays` 自动跑潮汐；`raw/` 为空时自动跳过（不烧 token）。注意：**插件当前不主动截获对话原文**，你需要把每天要记住的内容（对话记录或摘要）以 `.md` 写进 `data/memory/raw/`，潮汐到点时再统一处理——这也是 v0.2.1 的既有约定。

开发调试：

```bash
npm run dev    # tsc --watch
npm test       # 纯逻辑单测（Node 24，node --test）
```

---

## 配置项

### 顶层

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `memoryRoot` | string | `./data/memory` | 记忆根目录，首次启动自动创建全套子目录 |
| `windowDays` | number | `3` | 一次潮汐窗口的天数（一个窗口产出 1 道年轮） |

### 模型 target（`forget` / `memory` / `embedding`）

`forget` 与 `memory` 共用 `ModelTarget` 结构（`provider / model / temperature / maxTokens / timeoutMs`）；`embedding` 只有 `provider / model / threshold`。

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `forget.provider` | string | 空（回退 `deepseek`） | 遗忘官 provider 路由名，如 `ollama` |
| `forget.model` | string | 空（回退 `deepseek-chat`） | 遗忘官模型，如 `qwen2.5:3b` |
| `forget.temperature` | number | `0.1` | 遗忘要冷：低温度、去情感、抗叙事美化 |
| `forget.maxTokens` | number | `900` | 单日片遗骸的输出上限 |
| `forget.timeoutMs` | number | `60000` | 单次日片调用超时（毫秒） |
| `memory.provider` | string | 空（回退 `deepseek`） | 记忆官 provider，如 `deepseek` |
| `memory.model` | string | 空（回退 `deepseek-chat`） | 记忆官模型，如 `deepseek-chat` 或更强的模型 |
| `memory.temperature` | number | `0.35` | 记忆要暖：叙事连贯、关系敏感、守诺 |
| `memory.maxTokens` | number | `2500` | 单次年轮生成的输出上限 |
| `memory.timeoutMs` | number | `120000` | 单次涨潮调用超时（毫秒） |
| `embedding.provider` | string | `deepseek` | 嵌入模型 provider（检索用） |
| `embedding.model` | string | `text-embedding-3-small` | 嵌入模型名 |
| `embedding.threshold` | number | `0.6` | 语义检索相似度阈值（0–1，越高越严格） |

> 三个 target 相互独立、互不继承。`forget` / `memory` 的 `provider` 与 `model` 任一为空即视为**未显式配置**：插件会回退到内置默认 target（`deepseek/deepseek-chat`），并在汇报中标 `coupled`（解耦失败，需要修配置），而不是拒绝启动。

### 注入 / 保护 / 汇报 / 迁移

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `injection.memoryTokens` | number | `1200` | 每轮注入总预算（token） |
| `injection.indexEntries` | number | `15` | 潜意识索引注入条数上限 |
| `injection.commitments` | number | `20` | 承诺锁注入条数硬上限（超出按时间截断） |
| `protection.commitmentsLock` | boolean | `true` | 承诺锁：承诺不进压缩路径、每轮强制注入 |
| `protection.identityAnchor` | boolean | `true` | 身份锚：`IDENTITY.md` 独立于年轮、模型不得改写 |
| `protection.archiveRetentionDays` | number | `0` | 原文归档保留天数；`0` = 永久保留。**预留字段（v2.1 实现自动清理）** |
| `report.enabled` | boolean | `true` | 每轮生成 `reports/<年轮>.md` 汇报 |
| `report.outputDir` | string | `./data/memory/reports` | 汇报输出目录；留默认时落在 `<memoryRoot>/reports`，自定义相对路径按进程 cwd 解析 |
| `migration.auto` | boolean | `true` | 启动时自动检测并迁移 v0.2.1 数据（幂等，安全） |
| `debug` | boolean | `false` | 调试日志开关。**预留字段（v2.1 细化日志分级）** |

---

## 命令与工具

### 斜杠命令

| 命令 | 作用 | 示例 |
|---|---|---|
| `/dream [--dry-run]` | 立即手动触发一次潮汐（退潮 + 涨潮）；`--dry-run` 只预演不落盘；`raw/` 为空或输入未变则跳过 | `/dream` |
| `/memory status` | 查看周期、最新年轮、年轮总数、`raw/` 待处理、降级/待重试、承诺锁与索引条目数 | `/memory status` |
| `/memory report [年轮]` | 查看某一轮汇报，省略年轮则读最新一份 | `/memory report b11` |
| `/memory pin <文本>` | 登记一条承诺锁（任何模型不得删除，每轮强制注入） | `/memory pin 下周五是我生日` |
| `/memory forget <关键词>` | 从索引中移除匹配条目（原文仍在 `archive/`，并记入遗忘账本） | `/memory forget 上周的天气` |

### 给模型调用的工具

| 工具 | 作用 | 典型场景 |
|---|---|---|
| `recall_memory` | 三路检索归档记忆（年轮 / 索引 / 遗骸），返回带出处的片段 | 核心记忆不够用时，禁止直接说"忘了"，先查 |
| `memory_status` | 读取当前周期、最新年轮、待处理数量、降级与待重试状态 | 用户问"你还记得多少"时自查 |
| `memory_report` | 读取某轮汇报（12 节 Markdown） | 复盘、排查异常轮次 |
| `remember_this` | 写入承诺锁（`COMMITMENTS.md`），可带 `expires` | 用户说"一定要记得"或给出重要约定 / 生日时主动登记 |

---

## 目录结构

首次启动会在 `memoryRoot` 下自动创建：

```text
data/memory/
├── raw/                       # 潮间带：尚未处理的 3 天原文
│   ├── a1.md
│   ├── a2.md
│   └── a3.md
├── rings/                     # 年轮：追加式记忆结晶，永不覆盖
│   ├── a11.md                 # 人类可读（叙事 + 元信息）
│   ├── a11.json               # 机器可读（索引 / 承诺 / 冲突 / 统计）
│   ├── b11.md
│   ├── b11.json
│   └── LATEST                 # 当前生效年轮指针
├── distilled/                 # 注入产物：每次涨潮重建（不是原始数据）
│   ├── MEMORY.md              # 核心记忆（≤ 注入预算）
│   ├── INDEX.json             # 潜意识索引
│   ├── COMMITMENTS.md         # 承诺锁（只增不删）
│   └── IDENTITY.md            # 身份锚（名字 / 关系 / 边界）
├── archive/                   # 深海：原文永久归档
│   └── 2026-11/
│       ├── a1.md
│       ├── a2.md
│       └── a3.md
├── reports/                   # 每轮汇报（12 节 Markdown）
│   ├── b11.md
│   └── LATEST                 # 最新汇报指针
├── ledgers/                   # 账本：可审计的事实来源
│   ├── rings.jsonl            # 每轮：输入哈希 / 模型 / token
│   ├── forget.jsonl           # 每条被丢弃：原因 / 指针
│   └── recall.jsonl           # 每次检索：query / 命中 / 加固
└── STATE.json                 # 周期、lastRing、lastInputHash
```

> 记住三件事：`distilled/` 是**产物**（可重建），`rings/` 是**本体**（追加式），`archive/` 是**底线**（只增不删）。

---

## 每轮汇报长什么样

`/memory report b11` 或打开 `reports/b11.md`，会看到类似结构（下面是示例数据，完整 12 节见 [docs/REPORT_TEMPLATE.md](docs/REPORT_TEMPLATE.md)）：

```markdown
# 潮汐汇报 · b11

## 1. 一句话摘要
这三天主人换了工作、提到一次失眠、反复说起"别把我忘了"……

## 2. 本轮身份
| 项 | 值 |
|---|---|
| 年轮 | b11 |
| 遗忘模型（F） | ollama/qwen2.5:3b |
| 记忆模型（M） | deepseek/deepseek-chat |
| 模型解耦 | 是 |

## 3. 退潮报告（遗忘侧）
处理日片 3 份 · 输入 11 840 tok（估算） · 丢弃 27 条 · 压缩比 9.6× · 未降级

## 6. 忆体健康度
可回溯率 100% · 承诺完整率 100% · 漂移率 0% · 孤儿指针 0 · 检索命中率 62%
综合判定：healthy

## 9. 可回溯性与恢复路径
账本头 sha256:3c1f…a90e · 原文归档 archive/2026-11/ · 回退方式：把 rings/LATEST 指回 a11
```

---

## 与 v0.2.1 的差异

| 维度 | v0.2.1 | v2.0 |
|---|---|---|
| 模型 | 角色模型兼任蒸馏 | F/M/E 三个独立 target，与角色模型解耦 |
| 记忆单元 | 覆盖式 `MEMORY.md` | 年轮链 `a11 → b11 → c11` + `LATEST` 指针 |
| 遗忘 | 摘要覆盖的副作用 | 独立账本 + 遗骸指针 + 可回溯 |
| 提示词 | 角色人设 + 情绪打分 | 遗忘官（冷）/ 记忆官（暖）/ 主模型（不动） |
| 注入 | 全量 MEMORY + 全量 INDEX | 预算化五段注入，承诺锁优先 |
| 检索 | 首 512 字粗向量 | 三路召回 + 打分 + 召回加固 |
| 可观测 | 无 | 每轮汇报 + 忆死体检 + 三类账本 |
| 崩溃安全 | 无 | `inputHash` 幂等 + 原子写 + 回滚 |
| DSH API | `textChat` / `ctx.command`（已失效） | `ctx.llm.stream` / `ctx.commands.register` 等 0.2.2 API |

---

## 升级与迁移（v0.2.1 → v2.0）

**升级前一定要备份 `data/memory`，然后执行一次迁移：**

```bash
cp -a ./data/memory ./data/memory.bak-20261106   # 先备份
npm install
npm run build
npm run migrate                                   # 旧 MEMORY.md → rings/a11，INDEX 映射，旧 archive/ 不动
# 记忆目录不在默认位置时：npm run migrate -- --root=/path/to/data/memory
```

- 自动迁移是**幂等**的：`rings/LATEST` 已存在就跳过，重复执行安全；
- 旧 `archive/` 原样保留；旧 `raw/` 原文被搬进 `archive/<YYYY-MM>/`（内容保留、位置变化），旧 `MEMORY.md` / `INDEX.json` 另存到 `archive/legacy-v0.2.1/`；
- 迁移**不删原文、不伪造 v1 的历史 token 账本**；`a11` 只有一条迁移记录；
- 迁移出来的 `a11` 是"伪年轮"（没有真实退潮账本），第一份真实汇报在 `b11`；
- 承诺锁与身份锚 v1 没有，迁移不会替你猜——需要手动补 `COMMITMENTS.md` / `IDENTITY.md`。

完整对照表、手动步骤、回滚方法、FAQ 与迁移后检查清单（`/memory status` 逐项核对）见 **[docs/MIGRATION_v1_to_v2.md](docs/MIGRATION_v1_to_v2.md)**。

---

## 可检验性与诚实边界

本项目的设计声明按证据分级（E1 实测 / E2 类比 / E3 推演 / E4 推测）标注。目前**已对齐的是架构规格、类型契约与文档**；真实对话与多 provider 的端到端验证仍在进行中。下面把"能检验的"和"还没验证的"分开写：

| 声明 | 证据级别 | 怎么检验 | 现状 |
|---|---|---|---|
| 双模型分离降低情感偏置 | E2 类比 | 固定同一批原文，分别用"角色模型自蒸馏"与"F/M 分离"跑，盲评汇报质量 | 未做 A/B |
| 年轮链使每轮上下文恒定，成本不随历史增长 | E3 推演 | 连续跑 20 轮，记录每轮 input token | 未实测 |
| 遗骸可回溯降低忆死风险 | E2 类比 | 故意删除某道年轮，从 `archive/` + 账本恢复 | 恢复演练未跑 |
| 承诺锁能把"不可遗忘"从摘要里救出来 | E2 类比 | 构造"重要约定 + 大量琐事"数据集，检查承诺完整率 | 未做对照实验 |

**还没解决 / 没验证的（诚实清单）**：

- 年轮 n 步复合误差没有理论上界，"越传越偏"只能靠漂移率监控，不能保证；
- 承诺到期语义粗糙（一次性约定转普通记忆的边界需要人工兜底）；
- F 模型对反讽、否定、假设句的抽取仍不可靠（"我才不喜欢生日呢"可能被记成喜欢生日）；
- 注入预算、多 provider 兼容、真实 DSH 会话下的时延，尚未完成端到端压测；
- 目前没有大数据集评测——本插件是"个人助手级"的工程实现，不是论文级记忆系统。

**可证伪点**：如果把 F/M 都换成角色模型，而汇报里的"压缩比"与"承诺完整率"完全不变，那么"分离带来质量差异"的声明不成立。诚实地测它，比相信它重要。

---

## 许可与致谢

本项目基于 [MIT License](LICENSE) 开源（Copyright © 2026 stone / HU-SHD）：你可以自由地修改、分发，甚至用于商业项目。

- 作者：stone（HU-SHD）
- 感谢 DSH / Cordis 提供的插件生态；
- 感谢所有愿意把自己"粗糙的初版"拆开重做的人。

如果它帮到了你，欢迎点个 ⭐ Star；如果发现了文档与实现不一致的地方，欢迎提 issue——这比"我觉得挺好"有用得多。

嘻嘻。

2026.11.06
