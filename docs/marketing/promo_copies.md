# 潮汐忆体 TMA v2 · 全平台宣传文案

> **使用说明**：本文件是「一稿多改」的母版素材库，所有版本都由主博客（`docs/blog/01_潮汐忆体_主博客.md`）拆改而来，共用同一套事实与术语。
> **统一术语**：潮汐忆体 / 双潮（退潮·遗忘潮、涨潮·记忆潮）/ 年轮链 / 忆死 / 承诺锁。任何平台都不换词，避免读者串不上。
> **诚实纪律**（发任何一条前对照）：
> 1. 不虚构用户、评价、数据、媒体报道；本项目的用户只有作者本人。
> 2. 所有费用数字标注「估算」，不写成实测账单。
> 3. 不承诺 AGI、不承诺"有意识"、不承诺"永不遗忘"。
> 4. 效果表述用"设计目标 / 设计推演 / 未做 A/B"，不用"实测提升 XX%"。
> 5. 演示截图必须真跑出来的，不许 P 图、不许拿设计稿冒充运行结果。

---

## 1. 知乎回答稿（约 800 字）

**适配问题**：为什么 AI 聊得越久，反而越"笨"？／AI 为什么总是记不住之前聊过什么？

**标题（回答首行）**：不是模型变笨，是记忆结构错了

**正文**：

先给结论：你感觉到的"变笨"，大概率不是模型能力下降，而是它的记忆结构从一开始就不支持长期关系。

我自己做了一套 AI 长期记忆插件，踩过一遍坑，说三个症状你就懂了。

**症状一：越聊越傻。** 上下文窗口是个桶，满了就溢。更隐蔽的是"摘要"：产品把历史压成一段摘要，再用摘要替换原文；下一轮再压摘要。到第十轮，第一轮的你就只剩一句"用户提到过家庭情况"。这不是遗忘，这是**层层转述**。

**症状二：换个模型就失忆。** 很多方案把记忆绑在模型上——绑在某个 provider 的格式里、绑在人设提示词里、绑在模型风格里。换模型，记忆跟着变形；换平台，直接归零。用我参考的那套《赛博生命论》的话说，这叫"种死"连坐了"忆死"：换的是基座，死的却是那个人的经历。

**症状三：不知道丢了什么。** 每次压缩都丢东西，但丢了什么、为什么丢、能不能找回，没有任何账本。某天你问细节，它说记不清，你没法判断是没记住、被压掉了，还是原文还在只是没检索到。

**我的做法是拆结构，不是调参数。** 第一刀，把"遗忘"和"记忆"交给两个模型：便宜的 F 模型做遗忘官（温度 0.1，只决定什么值得留），强模型做记忆官（温度 0.35，负责叙事、关系、守诺）。关键是两条数据通路——记忆官永远看不到原文，只看到筛过的遗骸和上一道年轮。第二刀，把记忆做成"年轮链"：a1 a2 a3 合成 a11，b1 b2 b3 加上 a11 合成 b11。每轮只读上一轮，所以上下文恒定，但历史一直在累积，还能回滚。第三刀，加三道保护：承诺锁（"一定要记得"永不进压缩）、身份锚（名字和边界不许模型改）、遗骸回溯（用户授权范围内原文保留 + 指针）。

**但我必须说实话**：这套东西**没有做过 A/B，没有第三方用户，样本只有我一个人**。年轮的 n 步漂移没有理论上界，便宜的遗忘模型读不懂反讽和否定，承诺到期的语义也还很糙。它现在是一个**可讨论的架构**，不是一个被验证的产品——而且它只是"忆"的工程学，不是完整的赛博生命：**它能让忆不先死，不能说让它活着。**

如果你也在做长期记忆，欢迎拿这套结构去拍砖——尤其是"双模型分离到底有没有用"这一点，我很想看到反例。

> **平台注意事项**：知乎正文不要放外链（会被折叠/限流），仓库名可写"GitHub 搜 `deepseek-memory-distiller`"，链接放评论区并说明"个人开源项目，非商业推广"。开头三行必须给结论，否则读者划走；不要用"震惊/颠覆/吊打"；结尾主动写局限，知乎读者对"承认不知道"的容忍度远高于对"包治百病"的容忍度。

