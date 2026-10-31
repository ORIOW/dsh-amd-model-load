# M4-REPORT — 模型选择列表逐行负载徽章（移除工具行卡）

任务：task-6（M4） · 执行：m3-coder · 日期：2026-10-25
工作区：`/Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load`

---

## 0. 必答问题：`renderSlot` 的 fallback 在贡献者返回 null 时生效吗？

**答：不生效。fallback 只在「该 slot 一个贡献者都没有」时生效。**

### 证据（从 app.asar 里读到的源码，不是推测）

`@deepseek-ai/dsh-client-ui-renderer/lib/client.js` 第 1175 行，`renderOutletContent` 的 `single` 分支：

```js
if (spec.kind === "single") {
    const entry = host.entriesOfSlot(slotKey)[0];
    if (!entry) return entries.length > 0 ? deadCell()
                                         : jsx(Fragment, { children: opts?.fallback ?? null });
    return guarded(entry, entryKeyOf(entry));
}
```

判定链：

1. `entry = host.entriesOfSlot(slotKey)[0]` —— 有贡献者时 `entry` 非空。
2. `if (!entry)` 只在**没有 entry** 时成立，那时才渲染 `opts.fallback`。
3. 有 entry 时走 `guarded(entry, ...)` → `SlotErrorBoundary` / `RootEntry` → `renderEntry`，
   而 `renderEntry` 是直接 `jsx(Comp, props)`（第 882 行附近）：

   ```js
   function renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, ...) {
       if (slotInjected.slotHookFactories === void 0) return jsx(Comp, { ...kit, ...injected, ...props });
       ...
   }
   ```

   **没有任何「组件返回 null 就回退 fallback」的分支。**

两条独立证据同向：`fallback` 是「无贡献者时的占位」，不是「贡献者放弃时的兜底」。

### 据此的处理方式

**组件在每一个分支都自己渲染 `model.name`，绝不返回 null。**

| 分支 | 渲染内容 |
|---|---|
| `placement === "option"` + `provider.id === "amd"` + 有负载 | `model.name` + 彩色点 + `20.1%` |
| `placement === "option"` + amd + 无负载数据 / 查不到 | `model.name` + 灰点 + `—` |
| `placement === "trigger"` | **只有** `model.name` |
| `placement === "menu"` | **只有** `model.name` |
| `provider.id !== "amd"` | **只有** `model.name` |
| `placement` 缺失 / 未知值 | **只有** `model.name` |
| rpc 失败 / 抛异常 | `model.name` + 灰点 + `—` |

实现上就是「先无条件 `modelName`，徽章作为 Fragment 的第二个子节点**额外**追加」：

```js
const modelName = typeof model.name === "string" && model.name !== ""
  ? model.name : String(model.id ?? "");

if (!isOption || !isAmd) {
  return React.createElement(React.Fragment, null, modelName);   // ← 不返回 null
}
return React.createElement(React.Fragment, null,
  modelName,                                                       // ← 恒有
  React.createElement("span", {title, style}, dot, percent),        // ← 额外
);
```

测试里有一条专门锁这个行为：**「模型名在四种分支下都可见」**，逐一断言 option+amd / trigger / menu / option+非 amd
四种情况下 `text` 都包含模型名。另外还有「placement 缺失/未知值」与「model.name 缺失回退 model.id」两条。

---

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| 模型选择列表逐行显示「点 + 百分比」 | ✅ 只在 `placement === "option"` + `provider.id === "amd"` |
| 模型名在所有分支可见（不返回 null） | ✅ 6 条测试覆盖，含 4 分支同测 |
| 工具行卡已移除 | ✅ 组件 / 常量 / slot 注册 / `pickIdlest` 全删，有测试断言不再注册 |
| 共享 store 保留 | ✅ 订阅者变成「设置卡 + 列表徽章」 |
| host 侧零改动 | ✅ 三文件 mtime 未变 |
| 回归 | ✅ **166 用例全绿**（原 164 → 166） |

---

## 2. 文件改动

| 文件 | 行数 | 性质 |
|---|---|---|
| `lib/client.js` | 674（原 659） | 删工具行卡，新增 `ModelRowBadge` / `findModelLoad`；`apply` 换 slot |
| `test/client.test.mjs` | 1110（原 1058） | **60 用例**（原 58 −18 工具行 +20 列表徽章） |
| `M4-REPORT.md` | 本文 | — |

