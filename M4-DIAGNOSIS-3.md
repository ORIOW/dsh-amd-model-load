# M4 诊断（第三轮）：注册成功但零渲染 —— 观测手段换成日志自证

日期：2026-11-01（北京时间，宿主机时区 UTC+8）
宿主：DSH Desktop 0.12.1（app.asar mtime 2026-10-20 12:59:04，两轮真机同一份）

## 1. 本轮拿到的硬证据

用户重启后，`/Users/dengjiawei/Library/Logs/DSH Desktop/harness.log` 中（本轮启动 2026-10-31T16:04:19Z）：

```
+3612ms [amd-model-load] client-diag {"stage":"apply","connection":"在位"}
+3909ms client-diag {"stage":"register","slot":"settings.section","ok":true,"error":null}
+3910ms client-diag {"stage":"register","slot":"conversation.input.model.label","ok":true,"error":null}
+3913ms client-diag {"stage":"probe","priority":-1,"threw":true,
        "message":"single slot \"conversation.input.model.label\" already has a registration at priority -1 (registered by dsh-amd-model-load) — register at a different priority to shadow it (lowest renders)"}
+3914ms client-diag {"stage":"probe","priority":0,"threw":false,"message":null}
+30s 起 每 30 秒 heartbeat：rowRenders=0, rowOptionAmdRenders=0, rowLastSeen=null（连续 12 次以上，跨越用户点开模型菜单的时段）
```

两条结论：

1. **我们的条目确实在 ledger 的 priority -1 位**（错误原文里 `registered by dsh-amd-model-load` 是宿主自己吐的）。
2. **priority 0 是空的** ⇒ 内置 `dsh-client-ui-deepseek-model-label-1017` 在本次运行里根本没注册成功。此前「1017 占着 0 位、我们用 -1 顶掉它」的推断，对本次运行**不成立**；「1017 徽章消失」因此不能再当作「我们赢了」的证据。

## 2. 从 asar 读到的渲染条件（重要）

`@deepseek-ai/dsh-client-ui-model-selection/lib/client.js` 中，label slot 只有三处出口，且**都有前置条件**：

| placement | 代码 | 触发前提 |
| --- | --- | --- |
| `trigger` | `currentChoice === void 0 ? modelLabel : renderModelLabel(currentChoice.group.provider, currentChoice.model, "trigger", true)` | 必须已有 currentChoice |
| `menu` | 同上的 `"menu"` 分支 | 必须已有 currentChoice |
| `option` | `renderModelLabel(group.provider, model, "option", selected)` | 必须**下钻到「模型」二级列表**并渲染该行 |

⇒ 收起按钮上的那枚按钮**在 currentChoice 为 undefined 时根本不走 slot**，只显示静态 `modelLabel`；列表行也必须下钻到模型列表才会渲染。这解释了「行组件 0 次渲染」在用户只看了一级菜单时完全可能成立，也解释了 1017 徽章为什么同样不出现（同一个 outlet）。

## 3. 本轮改动：把判定依据搬到 harness.log

| 位置 | 改动 |
| --- | --- |
| `lib/client.js` `DIAG` | 新增 `slots` / `ledger` / `cardReportTs` |
| `describeSlot(slots, name)` | 读 `slots.entries(name)` 与 `slots.entriesOfSlot(name)`，返回 `{declared, entries, winners, winnerIds, winnerPriorities}`；所有异常吞成字段，绝不影响主流程 |
| `ledgerDigest(slots)` | 一次读 `conversation.input.model`（席位）与 `conversation.input.model.label`（本格） |
| `apply()` | 注册后上报 `stage:"ledger"`；心跳每 30 秒附 `ledger` |
| `Card` | 打开设置卡时（5 秒节流）重读并上报 `stage:"card"`，诊断行追加 `，席位=N(winner) ，本格=N(winner)` |
| `probeLedger(slots, rpc)` | 改为接收 slots，`slots.register` 缺席时也上报 |
| `test/client.test.mjs` | 桩的 `entries` / `entriesOfSlot` 按宿主形状返回 `{options: spec}`；+2 用例（ledger 上报、卡片节流上报）；数组断言改 `join` 比较（插件代码在 vm 上下文里，跨 realm 的 deepEqual 会误报） |

回归：client 76 / catalog 50 / load-source 32 / host 24（`bash test/with-stub.sh`）= **182 全绿**，临时 schemastery 桩已删除。

## 4. 下一次重启后怎么读（判定表）

看 `harness.log` 里 `stage:"heartbeat"` 或 `stage:"card"` 的 `ledger` 字段：

| 读数 | 含义 | 下一步 |
| --- | --- | --- |
| `seat.entries === 0` | 输入框那个「模型」席位没有任何注册者 ⇒ 内置 model-selection 没加载，label 永不被渲染 | 查 ui-model-selection 为何未注册（bundles/patch） |
| `label.entries === 0` | 我们的条目已被 dispose | 查 dispose 时机（声明塌陷 / HMR） |
| `label.winnerIds[0] !== "dsh-amd-model-load.modelrow"` | 被更高优先级条目顶掉 | 读 winner 的 id/priority |
| `seat.entries ≥ 1` 且 `label.entries === 1` 且 winner 是我们，但 `rowRenders === 0` | outlet 没有被渲染 | 用户需下钻到「模型」二级列表；若下钻后仍为 0，则是父组件未走 renderSlot |
| `rowRenders > 0` 且 `branch === "bare-name"` | 组件被调用但判定未命中 | 看 `rowLastSeen` 的 placement/providerId |

## 5. 仍未闭环

- 真机从未观测到 `rowRenders > 0`，因此「组件被调用后渲染什么」在真机上仍未被验证过。
- 1017 插件为何在本次运行中未注册（`priority 0` 空闲）尚无解释；它在 `dsh-web-app/cordis.patch.yml` 中是启用状态。
- 诊断代码是临时的：定位完成后要摘掉心跳与探针（计划保留 `safeRegister` 与设置卡诊断行）。
