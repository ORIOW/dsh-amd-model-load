# TASK-20261115-MODEL-UI 执行报告

- 执行：ZCode，2026-11-15
- 仓库：`/Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load`
- 提交：`abb24aa`（任务 A）、`9301bbd`（任务 B），本地 commit，**未 push**
- 基线 HEAD：`0c4a41d`（与本单 §1 记录一致）

---

## 1. 改动清单

```
$ git diff 0c4a41d..HEAD --stat
 README.en.md         |  23 ++--
 README.md            |  23 ++--
 lib/client.js        | 345 +++++++++++++++++++++++++++++++++++++++------------
 test/client.test.mjs | 336 ++++++++++++++++++++++++++++++++++++++++++++-----
 4 files changed, 595 insertions(+), 132 deletions(-)
```

分 commit（一项任务一个 commit）：

```
$ git show --stat abb24aa
 lib/client.js        | 257 +++++++++++++++++++++++++++++++++++++++------------
 test/client.test.mjs | 229 +++++++++++++++++++++++++++++++++++++++++----

$ git show --stat 9301bbd
 README.en.md         |  23 ++--
 README.md            |  23 ++--
 lib/client.js        |  90 ++++++++++++++++++++++++++++++++-----------
 test/client.test.mjs | 107 +++++++++++++++++++++++++++++++++++++++++++++------
```

未触碰：`lib/index.js`、`lib/load-source.js`、`lib/catalog.js`、`cordis.patch.yml`、`package.json`（version 仍 0.1.1）。

关键落点（lib/client.js，改动后行号）：

| 内容 | 位置 |
| --- | --- |
| `ROW_CONFIG_SLOT` / `PLUGIN_ROW_ROW_ID` / `PLUGIN_ROW_KEY` / `MODEL_LABEL_SLOT` 常量与宿主契约注释 | 常量区（`MODEL_ROW_PRIORITY` 之后） |
| `CHIP_ACCENT` / `CHIP_STYLE` / `CHIP_TEXT_STYLE`（token + fallback） | 常量区（`STATE_TEXT` 之后） |
| `shapeOf()` / `stateColor()` / `dotStyle()`（形状第二编码，纯函数） | 模型行徽章区，`badgeView` 之前 |
| `badgeView()` 返回值扩展 `state` / `label` / `aria`（aria 与 title 同文） | 原函数体 |
| `ModelRowBadge` option+amd 分支渲染 chip（`role:"img"` + `aria-label` + 状态点 + 百分比） | 原 772-803 段 |
| `Card` 按 `props.view` 分支：`summary` 单行摘要；`page`/缺省完整卡（**无页面级大标题**，「更新于」与陈旧标记保留） | 原 600-658 段 |
| `apply()` 入口新增「将注册 slots=[…，key=…]」日志；`plugins.row.config` 注册（key/inject，与模型行同一个 store）；旧设置页 slot 注册整块删除 | 原 879-924 段 |
| 导出 `badgeView` / `shapeOf`（非宿主契约，测试与预览脚本用） | 文件尾 exports |

新文件：`scripts/render-usage-chip.mjs`（§2.4.3 可选项，已做）、`docs/preview/usage-chip.html`（脚本产物，入库便于直接打开比对）。

---

## 2. 实现摘要

**任务 A（chip）**：模型行负载显示从「裸点 + opacity 0.75 百分比」改为 18px 胶囊 chip：背景 `var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))`、描边 `inset box-shadow`（不改变盒高）、文字 11px/600/tabular-nums 具名 token（不再 opacity 压灰）、状态点带形状第二编码（idle 实心圆 / busy 半填充+细环 / full 方块 / unknown 虚线环），点色 `color-mix(in srgb, <accent> 70%, currentColor)` 跟随主题。容器 `role="img"` + `aria-label`（与 title 同文），读屏念「AMD 负载：空闲 20.1%，更新于 17:20」整体语义。无数据仍显示 chip（虚线环 + `—`），不消失。行内契约（inline-flex、nowrap、无固定宽度、marginLeft 6px）保持不变。