**未改动**：`lib/index.js`、`lib/catalog.js`、`lib/load-source.js`、`package.json`、`cordis.patch.yml`、
`test/load-source.test.mjs`、`test/catalog.test.mjs`、`test/host.test.mjs`、`test/e2e-live.mjs`。

---

## 3. 删除清单（工具行卡相关，属功能移除的正当删除）

### 3.1 `lib/client.js` 删除项

| 删除对象 | 原位置 | 说明 |
|---|---|---|
| `TOOL_ROW_ID` 常量 | constants | 值为 `"dsh-amd-model-load.toolrow"` |
| `TOOL_ROW_ORDER` 常量 | constants | 值为 `70`（避开 dsh-pause 的 30） |
| `pickIdlest(groups)` 函数 | helpers | 「全局找最空闲」——列表徽章按 id 查，不需要选优 |
| `ToolRowBadge` 组件 | 工具行卡组件 region | 整块删除（约 90 行） |
| `ctx.slots.inject("conversation.input.right", ...)` | `apply` | slot 注册整块删除 |

### 3.2 `test/client.test.mjs` 删除的 18 个用例（逐条列出）

**A. 注册类（1 条）**
1. `apply 同时注册进 conversation.input.right，order 避开 dsh-pause 的 30`

**B. 工具行最空闲选择（5 条）**
2. `工具行显示全局最空闲的模型（跨组比较，不是取第一组第一行）`
3. `平局时按 id 字典序取第一个（结果可重复）`
4. `只有部分模型有数据时，从有数据的中选最小`
5. `全都没有负载数据时显示「AMD 负载 · 无数据」灰字`
6. `hasLoad 为 true 但 utilization 非数字时不参与竞争`

**C. 工具行渲染（10 条）**
7. `有数据时显示状态点 + id + 百分比 + 更新时间`
8. `状态点颜色跟随最空闲模型的状态`
9. `工具行**不显示** FREE 徽章（刻意的取舍）`
10. `陈旧时在百分比后追加「· 陈旧」`
11. `新鲜时不显示「陈旧」`
12. `title 属性带完整信息（hover 提示）`
13. `陈旧时 title 里也标注`
14. `无数据态的 title 也有说明`
15. `单行紧凑：工具行根节点是 flex 单行 + nowrap`
16. `工具行不做点击交互（无 onClick）`

**D. 容错（2 条）**
17. `工具行在 rpc 失败时降级为「无数据」而不崩`
18. `工具行在 rpc 抛异常时降级为「无数据」而不崩`

> 其中「陈旧时追加·陈旧」这个**能力**被移除了（列表行按用户要求不显示时间/陈旧标记），
> 但 `loadStale` 仍在 store 快照里，设置卡继续用它显示陈旧徽章 —— 不是数据层丢失。

### 3.3 保留但改名的用例

| M2 名字 | M4 名字 | 原因 |
|---|---|---|
| `两个 slot 拿到的是**同一个** store 实例` | 同名，断言对象从 `toolRow` 改为 `modelRow` | 共享 store 结构不变，只是第二个订阅者换了 |
| `全插件只创建一个 timer（两个订阅者不会各起一个）` | 同名，`toolRow` → `modelRow` | 同上 |
| `两个订阅者拿到**同一个快照对象**（时间戳必然一致）` | 同名，`toolRow` → `modelRow` | 同上 |

**M3 的 29 个用例：脚本核验 0 缺失**（用 M3 备份按用例名做差集，结果为空）。

---

## 4. `ModelRowBadge` 实现要点

### 4.1 slot 注册

```js
ctx.slots.inject("conversation.input.model.label", () =>
  ctx.slots.register(
    {
      name: "conversation.input.model.label",
      id: MODEL_ROW_ID,          // "dsh-amd-model-load.modelrow"
      inject: () => ({ store }), // 与设置卡同一个 store 实例
    },
    ModelRowBadge,
  ),
);
```

**没有 `order`**：父级声明是 `kind:"single"`，同一时刻只有一个贡献者生效，`order` 无意义。
（`kind` 与 `scope:"session"` 已从宿主源码确认：父级 `children` 里
`"conversation.input.model.label": { kind: "single", scope: "session", inline: true }`。）

### 4.2 按 id 查负载（`findModelLoad`）

catalog 是**分组结构**（`groups: [{label, models}]`），而列表给的是扁平 `model.id`，所以必须跨组线性查找：

