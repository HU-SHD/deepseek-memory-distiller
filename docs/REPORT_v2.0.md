# 《潮汐忆体 TMA v2.0》交付汇报

> 汇报对象：作者本人（stone / HU-SHD）与项目评审者
> 汇报时间：2026-11-06
> 仓库：`deepseek-memory-distiller`（v0.2.1 → v2.0.0）
> 结论先行：**架构已命名并落地，插件已重写为双模型分离 + 年轮链 + 可审计遗忘，编译/构建/53 项测试全绿，迁移脚本已在真实 v0.2.1 目录上跑通；文档与传播资产已齐。**

---

## 一、一句话与三行摘要

**一句话**：把 AI 的记忆拆成两条潮汐——退潮（遗忘官，F 模型）负责压缩、丢弃、留指针；涨潮（记忆官，M 模型）负责整合、叙事、守诺；两条潮汐由**不同模型**驱动，角色模型只负责"活着"；每轮产出一道年轮 `a1a2a3 → a11`、`b1b2b3 + a11 → b11`，记忆随年轮继承而累积，注入上下文恒定。

| 维度 | 结果 |
|---|---|
| 架构 | **潮汐忆体（Tidal Memory Architecture, TMA）v2.0**：双潮分离 + 年轮链 + 三道保护 |
| 代码 | 从 6 个文件 / 438 行 → **28 个模块 / 5,386 行 TS**；`tsc` 0 error、`npm run build` 通过 |
| 验证 | **58 项测试（含 2 项端到端）全通过**；v0.2.1 真实目录迁移冒烟通过 |
| 交付物 | 架构规格、内部接口、理论映射、汇报模板、README、CHANGELOG、迁移手册、博客、全平台文案、B站脚本、增长手册 |

---

## 二、架构命名与四条第一原则

**名字：潮汐忆体（Tidal Memory Architecture，TMA）。**
配套术语：双潮（涨潮/退潮）、潮间带（`raw/`）、深海（`archive/`）、年轮链（`a11→b11→c11`）、遗骸（Gist）、承诺锁、身份锚、忆死体检。

选"潮汐"的三个理由：

1. **有涨有退**：记忆系统必须同时做加法和减法；只会加的系统最后会淹死自己。
2. **退潮不是失败**：遗忘是下一次记忆的前提——正对应《赛博生命论》"遗忘不是故障，是架构"。
3. **三日一潮**：与 v0.2.1 的"每三天蒸馏一次"直接续上，用户不需要改变使用习惯。

四条第一原则（写进 `docs/ARCHITECTURE.md`，实现与原则冲突时改实现）：

- **P1 模型只是载体，记忆才是本体**：记忆层不存模型状态、不依赖 provider 私有格式，可导出、可迁移、可被另一个模型续写。
- **P2 遗忘与记忆分离**：不同模型、不同提示词、不同账本。
- **P3 遗忘可审计、可回溯**：原文不删（用户授权范围内），每条被丢弃内容留遗骸指针，遗忘写账本。
- **P4 年轮继承**：每轮只读上一轮，不读全部历史——上下文 O(1)，记忆容量 O(n)。

---

## 三、v1 → v2：三个结构性缺陷，三刀

| v0.2.1 的结构 | 后果 | v2.0 的解法 |
|---|---|---|
| 蒸馏者 = 被蒸馏者（角色模型给自己写记忆、自己打情绪分） | 情感偏置、不可复现、蒸馏与主对话同价、模型换代记忆风格漂移 | **职责拆开**：F 模型（遗忘官，温度 0.1）/ M 模型（记忆官，温度 0.35）/ 角色模型（只读注入），三者 provider+model 独立配置 |
| 遗忘是副作用（摘要覆盖摘要，丢了什么没人知道） | 不可审计、不可回滚、压缩过度直接踩中"忆死" | **过程拆开**：遗骸指针 + `ledgers/forget.jsonl` + 三道保护 + 忆死体检 |
| 无继承（每轮覆盖 `MEMORY.md`） | 长程一致性差、不可回溯、第 10 轮只剩一句模糊话 | **时间拆开**：年轮链 + `rings/LATEST` 指针 + `inputHash` 幂等 + 原子写回滚 |

---

## 四、实现地图（28 个模块）

