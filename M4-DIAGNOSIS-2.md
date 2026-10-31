# M4 缺陷诊断 2：模型选择列表不显示负载徽章（2026-10-31）

> 本轮做了三件事：**A** 解 app.asar 读实宿主语义（4 个包 + 运行时 Service），**B** 用从 asar
> 提取的**真实 SlotCore** 离线复现注册语义，**C** 按结论修复 + 加永久诊断。
> 结论先行：**ledger/注册机制没有问题（三条机制假设全部被 B 证伪）**；缺陷被定位到
> 「我们的组件在真实渲染路径上的失败完全不可观测」——本轮修复 = 防静默 + 防 abdicate + 可视诊断。

---

## 0. 结论摘要

| 事项 | 结论 |
|---|---|
| `priority: -1` 注册 | **正确**。真实 SlotCore 探针：两种时序下都进 ledger 并成为 `entriesOfSlot()[0]`（B-1/B-2） |
| 「条目进不了 ledger」三假设（session 绑定 / group.id 不是 amd / single 缺必填字段） | **全部证伪**（见 §2、§3） |
| `provider.id` 真实值 | **是 `"amd"`**。宿主源码证实 `provider.id = group.id = ctx.llm.listProviders()` 的 provider id（§2-A2）；本机会话存储中 `"provider": "amd"` 出现 18 次实证 |
| 1017 插件是否加载 | **是**。`dsh-web-app/cordis.patch.yml` 第 415 行无条件加载（§2-A4） |
| 根因层 | 我们组件在真机的失败（注册抛错 / 渲染抛错→abdicate）**完全静默**，无法从界面分辨；本轮把失败变成可见、可降级、可定位（§4、§5） |
| 测试 | 177/177 全绿（基线 172 + 新增 5）（§6） |

---

## 1. 时间线推理（关键突破口）

1. **第一轮缺陷**（M4-DIAGNOSIS.md）：不传 priority → 同 priority 撞车 → 我们的 register 抛错（静默）
   → **1017 是渲染者** → AMD 行只显示模型名（1017 对非 deepseek 返回 `model.name`）。
2. **修 priority:-1 之后**（当前现象）：模型名仍在、**AMD 徽章仍不在**、**1017 徽章也不在了**。
3. 「1017 徽章从『在』变『不在』」**本身就是证据**：说明新代码已加载、我们的条目已进场、
   `entriesOfSlot()[0]` 已经换成人（single slot 只有一个渲染者，1017 被 shadow）。
4. 于是缺陷只可能剩两处，且原来**都不可观测**：
   - **注册层**：某次 register 抛错（错误只进 DevTools console，见 §2-A1）；
   - **渲染层**：组件抛错 → 宿主 `SlotErrorBoundary` 把条目 **abdicate**（§2-A3）→ 1017 顶上 →
     现象在「有徽章/没徽章」之间跳，用户看到的是某一时刻的快照。

## 2. A：宿主语义核实（全部读自 app.asar 原文）

### A1. `slots.inject` 的 reconcile 与错误去向

`/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1368-1427`（Service 包装）：

```js
inject(key, callback) {
  const disposeController = ctx.effect(() => {
    ...
    const reconcile = () => {
      if (stopped) return;
      const spec = this._core.specDynamic(key);
      const epoch = this._core.declarationEpoch(key);
      if (active !== void 0 && activeEpoch === epoch) return;
      ...
      if (spec === void 0) return;                    // 未声明 → 静默等待
      const disposeEffect = ctx.effect(callback, `slots.inject(...): declaration`);
      ...
    };
    const changed = () => {
      try { reconcile(); } catch (error) {
        ...
        stop();
        queueMicrotask(() => { throw failure; });      // ← 回调抛错：只进浏览器 console
      }
    };
    unsubscribe = this._core.subscribeDeclaration(key, changed);
    try { reconcile(); } catch (error) { stop(); throw error; }  // 已声明时同步抛给调用方
    return stop;
  }, ...);
}
```

