# M5 · 渲染抖动与日志洪水（2026-11-01）

任务来源：`AI Tools/amd-model-load-task-20261101.md`。实测窗口 `2026-11-01T09:42:01.428Z – 10:07:24.179Z`
（25 分 22 秒，同一次宿主启动），宿主 DSH Desktop 0.12.1，日志 `/Users/dengjiawei/Library/Logs/DSH Desktop/harness.log`。

本轮只做三件事：**降噪（P1）**、**裁定抖动的归属（P2）**、**把渲染期副作用挪出去（P3）**。
徽章的功能、文案、挂载点与 `priority: -1` 抢占行为一律未改。

---

## 1. 结论

1. **重渲染源不是本插件，而是宿主父组件。** composer 收起态的模型行（`placement: "trigger"`）在流式输出
   期间被上游以 105–129 次/秒重渲染；本插件的快照 store 的理论 emit 上限是 **1 次 / 60 秒**
   （差 3–4 个数量级，见 §2.2）。
2. **日志洪水的主因是「每次渲染上报一条」这条策略，不是渲染本身。** 25 分钟里本插件产出 2299 行、
   其中 2235 行是 `stage:"render"`；对应 2231 次 RPC 与 2231 行宿主 `console.log`。
3. **插件在单次渲染里的成本可忽略。** 跨组线性查找 + title 拼串实测 **0.031 µs/次**（§2.4）；
   130 次/秒 ≈ 单核 **0.004%**。加缓存后 0.008 µs。所以「CPU 被拖垮」不成立，
   需要处理的只有**日志量**与**渲染期副作用**。
4. 依据 1，本插件不该去「优化掉」这个重渲染（那是宿主行为，我们无权也无力改），
   只把自己的每次渲染成本压到 O(1) 并在 README 明写该现象属宿主。

---

## 2. 证据

### 2.1 日志侧（任务书窗口，逐项复算）

| 指标 | 实测 | 说明 |
| --- | --- | --- |
| harness.log 总行数 | 2667 行 / 493 KB | 25 分 22 秒 |
| 本插件相关行 | **2299 行（86%）** | `grep -c 'amd-model-load'` |
| 其中 `stage:"render"` | **2235 行** | 占本插件行 97% |
| `renderIndex` 终值 | **55775** | n=1 起算 ⇒ 该窗口共 55775 次渲染 |
| 平均渲染速率 | **≈36.6 次/秒** | 55775 / 1523 秒 |
| 峰值（09:42 单分钟） | **≈105 次/秒** | n 从 1 涨到 6350 |
| 流式时段（09:54 单分钟） | 309 次 ≈ **129 次/秒** | 与峰值同量级 |
| 空闲时段（09:44 / 09:55 / 10:00） | 19 / 4 / 2 次（**≈8 / 0.07 / 0.03 次/秒**） | 空闲并不为零，仍有低频重渲染 |
| 上报策略 | 每 25 次一条 | 25 分钟 2231 次 RPC ≈ 1.5 次/秒 |

分布特征（决定性）：该窗口**所有** render 行都是
`placement:"trigger"`、`providerId:"apigoto"`、`modelId:"deepseek-flash"` ——
即「收起态触发按钮上的那一行标签」，且从来不是我们自己的 `providerId:"amd"` 行。
空闲 ~8 次/秒、流式 105–129 次/秒，两者的量级差与「流式 chunk 驱动的父组件更新」完全吻合。

### 2.2 代码侧：本插件 store 的 emit 通路是唯一的

```js
// lib/client.js:386   notify() 只有两个调用点，都在 pull() 的 then / catch 里
function notify() { emits += 1; /* 遍历 listener */ }

// lib/client.js:398-428  pull() —— 每次拉取结束后 notify 一次
// lib/client.js:431-438  start() —— 订阅时拉一次，然后 setInterval(CLIENT_POLL_MS)
const CLIENT_POLL_MS = 60_000;   // lib/client.js:108
```

再往下：

- `pull()` 的调用点只有 `start()`（`subscribe()` 首次调用时一次）与 `setInterval(..., 60_000)`；
- `subscribe()` 只在 `useSnapshot` 的 effect 里调用，依赖是 `[store, usable]` —— 挂载时一次；
- 没有任何「渲染即拉取」「定时器 < 60s」「listener 回调里再 pull」的路径。

⇒ **单订阅者的 emit 上限 = 1 次 / 60 秒 = 0.0167 次/秒。** 与实测均值 36.6 次/秒差 2196 倍，
与峰值 129 次/秒差 7740 倍。因此「插件 store 高频 emit 导致抖动」这一假设被排除。

> 反向验证留给真机：心跳里新增了 `storeEmits`（累计 emit 次数）与 `rendersPerSec`（上次心跳以来的
> 渲染速率），两数同框出现即可现场对照（见 §6 第 2 条）。

### 2.3 为什么「每次渲染一条日志」会变成灾难

