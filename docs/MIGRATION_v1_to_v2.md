# 从 v0.2.1 迁移到 v2.0（潮汐忆体）

> 适用：`dsh-plugin-memory-distiller` v0.2.1 → v2.0.0
> 原则：**原地兼容、不删除原文、可回滚**。旧 `distilled/MEMORY.md` 会变成第一道年轮 `a11` 的初稿，旧 `archive/` 原样保留，旧 `raw/` 原文被搬进 `archive/`（内容保留、位置变化）。
> 预计耗时：5–10 分钟（取决于记忆目录大小）。迁移**不调用任何模型**，不烧 token。

---

## 0. TL;DR

```bash
# 1. 停掉 DSH，等正在跑的潮汐结束
# 2. 备份（最重要的一步）
cp -a ./data/memory ./data/memory.bak-20261106

# 3. 安装依赖并构建
npm install
npm run build

# 4. 改好 cordis.patch.yml（新的 memoryRoot / forget / memory 配置）
# 5. 执行迁移（内部会先 tsc 再跑迁移器）
npm run migrate
# 记忆目录不在默认 ./data/memory 时：
# npm run migrate -- --root=/path/to/data/memory

# 6. 启动 DSH，用 /memory status 逐项核对（见第 5 节）
dsh web --patch ./cordis.patch.yml
```

> 只想快速判断要不要迁：**要**。v0.2.1 的配置字段与 DSH API 在 v2 里都已失效；不迁移的话插件能起来，但旧记忆读不到，等于清零重来。

---

## 1. 迁移前：确认与备份

### 1.1 确认版本与环境

- DSH 为 `0.2.2-rc.1`（v0.2.1 的 `ctx.llm.textChat` / `ctx.command` 在新版已不存在）。
- Node.js ≥ 18（构建）；要跑 `npm test` 需要 Node 24（原生 TypeScript 类型剥离）。
- 已获得 `forget`（便宜/本地模型）与 `memory`（强模型）两个 target 的 provider / model 名称。

### 1.2 备份记忆目录

默认记忆根目录是 `./data/memory`（v0.2.1 的 `rawDir` / `archiveDir` / `distilledDir` 都在其下）。**先备份，再动手**：

bash / Git Bash / macOS / Linux：

```bash
cp -a ./data/memory ./data/memory.bak-20261106
```

Windows PowerShell：

```powershell
Copy-Item -Recurse .\data\memory .\data\memory.bak-20261106
```

备份是回滚最稳的方式：迁移会移动旧的 `raw/` 原文、重建 `distilled/` 产物，虽然原文都被归档保留，但目录位置会变。

### 1.3 停掉自动潮汐

1. 停止 DSH（或卸载插件）。
2. 确认没有正在执行的 `/dream`。若刚触发过一轮，等它输出「潮汐完成」再停。
3. 确认 `data/memory/raw/` 里没有正在写入的半截文件（迁移会把它们一并归档，半截内容也会被保留）。

---

## 2. 新旧目录对照表

v0.2.1（三个目录）→ v2.0（年轮链 + 账本）：

| v0.2.1 位置 | v2.0 位置 | 迁移器行为 |
|---|---|---|
| `distilled/MEMORY.md` | `rings/a11.md` / `rings/a11.json` 的 `narrative` + `memoryMd` | 作为年轮 `a11` 的**初稿**；规范化后截到 800 字作叙事、截到注入预算作注入稿。**原文另复制一份**到 `archive/legacy-v0.2.1/MEMORY.md` 保留 |
| `distilled/INDEX.json` | `rings/a11.json` 的 `index` | 宽容解析后逐条映射：`topic` / `keywords` / `importance` 保留（importance 夹到 0–10，缺省 5），补 `ring: "a11"`、`decay: 1.0`；旧的 `file` 字段转成 `ptr`。**原文另复制一份**到 `archive/legacy-v0.2.1/INDEX.json` |
| `raw/*.md`（`.txt` 也认） | `archive/<YYYY-MM>/` | **移动并归档**：能按文件名解析出 `YYYY-MM-DD` 的按该月分桶，否则用迁移当月；同名冲突时加 8 位 hash 前缀；复制成功后删除 `raw/` 中的源文件。旧索引里的 `file` 会映射到这些新位置 |
| `archive/*.md`（v0.2.1 扁平归档） | `archive/` | **原样保留**，不移动、不改名、不重写；旧索引的 `ptr` 直接指向 `archive/<旧文件名>` |
| （不存在） | `archive/legacy-v0.2.1/` | 新建：保存旧 `MEMORY.md` 与 `INDEX.json` 的原文副本，供人工回查 |
| （不存在） | `rings/LATEST` | 新建，指向 `a11` |
| （不存在） | `STATE.json` | 新建：`schemaVersion: 2`、`cycle: "b"`、`lastRing: "a11"`、`lastInputHash: <迁移哈希>` |
| （不存在） | `distilled/COMMITMENTS.md` | 写一个空的承诺锁文件（带维护说明）。**v1 没有承诺可迁**，需要你补充 |
| （不存在） | `distilled/IDENTITY.md` | 若不存在，写入默认身份锚模板（可在迁移后自行修改；之后任何模型不得改写） |
| （不存在） | `ledgers/rings.jsonl` | 追加一条 `a11` 的迁移记录（`forgetIn: 0`，`memoryIn/out` 为估算）；**不伪造** v1 的历史 token 账本 |
| （不存在） | `reports/` | 创建目录，但**不生成** `reports/a11.md`——迁移没有真实潮汐可汇报，第一份真实汇报在 `b11` |

