# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

版本号格式：`主版本.次版本.修订号`。破坏性变更看 [2.0.0 的 Breaking 一节](#200---2026-11-06)。

---

## [Unreleased]

暂无。下一版重点把「诚实边界」里未验证的部分补成实测数据（20 轮 token 曲线、忆死恢复演练、双模型 A/B）。

---

## [2.0.0] - 2026-11-06

**潮汐忆体（Tidal Memory Architecture, TMA）** 的第一个正式版本。不是 v0.2.1 的功能叠加，是把记忆的**职责、过程、时间**各拆一刀后的重写。

### Breaking · 破坏性变更（升级前必读）

- **配置结构全部重写**。旧字段 `rawDir` / `archiveDir` / `distilledDir` / `intervalDays` / `embeddingModel` / `ragThreshold` **不再被识别**。新配置以 `memoryRoot` 为根，模型拆为 `forget` / `memory` / `embedding` 三个独立 target，并新增 `injection` / `protection` / `report` / `migration` / `debug`。
- **目录结构重排**。`data/memory/` 下新增 `rings/`、`reports/`、`ledgers/`、`STATE.json`、`rings/LATEST`；`distilled/` 从「热数据」变成「注入产物」。旧 `distilled/MEMORY.md` 与 `INDEX.json` 不再被直接读取，需迁移。
- **DSH 0.2.2 API 适配（旧写法已失效）**。v0.2.1 依赖的 `ctx.llm.textChat()`、`ctx.command()`、`ctx.llm.embed()`、`ctx.on('llm/request')` 在 DSH 0.2.2-rc.1 中**已不存在**；v2 改用 `ctx.llm.stream()` + `BlockAssembler`、`ctx.commands.register()`、`ctx.systemPrompt.section()`、`ctx.tools.register(defineTool(...))`。
- **工具与命令重命名**。`recall_archive_memory` → `recall_memory`；新增 `memory_status` / `memory_report` / `remember_this` 工具，新增 `/memory` 命令组。
- **升级必须迁移**。升级后首次启动时，`migration.auto`（默认开启）会尝试自动迁移；但**推荐先备份、再显式执行 `npm run migrate`** 并核对产物，步骤见 [docs/MIGRATION_v1_to_v2.md](docs/MIGRATION_v1_to_v2.md)。

### Added · 新增

- **双潮流水线**：退潮（遗忘潮，F 模型逐日片压缩）与涨潮（记忆潮，M 模型整合）物理分离，两条数据通路，不是两个 prompt。
- **双模型解耦**：`forget` / `memory` / `embedding` 三个 target 各自配置 `provider + model + temperature + maxTokens + timeoutMs`，默认不继承角色模型；未显式配置时回退到内置默认 target（`deepseek/deepseek-chat`）并在汇报中标 `coupled`。
- **年轮链（Ring Chain）**：`a1 a2 a3 → a11`，`b1 b2 b3 + a11 → b11`，`c1 c2 c3 + b11 → c11`……字母 26 进制进位（`z → za`）。每轮只读上一道年轮，上下文 O(1)、记忆容量 O(n)。
- **遗骸（Gist）与遗骸指针**：每条被丢弃的内容记录 `what / why / ptr`，`ptr` 指回 `archive/` 原文位置（`archive/YYYY-MM/a1.md#L12`）。
- **遗忘账本**：`ledgers/forget.jsonl` 逐条记录丢弃项、原因与指针；`ledgers/rings.jsonl` 记录每轮输入哈希、模型、token；`ledgers/recall.jsonl` 记录检索与召回加固。
- **承诺锁**：`COMMITMENTS.md` + `/memory pin`，承诺不进压缩路径、每轮强制注入、任何模型不得删除。
- **身份锚**：`IDENTITY.md` 独立于年轮链，任何模型不得改写。
- **三道保护与忆死体检**：承诺锁 / 身份锚 / 遗骸回溯；每轮计算可回溯率、承诺完整率、漂移率、孤儿指针、检索命中率，超红线在汇报中告警。
- **每轮汇报**：`reports/<年轮>.md`，12 节固定模板（见 [docs/REPORT_TEMPLATE.md](docs/REPORT_TEMPLATE.md)），每个数字可回查账本。
- **三路检索**：年轮路 + 索引路 + 遗骸路，统一打分 `0.45×语义 + 0.25×关键词 + 0.20×importance/10 + 0.10×decay`，返回带出处的 `ptr`。
- **确定性降级**：F 模型不可用或输出非 JSON 时，自动降级为正则+规则抽取，标记 `degraded=true`，不阻塞潮汐。
- **崩溃安全**：原子写（`tmp + fsync + rename`）+ `inputHash` 幂等 + `LATEST` 最后更新 + 启动自检回滚（`recover()`）。
- **配置校验**：`ConfigSchema`（Schemastery）+ `configFingerprint()`，配置快照可写进汇报（不含 Key）。
- **命令**：`/dream`、`/memory status`、`/memory report [年轮]`、`/memory pin <文本>`、`/memory forget <关键词>`。
- **工具**：`recall_memory`、`memory_status`、`memory_report`、`remember_this`。
- **v1 迁移器**：`src/migrate.ts` + `npm run migrate`，旧 `MEMORY.md` 生成为 `rings/a11` 初稿、`INDEX.json` 映射为年轮索引、旧 `archive/` 不动、旧 `raw/` 原文搬入 `archive/<YYYY-MM>/`（内容保留），旧产物副本存 `archive/legacy-v0.2.1/`。
- **纯逻辑单测**：`tests/` 下的 50+ 用例覆盖迁移索引解析、汇报渲染、检索打分、注入预算、token 估算、年轮链与文本工具；`npm test`（Node 24 `node --test`）全绿。
- **文档**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（行为规格与失败矩阵）、[docs/INTERFACES.md](docs/INTERFACES.md)（模块契约）、[docs/REPORT_TEMPLATE.md](docs/REPORT_TEMPLATE.md)（汇报模板）、[docs/MIGRATION_v1_to_v2.md](docs/MIGRATION_v1_to_v2.md)（迁移手册）、本文件，以及 README 全面重写。

### Changed · 变更

- **记忆的实现者**：从「角色模型兼任蒸馏者」变为「F 遗忘官 / M 记忆官 / 角色模型只读注入」。角色模型不再参与记忆整理，也不再看原文。
- **遗忘的地位**：从「摘要覆盖的副作用」变为「有账本、有遗骸、有理由、可回溯的一等过程」。
- **记忆单元**：从覆盖式 `MEMORY.md` 变为追加式年轮链 + `rings/LATEST` 指针；旧年轮永不覆盖。
- **注入方式**：从「全量 MEMORY + 全量 INDEX」变为五段预算化注入（身份 / 承诺 / 核心记忆 / 索引摘要 / 检索准则），默认 ≤1200 tok。
- **检索方式**：从「归档文件首 512 字粗向量」变为三路混合检索 + 打分 + 召回加固。
- **成本曲线**：从随历史线性上升（每轮全量重写）变为恒定（只读上一道年轮）。
- **定时触发**：`intervalDays` 改为 `windowDays` 潮汐窗口，通过 `ctx.effect()` 注册可随插件卸载清理的定时器。
- **包元信息**：`version` 升为 `2.0.0`，`description` / `dsh.displayName` / `dsh.description` 改为潮汐忆体的表述。
- **README**：重写为 v2 门面，保留旧版的自嘲口吻，但补上架构、配置、迁移与诚实边界。

### Removed · 移除

- 移除对 `ctx.llm.textChat()` 的依赖（DSH 0.2.2 无此 API）。
- 移除 `ctx.command('dream', ...)` 注册方式，改用 `ctx.commands.register()`。
- 移除 `ctx.on('llm/request')` 全局拦截式注入，改用 `ctx.systemPrompt.section()` 声明式注入。
- 移除旧工具 DSL（`parameters` 为完整 JSON Schema + `execute`），改用 `defineTool` 的属性内联 `required`。
- 移除旧配置字段 `rawDir` / `archiveDir` / `distilledDir` / `intervalDays` / `embeddingModel` / `ragThreshold`。
- 移除旧工具名 `recall_archive_memory`（更名 `recall_memory`）。
- 移除「单文件式」的 `distiller.ts` / `memory-manager.ts` / `rag.ts` 结构，拆分为 `model/`、`forget/`、`remember/`、`store/`、`retrieve/`、`report/`。
- 移除角色模型给自己打情绪分的提示词（v1 的「按你的主观情感打分」）。

### Fixed · 修复

- 修复「模型一换代，记忆风格跟着变」：记忆层不存模型状态、不依赖 provider 格式，换模型不换记忆。
- 修复「摘要覆盖旧摘要，丢了什么没人知道」：旧年轮保留 + 遗骸指针 + 遗忘账本，可审计、可回滚。
- 修复「第 10 轮里第 1 轮只剩一句模糊的话」：年轮链逐步继承，旧年轮原样可查。
- 修复「长程对话 token 爆炸」：注入预算化 + 年轮只读上一轮，上下文不随历史增长。
- 修复「蒸馏失败整轮记忆蒸发」：F 失败降级、M 失败不推进年轮且保留原文，下轮重试。
- 修复「崩溃导致 MEMORY 与 INDEX 不一致」：原子写 + `LATEST` 最后更新 + 启动自检回滚。
- 修复「重复触发重复烧钱」：`inputHash` 幂等，相同输入直接跳过。
- 修复「首轮没有记忆文件时注入报错」：缺失/损坏段落留空并记日志，绝不阻断主对话。
- 修复「情绪打分不可复现」：importance 改由显式信号（「一定要记得」「生日」等）与规则给出，不按情绪。

### Security · 安全

- **敏感内容不入摘要**：命中敏感词/规则的条目只保留遗骸指针，正文不进入 Gist 与注入稿，汇报中标注 `sensitive`。
- **凭据不进文档**：汇报的配置快照不含任何 API Key；仓库不提交 `data/`。
- **注入面收敛**：记忆文本固定为五段结构且预算封顶；插件侧避免在记忆文本里使用会被 DSH 插值的 `{{ }}`。
- **记忆可溯源**：检索结果必须带出处 `ptr`，降低模型编造记忆（"我确定你说过"）的空间。
- **原文只增不删**：`protection.archiveRetentionDays` 默认 `0`（永久保留）；自动清理为 v2.1 预留功能，v2.0 不会删除归档原文。

---

## [0.2.1] - 2026-10-29

**第一个能跑的粗糙初版。** 目标很朴素：别让大肥鱼的上下文被聊天记录撑爆。

### Added

- 每 3 天自动「梦境蒸馏」：读取 `raw/` 全部原文，交给角色模型（大肥鱼人设）输出 `MEMORY.md` 摘要 + `INDEX.json` 索引，原文移入 `archive/`。
- `/dream` 命令手动触发一次蒸馏。
- `recall_archive_memory` 工具 + 粗粒度 RAG 检索 `archive/`（文件首 512 字向量 + 余弦相似度 + 阈值）。
- `ctx.on('llm/request')` 全局拦截，把 `MEMORY.md` 与 `INDEX.json` 拼进系统提示词。
- 配置项：`rawDir` / `archiveDir` / `distilledDir` / `intervalDays` / `embeddingModel` / `ragThreshold`。
- 情绪权重：蒸馏提示词要求角色模型按主观情感给记忆打 1–10 分。

### 已知限制（v2 要解决的三件事）

- **蒸馏者 = 被蒸馏者**：角色模型给自己写记忆、打情绪分，情感偏置且不可复现，模型换代记忆风格就变。
- **遗忘是副作用**：新摘要直接覆盖旧摘要，丢了什么无人知道，无法审计与回滚。
- **无继承结构**：跨轮只有「当前版本的 MEMORY.md」，长程一致性差、旧轮不可回溯。

---

[Unreleased]: https://github.com/HU-SHD/deepseek-memory-distiller/commits/main
[2.0.0]: https://github.com/HU-SHD/deepseek-memory-distiller/releases/tag/v2.0.0
[0.2.1]: https://github.com/HU-SHD/deepseek-memory-distiller/releases/tag/v0.2.1
