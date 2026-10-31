# M4 上游结论：不是我们要修，是 dsh-reasoning-effort 0.8.1 的老架构

日期：2026-11-01
状态：**已闭环，无需向作者提 issue**

## 1. 现象（两轮真机 + A/B）

- 「推理强度」开关 **开** 时：模型菜单里 AMD 行没有「● 20.1%」，DeepSeek-V4.1-Flash 行的 `1017` 徽章也一起消失；`harness.log` 里 `client-diag` 全程 `rowRenders: 0`。
- 「推理强度」开关 **关** 的瞬间（无需重启）：AMD 徽章与 `1017` 徽章同时恢复。
- 日志硬证据：我们注册在 `commit conversation.input.model.label` 的 `priority: -1` 位，`probeLedger` 探针返回 `registered by dsh-amd-model-load`；同时 `conversation.input.model`（父席位）的 winner 是 `priority: -100`、无 `id` 的条目。

## 2. 根因

`dsh-reasoning-effort@0.8.1` 用**自己的组件整个替换** composer 的模型席位：

```js
ctx.slots.inject("conversation.input.model", () => {
  disposeModelSeat = ctx.slots.register({ name: SLOT, priority: -100, locale: NS, inject }, AdvancedModelSelect)
})
```

`AdvancedModelSelect` 自己画模型名，**从不调用 `renderSlot("conversation.input.model.label", ...)`**（该包里 `renderSlot` 出现 0 次）。

于是子 slot `conversation.input.model.label` 没有任何渲染入口：

| 谁 | 注册位置 | 结果 |
| --- | --- | --- |
| `dsh-amd-model-load`（我们） | label @ `priority: -1` | 注册成功、是 winner，但从不被渲染 |
| `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`（内置） | label @ 默认 0 | 同样不被渲染 |

这与我们插件的代码无关——`priority`、`abdicate`、session scope 的历次怀疑都是这条遮蔽的下游噪音。

## 3. 作者已在 0.9.0 修好

上游 `main` 现为 **0.9.1**，`src/client/index.tsx:1362-1402` 改成了「就地包裹原生组件」：

```ts
const entry = ctx.slots.entries?.(SLOT).find(entry => entry.locale === 'model'
  && entry.children?.['conversation.input.model.label'] !== undefined
  && typeof entry.component === 'function')
if (entry) {
  const original = entry.component
  const wrapped = wrapNativeSelector(original, props => <BoundNativeEffortPanel {...props} />)
  entry.component = wrapped
  restore = () => { if (entry.component === wrapped) { entry.component = original; notify() } }
  notify()
} else if (!fallback) {
  fallback = ctx.slots.register({ name: SLOT, priority: -100, locale: NS, inject }, AdvancedModelSelect)
}
```

`src/client/native-selector.tsx` 头注释写明：「the native registration retains its inject, locale, **child slots**, model search, selection, labels and portal positioning」。`AdvancedModelSelect` + `-100` 已降级为「找不到原生条目时的兜底」。

v0.9.0 Release 说明同样写着：模型列表、搜索、分组、**徽标**沿用原生界面，停用插件即恢复原生组件。

## 4. 结论与动作

- **不提 issue**：这是 0.8.1 的架构限制，0.9.0 起已不存在。
- 用户 profile 当前装的是 `dsh-reasoning-effort@0.8.1`（`profiles/web/package.json:22`；实体在 `profiles/.generations/live/dsh-reasoning-effort+0.8.1+52cc482f92d5/`）。
- 升级目标：npm 上的 **`@ayanehana/dsh-reasoning-effort@0.9.1`**（带 scope；无 scope 的同名包属其他维护者）。
- 升级顺序（避免重复加载）：先卸载旧的 `dsh-reasoning-effort`，再安装带 scope 的新包，重启客户端。
- 升级后需真机确认：AMD 行「● x%」、DeepSeek flash 行 `1017`、`client-diag` 里 `rowRenders` 开始增长。
- 确认通过后，把本次为定位加的诊断设施（`reportDiag`、`probeLedger`、`describeSlot`、`ledgerDigest`、30 秒 heartbeat、设置卡诊断行）摘掉，只保留失败日志与非静默错误处理。

## 5. 附带确认的宿主契约（可复用）

- `ModelSelect` 的 props 里 `renderSlot` 由宿主按 entry 发放：`if (entry.children !== void 0) kit["renderSlot"] = boundRenderSlot(host, entry)`。
- `boundRenderSlot` 会校验 `entry.children?.[key]`：未声明抛 `SlotOwnershipError`，条目已销毁抛 `StaleAuthorizationError('renderSlot(...) from a disposed registration')`。
- 因此第三方插件若要接管 `conversation.input.model`，**必须**声明并渲染 `children: { "conversation.input.model.label": ... }`，否则该 slot 的所有徽章（含内置 1017）集体失效。