> 一句话记法：**`MEMORY.md` 进年轮、`INDEX.json` 进索引、`raw/` 搬进归档、`archive/` 不动；承诺与身份要自己补。**

---

## 3. 自动迁移到底做了什么

`npm run migrate` 执行 `tsc && node dist/migrate.js`；插件启动时若 `migration.auto: true`，也会在启动自检里尝试同一套逻辑（`migrateFromV1()`）。

1. **幂等短路**：若 `rings/LATEST` 已有内容，或 `rings/` 里已存在任意 `.json` 年轮，直接返回「已是 v2 结构，跳过迁移」，**不覆盖**任何年轮。重复执行是安全的。
2. **探测 v1 痕迹**：读取 `<memoryRoot>/distilled/MEMORY.md` 与 `INDEX.json`；两者都不存在则返回「未发现 v0.2.1 数据，无需迁移」。
3. **保留旧产物**：把 `MEMORY.md`、`INDEX.json` 原文复制进 `archive/legacy-v0.2.1/`。
4. **归档旧 raw**：把 `raw/` 下的 `.md` / `.txt` 移动进 `archive/<YYYY-MM>/`（复制→删除源文件），建立"旧文件名 → 新 `archive` 路径"的映射。
5. **映射索引**：
   - 宽容解析旧 `INDEX.json`（允许 ```json 围栏、前后废话、裸数组、`{index:[…]}` / `{entries:[…]}`；解析失败返回空数组，迁移继续）；
   - 每条 `file` 依次尝试：新归档的 raw 路径 → 旧扁平 `archive/<file>` → 兜底 `rings/a11.md`；
   - `importance` 夹到 0–10，`decay` 给 1.0（迁移视为"刚读取"，之后由检索自然衰减）。
6. **造 `a11`**：`narrative` 由旧 `MEMORY.md` 去换行/合并空白后截到 800 字；`memoryMd` 截到 `injection.memoryTokens` 预算；`inputs.shards = []`（v1 分不清日片归属）；`commitments = []`、`conflicts = []`；`stats` 为估算值。
7. **写账本**：`ledgers/rings.jsonl` 追加一条 `kind: "ring"` 记录，`models` 记当前配置的 F/M 模型名，`forgetIn: 0`——迁移不调用模型，所以退潮 token 为 0。
8. **推进周期**：`STATE.json` 的 `cycle` 设为 `b`，`lastRing` 设为 `a11`。`a11` 是"继承来的第 0 道真实年轮"，下一次真实潮汐产出 `b11`。

> 诚实说明：迁移出的 `a11` 是**伪年轮**——没有真实的退潮账本、没有遗骸丢弃记录、没有承诺。第一份真实汇报会出现在 `b11`，不要拿 `a11` 当质量样本。

---

## 4. 手动迁移步骤（推荐）

### 4.1 更新配置

把旧的 6 个字段换成 v2 结构（最小可用示例，完整字段见 README 配置项表）：

```yaml
# cordis.patch.yml
- insert:
    - id: memory-distiller
      name: './src/index.ts'
      config:
        memoryRoot: './data/memory'   # v1 的 raw/archive/distilled 都在这个根下
        windowDays: 3
        forget:
          provider: ollama
          model: qwen2.5:3b
        memory:
          provider: deepseek
          model: deepseek-chat
        migration:
          auto: true                  # 允许启动时自动迁移；也可先手动跑一次看输出