- **声明到来后**：`notifyDeclaration` 在声明方的 `register()` 内**同步**触发 `changed` → reconcile
  → `ctx.effect(callback)` → 我们的 register 在声明方 register 的调用栈内执行。
- **cb 返回的 disposer**：交回 `ctx.effect` 托管；声明塌陷（父条目销毁）时 dispose，再声明时重跑。
- **cb 抛错**：`subscribeDeclaration` 已订阅后抛 → catch → `stop()` → **`queueMicrotask(() => { throw })`**
  → uncaught，**只进浏览器 DevTools console**，不写 harness 日志、不弹 UI、宿主照常运行。
  这是「完全静默」的机制根源——**本轮已用 safeRegister 消除**（§5）。

### A2. `scope:"session"` 的 single slot 读的是全局 ledger

- `renderer-client.js:1654-1655`：`entriesOf: (key) => this._core.entries(key)`、
  `entriesOfSlot: (key) => this._core.entriesOfSlot(key)` —— **同一个全局 `SlotCore`**，
  没有 per-session 分表。scope 只影响 inject 缓存轴（`sessionInjectCache` 按 entry × binding）
  与渲染边界（`StrictSessionEntry` 按 session 代数重挂），**不影响哪些条目存在**。
- `StrictSessionEntry`（`renderer-client.js:1091-1093`）：只在 `binding.key === void 0` 时抛
  `SlotAssemblyError`（渲染方缺 scope provider 的装配错误）；我们的 label slot 由
  ModelSelect（本就在 session 内）用 renderSlot 渲染，binding 必然在位 —— 与注册无关。
- **`provider.id` 的真实值**：`model-selection-client.js:1171-1177`：

  ```js
  const groups = orderModelProviders(state.groups).map((group) => ({
    ...group,
    provider: { id: group.id, name: ... },
  }))
  ```

  而 catalog groups 来自服务端 `dsh-api-session-controller/lib/types/catalog.js:11-46`：

  ```js
  const providers = ctx.llm.listProviders();
  ... group: { id: provider.id, name: provider.name, models: entries }
  ```

  `groups` 在 `ModelDirectory.syncInputs` 原样透传（`groups: catalog.value?.groups ?? []`）。
  ⇒ `provider.id` 就是 LLM provider 注册表的 key。**本机实证**：
  `~/Library/Application Support/dsh-desktop/harness/storages/session_projcache/sessions/*.json`
  中 `"provider": "amd"` 出现 18 次（且 `routableProviders` 校验要求 group.id === selection.provider），
  ⇒ AMD 组的 id 确实是 `"amd"`，我们的 `AMD_PROVIDER_ID` 没写错。

### A3. `abdicated` 机制（渲染崩溃的后果）

- `slots-index.js:455-463`：`reportEntryError(key, entry, error, { abdicate })` 对 single/keyed/list
  把**崩溃条目**加入 `abdicated` WeakSet，从 `entriesOfSlot` 的投影中除名（registration 留在
  ledger，等注册方自己 dispose）。
- 触发方：`renderer-client.js:1139-1141` 每个条目边界包 `SlotErrorBoundary`，
  `componentDidCatch → console.error("slot entry crashed in '...':", error) → reportEntryError(abdicate: true)`。
  **我们的组件一抛错，条目就被 abdicate，1017 立刻顶上** —— 徽章「时有时无」的根源。
  同样只进 DevTools console。
- B-4 探针实测：abdicate 后 winner 从我们换成 1017（§3）。

### A4. 1017 是否被加载

`/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:415-416`（无条件，未 disabled）：

```yaml
    - id: ui-deepseek-model-label-1017
      name: '@deepseek-ai/dsh-client-ui-deepseek-model-label-1017'
```

dsh-web-app 在活动 profile 的 bundles 里（`harness/profiles/web/package.json`），⇒ **1017 在 composition 里**。
它注册 `conversation.input.model.label` 不带 priority（=0），组件命中
「provider.id ∈ {deepseek-account, deepseek-official} 且 model.id==="deepseek-flash" 且
model.name==="DeepSeek-V4.1-Flash"」才画 Tag，否则 `return model.name`（`label-1017-client.js:28-41`）。

