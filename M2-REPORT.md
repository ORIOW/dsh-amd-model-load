# M2-REPORT — 会话工具行最空闲模型状态卡

任务：task-5（M2） · 执行：m3-coder · 日期：2026-10-25
工作区：`/Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load`

---

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| 工具行显示**最空闲的一个**模型 | ✅ 全局跨组比较（不是取第一组第一行） |
| **共享订阅器**（一个 timer + listener 集合） | ✅ 全插件只有 1 个 `setInterval`，测试断言 |
| 两张卡时间戳必然一致 | ✅ 同一个快照对象引用，`loadTs` 相同 |
| 复用 host 已有 `catalog` 端点 | ✅ 不新增任何轮询器，host 侧零改动 |
| 设置卡继续正常工作 | ✅ M3 的 29 个用例全保留 |
| 回归 | ✅ **164 用例全绿**（原 135 + 新增 29） |
| host 侧零改动 | ✅ `index.js` / `catalog.js` / `load-source.js` mtime 未变 |

---

## 2. 文件改动

| 文件 | 行数 | 性质 |
|---|---|---|
| `lib/client.js` | 659（改造，原 359） | 新增 `createSnapshotStore` / `useSnapshot` / `pickIdlest` / `ToolRowBadge`；`Card` 改为从 store 读 |
| `test/client.test.mjs` | 1058（改造，原 651） | **58 用例**（原 29 全保留 + 新增 29） |
| `M2-REPORT.md` | 本文 | — |

**未改动**：`lib/index.js`、`lib/catalog.js`、`lib/load-source.js`、`package.json`、`cordis.patch.yml`、
`test/load-source.test.mjs`、`test/catalog.test.mjs`、`test/host.test.mjs`、`test/e2e-live.mjs`。
（已用 `ls -la` 核对 mtime：host 侧四个文件仍是 17:20–17:55，只有 client.js 与 client.test.mjs 是 21:17/21:20。）

---

## 3. 共享订阅器的实现（验收重点）

### 3.1 问题

两张卡都要「挂载拉一次 + 每 60s 拉一次」。直觉写法是各自 `setInterval`，但两个 timer 的相位差会累积
（JS 定时器不保证精确，事件循环忙时会被推迟），跑上一段时间后用户会看到设置卡写「更新于 21:06」
而工具行写「更新于 21:07」——同一份 host 快照被显示成两个时间，看起来像数据不一致。

### 3.2 实现：`createSnapshotStore(rpc)`

在 `apply(ctx)` 里建**一个** store，两个 slot 的 `inject` 返回**同一个实例**：

```js
function apply(ctx) {
  const rpc = /* connection.rpc 或 undefined */;

  // 整个插件生命周期内只有这一个 store（也只有一个 interval）。
  const store = createSnapshotStore(rpc);

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register({ name: "settings.section", id: NS, order: 60,
      label: () => "AMD 模型负载", inject: () => ({ store }) }, Card));

  ctx.slots.inject("conversation.input.right", () =>
    ctx.slots.register({ name: "conversation.input.right", id: TOOL_ROW_ID, order: 70,
      inject: () => ({ store }) }, ToolRowBadge));
}
```

store 内部只有四样东西：`listeners: Set`、`state`、`timer`、`inFlight`。

```js
function createSnapshotStore(rpc) {
  const listeners = new Set();
  let state = { data: null, error: null, loaded: false };
  let timer = null;
  let inFlight = null;

  function notify() { for (const l of Array.from(listeners)) { try { l(state) } catch {} } }

  function pull() {
    if (inFlight !== null) return inFlight;          // 并发只发一次请求
    inFlight = Promise.resolve(rpc.call(CHANNEL, "catalog", {}))
      .then(result => { /* 成功换 data；失败只写 error，data 原样保留 */ notify(); })
      .catch(cause => { /* 同上 */ notify(); })
      .finally(() => { inFlight = null });
    return inFlight;
  }

  function start() {                                  // 幂等
    if (timer !== null) return;
    void pull();
    timer = setInterval(() => { void pull(); }, CLIENT_POLL_MS);
  }
  function stop() { if (timer !== null) { clearInterval(timer); timer = null } }

  function subscribe(listener) {
    listeners.add(listener);
    start();                                          // 首个订阅者启动
    try { listener(state) } catch {}                  // 订阅即刻拿到当前快照
    return () => { listeners.delete(listener); if (listeners.size === 0) stop() };  // 末个退订停表
  }

  return { subscribe, getSnapshot: () => state, pull, stop, listenerCount: () => listeners.size };
}
```