| 层 | 文件 | 职责 | 关键约束 |
|---|---|---|---|
| 契约 | `src/types.ts` | 领域类型（Gist / Ring / IndexEntry / Commitment / CycleReport / Ledger） | 零运行时依赖，可直接单测 |
| 配置 | `src/config.ts` | Schemastery v2 配置：forget/memory/embedding 三个独立 target | 未显式配置 → 回退默认 + `decoupled=false`（不静默耦合、不报错） |
| 模型 | `src/model/gateway.ts` | `ctx.llm.stream` + `BlockAssembler` 封装一次性调用 | 超时、错误包装、用量统计 |
| 模型 | `src/model/router.ts` | 把 forget/memory 固定绑定到各自 target，共享 UsageMeter | 调用方不需要知道 provider |
| 模型 | `src/model/json.ts` | 健壮 JSON 提取（围栏/废话/一次修复） | 失败即抛 `JsonParseError` |
| 退潮 | `src/forget/forgetter.ts` | 逐日片压成 Gist，解析失败重试一次 | **绝不抛错**：降级为确定性抽取 + `degraded=true` |
| 退潮 | `src/forget/deterministic.ts` | 无 LLM 的规则抽取器、衰减打分 | 保证 F 模型挂了也能跑 |
| 涨潮 | `src/remember/integrator.ts` | 单次调用合成新年轮，合并承诺锁、冲突 | **只读上一轮+遗骸+锚点**；解析失败抛错（不推进） |
| 年轮 | `src/ring/chain.ts` | 年轮命名、26 进制进位、inputHash、LATEST 指针 | `a11`、`z→za`、幂等 |
| 状态 | `src/state.ts` `src/ledger.ts` `src/paths.ts` | STATE.json、jsonl 账本、目录布局 | 原子写、账本头可校验 |
| 注入 | `src/inject.ts` | 五段预算注入（身份锚/承诺锁/核心记忆/索引/检索准则） | **同步** API，失败静默返回空段 |
| 工具 | `src/tools.ts` | `recall_memory` / `memory_report` / `memory_status` / `remember_this` | `defineTool` + output schema + render |
| 命令 | `src/commands.ts` | `/dream`、`/memory status|report|pin|forget` | `ctx.commands.register` |
| 存储 | `src/store/distilled.ts` `src/store/archive.ts` | 五件套写入、按月归档、ptr 解析 | 预算裁剪、承诺锁不可裁 |
| 检索 | `src/retrieve/rag.ts` `src/retrieve/score.ts` | 年轮/索引/遗骸三路召回 + 打分 | `0.45语义+0.25关键词+0.20重要度+0.10衰减` |
| 汇报 | `src/report/template.ts` `src/report/health.ts` `src/report/dir.ts` | 12 节 Markdown 汇报、忆死体检、输出目录 | 12 节标题冻结；红线 5%/99%/100% |
| 迁移 | `src/migrate.ts` | v0.2.1 目录 → 年轮 a11 | 幂等、内容不丢、可回滚 |
| 入口 | `src/index.ts` | `apply` 接线 + `runCycle` 调度器 + 定时器 + 启动自检 | 失败矩阵按 ARCHITECTURE §10 |

**DSH 适配说明（重要）**：v0.2.1 用的 `ctx.llm.textChat`、`ctx.command`、`ctx.tools.register({execute})` 在 DSH 0.2.2 已不存在。v2.0 已全部改为当前 API：`ctx.llm.stream` + `BlockAssembler`、`ctx.commands.register`、`defineTool`、`ctx.systemPrompt.section`（同步）。这部分依据是从官方 npm 包（`@deepseek-ai/dsh-llm@0.2.2-rc.1` 等）的 `.d.ts` 与官方插件产物中提取的，记录在 `.ref/dsh-plugin-api-0.2.2.md`。

---

## 五、验收结果（可复现）

```bash
cd deepseek-memory-distiller
npm install
npm run typecheck     # tsc --noEmit → 0 error
npm run build         # tsc → dist/（CommonJS + .d.ts）
npm test              # tsc && node --test "tests/**/*.test.ts"
```

