# M3-REPORT — 设置页按 AMD 5 分类分组 + 组内繁忙度排序 + FREE 徽章 + 轮询改 10 分钟

任务：task-4（M3） · 执行：m3-coder · 日期：2026-10-25
工作区：`/Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load`

---

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| 5 分类分组（VLM/LLM/Decision/TTS/OCR） | ✅ 组标题用 `capability_label` 原文，不翻译 |
| 组内按繁忙度从低到高 | ✅ 在 **host** 侧算，client 只按序渲染 |
| 无负载数据排组末 | ✅ 比较器第 1 层保证，且全序 ⇒ 输出可重复 |
| FREE 徽章照抄 AMD 样式 | ✅ 逐字段取自网页 `.ma-badge` / `.ma-badge-free` |
| d3 / d3-flash / Clef 无徽章 | ✅ 只认 `display_config.badge_label`，不做任何回退 |
| 轮询间隔改 10 分钟 | ✅ `pollMs` 600000；`staleAfterMs` 同步调到 660000 |
| 只显示 Public Free 的 15 个 | ✅ 按用户裁定；Dedicated 区 3 个不显示 |
| 回归测试 | ✅ **135 用例全绿**（原 64 + 新增 71） |
| 真实端点 e2e | ✅ PASS（25.5s，见 §8） |

---

## 2. 文件改动

| 文件 | 行数 | 性质 |
|---|---|---|
| `lib/catalog.js` | 619（新增） | **新增**。纯函数 + 目录轮询器，零 `@deepseek-ai/*` import |
| `lib/index.js` | 393（改造） | 加 catalog 轮询器、`catalog` RPC 端点、Config 扩到 7 字段、fetch 注入口 |
| `lib/client.js` | 359（重写） | 5 分组渲染 + FREE 徽章 + 分组标题；改为调 `catalog` 端点 |
| `test/catalog.test.mjs` | 706（新增） | catalog.js 单测，**50 用例** |
| `test/client.test.mjs` | 651（重写） | 跟新 UI 改，**29 用例**（原 15） |
| `test/host.test.mjs` | 610（改造） | Config 7 字段 + catalog 端点 7 个新用例，**24 用例**（原 17） |
| `test/e2e-live.mjs` | 249（重写） | 真实端点 e2e，验 5 分组 + 排序 |
| `test/load-source.test.mjs` | 未改动 | 32 用例保持全绿 |
| `M3-REPORT.md` | 本文 | — |

`package.json` / `cordis.patch.yml` **未改动**（M0 装配链无需调整，与 M1 一致）。

---

## 3. 分组排序的具体实现（重点）

### 3.1 分类不硬编码

`capability_label` 由上游给出，取值实测恰好是：

```
VLM (Vision) / LLM (Text) / Decision (Classifier) / TTS (Speech) / OCR (Document)
```

`CATEGORY_ORDER` 固化这 5 个字符串作为**展示顺序**（用户要求「直接按它的来分组显示」），
但**分类本身来自数据**：上游若新增第 6 类，会落到「其他」组而不是消失。

### 3.2 「无负载数据排组末」怎么保证稳定

这是本任务最容易被写错的一处。实现是一个**全序比较器**（`lib/catalog.js:compareModels`）：

```js
function compareModels(a, b) {
  const aHas = a.utilization !== null
  const bHas = b.utilization !== null
  if (aHas !== bHas) return aHas ? -1 : 1          // ① 有数据的一律在前
  if (aHas && a.utilization !== b.utilization) {
    return a.utilization - b.utilization            // ② 有数据的按升序
  }
  if (a.id < b.id) return -1                        // ③ 其余按 id 字典序
  if (a.id > b.id) return 1
  return 0
}
```

三层键合起来构成**全序（total order）**，因此：

- **不依赖 `Array#sort` 的稳定性**。旧版 V8 对 `>10` 元素用不稳定排序，靠「原始顺序」保证并列次序是不可移植的。这里同 utilization 的两个模型一定按 id 分开，不会因为输入顺序不同而换位。
- **「无数据排末尾」是结构性的**，不是特例分支：第 ① 层直接按「有没有可用 utilization」二分，无论数据条数多少、输入顺序如何，缺数据项一定全部落在有数据项之后。
- **UI 不会在两次轮询之间无谓抖动**：同一份数据永远得到同一份输出，React 的 diff 不会因为排序不稳定而重建 DOM。