```

> 建议 `forget` 与 `memory` **显式配置**。未显式配置时 v2 会回退到内置默认 target（`deepseek/deepseek-chat`）并在汇报里标 `coupled`——能用，但不是"双模型解耦"的本意。

### 4.2 执行迁移

```bash
npm run migrate
# 记忆目录不是默认 ./data/memory 时，用 --root 指定（注意 npm 的 `--` 分隔符）：
npm run migrate -- --root=/path/to/data/memory
```

预期输出类似：

```text
[memory-distiller] v0.2.1 → v2 迁移完成：生成年轮 a11（14 条索引、612 字叙事）。
旧 raw/ 原文 3 份已归档到 archive/<YYYY-MM>/。
旧 distilled 原文已复制到 archive/legacy-v0.2.1/，旧 archive/ 扁平文件未改动。
下一轮潮汐将从周期 b 开始（b1 b2 b3 + a11 → b11）。
[memory-distiller] 年轮 a11 已生成：<memoryRoot>/rings
```

若提示「未发现 v0.2.1 数据」，检查 `memoryRoot` / `--root` 是否指向旧的 `data/memory` 根目录。

### 4.3 人工核对产物

```bash
# 年轮与指针存在
cat data/memory/rings/LATEST
cat data/memory/rings/a11.json

# 索引条数与旧 INDEX.json 一致（解析失败除外）
node -e "console.log(require('./data/memory/distilled/INDEX.json').length)"

# 旧产物已保留在 legacy 目录
ls data/memory/archive/legacy-v0.2.1/