宿主把我们上报的 `diag` 落到 `harness.log`，代价是**每次上报 = 1 次 RPC + 1 行宿主日志**。
25 分钟 2231 次 ⇒ 本插件行数占全日志 86%，`register` / `probe` / `heartbeat` 这些真正有用的记录被淹没，
`grep` 直接失去可用性。渲染本身无害，**按次上报有害**。

### 2.4 本地微基准：单次渲染成本可忽略

用 `lib/catalog.js` 的 `groupAndSort` + `test/fixtures/{catalog,load}.json` 造出真实规模（5 组 15 模型），
跑 200000 次「跨组线性查找 + 拼 title」：

| 路径 | 每次耗时 | 130 次/秒占用单核 |
| --- | --- | --- |
| 旧路径（每渲染都查找 + 拼串） | 0.031 µs | 0.004% |
| 新路径（按 `快照引用 + model.id` 命中缓存） | 0.008 µs | 0.001% |

结论：缓存不是为了救 CPU，而是为了把「每渲染做的活」从「遍历 + 分配字符串」降到「一次 Map 取值」，
让这段代码在 130 次/秒下也不必被怀疑。**真正的修法是 §3 的日志阶梯。**

---

## 3. 改动（P1 + P3）

### 3.1 P1 · 上报改对数阶梯

```js
const RENDER_REPORT_MARKS = [10, 100, 1000, 10000, 100000, 1000000, 10000000];
function shouldReportRender(n) { return n <= 3 || RENDER_REPORT_MARKS.indexOf(n) !== -1; }
```

单次启动的生命周期内，render 上报从「每 25 次一条」变成「n ≤ 3 各一条 + 每个数量级一条」，
即 55k 次渲染只产 **10 条左右**（含 n=1,2,3 与 10/100/1000/10000）。

**为什么没做「诊断模式开关、默认不报」**：任务书把开关列为「更稳的做法」，但它会让
「重启后核验」依赖于有人先把开关打开 —— 这与本项目已确立的**验收必须可 headless 自证**原则冲突
（见交接账本：验收标准必须是能自己执行的命令，不能以「等用户看一眼」为准）。
阶梯方案在默认关闭之外拿到了同样的量级收益（≤10 行/会话），且核验不需要任何人工开关。

### 3.2 P1 · 心跳补增量与速率（可观测性不丢）

每 30 秒的 heartbeat 现在包含：

| 字段 | 含义 |
| --- | --- |
| `rowRenders` | 累计渲染次数（阶梯上报后仍可信，因为它来自 effect 计数） |
| `rowRendersDelta` | 距上次心跳的渲染增量 |
| `rendersPerSec` | `delta / elapsed * 1000`，保留两位 |
| `storeEmits` | store 累计 notify 次数 —— **与 `rowRendersDelta` 对照即可判定抖动归属** |
| `rowLastSeen` | 最近一次渲染的 `placement / providerId / modelId / branch / error` |

判定读法：`rendersPerSec` 高而 `storeEmits` 不涨 ⇒ 宿主放大器；
两者同步上涨 ⇒ 我方数据源有问题（此时才需要查 poller）。

### 3.3 P3 · 渲染期只读

`ModelRowBadge` 的渲染体内不再写任何模块级对象：

- 删掉了渲染首行的 `DIAG.rowRenders += 1` 与「每 25 次」上报块；
- 计数、`rowLastSeen`、`rowOptionAmdRenders`、阶梯上报全部搬进
  `React.useEffect(() => { ... })`（**无依赖数组 ⇒ 每次提交跑一次**）；
- catch 分支不再直接写 `DIAG.rowLastSeen`，改为 `renderError = message`，由 effect 落账；
- AMD 分支改用 `badgeView(snapshot.data, model.id)`，按「快照引用 + model.id」缓存读数。

已知取舍（写进测试注释）：旧实现能统计「组件被调用了但渲染提前抛错」，新实现不能
（渲染抛错 ⇒ 没有 commit ⇒ effect 不跑 ⇒ 计数不动）。这一场景改由宿主 `SlotErrorBoundary`
（abdicate 后 1017 顶上）与 `console.error` 兜底。测试 `渲染期只读：渲染抛错时不得改动 DIAG` 固化了新不变量。

---

## 4. 验收（本会话已执行）

```sh
node test/client.test.mjs    # PASS 78 passed, 0 failed
node test/catalog.test.mjs   # PASS 50 passed, 0 failed
node test/load-source.test.mjs  # PASS 32 passed, 0 failed
bash test/with-stub.sh       # PASS 24 passed, 0 failed（临时 schemastery 桩退出即删）
```

合计 **184 用例全绿**（原基线 182，本轮 +2：阶梯上报上限、trigger 布局的 effect 记账；
另「渲染早期抛错时计数已自增」按 P3 改写为「渲染期只读」）。

针对 P1 的验收用例：`渲染上报走阶梯：5000 次提交最多 12 条 render diag（防日志洪水）` ——
5000 次提交只产生 ≤12 条 render 上报，满足任务书「≤12」的判据。