「无数据」的判定是 `utilization === null`，而 `null` 来自 `numberOrNull()` 对以下情况的归一：
缺字段、`null`、`undefined`、非数字字符串、`NaN`、`Infinity`。所以 `"abc"` 这种脏值也排末尾，不会算成 0。

**测试覆盖**（`test/catalog.test.mjs`）：
- 「无负载数据的排在该组末尾（哪怕 id 字典序更靠前）」—— 用 AAA/ZZZ 构造反例
- 「无数据项即使 utilization 字段是 null / 非数字，也排末尾」
- 「同 utilization 时按 id 字典序 —— 结果可重复，不依赖 sort 稳定性」—— **输入顺序反转，输出必须一致**
- 「全无负载数据时：每组内全部按 id 字典序」
- 真实样本端到端：VLM 组 `[3.7, 18, 20.1, 69.5, 100, 100]` + 1 个无数据在末尾

### 3.3 分组顺序

`CATEGORY_ORDER` 顺序遍历取桶 → 剩下的（未知分类）合并成「其他」追加到最后。
**空分类不出空标题**（桶不存在就跳过），所以只有 TTS 1 个模型时也只渲染 1 行，不会出现 4 个空组。

### 3.4 排序放在 host 而不是 client（架构决定）

分组排序是纯逻辑，放 host 的 `lib/catalog.js` 就能被 **50 个单测**直接覆盖；
放 client 则只能靠 vm 里伪造 React 渲染来验证（client 的 29 个用例只能验「按 host 给的顺序渲染」）。
RPC 契约因此是 `catalog` → `{groups:[{label, models:[...]}]}`，**host 算好，client 只管画**。

---

## 4. FREE 徽章的 CSS 取值（重点）

用户要求「照抄进 AMD 模型负载页面的每个模型的 UI 里」。做法是**从 AMD 网页的 `<style>` 里逐字抓规则**，不是凭截图目测：

抓取来源：`https://developer.amd.com.cn/radeon/tokenfactory` 的第二个 `<style>` 块（2026-10-25 实测）。

```css
.ma-badge      { font-size:10px; font-weight:800; letter-spacing:.04em;
                 text-transform:uppercase; padding:3px 7px; border-radius:4px;
                 white-space:nowrap; }
.ma-badge-free { color:#5b3fd6; background:#efeafe; }
```

落成 `lib/client.js` 的 `FREE_BADGE_STYLE`：

| 属性 | 值 | 来源 |
|---|---|---|
| `color` | `#5b3fd6` | `.ma-badge-free` |
| `background` | `#efeafe` | `.ma-badge-free`（淡紫底深紫字） |
| `fontSize` | `10px` | `.ma-badge` |
| `fontWeight` | `800` | `.ma-badge` |
| `letterSpacing` | `0.04em` | `.ma-badge` |
| `textTransform` | `uppercase` | `.ma-badge` |
| `padding` | `3px 7px` | `.ma-badge` |
| `borderRadius` | `4px` | `.ma-badge` |
| `whiteSpace` | `nowrap` | `.ma-badge` |
| `flex` | `none` | 本插件自加（行内不被压缩） |

**这些数值刻意不换成 design token**：用户要的是「照抄」，一旦 token 化就与 AMD 页面脱钩，
上游改色我们也发现不了。测试直接断言 `#5b3fd6` / `#efeafe` 与 6 个排版值。

### 4.1 徽章判定：只认 `badge_label`，不做任何回退（关键）

实测发现一个**反直觉的坑**：

| 字段 | d3 / d3-flash / Clef |
|---|---|
| `display_config.badge_label` | **缺失**（undefined） |
| `token_factory.badge.label` | **`"Free"`**（有值！） |

`token_factory.badge` 是给**整页 section** 用的（`{label:"Free", tone:"free"}`），不是给这三个模型的。
若拿它做回退，d3 / d3-flash / Clef 会被错加 FREE 徽章 —— 与网页实际显示不符。

因此 `parseModelDetail` **只读 `display_config.badge_label`**，代码里留了显式注释说明为什么不能回退。