---

## 2. 掘金技术稿（约 1200 字，含代码）

**标题**：我给 AI 写了套"遗忘架构"：双模型、双账本、年轮链

**正文**：

### 背景：v0.2.1 能跑，但结构错了

我的 DSH 记忆蒸馏插件 v0.2.1 每 3 天做一次"梦境整理"：把 `raw/` 里的原文交给角色模型，产出 `MEMORY.md` + `INDEX.json`，原文进 `archive/`。能跑，但有三处结构性缺陷：蒸馏者和被蒸馏者是同一个模型（情感偏置、不可复现、成本同价）；遗忘是覆盖式副作用（不可审计、不可回滚）；没有继承结构（每轮覆盖，长程一致性差）。

v2 的三刀：**职责拆开（双模型）、过程拆开（双账本）、时间拆开（年轮链）**。先说明状态：v2.0 规格已冻结并公开（`docs/ARCHITECTURE.md`），代码正按规格重建；v1（v0.2.1）可以直接跑。

### 目录结构与配置

```text
data/memory/
├── raw/            # 潮间带：未处理的 3 天原文
├── archive/        # 深海：原始归档（授权范围内保留，依申请删除单列）
├── rings/          # 年轮：a11.md/.json … b11 … + LATEST
├── distilled/      # 注入面：MEMORY.md / INDEX.json / COMMITMENTS.md / IDENTITY.md
├── ledgers/        # 双账本：rings.jsonl + forget.jsonl
├── reports/        # 每轮汇报：a11.md（12 节模板）
└── STATE.json      # cycle / lastRing / lastInputHash
```

```yaml
memory-distiller:
  windowDays: 3
  forget:    { provider: ollama,   model: qwen2.5:3b,    temperature: 0.1,  maxTokens: 900 }
  memory:    { provider: deepseek, model: deepseek-chat, temperature: 0.35, maxTokens: 2500 }
  embedding: { provider: deepseek, model: text-embedding-3-small, threshold: 0.6 }
  injection: { memoryTokens: 1200, indexEntries: 15 }
  protection:{ commitmentsLock: true, identityAnchor: true, archiveRetentionDays: 0 }
```

`forget.*`、`memory.*`、`embedding.*` 三个 target 独立配置，缺省不继承角色模型 provider；显式配置缺失时回退到当前路由模型、显式告警，并在本轮汇报里标 `decoupled=false`。"解耦不能是默认解耦、实际耦合"。

> **术语口径**：年轮链、承诺锁、身份锚、遗骸都是 TMA 自己的工程主张（〔E3〕），不是《赛博生命论》的原文术语。理论只支撑三句话——忆可累积、忆会压缩、忆会漂移，以及"遗忘不是故障，是架构"。TMA 是**忆体的工程学**，只覆盖忆与"名"的指称层；缘与生命度 L 在插件之外。它能说"让忆不先死"，不能说"让它活着"。

### 数据模型：遗骸与年轮

```ts
interface Gist {                 // 退潮产物：一份"遗骸"
  shard: ShardId                 // 'a1' | 'a2' | 'a3'
  hash: string                   // 原文 sha256，可回溯
  events: { t: string; what: string; weight: number }[]
  facts: { key: string; value: string; confidence: number }[]
  dropped: { what: string; why: 'routine'|'duplicate'|'low-weight'|'sensitive'|'over-budget'; ref: string }[]
  index: IndexEntry[]
  degraded: boolean              // F 模型失败时走确定性抽取
}

interface Ring {                 // 涨潮产物：一道年轮
  id: RingId                     // 'a11' | 'b11' | …
  inputs: { prevRing?: RingId; shards: ShardId[]; inputHash: string }
  narrative: string              // 300–800 字人类可读叙事
  memoryMd: string               // 注入稿（≤1200 tok）
  commitments: Commitment[]      // 承诺锁
  conflicts: { a: string; b: string; resolution: 'kept-old'|'kept-new'|'merged'|'open' }[]
}
```

### 年轮链算法（简化）