---

## 5. 为什么本会话拿不到真机日志

任务书边界第 1 条：**禁止重启 DSH Desktop 宿主**（真机日志核验由用户与 AI Tools 会话完成）。
`lib/client.js` 的改动只在宿主重启后才会生效（HMR 只提示 "changed modules keep running their previous
code until a restart"），因此「重启后 30 分钟内 `grep -c 'amd-model-load'` ≤ 60」这一条只能由重启后的窗口验证。

---

## 6. 待真机核验清单（需重启，按任务书不由本会话执行）

1. **日志量**：重启后观察 30 分钟，`grep -c 'amd-model-load' "/Users/dengjiawei/Library/Logs/DSH Desktop/harness.log"`
   （按本窗口起始偏移计数）应 **≤ 60 行**；其中 `stage:"render"` ≤ 12 行。
2. **抖动归属**：读一条 heartbeat，比对 `rendersPerSec` 与 `storeEmits`。预期 `storeEmits` ≤ 1、`rendersPerSec` 随流式在 0–130 之间浮动。
3. **功能未回归**：展开模型列表，AMD 行仍是 `● x%`，`DeepSeek-V4.1-Flash` 行仍带 `1017`（前提：`dsh-reasoning-effort ≥ 0.9.0`）。
4. **设置卡**：诊断行仍显示「模型行徽章 已注册，行组件已渲染 N 次（option+amd M 次）」+ `席位=…/本格=…`。

---

## 7. 未闭环

- `storeEmits` 的实测值要等重启后的心跳（本会话无法读取）。
- 宿主的 trigger 行为何空闲时仍有 ~8 次/秒（推测为计时/光标类周期更新）不在本仓修复范围；
  README「已知限制」已记一条「trigger 随流式重渲染属宿主行为」。
- 诊断设施（`reportDiag` / `probeLedger` / heartbeat / 设置卡诊断行）仍按要求保留，
  降噪后计划在 v0.1.1 摘除 —— 摘除时需同步改掉 `test/client.test.mjs` 里断言诊断上报的用例。

---

## 8. 重启后真机核验（2026-11-01T10:20:16Z 启动，改动早已生效）

用户在 18:20（北京时间）重启宿主后，`harness.log` 新增窗口实测：

| 指标 | 改造前（任务书窗口，25m22s） | 改造后（本窗口，1m50s） |
|---|---|---|
| 插件行 / 总行 | 2 299 / 2 667（86%） | **19 / 51（37%）** |
| `stage:"render"` 行 | 2 235 | **6**（n = 1, 2, 3, 10, 100, 1000） |
| render 上报机制 | 每 25 次一条 | 对数阶梯，n=1000 之后不再逐级命中 |
| 心跳 | 30 秒一条 | 30 秒一条（**本次核验时仍是旧行为**，见下） |

**P2 归属复证（新数据，比值更极端）**：心跳 `rowRenders:2771` / `rowRendersDelta:2225`（30 秒窗口）/
`rendersPerSec:74.12` / `storeEmits:6`。渲染次数是 store 推送次数的 **≈ 460 倍**，且 `storeEmits` 在
110 秒里只增长 6 次 —— 与「store 只在 60 秒轮询时 emit」的实现完全一致。抖动源确认为宿主父组件。

**ledger 实况（顺带复核 M4）**：`seat` 条目 1 条、winner 优先级 `0`（原生 `ModelSelect`，说明
`dsh-reasoning-effort` 0.9.1 的原生接管生效、不再有 -100 的替换条目）；`label` 条目 2 条
（我们 + 内置 1017），winner 仍是 `dsh-amd-model-load.modelrow`（priority -1）。

### 8.1 顺带修正：心跳上报间隔 30 秒 → 2 分钟（采样仍 30 秒）

本窗口暴露了 P1 验收与心跳设计的冲突：任务书要求「单启动周期 30 分钟内插件行 ≤ 60」，
而 30 秒一条心跳 = 2 条/分钟 = **60 条/30 分钟**，正好吃掉全部预算，留给 12 行启动期与
7 行 render 阶梯的余量为 0（实测 30 分钟窗口会落在 ≈ 79 行）。

改法：**采样间隔不变（30 秒），上报改为每 4 次采样一次（2 分钟）**，并保留峰值：

- `rendersPerSec` 改为这 2 分钟的平均值（`rowRendersDelta` 同为 2 分钟累计）；
- 新增 `rendersPerSecPeak`（内部 30 秒粒度上的最大瞬时速率）与 `windowMs`，尖峰信息不丢；
- 30 分钟预算：心跳 15 行 + render 阶梯 ≤ 7 行 + 启动期 12 行 ≈ **34 行 ≤ 60**。

心跳在单测里不会执行（`test/client.test.mjs` 把 `setInterval` 桩成不保存回调），因此该改动
不影响既有断言；四套件复跑仍为 184 全绿（client 78 / catalog 50 / load-source 32 / host 24）。
