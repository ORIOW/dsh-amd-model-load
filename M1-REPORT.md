# M1-A 报告 · host 轮询 + loopback RPC + 设置卡真数据

> 2026-10-25 · 任务 task-3 · 状态：**实现完成，自检全绿，GUI 目视为待验项**

## 1. 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `lib/load-source.js` | **新增** 258 行 | 纯函数数据源：`normalizeLoad` / `isStale` / `createPoller`。零 import（连 schemastery 都不 import），可裸跑单测 |
| `lib/index.js` | 改造 288 行 | host 半身：Config 四字段、poller 进 effect、RPC 通道（`load` / `refresh`） |
| `lib/client.js` | 改造 265 行 | 设置卡升级为真数据：6 行状态点 + utilization + 「更新于 HH:MM」+ 陈旧标记 |
| `test/load-source.test.mjs` | **新增** | 32 个用例（normalizeLoad 11 / isStale 7 / createPoller 14） |
| `test/host.test.mjs` | **新增** | 17 个用例（装配 4 / handler 契约 3 / serve HTTP 层 10） |
| `test/client.test.mjs` | **新增** | 15 个用例（信封注册 5 / 渲染 8 / 拉取纪律 2） |
| `test/e2e-live.mjs` | **新增** | 真打 AMD 端点的端到端，产出 `test/e2e-sample.json` |
| `test/with-stub.sh` | **新增** | 临时 schemastery 桩跑 host 测试，`trap` 保证退出即删 |

**未改动**：`package.json`、`cordis.patch.yml`。M0 已验证的装配链不需要任何调整 —— M1 全部在 `lib/` 内完成，这正是 M0 骨架设计的意图。

## 2. 关键设计决定

### 2.1 「失败保留旧数据」是结构性的，不是分支性的

`createPoller` 的内部状态只在**成功路径**上整体替换：

```js
state = { ts: now(), models: normalized.models, scope: normalized.scope, error: null }  // 成功
state = { ...state, error: describe(error) }                                            // 失败
```

失败分支只覆盖 `error`，`models` / `ts` / `scope` 原样保留。副作用是 `ts` 不前进 ⇒ 快照自然变 stale，不需要额外的 `failed` 标志。这比「先清空再回填」少一整类 bug。

### 2.2 `isStale` 用 `>` 而非 `>=`，且不吃时钟回拨

- `age === maxAgeMs` → **false**（恰好到点不算过期）
- `age < 0`（系统时钟回拨 / NTP 校正）→ **false**，不把未来时间当过期
- `maxAgeMs` 非有限 → **false**，配置写错不会把所有数据一次标陈旧

### 2.3 state 直取上游，绝不用 utilization 反推

Lead 的 16:23 vs 17:18 采样对比是决定性证据：`Qwen3.8-27B` 在 38.5% 时是 idle，`GLM-5.3-Flash` 在 50.0% 时是 busy。任何阈值都会判错。代码里只有 `normalizeState()` 做大小写/空白容忍，未知值一律归 `unknown`（渲染成灰点 + 「无数据」），不猜。

本次 e2e 又添一例佐证：`Clef` 在 **0.8%** 时仍是 idle，`DeepSeek-V4-Pro` 3.1% 是 idle —— 低 utilization 不保证 idle，反之 `DeepSeek-V4-Flash` 82.6% 是 busy 而非 full（full 是精确 100.0）。**utilization 与 state 是两个独立信号。**

### 2.4 `normalizeLoad` 不做任何过滤

fleet 集合会变（16:23 有 12 个含 `d3-flash`；17:18 有 11 个，`d3-flash` 消失、`Clef` 出现；本次 e2e 又有 12 个）。过滤只发生在渲染层，这样 M3 换动态模型清单时**不用改 host**。

### 2.5 RPC 契约完全照抄 `dsh-pause`