另外 `free` 布尔字段也**不可用**：实测 15 条记录**全部是 `false`**（包括明确标 FREE 的 MiMo-V2.6-Flash），
它与页面徽章无关。（此结论由 lead 实测确认并撤回了他先前「用 free 字段」的建议。）

**测试覆盖**：
- 「真实样本（d3）：badge_label 缺失 → badgeLabel 为 null，**不回退到 token_factory.badge**」
- 「12 个模型显示 FREE 徽章，3 个 Decision 模型不显示」
- 「d3 / d3-flash / Clef 三个 Decision 模型没有徽章」（断言全文不含 `FREE` 字样）
- 「free 非布尔 true（脏数据）时不渲染徽章」（`free:'yes'` / `free:1` 都不给徽章）

---

## 5. 数据源：一次拿全优先，逐卡 GET 回退

lead 提供的发现改变了实现：`POST bootstrap?section=dedicated` 一次返回 **15 条 `shared_models`**，
每条自带 `display_config`，与 `model?id=` 单查的 `{model:{...}}` **内部对象同构**。

于是三级数据源：

| 级别 | 请求数 | 实测耗时 | `source` 值 |
|---|---|---|---|
| 1. `bootstrap?section=dedicated` → `shared_models` | **1** | 0.37s / 58KB | `shared` |
| 2. `bootstrap?directory=true` → cards + 逐卡 GET | 16 | ~5s | `cards` |
| 3. `FALLBACK_CATALOG`（内置 15 条常量） | 0 | — | `fallback` |

`source` 字段如实反映实际走的那条，RPC 返回里带出去，便于排查「为什么数字没变」。

**「失败保留旧数据」纪律**与 load 一致：失败只写 `error`，`entries` / `ts` 原样保留，`ts` 不前进即自动变陈旧。
从没成功过时 `entries` 就是 `FALLBACK_CATALOG` 的克隆 —— **UI 永远不会空白**。

> ⚠️ 参数名是 `section=dedicated`，但返回的 `section.key` 是 **`public_free`**。
> 即「Public Free Model APIs」区的 15 个免费模型。Dedicated 区的 3 个（`MiniCPM5-2B` 的另一套 /
> `MiniCPM-v46` / `MiniCPM5-1B`）**不在**这个响应里 —— 与用户裁定「只显示 15 个免费模型」正好一致。

---

## 6. 与任务描述冲突的地方（以真实数据为准）

任务描述里有 3 处与 `test/fixtures/` 的真实样本不符，均已按真实数据实现：

### 6.1 `display_config.name` 不是模型 id —— 用它当 id 会丢两个模型的负载

任务描述写「短 id 取 `display_config.name`」。实测：

| 模型 | `display_config.name` | load 端点的 key |
|---|---|---|
| DeepSeek-V4.1-Flash | `DeepSeek-V4.1-Flash-1017` | `DeepSeek-V4.1-Flash` |
| DeepSeek-V4-Flash | `DeepSeek-V4-Flash-0731` | `DeepSeek-V4-Flash` |

两个模型带 `-1017` / `-0731` 后缀。**用 `name` 当 id 会让它们永远匹配不到负载，白白显示成「无负载数据」。**

修正：`id` 恒取「去前缀的全 id」（`model_gateway:X` → `X`），`display_config.name` 另存 `displayName` 备查。
这是唯一能与 load 端点 key 对齐的口径 —— 已用脚本验证：去前缀后 15 个 id 与 `load.json` 的 key
完全对得上（差异只有 `DeepSeek-V4-Flash-Vision-Exp` 那个不在目录里的，按「目录为主集」不显示）。

### 6.2 分类与徽章「必须动态拿」是对的，但一次请求就够

任务描述建议「先 bootstrap 拿 cards，再逐个 GET model」。实际上 `section=dedicated` 一次就返回全部
`display_config`，**省 15 次往返**。已按 lead 的建议改为首选路径。

### 6.3 `badge_label` 之外的两个字段都不可信

- `token_factory.badge.label` 对 d3 系也是 `"Free"`（见 §4.1）
- 顶层 `free` 布尔对 15 条全是 `false`

---

## 7. 轮询节奏