组件侧只有一个 hook：

```js
function useSnapshot(store) {
  const [snapshot, setSnapshot] = React.useState(store.getSnapshot());
  React.useEffect(() => store.subscribe(setSnapshot), [store]);
  return snapshot;
}
```

### 3.3 为什么这样能保证「两张卡同一份数据」

三条性质叠起来：

1. **同一个 store 实例**：`inject()` 每次调用返回的是闭包里的同一个 `store`，不是新建。
   测试 `assert.equal(settingsStore, toolRowStore)` 直接断言对象引用相等。
2. **同一个快照对象引用**：`notify()` 把 `state` 本身（不是拷贝）发给所有 listener。
   测试 `assert.equal(got.settings, got.toolRow)` 断言引用相等 —— 两张卡的 `loadTs` **不可能**不同。
3. **只有一个 timer**：`start()` 幂等（`if (timer !== null) return`）。第二个订阅者进来时
   timer 已经存在，直接返回。测试在沙箱里数 `setInterval` 调用次数，断言「两张卡只创建 1 个」。

另外三个次要但重要的不变量：

- **并发拉取合并**：`inFlight` 复用，两个组件几乎同时 mount 也只发 1 个 RPC。
- **失败保留旧数据**：只更新 `error`，`data` 保持上一次成功值（与 host 的「失败不清空」纪律一致）。
- **末个退订停表**：设置页与工具行都关了就不空转；再有订阅者会重启。
  这里刻意不做「延迟 N 秒再停」，因为 RPC 打的是本地内存快照，重启成本只有一次毫秒级调用。

### 3.4 为什么没选「退而求其次」的方案

任务里给的备选是「两个组件各自 setInterval，但从模块级变量读 ts」。没选它，两个原因：

1. **它解决不了真正的问题**。共享 ts 只能让显示的时间戳一致，但两次拉取拿到的 `data` 仍是
   两份不同对象（可能一份新一份旧），`groups` 里的 utilization 仍可能不同。
   共享 store 是从根上消除「两份数据」。
2. **它没法被断言**。模块级变量在 vm 沙箱里是隐式全局，测试只能间接观察；
   共享 store 的 `listenerCount()` 与 timer 计数都是可直接断言的结构。

---

## 4. 工具行显示格式（最终样子）

### 4.1 一行示例文本

```
● Clef 0.8% · 21:06
```

（`●` 是 6px 圆点，颜色跟随该模型的状态：idle 绿 `#22c55e` / busy 黄 `#eab308` / full 红 `#ef4444`；
元素之间靠 `gap: 5px` 留白，所以从 DOM 拍平出来的字符串是 `"Clef0.8%· 21:06"` —— 空格来自 CSS gap，不是文本。）

**陈旧时**：

```
● Clef 0.8% · 陈旧 · 21:06
```

**无数据时**：

```
● AMD 负载 · 无数据
```

（灰点 `#9ca3af` + 整行 `opacity: 0.55`。）

### 4.2 结构与样式

| 元素 | 样式 |
|---|---|
| 根 `div` | `display:flex; align-items:center; gap:5px; padding:0 6px; font-size:11px; white-space:nowrap; font-variant-numeric:tabular-nums` |
| 状态点 `span` | `width/height:6px; border-radius:50%; background:<state color>` |
| 模型 id `span` | `max-width:180px; overflow:hidden; text-overflow:ellipsis` |
| 百分比 `span` | `opacity:0.75` |
| 陈旧 `span` | `color:#b45309`，文案 `· 陈旧` |
| 时间 `span` | `opacity:0.45`，文案 `· HH:MM` |

`font-variant-numeric: tabular-nums` 是刻意的：百分比刷新时数字宽度不变，工具行不会左右抖动。
`max-width: 180px + ellipsis` 兜住超长 id（`MiniCPM-V-4.7-35B-A3B` 是 21 字符，实测放得下）。

### 4.3 title（hover 提示）

```
AMD 最空闲：Clef 0.8%（空闲），更新于 21:06
AMD 最空闲：Clef 0.8%（空闲），更新于 21:06（数据陈旧）      ← 陈旧时
AMD 免费模型：暂无负载数据                                    ← 无数据时
```