`mountRpcChannel` / `serve` / `reply` / `missing` / `tooLarge` / `isJsonContentType` / `readBody` 逐段对齐，包括：
- `kind: 'prefix'`（不是 `exact` —— `exact` 是 `dsh-zcode-connect` 自建 GET 路由的用法，不适合带 method 段的 RPC 通道）
- `ctx.inject(['connection','webServer'], cb)` 延迟注册
- `connection.requestRejection(req)` 返回 `undefined` 才放行
- `method !== endpoint` → `gateway/bad-request`
- 先回 413 再 `req.destroy()`（顺序反了 socket 已断，413 发不出去）

**唯一偏离**：`maxBodyBytes` 用 64 KiB 而非 pause 的 300 MiB。本通道请求体只有 `{}`，没有 base64 图片。

### 2.6 client 绝不拉上游

挂载时拉一次 + 每 60s 拉一次本地 RPC（打内存快照）。e2e 实测：上游往返 **28.7s**，`load` 读缓存 **0ms** —— 差 4 个数量级，这个设计不是优化而是必需。

### 2.7 每次 RPC 调用重算 `stale`，不缓存

`stale` 随时间推移而变（同一份数据 5 分钟后就从新鲜变陈旧），必须按请求时刻算。

## 3. 自检结果

### 3.1 `node --check`（7 个文件全过）

```
lib/index.js                     ok
lib/client.js                    ok
lib/load-source.js               ok
test/client.test.mjs             ok
test/e2e-live.mjs                ok
test/host.test.mjs               ok
test/load-source.test.mjs        ok
```

### 3.2 `lib/load-source.js` 单测：**32 passed, 0 failed**

`normalizeLoad`（11 例）：
- 正常样本全字段保留
- **不过滤 fleet 里本机没有的模型**（`Clef` / `MiniCPM5-2B` / `DeepSeek-V4-Flash-Vision-Exp` 全留下）
- **state 直取**：38.5% 的 idle 不被改写；50% 的 busy 不被改写
- 畸形顶层：`null` / `undefined` / `42` / `'x'` / `true` / `[]` / `[{models:{}}]` 全部返回 `null` 而非抛
- 畸形 models：`{}` / `{models:null}` / `{models:[]}` / `{models:'x'}` / `{models:7}` 全部 `null`
- `{models:{}}` 合法（返回空 models，由展示层显示「无负载数据」）
- **单条脏数据跳过**：`null` / `'oops'` / `[1,2]` / `5` 被剔除，`good` 保留
- 未知 state（`draining` / `42` / 缺失）→ `unknown`；大小写与空白容忍（`'IDLE'` / `'  Busy '`）
- utilization 越界夹取：`140`→100、`-3`→0；字符串 `'42.5'`→42.5；`'abc'`/缺失/`Infinity`→`null`
- label 缺失或纯空白 → 回退 id
- scope 缺失/非字符串/空串 → `fleet`

`isStale`（7 例）：无快照/ts 非数字 → true；**age === maxAge → false**；age 超 1ms → true；age 0 → false；**时钟回拨 → false**；now 非有限 → true；maxAge 非有限 → false。

`createPoller`（14 例）：
- 成功：ts 前进、models 就位、error 为 null、onUpdate 被调
- **HTTP 503 → 保留旧数据**、ts 不前进、error 含 503
- **畸形响应（models 缺失）→ 保留旧数据**
- **网络抛错（TypeError）→ 保留旧数据**，error 保留类型前缀（`TypeError: fetch failed`，能区分网络断与坏数据）
- 普通 Error 只留 message，不重复加前缀
- 从没成功过：models 空、ts null、scope null、error 有值、必然 stale
- **超时：AbortSignal.timeout 触发后保留旧数据**，error 含 `TimeoutError`
- 传给 fetch 的 signal 是 `AbortSignal` 实例、method 为 GET
- **refresh 共用 in-flight**：并发两次只发 1 个请求
- **start 幂等**（连调 3 次仍只有一条 interval）+ **stop 真停表**（stop 后 80ms 内零新请求）
- stop 是终态：stop 后 start 不再起表
- **snapshot 返回深拷贝**：调用方改 models 不影响内部状态
- onError 回调自己抛错不打断轮询
- `pollMs <= 0` 时只拉一次、不起 interval