# 旧 raw 已被归档；archive 里能看到按月份分桶的新文件
find data/memory/archive -maxdepth 2 -name '*.md' | head
```

### 4.4 补承诺锁与身份锚

v1 里「一定要记得」「我下周五过生日」只是 `MEMORY.md` 里的一句话，迁移器**不会**把它解析成承诺锁（否则就是替用户编承诺）。迁移后：

- 把真正不能忘的约定写进 `data/memory/distilled/COMMITMENTS.md`；
- 或在对话里用 `/memory pin <文本>` 补登记；
- 默认身份锚模板会写入 `distilled/IDENTITY.md`，按实际情况改成你的名字 / 关系 / 边界（之后任何模型不得改写）。

### 4.5 跑第一轮真实潮汐

1. 启动 DSH：`dsh web --patch ./cordis.patch.yml`；
2. `/memory status` 按第 5 节清单核对；
3. **注意：迁移会把旧 `raw/` 原文归档，迁移后 `raw/` 可能是空的。** 想验证 `b11`，先放入新的日片（新的对话记录 `.md`），再执行 `/dream`；`raw/` 为空时 `/dream` 会跳过（不烧 token），不会生成 `b11`；
4. 成功后执行 `/memory report b11`，对照 [REPORT_TEMPLATE.md](REPORT_TEMPLATE.md) 看第一份真实汇报。

---

## 5. 迁移后检查清单（`/memory status` 逐项核对）

在 DSH 里输入 `/memory status`，逐项对照。当前实现会输出这些行：

```text
周期：b
最新年轮：a11
年轮总数：1
raw/ 待处理：0 份
退潮降级：否
待重试：否
承诺锁：0 条
索引条目：N 条
```

| 检查项 | 期望 | 不符时怎么办 |
|---|---|---|
| 周期 | `b`（`a11` 是迁移种子） | 若是 `a`，检查 `STATE.json` 是否被旧进程覆盖 |
| 最新年轮 | `a11` | 检查 `rings/LATEST` 是否指向 `a11` |
| 年轮总数 | `1`（只有 `a11`） | 多出年轮说明重复迁移或已跑过潮汐 |
| `raw/` 待处理 | `0` 份（旧 raw 已归档） | 非 0 但你看不到文件 → 检查是否有别的进程在写 |
| 退潮降级 | 否 | 迁移不调用模型，降级只可能来自上一轮残留状态 |
| 待重试 | 否 | 若为"是"，说明 raw 里还有原文，可手动 `/dream` |
| 承诺锁 | `0` 条（除非你手动补过） | 非 0 但你没补 → 检查是否有别的实例在写 |
| 索引条目 | 等于旧 `INDEX.json` 的条数 | 少了 → 旧索引解析失败或条目缺 `topic`/`keywords`，看迁移日志 |
| 模型解耦 | 迁移后 `/memory status` 不显示；确认配置里 `forget` / `memory` 都填了 provider + model | 首次 `b11` 汇报的「本轮身份」里看「模型解耦 = 否」就说明漏配了 target |

补充的文件级核对（不依赖 `/memory status`）：

- [ ] `rings/a11.md` 与 `rings/a11.json` 同时存在，且 `rings/LATEST` 内容为 `a11`；
- [ ] `distilled/MEMORY.md`、`INDEX.json` 已是新格式（索引里有 `ring` / `ptr`）；
- [ ] `distilled/COMMITMENTS.md`、`distilled/IDENTITY.md` 已存在（承诺需手动补）；
- [ ] `archive/legacy-v0.2.1/MEMORY.md` 与 `archive/legacy-v0.2.1/INDEX.json` 保存了旧原文；
- [ ] 旧 `archive/` 扁平文件数量没变；旧 `raw/` 文件已出现在 `archive/<YYYY-MM>/` 下；
- [ ] `ledgers/rings.jsonl` 有且只有一条 `a11` 迁移记录；
- [ ] `reports/` 为空目录（`a11` 不生成汇报），`b11` 完成后出现 `reports/b11.md` 且 12 节完整。

---

## 6. 回滚

### 6.1 完整回滚到 v0.2.1（推荐路径）

1. 停掉 DSH；
2. 恢复备份目录：

   ```bash
   rm -rf ./data/memory
   cp -a ./data/memory.bak-20261106 ./data/memory
   ```

   Windows PowerShell：

   ```powershell
   Remove-Item -Recurse -Force .\data\memory
   Copy-Item -Recurse .\data\memory.bak-20261106 .\data\memory
   ```

3. 代码切回 v0.2.1（仓库保留了 `legacy_v0.2.1_src/` 六个旧文件作为参考实现；若打过 tag 则直接 `git checkout v0.2.1`）；
4. 配置改回旧字段 `rawDir` / `archiveDir` / `distilledDir` / `intervalDays` / `embeddingModel` / `ragThreshold`；
5. `npm install && npm run build` 后启动。

> ⚠️ 不要只换代码不恢复数据：v2 的 `distilled/INDEX.json` 结构已经变了，v0.2.1 会把它当文本整段注入，能用但语义不对。

### 6.2 只回滚某一道年轮（v2 内部）

年轮链是**追加式**的，旧年轮永远在。若某一轮涨潮结果不满意：

1. 找到上一道年轮，例如 `rings/a11`；
2. 把 `rings/LATEST` 的内容改为上一道年轮名（`a11`）；
3. `/memory status` 核对，必要时 `/memory report a11` 复核；
4. 想重跑该轮：先移除该轮 `rings/<id>.md` / `rings/<id>.json`，并清掉 `STATE.json` 里对应的 `lastRing` / `lastInputHash`，再 `/dream`。

**限制**：年轮能回滚，`distilled/` 会在下次涨潮按新 `LATEST` 重建；但已归入 `archive/` 的原文不会消失，所以原文始终可回溯。

### 6.3 迁移失败时的最小回滚

若迁移在中途中断（断电、Ctrl-C、磁盘满），`archive/` 里的原文不会丢，但 `raw/` 可能已被部分移动。稳妥做法是直接走 6.1 恢复备份；若没有备份：

1. 停掉插件；
2. 删除 v2 迁移产物：`rings/`、`rings/LATEST`、`STATE.json`（`reports/` 可留；若想彻底重来，删掉 `ledgers/rings.jsonl` 里 `a11` 那一条，避免重跑后重复记账）；
3. 从 `archive/<YYYY-MM>/` 把旧 raw 文件复制回 `raw/`（按原文件名）；
4. 删除 `archive/legacy-v0.2.1/` 中迁移复制出的副本（可选）；
5. 重跑 `npm run migrate`。

---

## 7. FAQ

### Q1. 重复执行 `npm run migrate` 会怎样？

幂等。迁移器检测到 `rings/LATEST` 已有内容（或 `rings/` 已有年轮 JSON）就直接跳过，不覆盖、不重复写。副作用只有一个：若 `migration.auto: true`，每次启动都会做一次"已迁移"检查（无模型调用，开销可忽略）。

### Q2. 迁移到一半断了，会不会把记忆弄坏？

原文不会丢：旧 `archive/` 里的文件不被改动（迁移只会向 `archive/` 新增 `legacy-v0.2.1/` 副本与 `raw/` 归档），旧 `raw/` 是"复制成功后才删源文件"。半迁移的典型特征是「有年轮文件、但 `LATEST` 或 `STATE.json` 还没同步」。按 6.3 处理，最稳的是恢复备份重跑。

### Q3. 迁移后承诺是不是丢了？为什么承诺锁是 0 条？

不是"丢了"，是 **v1 根本没有承诺锁这个结构**。v1 只是让角色模型把重要内容写进 `MEMORY.md`，没有独立、不可删除的承诺记录。迁移器不替用户猜哪些话算承诺（这正是 v1 情绪打分不可信的老问题），所以需要你按 4.4 手动补。补登记后的承诺从下一轮起强制注入；承诺完整率只对 v2 之后登记的承诺负责。

### Q4. 为什么迁移后周期从 `b` 开始，而不是 `a`？

`a11` 是迁移造出来的"第 0 道年轮"，代表 v1 的存量记忆；`a` 这个周期并没有真实发生过退潮-涨潮，所以第一轮真实潮汐是 `b11`。这样年轮链从 `b11` 起每个真实环节都有账本，`a11` 只有一条迁移补记记录（退潮 token 为 0），不会被误当成正常轮次的完整账本。

### Q5. 迁移会删除或覆盖我的旧数据吗？

- `archive/` 旧扁平文件：不碰；
- 旧 `distilled/MEMORY.md`、`INDEX.json`：被重建为新格式，但**原文副本保存在 `archive/legacy-v0.2.1/`**；
- 旧 `raw/`：被移动到 `archive/<YYYY-MM>/`（内容保留，位置变化）；
- 旧代码文件（`distiller.ts` 等）：运行时不再使用，仓库保留在 `legacy_v0.2.1_src/`。

### Q6. 我的旧 `raw/` 文件去哪了？为什么迁移后 raw 空了？

被搬进 `archive/<YYYY-MM>/` 了。这样做的目的是让"还没被蒸馏的原文"也能立刻被检索到（旧索引里的 `file` 会指向新归档位置），避免迁移丢内容。如果你希望它们再走一次退潮流程，可以把这些文件复制回 `raw/`（它们会被当成新周期日片，重新生成遗骸与记忆）。

### Q7. 我 v0.2.1 时自定义过 `rawDir` / `archiveDir` / `distilledDir`，怎么办？

v2 只认一个 `memoryRoot`，再按固定子目录名 `raw/`、`archive/`、`distilled/` 解析。两种做法：

- 把三个目录移动/复制到同一个根目录下并改成这三个名字，然后 `memoryRoot` 指向该根；
- 或直接把 `memoryRoot` 指向它们共同的父目录（若原来的目录布局恰好是 `<root>/raw`、`<root>/archive`、`<root>/distilled`）。

迁移前先备份；移动目录用复制再删，别直接 `mv` 赌运气。

### Q8. 迁移后还能检索到旧记忆吗？

能，取决于两件事：`INDEX.json` 映射成功（索引路），以及归档文件仍在 `archive/`（遗骸路）。迁移器给旧条目生成的 `ptr` 会优先指向 `archive/<YYYY-MM>/<旧文件名>`，其次指向旧扁平 `archive/<旧文件名>`，都找不到时兜底 `rings/a11.md`。若 `/memory report b11` 的忆体健康度里「孤儿指针」不为 0，说明有归档文件被移动/删除过，先补回文件再排查。

### Q9. 迁移要花多久？会调用模型吗？

不调用任何模型，纯文件读写。通常几秒到十几秒，取决于 `INDEX.json` 条数与磁盘。迁移后第一次 `/dream` 才会真正花 token。

### Q10. 迁移完成后能删掉 `legacy_v0.2.1_src/` 吗？

可以，它只是旧实现的参考副本，不参与构建。但建议留到 v2 稳定运行一两个周期之后再删。

### Q11. 迁移后第一轮汇报里"年轮链"只有 a11，没有 token 数据，正常吗？

正常。v1 没有账本，迁移器只写一条 `a11` 的迁移记录（退潮 token 记为 0），不伪造历史开销。真实成本数据从 `b11` 开始累积。

---

## 8. 附：配置字段对照（v0.2.1 → v2.0）

| v0.2.1 | v2.0 | 说明 |
|---|---|---|
| `rawDir` | `memoryRoot` + 固定 `raw/` | 不再单独配置路径 |
| `archiveDir` | `memoryRoot` + 固定 `archive/` | 新归档按 `YYYY-MM/` 分目录 |
| `distilledDir` | `memoryRoot` + 固定 `distilled/` | 变为注入产物目录 |
| `intervalDays` | `windowDays` | 同义，潮汐窗口天数 |
| `embeddingModel` | `embedding.provider` + `embedding.model` + `embedding.threshold` | 拆成独立 target |
| `ragThreshold` | `embedding.threshold` | 同义 |
| （无） | `forget.*` / `memory.*` | 新增：双模型解耦的核心 |
| （无） | `injection.*` / `protection.*` / `report.*` / `migration.*` / `debug` | 新增：注入预算、三道保护、汇报、迁移开关、调试日志 |

完整字段、默认值与说明见 [README 配置项](../README.md#配置项)。