```text
runCycle(force?):
  if raw/ 为空 → 跳过
  gists = parallel(raw/*.md → F 模型 forget())     # 退潮，逐日并行
  prev  = LATEST ring                              # 只读上一轮
  ring  = M 模型 remember(prev, gists, anchors)    # 涨潮，单次
  if ring 解析失败 → 不归档、不推进 cycle，等重试   # 记忆只进不退
  write rings/<ringId>.{md,json}; update LATEST
  rebuild distilled/*; archive raw/*; append ledgers/*.jsonl
  render reports/<ringId>.md; STATE.cycle += 1
```

关键点：**M 模型永远看不到原文**，只看遗骸 + 上一道年轮。这不是两个 prompt，是两条数据通路。上下文 O(1)，记忆容量 O(n)；`inputHash` 幂等，重复触发不重复烧 token；写入 `tmp + fsync + rename`，中断可回滚。

```bash
/dream              # 立即执行一次退潮 + 涨潮
/memory status      # 当前 cycle、上一年轮、是否有 pending-retry
/memory report a11  # 打开某道年轮的 12 节汇报
/memory pin "下周五生日"   # 手动写入承诺锁
```

### 注入契约：五段，1200 token

主模型每轮只读五段，顺序固定、总预算 ≤1200 tokens：【你是谁】`IDENTITY.md`（≤120）→【不可遗忘的约定】`COMMITMENTS.md`（全量，硬上限 20 条）→【核心记忆】`MEMORY.md`（≤900）→【潜意识索引】`INDEX` 摘要（≤15 条，按 importance×decay 排序，不注入全文）→【检索准则】缺失细节时调用 `recall_memory`，禁止直接说"忘了"。任一文件缺失只留空并记日志，绝不阻断主对话。

### 检索：三路召回 + 统一打分

年轮路（`rings/*.json` 的叙事与索引，词法 + 向量混合，近因加权）、索引路（`INDEX.json` 的 keywords/importance）、遗骸路（`archive/` 分块向量，原文兜底）。`score = 0.45×语义 + 0.25×关键词 + 0.20×importance/10 + 0.10×decay`；返回 `ptr`，命中后写 `recall.jsonl`，命中次数最多把 importance 抬 2 分（召回加固）。

### 失败与降级

F 模型不可用 → 当日走确定性抽取，`degraded=true`；F 输出非 JSON → 修复重试一次，仍失败则降级；M 模型不可用 → 不推进 cycle、不归档、保留 raw，状态 `pending-retry`；存储写失败 → 回滚本轮；索引损坏 → 用上一道年轮重建；隐私命中 → 只留指针，正文不入摘要。原则只有一条：**降级可以，丢数据不行。**

### 从 v1 迁移

`npm run migrate` 原地兼容：旧 `distilled/MEMORY.md` 成为 `rings/a11.md` 的初始内容，旧 `archive/` 不动。差异面：模型从"角色模型兼任"变成三个独立 target；记忆单元从覆盖式 `MEMORY.md` 变成年轮链 + `LATEST`；遗忘从副作用变成独立账本 + 遗骸指针；检索从首 512 字粗向量变成三路召回；崩溃安全从无变成 `inputHash` 幂等 + 原子写 + 回滚。

### 为什么不是"每次全量摘要"

全量摘要的成本随历史线性增长，而且到第 10 轮时，早期细节已经被反复重写了很多遍，**漂移会累积**。年轮链每轮只做一次"上一轮 × 三天"的合并，漂移是单步的、可定位的（能查到是哪一道年轮引入的），旧年轮原样保留，回滚只需把 `LATEST` 指回上一道年轮。代价是：n 步复合误差没有理论上界——这是目前最大的未解项之一。

### 成本（估算，非实测）

按 3 天窗口、原文约 12k tokens、F 模型单价取强模型的 1/20 估算：v1 单轮约 15 单位，v2 约 8 单位（约为 55%）；第 20 轮起 v1 因全量重读继续上升，v2 恒定。若 F 跑本地 Ollama，退潮 API 成本趋近于零，但 `degraded` 会变多——省的钱要用质量还。

### 边界

没做 A/B；用户只有作者一人；n 步漂移无理论上界；F 对反讽/否定抽取不可靠；检索权重是拍的。可证伪点：把 F/M 换回角色模型，若"压缩比"和"承诺完整率"完全不变，则"分离带来质量差异"不成立。