**任务 B（插件行配置页）**：删除设置页 slot 注册（不双注册），改为注册 `plugins.row.config`，`key = dsh-amd-model-load#amd-model-load`（bundle 部分 = NS 常量即 package.json `name`；rowId 部分 = cordis.patch.yml `- id:`；测试从两个文件反推比对防漂移）。`Card` 按 `view` 分支；两个 slot 的 `inject` 仍返回同一个 store 实例。`apply()` 入口打「将注册」日志应对 `slots.inject` 的静默等待。README（中/英）同步配置入口与宿主版本要求。

---

## 3. 验收证据（原始输出）

### 3.1 §1 基线（动手前复现）

```
$ git rev-parse --short HEAD
0c4a41d

$ npm test
PASS  32 passed, 0 failed
PASS  50 passed, 0 failed
PASS  72 passed, 0 failed
PASS  24 passed, 0 failed
[with-stub] 已删除临时桩 /Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load/node_modules/@deepseek-ai/schemastery

$ ls node_modules
ls: node_modules: No such file or directory
```

合计 178，0 failed；`node_modules` 无残留（未污染）。与 §1 基线一致。

### 3.2 §2.4 任务 A

```
$ node test/client.test.mjs
...
PASS  82 passed, 0 failed
```

原 72 条不变（其中 6 条的断言值按 §2.3 新形态同步，见 §5 偏离说明），新增 6 条（全在 `test/client.test.mjs` 的新 region「任务单 2026-11-15 · 任务 A」）：

- `badgeView 四态齐全：0.0% → idle；无读数 → unknown；0.0% 与 — 不是同一串`
- `shapeOf 四态两两不等（「不只靠颜色」的可测形式）`
- `对比度：chip 文字色对 chip 底 ≥ 4.5:1（WCAG 公式真算，不硬编码）` — `contrastRatio()` 按相对亮度公式实现，算得 **#59636e on #f4f4f5 = 5.56:1**（≥ 4.5 通过；#6b7280 on #f4f4f5 = 4.40:1 < 4.5，作为换色依据一并锁进测试）
- `渲染树：外层只有一枚 chip span（role=img）、无 width 键、nowrap、aria 含状态中文与百分比`
- `幂等：同一快照连续渲染 3 次，三棵树逐字节一致（渲染期不写会漂移的模块级状态）`
- `脏数据降级：utilization 为 NaN / "63" / null 时不抛错，模型名可见，降为 unknown chip（不编数字）`

预览脚本（§2.4.3 可选项）：

```
$ node scripts/render-usage-chip.mjs
idle: 4 个元素
busy: 4 个元素
full: 4 个元素
unknown: 4 个元素
wrote /Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load/docs/preview/usage-chip.html（5749 bytes）
（exit 0）
```

无网络、无依赖、`node` 直接可跑；片段是真组件（vm 信封 + 微型 React）序列化产物，不是手工复刻。

### 3.3 §3.4 任务 B

1. `node test/client.test.mjs` → `PASS  82 passed, 0 failed`（同上）。
2. 注册断言（改写 `apply 注册进 plugins.row.config…` 一条，原「带 id/order/label/inject」意图改为 key/inject）：
   - `mounted.slotsInjected` 含 `"plugins.row.config"`、**不含** `"settings.section"`（反向守卫断言保留）；
   - `spec.name === "plugins.row.config"`、`spec.key === "dsh-amd-model-load#amd-model-load"`；
   - `spec.inject()` 返回 `{ store }`，且 `assert.equal(rowStore, labelStore)` 通过 —— 与 `conversation.input.model.label` 注册拿到的是**同一个引用**（独立的旧用例「两个 slot 拿到的是同一个 store 实例」继续通过）。
3. view 分支（新用例）：`view:"summary"` 树里无 `VLM (Vision)` 等分组标题、无 FREE；`view:"page"` 有分组、有 FREE、**无**「AMD 模型负载」大标题、保留「更新于」。
4. 反推测试（新用例，代码即 §3.4.4 原样）：从 `package.json` 读 `name`、从 `cordis.patch.yml` 用 `/^\s*-\s*id:\s*(\S+)\s*$/m` 取行 id，`assert.equal(mounted.settings.spec.key, `${pkg.name}#${rowId}`)` 通过。
5. `npm test` 四段全绿：