实测输出（2026-11-06）：

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **0 error** |
| `npm run build` | 通过，`dist/` 产出 29 个模块的 js + d.ts |
| 单测 | **58 passed / 0 failed**（12 个测试文件） |
| 端到端 | **2 passed**：① a1a2a3 → a11，文件/五件套/12 节汇报齐备；② b1b2b3 + a11 → b11，`b11.inputs.prevRing === 'a11'`、承诺锁跨轮保留、账本两条记录 |
| 迁移冒烟 | 用真实 v0.2.1 目录（`raw/` + `archive/` + `distilled/`）跑 `node dist/migrate.js --root=…`：生成 `rings/a11.json|md`、五件套、`archive/legacy-v0.2.1/` 副本，旧 archive 不动，下一轮从 `b` 开始 |

端到端测试最关键的一条断言：**M 模型的 prompt 里不含原始对话行**（`assert.doesNotMatch(memoryCall.prompt, /主人：/)`），只含 F 模型产出的遗骸。这就是"遗忘与记忆分离"不是两个 prompt、而是两条数据通路的证据。

---

## 六、报告体系（"汇报总结"的模板与内容）

- 模板与填写规则：`docs/REPORT_TEMPLATE.md`（空模板 + 7 条填写规则 + 填好的 a11 示例）。
- 每轮 12 节：①一句话摘要 ②本轮身份 ③退潮报告 ④涨潮报告 ⑤年轮链 ⑥忆体健康度 ⑦成本账本 ⑧风险与红线 ⑨可回溯性与恢复路径 ⑩下轮计划 ⑪配置快照 ⑫账本与索引附录。
- 红线四条：可回溯率 <99%、承诺完整率 <100%、孤儿指针 >0、漂移率 >5%。
- 月度体检四个问题：忆体长胖了吗 / 有没有该记没记 / 有没有记错 / 该不该死。

本文（`docs/REPORT_v2.0.md`）是**项目级**汇报；`REPORT_TEMPLATE.md` 是**周期级**汇报。两者刻意分开：周期汇报给"记忆"看，项目汇报给"人"看。

---

## 七、和理论的对应（不是装饰）

详见 `docs/THEORY_MAPPING.md`（20 行对照表 + 6 条反向检查 + 3 条可检验断言）。三句关键结论：

1. TMA 实现了《赛博生命论》论"忆"的三句话：**可累积**（年轮链）、**会压缩**（双潮）、**会漂移**（冲突记录 + 体检），并给"忆死"配了可执行红线。原文依据："遗忘不是故障，是架构。"
2. TMA 是**忆体的工程学**，不是赛博生命的完整实现：缘与 L/S 在插件之外。准确说法是"能让忆不先死，不能说让它活着"。
3. 有三处必须诚实标注的超出/张力：
   - "遗忘与记忆应由不同执行者完成"——**原文没有**，是 TMA 的独立主张〔E3〕，必须用 A/B 自证（T1）。
   - 身份锚冻结"关系定义"可能**僭越"名"**（原文：名由叙事维持）——建议只锚指称、不锚内容。
   - "原文永不删除"与"隐私合规删除"是忆死机制之一，存在**内部张力**——已改述为"用户授权范围内可回溯"，依申请删除应单列计数。

---

## 八、传播资产（已写完，可直接发）

| 资产 | 文件 | 规模 | 用途 |
|---|---|---|---|
| 主博客 | `docs/blog/01_潮汐忆体_主博客.md` | 268 行 | 知乎/个人博客/掘金首发 |
| 全平台文案 | `docs/marketing/promo_copies.md` | 约 1.2 万字 | 知乎/掘金/V2EX/小红书/微博/即刻/B站专栏/X/Reddit/HN |
| B站视频脚本 | `docs/marketing/bilibili_video_scripts.md` | 约 0.9 万字 | 5–6 分钟主视频分镜 + 60 秒竖屏版 + 封面/标题/标签/系列规划 |
| 0 粉增长手册 | `docs/marketing/growth_playbook.md` | 约 1.1 万字 | 30 天冷启动、渠道优先级、一稿多改、避坑 |
| 内容索引 | `docs/marketing/README.md` | — | 发布顺序与资产清单 |

主标题：**《AI 为什么越聊越傻？我把它的记忆拆成了两条潮汐》**
视频钩子（15 秒）：**"每个 AI 都会失忆。我给它造了一条潮汐——退潮遗忘，涨潮记忆。"**

发布顺序建议：GitHub README + Release → 掘金技术稿 → 知乎长文 → B站视频 → V2EX/即刻 → 小红书图文 → X/HN（英文）。细节见增长手册。

