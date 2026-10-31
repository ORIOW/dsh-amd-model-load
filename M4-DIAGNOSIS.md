# M4 真机问题诊断（2026-10-25 22:50）

## 现象
用户重启后：设置页正常、工具行卡已消失、收起按钮正常、菜单顶部正常。
**但展开菜单里每个 AMD 模型行没有任何徽章，也没有比原版多出任何 UI。**

## 已排除
- host 侧完全正常：`catalog ok: 15 models, source=cards`、`load ok: 13 models`
- 组件代码常量正确：`AMD_PROVIDER_ID="amd"` / `PLACEMENT_OPTION="option"` / `MODEL_ROW_ID="dsh-amd-model-load.modelrow"`
- 注册代码正确：`ctx.slots.inject("conversation.input.model.label", () => ctx.slots.register({name, id, inject}, ModelRowBadge))`
- 宿主契约已读实：
  - 父级 `children: { "conversation.input.model.label": { kind:"single", scope:"session", inline:true } }`
  - 调用点 `renderModelLabel(group.provider, model, "option", selected)` → `renderSlot(slotKey, {provider, model, placement, selected}, {fallback: model.name})`
  - `group.provider = { id: group.id, name: ... }`
- 模型名正常显示 → 说明**要么我们的组件没被调用（走 fallback），要么被调用但 `isOption && isAmd` 为假**

## 未排除的关键假设
1. **`scope: "session"` 的 slot，第三方 `slots.register` 是否需要 session 绑定？** 设置卡用的是 `scope: "root"`，能工作；本 slot 是 session scope，可能需要不同的注册方式或额外选项。
2. **`group.id` 的真实值不是 `"amd"`**（可能是 `amd-something` 或 provider 的 displayName 派生值）。
3. **`kind: "single"` 要求注册项带某个必填字段**（如 `order` 或 `key`），缺了就被静默忽略。

## 建议的诊断顺序（最省时间）
1. **先验假设 2**：在组件里临时把收到的 `provider.id` 渲染成可见文本（而不是 console.log，因为读不到浏览器 console）。比如 `placement==="option"` 时在模型名后追加 `[pid:xxx]`。一次重启就能看到真实值。
2. 若 pid 正确，验假设 1/3：对比 `dsh-pause` 在 `conversation.input.right`（也是 root/session 混合）的注册写法，看有没有额外字段。
3. 若都不对，改用 `kind:"chain"` 或检查 `slots.inject` 的第二个参数语义。

## 临时探针（已移除，可复用）
曾注入 `globalThis.__amdRowProbe` + `console.log`，但浏览器 console 无法读取，故放弃。**改用可见 UI 探针**更有效。