```
$ npm test
PASS  32 passed, 0 failed
PASS  50 passed, 0 failed
PASS  82 passed, 0 failed
PASS  24 passed, 0 failed
[with-stub] 已删除临时桩 /Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load/node_modules/@deepseek-ai/schemastery

$ ls node_modules
ls: node_modules: No such file or directory
```

合计 **188**（32+50+82+24）≥ 178，0 failed；`node_modules` 无残留。
6. 残留搜索：

```
$ grep -rn "settings.section" lib/ test/ README.md README.en.md
test/client.test.mjs:419:  // 注册位置断言（原「注册进 settings.section，带 id/order/label/inject」按 keyed slot 改写：
test/client.test.mjs:423:    !mounted.slotsInjected.includes('settings.section'),
```

- `lib/` **0 命中**（要求达成）。
- 剩余 2 行均为测试内性质允许的行：419 行是改写说明注释（历史说明），423 行是**反向守卫断言**（`!includes('settings.section')`，防止设置页注册复活）。
- README 里没有 `settings.section` 字样；配置入口的新表述「本插件不再注册设置页，配置入口在 插件 → 已安装 → dsh-amd-model-load」已按 §3.4.6 写入两个 README 的简介与已知限制。

### 3.4 §3.6 风险项落地

- `apply()` 开头的既有 `apply: connection=…` 日志之后新增一条：

```
[amd-model-load] apply: 将注册 slots=[plugins.row.config（key=dsh-amd-model-load#amd-model-load）, conversation.input.model.label]
```

（上面 3.2/3.3 的测试输出里可见真实打印。）真机上 `grep amd-model-load harness 日志` 可区分「注册了但宿主没渲染」与「根本没注册」。
- README 已知限制（中/英）补了：**配置入口需要 DSH Desktop ≥ 0.14.0（内嵌 dsh ≥ 0.2.2-rc.1），旧版本上入口不可见且无日志**。

---

## 4. Modern Web Guidance（§2.4.4 / §4）

```
$ npx --no-install modern-web-guidance@latest search "inline status chip contrast"
（命中 10 条，最相关：contrast-color / icons / color / accessibility / single-line-overflow）
```

CLI 可用（`--no-install` 命中本地 npx 缓存，无需网络下载）。取了两份：

- `contrast-color`：`contrast-color()` 可按底色自动选黑/白前景。**核对后未采用** —— 该函数比宿主 Chromium 版本新（且只出黑白两色）；本插件的底/字是宿主主题 token 配对（`--sys-color-on-surface-subtle` 随主题切换），对比度以 WCAG 公式在测试里真算兜底（5.56:1）。
- `single-line-overflow`：与 chip 的行内契约一致 —— 全文留在 DOM（只调渲染不裁字符串）、`white-space: nowrap`、不设固定宽度；本 chip 百分比很短不需要 ellipsis，模型名截断是宿主 `<span data-model-id>` 的事。
- 结合此前取过的 `color` guide：正常文本 4.5:1（已算）、不用 color 做唯一状态编码（形状第二编码）、tint 用 `color-mix()`（点的混色已是此写法）。
- `:focus-visible` / `text-wrap`：chip 是非交互元素（无可聚焦目标）且按契约单行不换行，两条不适用。

## 5. 偏离说明（未按本单字面执行之处 + 原因）