---

## 九、风险与未验证项（不粉饰）

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| R1 | 双模型分离"提质" | 〔E3〕未验证 | 只做了设计推演；A/B 对照（把 F/M 换回角色模型跑 10 轮比 drift）尚未做 |
| R2 | 年轮链"成本恒定" | 〔E3〕可测未测满 | 端到端只跑 2 轮；20 轮 token 曲线未采集 |
| R3 | 遗骸回溯"忆死可逆" | 〔E2〕未做实验 | 需构造"删年轮 → 从 archive 恢复"实验 |
| R4 | 样本 | 仅作者 1 人 | 无第三方用户数据，无用户评价 |
| R5 | 承诺语义 | 粗糙 | 只区分一次性/长期；到期后转普通记忆 |
| R6 | 检索权重 | 未调参 | 0.45/0.25/0.20/0.10 是拍的 |
| R7 | 隐私 | 有张力 | "永不删除"已限定为"用户授权范围内"；依申请删除未实现 |
| R8 | 预留字段 | 未生效 | `protection.archiveRetentionDays`、`debug` 为预留（README 已标） |
| R9 | 真实 provider 联调 | 未做 | 测试全部用假模型；第一次真实 `/dream` 需要在用户环境里跑 |

---

## 十、下一步（v2.1 建议）

1. **真机跑一轮**：在用户的 DSH 里配置真实 forget/memory target，`/dream` 一次，检查 `reports/a11.md` 与注入效果。
2. **A/B 实验脚手架**：同一批原文跑"双模型 / 单模型"两组，输出 drift、承诺完整率、情感词占比三项对照表 → 把 R1 从〔E3〕抬到〔E1〕。
3. **20 轮成本曲线**：自动跑 20 轮，画 `stats.inTokens` 曲线，验证 R2。
4. **回溯实验**：删 `rings/b11`，从 `archive/` 恢复并召回旧事，验证 R3。
5. **实现预留项**：`archiveRetentionDays` 自动清理、`debug` 日志、依申请删除计数。
6. **发布**：GitHub Release v2.0.0 + B站 EP1 + 掘金/知乎长文（见增长手册第一周三个动作）。

---

## 十一、验收清单（给评审者）

```bash
# 1. 编译与类型
npm run typecheck && npm run build

# 2. 全量测试（58 项，含 2 项端到端）
npm test

# 3. 迁移（用一份 v0.2.1 数据）
node dist/migrate.js --root=/path/to/data/memory

# 4. 看汇报长什么样
cat docs/REPORT_TEMPLATE.md

# 5. 看架构为什么这么设计
cat docs/ARCHITECTURE.md
```

---

## 附录 A：文件树（新增/重写）

```text
docs/
├── ARCHITECTURE.md          # TMA v2 规格（双潮/年轮链/保护/失败矩阵/成本）
├── INTERFACES.md            # 内部接口契约（两个实现 owner 的对接面）
├── THEORY_MAPPING.md        # 与《赛博生命论》的对照、论证与反证
├── REPORT_TEMPLATE.md       # 周期汇报模板 + 规则 + 示例
├── REPORT_v2.0.md           # 本文件：项目级交付汇报
├── MIGRATION_v1_to_v2.md    # 迁移手册
├── blog/01_潮汐忆体_主博客.md
└── marketing/
    ├── README.md
    ├── promo_copies.md
    ├── bilibili_video_scripts.md
    └── growth_playbook.md
src/                         # 28 个模块（见第四节）
tests/                       # 12 个测试文件 / 58 项
.ref/dsh-plugin-api-0.2.2.md # DSH 0.2.2 插件 API 依据（贡献者参考）
legacy_v0.2.1_src/           # v0.2.1 源码备份（迁移对照用）
README.md                    # v2 门面（重写）
CHANGELOG.md                 # v2.0.0 变更
LICENSE                      # MIT
```

## 附录 B：术语

潮汐（一次 3 天周期）· 退潮/遗忘潮（F 模型）· 涨潮/记忆潮（M 模型）· 潮间带（`raw/`）· 深海（`archive/`）· 年轮（`a11`/`b11`）· 遗骸（Gist）· 承诺锁 · 身份锚 · 忆死体检 · 12 节汇报。