### 3.3 host 装配测试：**17 passed, 0 failed**

用假 ctx（`inject` 只记录不执行）驱动 `apply`：

- `inject` 导出仍是 `[]`（M0 已验证的形状没被破坏）
- **Config 四字段默认值全对**：`pollMs=300000` / `timeoutMs=40000` / `loadUrl=…tokenfactory/load` / `staleAfterMs=360000`
- **apply 走 `ctx.inject(['connection','webServer'], cb)` 延迟注册**：flush 前 `registrations.length === 0`（证明没有在组合期硬注册）
- flush 后 `register` 收到 `kind:'prefix'` + `path:'/dsh-amd-model-load'`
- **dispose 后 `spec.disposed === true`**（路由真被摘掉），同时 `poller.stop()` 被调用
- `load` 端点返回 `200` + `content-type: application/json` + `server-response` 信封 + `ok:true` + value 恰好 5 字段 `{ts, models, scope, stale, error}`
- `refresh` 端点同形状
- 未知 endpoint 走到 handler default → `ok:false` + `unknown endpoint`
- `method` 与 endpoint 不符 → `gateway/bad-request`（rpcId 原样回填）
- 非 POST → 404；路径不在通道下 → 404；`text/plain` → 415；`application/json; charset=utf-8` → 接受；body 非 JSON → 400
- 信封 `type` 错 → `gateway/bad-request`，rpcId 回填 `invalid-request`
- `requestRejection` 返回 401 → 回 401 + `unauthorized`；403 → `forbidden`

### 3.4 client 冒烟测试：**15 passed, 0 failed**

用 vm 沙箱伪造 `window.__ModuleLoader__` + 微型 React 渲染器（hooks / 函数组件展开 / 异步 effect / 重渲染）：

- 信封 `id` / `name` 正确；`inject` 为 `["slots","connection"]`
- `apply` 注册进 **`settings.section`**，`id` / `order:60` / `label()` 正确，`inject().rpc` 来自 `ctx.connection.rpc`
- connection 缺席时 `inject().rpc === undefined` 且渲染不崩
- **无数据时 6 个本机模型全渲染**，且 M0 占位文案「骨架已加载」**已消失**
- 有数据时：`更新于 17:20`、`82.6%`、`100.0%`、`空闲`/`繁忙`/`满载` 全部出现，且**不显示**陈旧
- stale → 显示「陈旧」+ 6 行全「无数据」
- **fleet 独有的 `Clef` 不渲染**
- rpc 返回 `ok:false` → 显示「负载读取失败」+ message，6 行仍在
- rpc 抛异常 → 不崩，显示错误
- 未知 state → 「无数据」+ `—`
- **状态点颜色**：idle `#22c55e` / busy `#eab308` / full `#ef4444` / 无数据 `#9ca3af`（3 个缺失 = 3 个灰点，总数 6）
- **挂载只拉 1 次**（不按模型数拉 6 次）
- 卸载后不再拉取（interval 清掉）

### 3.5 真实端点端到端：**PASS，28.8s**

```
[e2e] 上游往返 28.7s
[e2e] load 读缓存耗时 0ms
[e2e] 真实上游返回 12 个模型，scope=fleet
```

**实测 RPC handler 返回样例**（`test/e2e-sample.json`，此处截断为 6 个本机模型 + 3 个代表）：

```json
{
  "type": "server-response",
  "rpcId": "e2e-1",
  "result": {
    "ok": true,
    "value": {
      "ts": 1792920044694,
      "models": {
        "DeepSeek-V4-Flash":   { "state": "busy", "label": "Busy",        "utilization": 82.6 },
        "GLM-5.3-Flash":       { "state": "full", "label": "At capacity", "utilization": 100 },
        "DeepSeek-V4.1-Flash": { "state": "full", "label": "At capacity", "utilization": 100 },
        "MiMo-V2.6-Flash":     { "state": "full", "label": "At capacity", "utilization": 100 },
        "Qwen3.8-27B":         { "state": "idle", "label": "Idle",        "utilization": 17.4 },
        "Gemma-4-31B-IT":      { "state": "idle", "label": "Idle",        "utilization": 15.6 },
        "Clef":                { "state": "idle", "label": "Idle",        "utilization": 0.8 },
        "Qwen3.8-Flash-Next":  { "state": "busy", "label": "Busy",        "utilization": 60.5 },
        "DeepSeek-V4-Pro":     { "state": "idle", "label": "Idle",        "utilization": 3.1 }
      },
      "scope": "fleet",
      "stale": false,
      "error": null
    }
  }
}
```