---

## 3. B：离线复现（真实 SlotCore，/tmp/host-probe/probe.mjs）

方法：解 asar 提取 `dsh-client-ui-slots/lib/index.js` 原文直接 import；`slots.inject` 的 reconcile
逐行照抄 renderer-client.js:1368-1427。五个场景：

```
场景 a（先注入后声明）: 父条目声明后 entries(raw)=p-1,p0 → entriesOfSlot=p-1
                        renderer 分支: guarded(winner) — priority -1 的条目渲染
场景 b（先声明后注入）: entries(raw)=p-1,p0 → entriesOfSlot=p-1 → 我们渲染
场景 c（不传 priority）: register 抛 "single slot ... already has a registration at
                        priority 0 (registered by 1017) — register at a different priority..."
                        （第一轮缺陷的机制，已被 priority:-1 修复）
场景 d（渲染崩溃 abdicate）: abdicate 后 entriesOfSlot=p0 → 新 winner: 1017
                        raw entries 仍 2 条（registration 不摘除）
场景 e（父条目销毁→塌陷→重声明）: 塌陷期 entries 空（fallback），重声明后我们自动重新注册成功
```

**三条待验假设的判决**：

| 假设 | 判决 | 证据 |
|---|---|---|
| session scope 需要特殊注册方式 | **证伪** | 场景 a/b：root 注册的条目直接可见、直接成为 winner |
| group.id（=provider.id）不是 "amd" | **证伪** | §2-A2 源码链 + 会话存储 `"provider": "amd"` ×18 |
| single slot 有必填字段缺失被静默忽略 | **证伪** | SlotCore.register 对 single 只查同 priority 占用（场景 c）；缺字段不忽略、只冲突 |

**遗留可观测缺口**（本轮修复对象）：注册抛错只进 DevTools console（A1）；
渲染抛错 → abdicate 只进 DevTools console（A3）→ 真机上无法分辨「没注册 / 没被调 / 调了判定没命中」。

## 4. 根因判定

**不是注册进不了 ledger**（B 证伪），而是：第一轮的静默抛错修复后，剩余失败模式
（注册再抛错、AMD 分支在真机脏数据下抛错→abdicate）依然零反馈，导致真机现象无法归因。
M4-DIAGNOSIS.md 建议的「可见 UI 探针」是正确方向，本轮把它落成永久诊断。

## 5. 改动清单（全部在工作区内）

### `lib/client.js`

1. **新增 `safeRegister()` 包装**（诊断 region，`lib/client.js:791` 起）：
   每次 `ctx.slots.register` 前后 `console.log("[amd-model-load] slots.register →/← ...")`
   （带 priority、id、成败）；失败 `console.error` 并记入 DIAG，**返回空 disposer**——
   不再让错误走 `queueMicrotask(() => { throw })` 的静默路径，也不再 stop 掉 slots.inject
   控制器；声明重临时还能重试注册。
2. **新增 `DIAG` 状态对象**：两个 slot 的注册落账状态（ok/error）、行组件渲染计数
   `rowRenders` / `rowOptionAmdRenders`、最近一次渲染的 `rowLastSeen`
   （placement / providerId / modelId / branch / 渲染降级错误）。
3. **`apply()` 入口打点**：`[amd-model-load] apply: connection=...`。
4. **`ModelRowBadge` 渲染计数 + AMD 分支 try/catch**：分支 3/4（查负载、渲染徽章）整段
   try/catch，任何意外降级为纯模型名 + `console.error` —— 杜绝「组件抛错 → 宿主 abdicate →
   1017 顶上 → 徽章时有时无」。1017 代渲染、模型名必渲染的产品行为不变。