```js
function findModelLoad(groups, id) {
  for (const group of groups) {
    for (const model of group.models) {
      if (model.id !== id) continue;
      return { state, utilization, hasLoad: model.hasLoad === true };
    }
  }
  return null;
}
```

规模很小（15 个模型），不做索引 —— 一次渲染最多 N 行 × 15 次比较，可忽略。

返回 `null` 覆盖两种情况：「查不到」与「查到了但没有负载数据」，UI 上都是灰点 + `—`
（对用户而言是同一件事：现在没有可用的繁忙度读数）。

### 4.3 样式（行内元素约束）

| 属性 | 值 | 理由 |
|---|---|---|
| `display` | `inline-flex` | 必须行内，不能独占一行 |
| `alignItems` | `center` | 点与文字垂直居中 |
| `gap` | `5px` | 点与百分比之间 |
| `marginLeft` | `6px` | 与模型名拉开 |
| `fontSize` | `11px` | 与列表行次级信息同档 |
| `fontVariantNumeric` | `tabular-nums` | **数字宽度稳定，刷新时不抖动** |
| `whiteSpace` | `nowrap` | 不换行 |
| `verticalAlign` | `middle` | 与模型名基线对齐 |
| 宽度 | **不设** | 由内容决定（模型名长短不一） |
| 点 | `6px` 圆，`background: STATE_COLOR[state]` | 复用现有配色 |

**不显示**：FREE 徽章、时间、`· 陈旧` 标记 —— 用户要求列表行只要「状态点 + 百分比」。

### 4.4 title（hover）

```
AMD 负载：空闲 20.1%，更新于 21:37
AMD 负载：无数据 —            ← 无负载数据时（没有时间可显示，就省略「更新于」）
```

### 4.5 实际渲染输出（用真实 fixtures 跑真实 host 分组逻辑）

```
option + amd（有负载 20.1%）     "Qwen3.8-27B20.1%"
option + amd（满载 100%）        "GLM-5.3-Flash100.0%"
option + amd（无负载数据）        "OmniVoice—"
trigger（收起按钮）              "Qwen3.8-27B"
menu（顶部当前项）                "Qwen3.8-27B"
option + 非 amd                 "Hunyuan Turbo"
```

文本里没有空格是因为「模型名」与「徽章 span」之间靠 `marginLeft: 6px` 留白，
视觉上是 `Qwen3.8-27B  ● 20.1%`。**六种情况下模型名都在。**

---

## 5. 自检结果

### 5.1 语法

```
check ok  lib/client.js
check ok  test/client.test.mjs
```

### 5.2 全量回归（166 用例全绿）

| 套件 | 命令 | 结果 |
|---|---|---|
| load-source | `node test/load-source.test.mjs` | **32 passed, 0 failed** |
| catalog | `node test/catalog.test.mjs` | **50 passed, 0 failed** |
| client | `node test/client.test.mjs` | **60 passed, 0 failed**（原 58） |
| host | `bash test/with-stub.sh` | **24 passed, 0 failed** |

合计 **32 + 50 + 60 + 24 = 166**。

### 5.3 用例保留核验

| 基线 | 用例数 | 缺失 |
|---|---|---|
| M3（29 条） | 29 | **0**（脚本差集为空） |
| M2（58 条） | 58 | 18（全部是工具行功能用例，已逐条列在 §3.2） |

### 5.4 新增的 20 个用例

**placement / provider 分支（7 条）**
1. `placement="option" + amd + 有负载 → 渲染模型名 + 点 + 百分比`
2. `placement="trigger" → 不渲染徽章，但模型名仍可见`
3. `placement="menu" → 不渲染徽章，但模型名仍可见`
4. `provider 不是 amd → 不渲染徽章，但模型名仍可见`
5. `**模型名在四种分支下都可见**（宿主 fallback 只在无贡献者时生效，返回 null 会变空白）`
6. `模型名取 model.name，缺失时回退到 model.id（不渲染成 undefined）`
7. `placement 缺失 / 未知值 → 当作非 option，只渲染模型名`

**读数与容错（9 条）**
8. `有负载数据 → 状态点颜色跟随 state`
9. `查不到该模型 → 灰点 + 「—」`
10. `查到了但 hasLoad 为 false → 灰点 + 「—」`
11. `rpc 失败 / 抛异常 → 灰点 + 「—」，模型名仍可见`
12. `title 带状态中文与时间；无数据时 title 仍可读`
13. `徽章不显示 FREE 字样（列表行只要点 + 百分比）`
14. `徽章不显示「更新于」（只在 title 里）`
15. `样式：inline-flex + marginLeft + nowrap + tabular-nums，且不设固定宽度`
16. `selected 为 true 时不改变徽章渲染（选中态由父级样式负责）`