| 配置项 | 默认值 | 理由 |
|---|---|---|
| `pollMs` | **600000（10 分钟）** | 用户明确要求：dsh 能导入的 VLM/LLM 都慢（十几到三十 tokens/s），繁忙度变化缓慢 |
| `staleAfterMs` | **660000（11 分钟）** | pollMs + 1 分钟余量，避免正常轮询间隙被误标陈旧 |
| `catalogPollMs` | 21600000（6 小时） | 分类与徽章几乎不变 |
| `timeoutMs` | 40000 | load 端点实测 ~26s，低于 40s 必然假超时 |
| `catalogTimeoutMs` | 20000 | 目录端点实测 0.37s，20s 足够宽 |

client 侧保持 **60s** 打本地 RPC（毫秒级，打内存快照，不打上游）。

---

## 8. 自检结果

### 8.1 语法检查

```
check ok  lib/catalog.js        check ok  test/catalog.test.mjs
check ok  lib/index.js          check ok  test/client.test.mjs
check ok  lib/client.js         check ok  test/host.test.mjs
check ok  lib/load-source.js    check ok  test/load-source.test.mjs
                                check ok  test/e2e-live.mjs
```

### 8.2 单测（135 用例全绿）

| 套件 | 命令 | 结果 |
|---|---|---|
| load-source | `node test/load-source.test.mjs` | **32 passed, 0 failed**（未改动，保持全绿） |
| catalog（新） | `node test/catalog.test.mjs` | **50 passed, 0 failed** |
| client | `node test/client.test.mjs` | **29 passed, 0 failed**（原 15，跟新 UI 改） |
| host | `bash test/with-stub.sh` | **24 passed, 0 failed**（原 17） |

原 64 个用例**没有删除任何一个**，全部保留并跟着新 UI 改断言。

### 8.3 真实样本端到端（fixtures）

```
bootstrap cards: 15
groups: 5  VLM (Vision)(7) | LLM (Text)(3) | Decision (Classifier)(3) | TTS (Speech)(1) | OCR (Document)(1)
free: 12 / total: 15
no-load: [MiniCPM-V-4.7-1B, d3, d3-flash, OmniVoice, MinerU2.5-Pro]
```

断言通过：**15 个模型、5 个分组、3 个无 FREE 徽章**（正是自检清单要求的三条）。

### 8.4 真实端点 e2e（`bash test/with-stub.sh e2e`）

```
[amd-model-load] catalog ok: 15 models, source=shared
[amd-model-load] load ok: 12 models, scope=fleet
[e2e] 上游往返 25.4s
[e2e] catalog 读缓存耗时 0ms
[e2e] 目录数据源：shared，目录 5 组
[e2e]   VLM (Vision)            7 个（有数据 6 / 无数据 1）
[e2e]   LLM (Text)              3 个（有数据 3 / 无数据 0）
[e2e]   Decision (Classifier)   3 个（有数据 1 / 无数据 2）
[e2e]   TTS (Speech)            1 个（有数据 0 / 无数据 1）
[e2e]   OCR (Document)          1 个（有数据 1 / 无数据 0）
PASS  e2e 通过，总耗时 25.5s
```

实时抓到的分组视图（host 已排好序，注意 VLM 组严格升序、无数据在末）：

```
VLM (Vision)
  MiniCPM-V-4.7-35B-A3B    idle      14.8%  FREE
  Qwen3.8-27B              idle      21.3%  FREE
  Gemma-4-31B-IT           idle      25.8%  FREE
  Qwen3.8-Flash-Next       idle      42.2%  FREE
  DeepSeek-V4.1-Flash      full     100.0%  FREE
  MiMo-V2.6-Flash          full     100.0%  FREE
  MiniCPM-V-4.7-1B         unknown       —  FREE   ← 无数据，组末
LLM (Text)
  MiniCPM5-2B              idle       4.7%  FREE
  DeepSeek-V4-Flash        busy      67.4%  FREE
  GLM-5.3-Flash            full      93.8%  FREE
Decision (Classifier)
  Clef                     idle       0.8%         ← 无徽章
  d3                       unknown       —         ← 无徽章
  d3-flash                 unknown       —         ← 无徽章
TTS (Speech)
  OmniVoice                unknown       —  FREE
OCR (Document)
  MinerU2.5-Pro            idle       4.7%  FREE
```