本机 6 模型渲染视图（e2e 实测）：

| 模型 | state | utilization | 显示 |
|---|---|---|---|
| DeepSeek-V4-Flash | busy | 82.6% | 黄点 繁忙 |
| GLM-5.3-Flash | full | 100.0% | 红点 满载 |
| DeepSeek-V4.1-Flash | full | 100.0% | 红点 满载 |
| MiMo-V2.6-Flash | full | 100.0% | 红点 满载 |
| Qwen3.8-27B | idle | 17.4% | 绿点 空闲 |
| Gemma-4-31B-IT | idle | 15.6% | 绿点 空闲 |

不显示的本机外模型（6 个）：`Clef`、`MiniCPM5-2B`、`Qwen3.8-Flash-Next`、`DeepSeek-V4-Flash-Vision-Exp`、`MiniCPM-V-4.7-35B-A3B`、`DeepSeek-V4-Pro`。

### 3.6 临时桩已清理

`test/with-stub.sh` 用 `trap cleanup EXIT INT TERM`，无论成功失败都 `rm -rf node_modules`。验证后 `ls node_modules` → `No such file or directory`。

## 4. 任务描述与真实契约的差异

**一处实质差异（已按实测修正）**：任务描述写 `{models:{<id>:{state, label, utilization}}}`，暗示 `label` 是模型显示名。**实测 `label` 是状态文案** —— `"Idle"` / `"Busy"` / `"At capacity"`，不是模型名。已在 `load-source.js` 加显著注释，并让渲染层用模型 **id** 显示（`label` 只在 id 缺失时回退）。M3 若要做友好名，必须另建本地 id→名称映射，**不能指望这个字段**。

其余契约与参考实现一致，无冲突：
- RPC 信封字段、`{ok,value}` 解包形状、`requestRejection` 判定、`method === endpoint` 校验，全部与 `dsh-pause` 逐字对齐
- `webServer.register` 的 `kind:'prefix'` 用法与 `dsh-pause` 一致；`dsh-zcode-connect` 的 `kind:'exact'` 是自建 GET 路由，不适用

## 5. 待验项（需重启 App 后目视）

M1 的代码改动要生效**必须重启 DSH Desktop**（HMR 不会重新执行已加载的 host 半身；M0 已验证改 `package.json` 后 HMR 不再自动重试）。

重启后应能看到：
1. `harness.log` 出现 `[amd-model-load] host loaded`、`[amd-model-load] poller started (pollMs=300000, timeoutMs=40000)`
2. 约 26–30s 后出现 `[amd-model-load] load ok: 12 models, scope=fleet`
3. Settings → AMD 模型负载，显示 6 行真实读数 + 「更新于 HH:MM」

未验项如实标注：**GUI 真实渲染**（`settings.section` 卡片在真浏览器里的 DOM）本轮无法自证，只能靠 node 里的信封 + 微型渲染器间接覆盖。这与 M0 的教训一致：`slots.inject` 对未声明 slot 静默等待，日志干净不能证明 UI 出现。

## 6. 对 M2 的一句话建议

**M2 的工具行状态卡直接复用 `load` 端点，但只显示「最空闲的一个模型」而非 6 行**——工具行空间窄，6 行会挤爆 composer；且必须复用同一个 60s 本地轮询节拍，不要为第二张卡再开一个 RPC 循环（两份节拍会不同步，用户会看到两张卡上的时间戳不一致）。