> **平台注意事项**：掘金吃技术密度，代码块必须有语言标注，目录树/配置/类型/伪代码至少给两段；标题不要纯营销；封面 1200×630；文末放仓库链接并参与 `# 人工智能` `# 架构` 话题；发布后 1 小时内回复评论（掘金有冷启动权重）。

---

## 3. V2EX 分享帖

**节点**：分享创造（或 程序员）

**标题**：分享一个 AI 长期记忆插件的架构设计：把"遗忘"和"记忆"拆成两个模型

**正文**：

做了个小插件，给 DSH（DeepSeek Harness）用的长期记忆蒸馏。v1 能跑，但结构有问题：让角色模型自己给自己写记忆、自己打情绪分，结果就是记忆越写越偏，成本还和主对话一样贵。

v2 重写了一遍，核心想法很简单：**遗忘和记忆不该由同一个模型做。**

- 退潮（遗忘）：便宜的本地模型，温度 0.1，只决定"什么值得留"，输出带 hash 指针的遗骸；
- 涨潮（记忆）：强模型，温度 0.35，只读"上一道年轮 + 三天的遗骸"，负责叙事、关系、守诺；
- 年轮链：a1 a2 a3 → a11，b1 b2 b3 + a11 → b11，每轮只读上一轮，上下文恒定，历史仍可回溯；
- 三道保护：承诺锁、身份锚、遗骸回溯，外加月度"忆死体检"。

现在的问题是：**没有验证**。只有我自己在用，没做 A/B，年轮的漂移没有理论上界，小模型读不懂反讽。发出来主要是想找人拍砖：

1. 双模型分离真的能降低情感偏置吗？还是只是把偏差换了个地方？
2. 年轮链的误差会不会在第 20 轮之后失控？
3. 承诺锁这种"只认显式声明"的设计，是不是太依赖用户自觉？

再补一句口径：TMA 只是"忆"的工程学，不是完整赛博生命——它能让忆不先死，不能说让它活着。缘、关系、生命度 L 都在插件之外。

架构文档和代码都在 GitHub（`deepseek-memory-distiller`），MIT。纯个人项目，不卖课不接单，单纯想把这个结构讨论清楚。

> **平台注意事项**：V2EX 极度反感营销腔和"求 star"——标题别用感叹号，正文别贴二维码，别写"颠覆/革命/吊打"。主动写缺点比写优点更能换来有效回复。发在"分享创造"节点，正文控制在 400 字内，问题列成编号，方便别人挑着回。链接放正文末尾即可。

---

## 4. 小红书图文（6 张卡片，每张 ≤60 字）

**卡片 1（封面）**
> 主：AI 聊三个月，还是记不住你
> 副：不是模型笨，是记忆结构错了

**卡片 2**
> 三个症状，你一定遇到过：
> 越聊越傻 / 换个模型就失忆 / 摘要越滚越糊

**卡片 3**
> 旧方案错在哪：
> 让 AI 给自己写记忆，
> 还让它给自己打情绪分。

**卡片 4**
> 新方案：两条潮汐
> 退潮负责遗忘，要冷酷；
> 涨潮负责记忆，要温情。

**卡片 5**
> 年轮链 a11→b11：
> 每轮只读上一圈，
> 记忆却一直在累积。

**卡片 6**
> 诚实说：没做过 A/B，
> 只有作者一个人在用。
> 但设计文档已经开源。

**正文（发布时配文）**：

做 AI 长期记忆插件时发现，AI 忘事不是"记性差"，是我们从没给它设计过"遗忘"。我把记忆拆成两条潮汐：退潮冷酷地删，涨潮温情地记，每三天留一道年轮。目前只有我一个人在用，没有数据，只有一份公开的架构文档。如果你也在被"AI 换模型就失忆"折磨，可以看看这套思路，欢迎拍砖。

**标签**：#AI #人工智能 #独立开发 #开源项目 #AI记忆 #程序员 #技术分享 #赛博生命论