### 4.4 关于「工具行不显示 FREE 徽章」—— 我同意你的判断

我**采纳**你的取舍，不推翻。三条理由：

1. **空间**：徽章占 `3px 7px` 内边距 + `10px` 字 + `0.04em` 字距，约 34px。工具行当前整行约
   180–210px（含 id 截断上限），加徽章后 id 可显示宽度会被压到 ~140px，
   `MiniCPM-V-4.7-35B-A3B` 这类长名会被截断成 `MiniCPM-V-4.7-35B-…`，反而更难认。
2. **场景**：工具行回答的是「现在哪个最空，能不能马上用」；「这模型免不免费」是选型决策，
   在设置页看完整 15 行时才有意义（那里还有分组、状态文字、全部 utilization）。
3. **信息冗余**：15 个模型里 12 个都带 FREE，工具行显示的那一个**大概率**是免费的
   —— 徽章在多数情况下不提供区分度，只在少数情况（抽到 Clef）才排除一个候选，
   而 Clef 的场景（`/v1/systemone` 概率问答）本来就不是普通对话模型。

已在测试里断言「工具行不渲染徽章」（`freeBadges(nodes).length === 0` 且全文不含 `FREE`），
所以将来若想改，会有一条明确的失败用例提醒。

### 4.5 最空闲模型的选择逻辑

```js
function pickIdlest(groups) {
  let best = null;
  for (const group of groups) {
    for (const model of group.models) {
      if (model.hasLoad !== true) continue;                              // 无负载不参与
      const u = model.utilization;
      if (typeof u !== "number" || !Number.isFinite(u)) continue;        // 脏值不参与
      if (best === null || u < best.utilization) { best = {...}; continue; }
      if (u === best.utilization && id < best.id) { best = {...}; }      // 平局按 id
    }
  }
  return best;
}
```

**必须跨组全局比较**，不能取「第一个组的第一行」：host 的 `groupAndSort` 只保证**组内**升序，
组与组之间是按官方分类顺序（VLM → LLM → Decision → …）排的，不是按繁忙度。
真实样本就是反例：Decision 组的 `Clef` 只有 0.8%，而 VLM 组首行是 3.7%。
测试用真实 fixtures 断言「显示 Clef，不显示 MiniCPM-V-4.7-35B-A3B」。

**平局按 id 字典序**：同一份数据永远得到同一个结果，工具行不会因为并列而在两次轮询之间跳变。

---

## 5. 自检结果

### 5.1 语法

```
check ok  lib/client.js
check ok  test/client.test.mjs
```

### 5.2 全量回归（164 用例全绿）

| 套件 | 命令 | 结果 |
|---|---|---|
| load-source | `node test/load-source.test.mjs` | **32 passed, 0 failed** |
| catalog | `node test/catalog.test.mjs` | **50 passed, 0 failed** |
| client | `node test/client.test.mjs` | **58 passed, 0 failed**（原 29 → 58） |
| host | `bash test/with-stub.sh` | **24 passed, 0 failed** |

**29 个原用例逐条比对过，一个未删**（用脚本按 `await test('...')` 的名字集合做差集，
结果 `MISSING: (none)`）。唯一调整的是「connection 缺席时 inject().rpc 为 undefined 而不抛」
—— M2 起 `inject` 交出去的是 `store` 而不是裸 `rpc`，所以该用例保留原名、断言对象随重构调整
（`rpc` 现在确实为 `undefined`，且 `store` 必须存在）。

### 5.3 新增 29 个用例的分布

| 分组 | 数量 | 覆盖 |
|---|---|---|
| 信封与注册 | +3 | 工具行 slot 名 / order 70 / id 不与设置卡撞车；两个 slot 拿到同一 store |
| 拉取契约 | +1 | 并发 3 次只发 1 个请求 |
| **共享订阅器** | +8 | 只 1 个 timer；同一快照对象；订阅即刻回调；末个退订停表 + 重订阅重启；退订其一不停表；listener 抛错不影响其他；两种失败保留旧数据 |
| 工具行：选择 | +5 | 跨组全局最小；平局按 id；部分有数据；全无数据；脏 utilization 跳过 |
| 工具行：渲染 | +8 | 状态点/百分比/时间；点色跟随状态；无徽章；陈旧标记；title 三态；单行 flex+nowrap；无 onClick |
| 容错 | +2 | 工具行在 rpc 失败/抛异常时降级为「无数据」 |
| 注册（原 1 拆 2） | +1 | connection 缺席时 store 不崩 |