**上游 25.4s vs catalog 读缓存 0ms** —— 再次证明 host 缓存设计必需。

### 8.5 自检清单逐项

- [x] `node --check` 全部（9 个文件）
- [x] `catalog.js` 分组排序边界：空目录、缺分类、未知分类归「其他」、全无负载数据、无数据排末尾、同繁忙度稳定排序
- [x] 真实样本端到端：15 模型 / 5 分组 / 3 个无 FREE 徽章
- [x] 现有 64 用例全绿（client 测试跟新 UI 改，未删除）
- [x] 报告写 `M3-REPORT.md`

---

## 9. 对真机验证的预期

**未验证项：GUI 目视。** 这是唯一剩下的待验项，原因见 PLAN.md 固化的坑：
`ctx.slots.inject` 对未声明 slot **静默等待**，不报错不打日志 ⇒ 日志干净不能证明 client 加载成功。

真机上应该看到：

1. Settings 左侧导航出现「AMD 模型负载」，order 60。
2. 点进去是**5 个分组**，标题依次是 `VLM (Vision)` / `LLM (Text)` / `Decision (Classifier)` /
   `TTS (Speech)` / `OCR (Document)`，每个标题右侧有「N 个」计数。
3. 组内顺序与 §8.4 的实时视图一致（繁忙度升序，无数据在组末）。
4. **12 个模型名右侧有淡紫底深紫字的 `FREE` 徽章**；`Clef` / `d3` / `d3-flash` 三行**没有**徽章。
5. 标题行右侧显示「更新于 HH:MM」；快照超过 11 分钟未刷新时多一个黄色「陈旧」标记。
6. 无负载数据的行（MiniCPM-V-4.7-1B / d3 / d3-flash / OmniVoice / MinerU2.5-Pro）整行**变淡**（opacity 0.55），
   utilization 显示 `—`，状态文字是「无数据」。

**首屏时序**：目录（0.37s）通常比负载（~26s）先到。所以刚打开时可能看到完整 5 组 15 行、
但 utilization 全是 `—`、标题写「尚未取到数据」；约 26s 后数字填充。
这是**预期行为**，不是 bug —— 目录与负载是两个独立轮询器。

**日志预期**（`console.log`，非 `ctx.logger.info`）：
```
[amd-model-load] host loaded
[amd-model-load] pollers started (load pollMs=600000, timeoutMs=40000; catalog pollMs=21600000)
[amd-model-load] catalog ok: 15 models, source=shared
[amd-model-load] load ok: 12 models, scope=fleet
```

**若 UI 不出现**：先确认插件是否真的重载（改 `lib/` 后需要 HMR 或重启 App），
再确认 `settings.section` slot 名（不要用 `settings.plugin.item`，那个在宿主里不存在）。

---

## 10. 硬约束遵守情况

- ✅ 未改 `$DSH_HOME`
- ✅ 未跑 `pnpm install`
- ✅ 未重启 App
- ✅ 纯 JS 无构建，client 保持手写 `__ModuleLoader__` 信封
- ✅ `lib/catalog.js` 零依赖（不 import 任何包，可裸跑单测）
- ✅ 未向工作区留临时桩（`with-stub.sh` 的 trap 已删除 `node_modules`）

## 11. 已知限制 / 后续可做

1. **未显示 `context_length`**（lead 提供了实测值表）。M3+ 可在模型行右侧加「上下文窗口」列。
2. **未显示 `supported_parameters`**（tools / vision / reasoning 等能力标记）。原计划里「视觉输入」需求的
   数据源就在这儿，但 M3 未要求。
3. **`displayName` 已解析但未渲染**。`DeepSeek-V4.1-Flash-1017` 这类带后缀的展示名目前不显示，
   UI 用的是规范 id。若以后要显示友好名，`displayName` 字段已就位。
4. **无手动刷新按钮**。`refresh` RPC 端点已就绪（同时刷负载 + 目录），但 client 未接按钮 ——
   因为刷新要等 ~26s，接按钮需要配套 loading 态。M3 未要求。
5. **`source: 'cards'` 回退路径未经真实端点验证**。只在单测里用 fixtures 验过
   （`bootstrap?directory=true` + 逐卡 GET）。首选路径 e2e 已实测。