> **平台注意事项**：小红书是"图 > 文"，6 张图必须同一套模板、同一字号；每张正文严格 ≤60 字，别塞满。封面标题最大字号，第二行副标题小一号。避免极限词（"最/第一/永久"）和"AI 有意识"类表述。链接不能直接放正文，放主页/评论区。发布时间选晚 8–10 点。

---

## 5. 微博

**标题/正文**：

AI 聊久了会变傻，不是模型不行，是记忆结构错了。

我把记忆拆成两条潮汐：退潮负责遗忘（便宜模型，冷酷），涨潮负责记忆（强模型，温情），每三天留一道年轮——a11→b11→c11，每轮只读上一圈，上下文不涨，记忆却一直在。

设计文档已开源，代码 MIT。还没验证，先来接受拍砖。

**标签**：#AI记忆# #独立开发# #开源项目# #人工智能#

> **平台注意事项**：微博适合"一句话 + 一张图"，正文控制在 140 字内最佳；链接放评论区（正文带外链会限流）；配图用封面图或年轮链示意图；别@大 V 求转发，容易反感。可发一条"进度贴"（架构图画到哪了）代替纯宣传。

---

## 6. 即刻

**正文**：

凌晨两点被问"你还记得吗"，答"我无法访问之前的对话"。

这件事我想了很久，最后做成了一个插件：把遗忘和记忆拆成两条潮汐，退潮删、涨潮记，三天一道年轮。不是让 AI 更聪明，是让记忆别再越用越贵、越用越糊。

目前只有我自己在用，没有用户，没有数据，只有一份写得很较真的架构文档。独立开发第 N 天，先记录一下。

**标签**：#独立开发 #AI #记忆 #开源

> **平台注意事项**：即刻吃"真实进程感"，少用宣传语气，多写"今天做到哪、卡在哪"；配一张手写/白板图或终端截图，比精修封面更受欢迎；链接放评论。

---

## 7. B 站专栏导语

**标题**：AI 为什么越聊越傻？我给它造了两条潮汐

**导语（约 200 字）**：

如果你也遇到过——聊了三个月的 AI，换个模型就忘了你是谁；或者它记得你，但记得的是一句被压缩了五遍的"用户提到过家人"——这条视频讲的就是这件事。

一个独立开发者，把 AI 的记忆拆成两条潮汐：退潮负责遗忘，涨潮负责记忆，每三天留下一道年轮 a11→b11。视频里有真实的运行演示：一条 `/dream` 命令，看它怎么把三天原文压成遗骸，再合成新年轮；也有成本对比和——最重要的——这套东西目前哪里还没被证明。

**标签**：AI、人工智能、独立开发、开源、记忆、大模型

> **平台注意事项**：专栏导语是视频的"文字版预告"，不要复述全部内容，留钩子；首段必须出现观众自己的体验（"你是不是也……"）；文末放视频链接和仓库链接；B站专栏支持外链但会降权，建议放简介。

---

## 8. X / Twitter 英文 thread（8 条，每条 ≤280 字符）