5. **设置卡常驻诊断行**（`renderDiagLine`，inject 新增 `diag`）：
   `诊断：模型行徽章 已注册，行组件已渲染 N 次（option+amd M 次），最近一次：placement=... provider=... → ...`
   —— 不开 DevTools 即可判定缺陷在哪一层（见 §7 决策树）。

### `test/client.test.mjs`

- `mount()` 支持 `failRegisterFor` 选项（注入 register 抛错）。
- 新增 5 用例：统一前缀日志 / 卡片诊断行「已注册」 / 渲染计数与分支记录 /
  register 抛错不再向上抛且 console.error / AMD 分支抛错降级为纯模型名。

### 未改动

`lib/index.js`、`lib/catalog.js`、`lib/load-source.js`（host 侧与本缺陷无关，mtime 未变）；
app.asar 只读未改；未重启 / 未 osascript DSH Desktop。

## 6. 测试结果

```
node test/load-source.test.mjs   PASS  32 passed, 0 failed
node test/catalog.test.mjs       PASS  50 passed, 0 failed
node test/client.test.mjs        PASS  71 passed, 0 failed   （基线 66 + 新增 5）
bash test/with-stub.sh           PASS  24 passed, 0 failed   （桩已自动删除，ls node_modules 确认不存在）
```

合计 **177/177**（基线 172 + 5）。`node --test test/`（需临时 schemastery 桩，验后已删）：**4 文件全过**。

## 7. 重启 DSH Desktop 后 30 秒验证（决策树）

1. 打开 **Settings → AMD 模型负载**，看卡片底部灰色小字 **「诊断：…」**：
   - **「模型行徽章 已注册」** → 注册层 OK，继续第 2 步；
   - **「未注册（…错误消息…）」** → 把错误消息发回来，一眼定位（最可能是同 priority 冲突类）。
2. 打开一次模型选择菜单（展开 AMD 模型列表），回到设置页再看诊断行：
   - **「已渲染 N 次（option+amd M 次），最近一次：placement=option provider=amd → option+amd」**
     且 M>0 → 组件被调、判定命中、徽章应该已经在列表里；
   - **N 增长但 branch=bare-name、provider=非 amd** → provider 判定问题，lastSeen 里有真实 id，照改常量即可；
   - **N 不增长** → 条目没成为渲染者（被 shadow / 声明塌陷），转 DevTools console 过滤
     `[amd-model-load]` 看注册日志，以及 `slot entry crashed` 看是否 abdicate。
3. **列表里直接看**：AMD 模型行名字右侧应有 `● 20.1%`（首屏目录 0.4s 内、负载 ~26s 后填充，
   期间是灰点 + `—`）；DeepSeek-V4.1-Flash 行与收起按钮应带 **1017** 徽章。
4. 若出现 `（渲染降级：…）` 字样 → AMD 分支真机抛错，错误消息会直接写在诊断行里，发回即可。

## 8. 若诊断行一切正常但徽章仍不显示（后备假设 × 3）

1. **运行中的浏览器仍是旧代码**（link: 型插件的 client 半身要页面重载才刷新）。
   验证：DevTools console 应有 `[amd-model-load] apply:` 前缀日志；没有即旧代码，
   让用户重启后再看。要读的文件：无（console 即证据）。
2. **渲染输出被父级 UI 吞掉**（badge span 渲染了但布局不可见）。验证：DevTools Elements
   搜 `data-model-id="..."` 的兄弟节点里有无我们的徽章 span（title="AMD 负载：…"）。
   要读的文件：asar 内 `dsh-client-ui-model-selection/lib/client.js:1665-1673`（option 行 DOM 结构）。
3. **同一会话里有更高优先级的另一注册者**（其他第三方插件也抢了 label slot）。
   验证：DevTools console 找 `already has a registration at priority -1`；或在宿主 inspect
   （`dsh-client-ui-slots` 的 snapshot 面）看该 slot 的 occupants 列表。
   要读的文件：asar 内 `dsh-client-ui-slots/lib/index.js:163-243`（register 冲突判定）。