1. **chip 文字色 fallback 由 `#6b7280` 改为 `#59636e`**。§2.3 规范 `var(--sys-color-on-surface-subtle, #6b7280)`，但同一节又要求「文字色对 chip 背景 ≥ 4.5:1（浅色 fallback：#6b7280 on #f4f4f5）」——按 WCAG 公式实算 **#6b7280 on #f4f4f5 = 4.40:1，不满足 4.5**（测试里固化了这一事实作为换色依据）。token 结构保持本单要求（`--sys-color-on-surface-subtle`），仅 fallback 压暗到同色系、对比度 5.56:1 的 `#59636e`。
2. **改写既有断言不止 §3.5 列的 3 处**。§3.5 清单覆盖任务 B；任务 A 的重绘与 §3.3.3 的去标题还使 7 处既有断言失效，全部按 §0.5「保留原断言意图」改写：
   - `有负载数据 → 状态点…`（busy 点：原「solid 黄点 #eab308」→「半填充渐变 + 细环含 #b45309」，意图=颜色跟随 state）
   - `查不到该模型 → …`、`查到了但 hasLoad 为 false → …`、`rpc 失败 / 抛异常 → …`、`模型行在 rpc 失败时降级 → …`（4 处：原「灰点 #9ca3af」→「透明底虚线环含 #6b7280」，意图=无数据可辨且不崩）
   - `样式：…`（gap 5px→4px、fontSize 移到文本子节点等，意图=chip 行内布局与不设宽度，逐项对齐 §2.3 新规格）
   - `rpc 为 undefined 时渲染不崩（只有空态）`（原断言「显示 AMD 模型负载 标题」反转——§3.3.3 明确去掉页面级大标题；意图=空态可辨不崩）
3. **§2.4.2 脏数据一条的「降级为纯模型名」按实际语义执行**：`utilization` 为 NaN/"63"/null 在现有路径**不会抛错**，按 §2.3 的硬要求（「无数据时仍显示 chip…不要整个消失」）降为 **unknown chip + `—`**（不编数字）；「纯模型名」只发生在真正的异常路径（现有 try/catch，已有 M4 用例覆盖）。新用例断言：不抛错 + 模型名可见 + chip 在场 + unknown 语义。
4. **`PLUGIN_ROW_KEY` 的 bundle 部分复用 `NS` 常量**（不把包名字面量写第二次），rowId 部分为独立常量 `PLUGIN_ROW_ROW_ID`；两处来源由反推测试锁定（§3.4.4）。
5. **新增导出 `badgeView` / `shapeOf`**：§2.4.2 要求直接断言这两个纯函数，而它们原先在信封闭包内不可达；导出不属宿主契约（宿主只读 `apply`/`inject`/`name`），已在导出处注释。
6. **apply「将注册」日志是新增的一条**，既有 `apply: connection=…` 日志原样保留（既有日志断言依赖它）。
7. **摘要行的形态**取 `空闲 N / M · 更新于 HH:MM`（N = state 为 idle 的模型数，M = 模型总数），与 §3.3 示例同构；无数据时给单行「暂无数据」占位，不渲染整卡。
8. **`docs/preview/usage-chip.html` 产物入库**：便于直接打开比对，脚本可随时重生成。
9. **README Quick start 的前置版本行**在已知限制之外也补了一句（0.12.1 可装、配置入口需 0.14.0+），避免读者只看开头。

## 6. 未做 / 未验证项

- **client 半身需重启宿主才在真机生效。本单未做真机确认，也没有任何「已生效 / 界面上能看到」的依据。** 生效与否由用户下次重启 DSH Desktop 后确认；若宿主低于 0.14.0（内嵌 dsh < 0.2.2-rc.1），配置入口不可见且无日志（见 README 已知限制与 apply「将注册」日志的排查说明）。
- `prepublishOnly` 门禁（`npm test`）在 188/188 状态下可通过，但本单未发布 npm，未执行发布流程。

## 7. 一句话结论

- **任务 A 达成 §2.3 形态与行为**：行内 18px 主题化胶囊 chip，背景/描边/文字走宿主 token（fallback 可脱离宿主渲染），形状第二编码 + `color-mix` 主题混色 + `role="img"`/`aria-label` 语义，文字对比度 5.56:1（真算），无数据 chip 常驻；行内契约（nowrap / 无固定宽度 / 不改变行高）保持。
- **任务 B 达成 §3.3 形态与行为**：设置页 slot 注册整体移除（lib/ 0 残留），`plugins.row.config` 以 `dsh-amd-model-load#amd-model-load` 注册且与模型行共享同一 store；`Card` 的 summary 是单行摘要、page 是无大标题的完整卡；apply 入口有可排查的「将注册」日志；真机生效留待用户重启宿主确认。