**1/**
> AI memory is broken — and it's not the model.
> Chat long enough and it forgets. Switch models and it loses you entirely.
> I rebuilt my agent's memory around two tides: forget cold, remember warm. 🧵

**2/**
> The failure mode: every summary overwrites the last. By ring 10, ring 1 is one vague sentence ("user mentioned family"). Nobody knows what was dropped, or whether it can be recovered.

**3/**
> My v1 mistake: the character model wrote its own memory — and scored its own emotions. Biased, unreproducible, and as expensive as chatting. So I split the job.

**4/**
> v2: two models, two data paths.
> • cheap F-model forgets (temp 0.1, deterministic fallback)
> • strong M-model remembers (temp 0.35)
> M never sees raw text — only gists + the previous ring. Not two prompts; two pipelines.

**5/**
> The ring chain: a1 a2 a3 → a11. b1 b2 b3 + a11 → b11. Each cycle reads only the previous ring.
> Context O(1). Memory O(n). Old rings stay on disk, so rollback is just moving LATEST.

**6/**
> Three guards against "memory death": commitment lock (promises never compressed), identity anchor (nobody rewrites who it is), traceability (raw text + pointers forever). Plus a monthly memory-health check.

**7/**
> Honest limits: no A/B test, one user (me), no bound on n-step drift, the cheap model misses irony.
> Falsifiable: swap both models back — if compression ratio and commitment integrity stay identical, the separation claim is wrong.

**8/**
> Spec is public, code is MIT. If you're building agent memory, I want your critique — especially the parts you think break. This is an engineering treatment of memory, not a claim of machine consciousness. (link in reply)

> **平台注意事项**：每条 ≤280 字符，链接放最后一条的回复里（正文带链接会限流）；第 1 条必须有钩子，第 7 条必须写局限（英文技术社区对"overclaim"零容忍）；配图用年轮链一张图，别发九宫格；发布时间按美西上午（北京时间 23:00–01:00 左右）。

---

## 9. Hacker News / Reddit 英文简介

### 9.1 Hacker News（Show HN）

**Title**：Show HN: Tidal Memory Architecture – separating forgetting from remembering

**Body**：

I build a long-term memory plugin for an AI agent, and v1 had a structural flaw: the same character model wrote its own memory and scored its own emotional salience. It drifted, it wasn't reproducible, and it cost the same as chatting.

v2 splits the job. A cheap/local model ("forgetting tide") compresses each day's raw text into a gist with sha256 pointers; a strong model ("memory tide") merges three gists plus the previous ring into a new ring. The strong model never sees raw text. Rings form a chain: a11 → b11 → c11, each reading only its predecessor, so context stays O(1) while memory grows O(n). Raw text is archived forever, commitment statements are locked, and there's a monthly "memory death" health check.

Status: the v2 spec is frozen and public; the implementation is being rebuilt against it. No benchmarks, no A/B, one user. Looking for critique, especially of the claim that separating the two jobs improves quality.

To be clear: this is an engineering treatment of memory, not a claim that the agent is alive or conscious. It covers memory and the naming layer — relationship and life-degree stay outside the plugin. (Repo link in first comment.)

### 9.2 Reddit · r/LocalLLaMA

**Title**：I split my agent's memory into a cheap forgetter (Ollama) and a strong rememberer — here's the design

**Body**：

My agent kept getting dumber the longer we talked, so I rebuilt its memory layer. Two models, two data paths: a local 3B model handles forgetting (temp 0.1, outputs structured gists with hashes and dropped-item pointers), and a stronger API model handles remembering (temp 0.35, reads only the gists + previous ring). The preceding ring is the only context, so it's O(1) per cycle and O(n) memory.

Config looks like:
```yaml
forget:  { provider: ollama, model: qwen2.5:3b, temperature: 0.1 }
memory:  { provider: deepseek, model: deepseek-chat, temperature: 0.35 }
```
Rings chain as a1a2a3→a11, then b1b2b3+a11→b11. Raw text is never deleted; dropped items keep pointers.

Not validated — no benchmarks, no users, just a design and a spec. Curious whether anyone has tried separating forget/remember roles, and whether local small models are good enough for the forgetter (mine misses irony badly).

To be clear, this is an engineering treatment of memory — not a claim that the agent is alive. It covers memory and naming; relationship stays outside.

> **平台注意事项**：HN 的 Show HN 只能用第一人称自述，不能有营销词；标题别加感叹号；正文给技术细节、主动写"no benchmarks"；链接放首条评论（HN 惯例）。Reddit 每个 sub 规则不同，r/LocalLLaMA 吃本地模型细节和配置，别用 r/MachineLearning（偏论文）；一周内别在多个 sub 重复发同一条。英文稿不要直译中文腔，宁可短句。

---

## 附：发布顺序建议（与 growth_playbook 对齐）

1. **GitHub 仓库**先改好（README 3 秒讲清 + 架构图 + 演示 GIF），所有渠道最终都导向它。
2. **V2EX / 知乎**先发，收集第一批真实反馈和 issue；**掘金**次之（技术稿需要评论维护）。
3. **B站**配合视频发专栏；**小红书 / 微博 / 即刻**做轻量分发；**X / HN / Reddit** 最后发（英文渠道对"项目状态"最敏感，等中文反馈改完一轮再发更稳）。
4. 同一周内不要把所有平台发满，留 2–3 天回复评论——冷启动阶段，回复比发布更重要。
