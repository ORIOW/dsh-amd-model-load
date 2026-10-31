# M4 修复报告：模型选择行徽章不显示

> 2026-10-25 · 根因：single slot 的 priority 撞车

## 现象
M4 首轮真机：设置页正常、工具行卡已消失、收起按钮与菜单顶部正常，**但展开菜单里每个 AMD 模型行没有任何徽章，也没有比原版多出任何 UI**。

## 根因（已从宿主源码逐行证实）

`conversation.input.model.label` 是 `kind: "single"` 的 slot。**宿主内置插件已经占用了它**：

```
/node_modules/@deepseek-ai/dsh-client-ui-deepseek-model-label-1017/lib/client.js
  ctx.slots.inject("conversation.input.model.label", () => ctx.slots.register({
    name: "conversation.input.model.label",
    locale: namespace,          // ← 注意：没传 priority
  }, DeepSeekModelLabel))
```

而 slots 核心对 single 的处理（`@deepseek-ai/dsh-client-ui-slots/lib/index.js`）：

```js
register(options, component) {
  const priority = options.priority ?? 0;
  switch (spec.kind) {
    case "single": {
      const occupant = rec.entries.find((e) => (e.options.priority ?? 0) === priority);
      if (occupant) throw new Error(
        `single slot "${options.name}" already has a registration at priority ${priority}
         — register at a different priority to shadow it (lowest renders)`);
      break;
    }
    ...
```

**我们的注册没传 priority ⇒ 默认 0 ⇒ 与内置的 0 撞车 ⇒ 抛错 ⇒ 条目根本没进 ledger。**

而这个错误发生在 `slots.inject` 的回调里，**不写 harness.log、不弹 UI**，所以表现为：
- 模型名正常显示（是内置 1017 插件渲染的，它在非 deepseek provider 上直接 `return model.name`）
- 我们的徽章永远不出现
- 日志干净，无任何报错

## 修法

注册时带 `priority: -1`：

```js
ctx.slots.register({
  name: "conversation.input.model.label",
  id: MODEL_ROW_ID,
  priority: MODEL_ROW_PRIORITY,   // = -1
  inject: () => ({ store }),
}, ModelRowBadge)
```

核心注释明确写了 **`lowest renders`**（priority 最小者渲染），所以 `-1` 排在内置的 `0` 之前，成为 `entriesOfSlot()[0]` 即真正的渲染者。

## 回归守卫

新增测试「**模型行注册必须带负数 priority**」，断言：
1. `spec` 必须显式带 `priority`（`hasOwnProperty`）
2. 类型是 number
3. 值 < 0

**已验证这条测试能抓到 bug**：临时删掉 `priority` 行 → 实测 `FAIL 61 passed, 1 failed`；恢复后 `PASS 62 passed`。

## 为什么之前所有测试都没抓到
`mount()` 用的是假 ctx，`slots.register` 只是把 spec 收集进数组，**不执行 slots 核心的 priority 冲突检查**。所以「同 priority 撞车抛错」这个行为在单测里根本不存在。这也说明：**假 ctx 的测试只能验我们自己的逻辑，验不了宿主契约**——涉及 slot 注册的字段（priority/scope/key）必须有独立的断言直接检查 spec。

## 交付状态
- `lib/client.js` 704 行，`priority: -1` 已加，注释写明原因
- 回归 **168 用例全绿**（load-source 32 / catalog 50 / client 62 / host 24）
- 无残留探针

---

## 追加修复：保留内置 1017 徽章

### 问题
我们用 `priority: -1` 抢占 `conversation.input.model.label` 后，**内置 1017 插件被遮蔽**，它原本渲染的徽章会永久消失。用户明确要求保留。

### 内置插件的原实现（逐字照抄自 app.asar）
```js
// @deepseek-ai/dsh-client-ui-deepseek-model-label-1017/lib/client.js
const MODEL_NAME = "DeepSeek-V4.1-Flash";
function DeepSeekModelLabel({ provider, model, t }) {
  if (!(provider.id === "deepseek-account" || provider.id === "deepseek-official")
      || model.id !== "deepseek-flash"
      || model.name !== MODEL_NAME) return model.name;
  return (
    <span className={label}>
      <span>{model.name}</span>{" "}
      <Tag tone="info">{t("badge.label")}</Tag>   // 中英文字典值都是 "1017"
    </span>
  );
}
```

### 修法
新增 `deepSeek1017Name(provider, model, modelName)`，在 `ModelRowBadge` 的**所有分支**统一用它替代裸 `modelName`：
- 命中三个条件（provider 是 deepseek-account/official **且** model.id === "deepseek-flash" **且** model.name === "DeepSeek-V4.1-Flash"）→ 返回「名字 + 1017 胶囊」
- 否则 → 返回模型名（与内置插件 `return model.name` 一致）

样式照抄 primitives 的 `Tag tone="info"`（`@deepseek-ai/dsh-client-ui-primitives/lib/Tag.module.css`）：
```css
.tag { display:inline-flex; align-items:center; border-radius:999px; corner-shape:round;
       padding:1px 8px; font-size:11px; line-height:17px; font-weight:500; white-space:nowrap; }
.tag[data-tone='info'] {
       background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
       color: var(--dsw-alias-state-business-primary); }
```
用 CSS 变量原样复刻（不硬编码颜色），主题切换跟随 DSH 配色。

### 新增测试（4 条）
1. 命中三个条件 → 出现 1017，且胶囊样式为 `borderRadius:999px` / `11px` / `500`
2. 三个条件缺一个（name 不符 / id 不符 / provider 非官方 ×2）→ 不出现
3. `trigger` / `menu` 位置**也保留** 1017（内置插件在所有位置都渲染它，不只是 option）
4. AMD 的 `DeepSeek-V4.1-Flash`（id 不是 deepseek-flash）不会被误加

**已验证可抓 bug**：把 `with1017` 改回裸 `modelName` → 实测 2 条 FAIL；恢复后全绿。

### 交付状态
- 回归 **172 用例全绿**（load-source 32 / catalog 50 / client 66 / host 24）