### 5.4 工具行真实渲染输出（用 fixtures 跑真实 host 分组逻辑）

```
【有数据】 "Clef0.8%· 21:06"
  title  : "AMD 最空闲：Clef 0.8%（空闲），更新于 21:06"
【陈旧】   "Clef0.8%· 陈旧· 21:06"
  title  : "AMD 最空闲：Clef 0.8%（空闲），更新于 21:06（数据陈旧）"
【无数据】 "AMD 负载 · 无数据"
  title  : "AMD 免费模型：暂无负载数据"
```

（文本里没有空格是因为元素间靠 CSS `gap: 5px` 留白，不是文本空格 —— 视觉上是 `● Clef 0.8% · 21:06`。）

---

## 6. 对真机验证的预期

**未验证项：GUI 目视。** 与前两轮相同，`ctx.slots.inject` 对未声明 slot 静默等待，
日志干净不能证明 client 加载成功。

真机上应该看到：

1. **设置页**（Settings →「AMD 模型负载」）与 M3 完全一致：5 组标题原文、12 个 FREE 徽章、
   无数据行变淡。**M2 不应改变任何设置页的可见行为** —— 它只是换了数据来源（store 而非组件内 effect）。
2. **会话输入框右侧**多出一行小字，形如 `● Clef 0.8% · 21:06`，排在 dsh-pause 的控件之后（order 70 > 30）。
3. 鼠标悬停出现 title：`AMD 最空闲：Clef 0.8%（空闲），更新于 21:06`。
4. **两张卡的「更新于」时间必须完全相同** —— 这是共享订阅器最直观的验收点。
   可以等几分钟再对比，若出现不一致就是订阅器没生效。
5. 点击工具行**没有任何反应**（刻意的，纯展示）。

**首屏时序**：目录 0.37s 到、负载 ~26s 到。所以刚打开时工具行可能先显示
`● AMD 负载 · 无数据`，约 26s 后变成具体模型。这是预期行为，不是 bug。

**日志预期**：client 半身不打日志（`console.log` 在 host 侧）。
host 侧应仍是 `catalog ok: 15 models, source=shared` 与 `load ok: N models, scope=fleet`。

**若工具行不出现但设置卡正常**：说明 `conversation.input.right` 这个 slot 名不对
（或该 slot 在当前宿主里未声明）。设置卡正常能排除「整个 client 半身没加载」，
所以问题会收敛到 slot 名 —— 届时用 `dsh-pause` 的实际注册代码再核对一次。

---

## 7. 硬约束遵守情况

- ✅ 未改 `$DSH_HOME`、未跑 `pnpm install`、未重启
- ✅ **host 侧零改动**：`lib/index.js` / `lib/catalog.js` / `lib/load-source.js` mtime 未变
- ✅ 纯 JS 无构建，client 保持手写 `__ModuleLoader__` 信封
- ✅ 设置卡继续正常工作（29 个原用例全绿）
- ✅ 原 29 个 client 用例一个未删
- ✅ 工作区无 `node_modules` 残留

## 8. 已知限制 / 后续可做

1. **工具行不做点击交互**（按任务要求）。若将来要做，建议打开设置页而不是做下拉 ——
   下拉会引入焦点管理、外部点击关闭、与 composer 键盘事件竞争等一串复杂度。
2. **只显示一个模型**。若想「显示最空闲的前 2–3 个」，工具行宽度大概还够（每个约 60–90px），
   但信息密度会明显上升。当前选择是「一个」。
3. **没有「全部满载」的特殊文案**。当前逻辑下，即使所有模型都 100% 满载，也会正常显示
   `● xxx 100.0%`（红点），不会切换成警告样式。M2 未要求；若需要可以加一条
   `utilization >= 100 → 换文案` 的分支。
4. **`pickIdlest` 只认 `hasLoad === true`**。若上游某天只给 `utilization` 而不给 `hasLoad`，
   该模型会被跳过。这是刻意的（`hasLoad` 是 host 明确算出的字段），但值得记住。