**注册（4 条）**
17. `apply 同时注册进 conversation.input.model.label，id 与设置卡不同`
18. `不再注册 conversation.input.right（M2 工具行卡已按用户裁定移除）`
19. （改名保留）`两个 slot 拿到的是同一个 store 实例`
20. （改名保留）`全插件只创建一个 timer` / `两个订阅者拿到同一个快照对象`

### 5.5 硬约束逐项

- [x] `node --check` 通过（2 个改动文件）
- [x] 工具行相关用例删除并**逐条列出**（§3.2，18 条）
- [x] 其余用例全绿（M3 的 29 条零缺失）
- [x] 新增用例覆盖：trigger / menu 不渲染、非 amd 不渲染、option+amd 有负载、无负载、**模型名四种情况都断言**
- [x] 报告回答 fallback 问题（§0）
- [x] 未改 `$DSH_HOME`、未跑 pnpm install、未重启
- [x] **host 侧零改动**（`index.js` / `catalog.js` / `load-source.js` mtime 未变）
- [x] 设置卡继续正常工作（其 29 条 M3 用例全绿）
- [x] 工作区无 `node_modules` 残留

---

## 6. 对真机验证的预期

**未验证项：GUI 目视。**

真机上应该看到：

1. **设置页不变**：Settings →「AMD 模型负载」仍是 5 组、12 个 FREE 徽章、无数据行变淡。
2. **输入框下方的模型选择按钮（trigger）不变**：仍只显示模型名，**没有**百分比。
   （这是我们刻意排除的分支 —— 若这里出现 `20.1%` 说明 `placement` 判断失效。）
3. **点开模型选择菜单**：
   - 顶部「当前选择」那一行（menu）**只有模型名**，没有百分比；
   - 下面的**可选项列表**（option）每行在模型名右边出现 `● 20.1%` 形式的小徽章；
   - **AMD provider 的模型都有**，非 AMD provider 的行没有。
4. 鼠标悬停徽章出现 title：`AMD 负载：空闲 20.1%，更新于 HH:MM`。
5. 无负载数据的模型（OmniVoice / MinerU2.5-Pro / d3 / d3-flash / MiniCPM-V-4.7-1B）显示灰点 + `—`。
6. **工具行那张卡消失** —— 输入框右侧不再有 `● Clef 0.8% · 21:37`。

**最关键的一条**：模型名必须在**所有**位置都正常显示（trigger / menu / option / 非 AMD provider）。
若任何一处模型名消失，说明我们的组件返回了 null —— 但代码里所有分支都渲染了 `modelName`，
6 条测试也锁住了这一点，所以理论上不应发生。

**首屏时序**：目录 0.37s 到、负载 ~26s 到。刚打开菜单时可能全是灰点 + `—`，约 26s 后填充。
这是预期行为。

**若列表行完全没有徽章**：先确认 `provider.id` 真的是 `"amd"`
（`cordis.patch.yml` 里 `providers.amd` 的 key）。若 provider key 不是 `amd`，
把 `AMD_PROVIDER_ID` 常量改成实际的 key 即可，无需改逻辑。

---

## 7. 已知限制 / 后续可做

1. **列表行不显示 FREE 徽章与时间**（按用户要求）。若以后想在列表行区分免费/付费，
   数据已在 catalog 里（`free` / `badgeLabel`），加一行渲染即可。
2. **`findModelLoad` 是 O(组数 × 组内数) 线性查找**。15 个模型可忽略；若将来目录涨到几百个，
   可以在 store 里额外维护一份 `Map<id, load>` 索引（纯 host 侧改动）。
3. **没有处理「同一个 model.id 出现在多个组」的情况**。当前 catalog 里 id 唯一
   （`groupAndSort` 已按 id 去重），返回第一个匹配项。若上游未来允许跨组重复，
   这里会取到第一个 —— 但按 AMD 的数据模型，一个模型只属于一个 capability，不应发生。
4. **`placement` 的 `"menu"` 与 `"trigger"` 都只渲染名字**。如果将来产品想让 trigger 也带一个
   极简状态点（不带百分比），需要单独加一个分支 —— 当前按用户裁定不做。
