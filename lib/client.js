/**
 * dsh-amd-model-load — client half (M5).
 *
 * 手写 __ModuleLoader__ 信封，无构建步骤：写出来就能被 dsh-client-modules 直接加载。
 * 信封形状照抄 dsh-pause / dsh-zcode-connect 的 lib/client.js：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 *
 * 两个挂载点，共用一份数据：
 *   1. **插件行配置页**（slot `plugins.row.config`，key = `dsh-amd-model-load#amd-model-load`）——
 *      宿主「插件 → 已安装 → dsh-amd-model-load」行详情页的配置区。按 AMD 官方 5 分类分组，
 *      组内按繁忙度升序，每个模型带 FREE 徽章。M3 的成果；M5 起从设置页 slot 挪进插件行
 *      （keyed slot，spec 只带 key 与 inject），并按 `props.view` 分支渲染 summary / page。
 *   2. **模型选择列表行徽章**（slot `conversation.input.model.label`）—— 在模型选择菜单
 *      每一行的模型名右边追加一枚负载 chip（`● 20.1%`）。M4 新增，M5 重绘为胶囊 chip。
 *
 * ## ⚠️ M4 最重要的一条：`fallback` 只在「没有贡献者」时生效
 *
 * 父级（`dsh-client-ui-model-selection`）这样调用：
 *   `renderSlot("conversation.input.model.label", {provider, model, placement, selected},
 *               { fallback: model.name })`
 *
 * 而 `fallback` 的语义已从宿主源码读实（`@deepseek-ai/dsh-client-ui-renderer/lib/client.js`
 * 第 1175 行，single 分支）：
 *
 *   if (!entry) return entries.length > 0 ? deadCell()
 *                                    : jsx(Fragment, { children: opts?.fallback ?? null });
 *
 * 即 **`fallback` 只在 `entriesOfSlot()` 为空（该 slot 一个贡献者都没有）时生效**。
 * 一旦我们注册了这个 slot，`entry` 就存在，`fallback` 永不参与渲染 ——
 * 我们组件返回 `null` 会让那个 `<span data-model-id>` **变成空白**（模型名消失）。
 *
 * 结论（决定了下面的实现）：**组件必须在所有分支都自己渲染 `model.name`**，
 * 包括 `placement !== "option"`（收起按钮 trigger / 菜单顶部 menu）与非 amd provider。
 * 绝不返回 null。
 *
 * 补充：即使我们渲染出 `<Fragment>{null}</Fragment>`，`RootEntry → renderEntry` 也是
 * 直接 `jsx(Comp, props)`，没有「返回 null 就回退」的分支 —— 两条独立证据同向。
 *
 * ## 为什么必须有「共享订阅器」（M2 的核心设计）
 *
 * 两张卡都要「挂载拉一次 + 每 60s 拉一次」。最直觉的写法是各自 `setInterval`，
 * 但那样会**逐渐错开**：两个 timer 的相位差从 0 开始累积（JS 定时器不保证精确），
 * 跑上一段时间后，用户会看到配置页写「更新于 21:06」而列表徽章写「更新于 21:07」——
 * 同一份 host 快照被显示成两个时间，看起来像数据不一致。
 *
 * 所以这里把拉取与分发收进 `createSnapshotStore()`：**一个 timer + 一个 listener 集合**。
 * `apply(ctx)` 里建一个 store，两个组件通过 slot 的 `inject` 拿到**同一个** store 实例，
 * 各自 `subscribe` 一个 setState。于是：
 *   - 全插件任意时刻最多 1 个 interval（测试断言了这点）；
 *   - 两张卡拿到的 `snapshot` 是**同一个对象**，`loadTs` 必然相同；
 *   - 第一个订阅者到来时启动 timer，最后一个退订时停掉（页面都关了就不空转）。
 *
 * ## 显示纪律（PLAN.md 固化，M3 沿用）
 *
 *   1. **绝不在这里拉 AMD**。上游 load 要 ~26 秒、目录要 16 次请求，
 *      这里只调本地 RPC（打 host 的内存快照，毫秒级）。
 *   2. **数字旁必须带「更新于 HH:MM」**，否则用户会把 10 分钟前的读数当实时值。
 *   3. **排序不在这一层做**。分组/排序是纯逻辑，放 host 才能被单测覆盖；
 *      client 半身只能靠伪造 React 渲染验证，把规则放这儿等于把可测性让给目视。
 *      列表徽章按 `model.id` 在 catalog 里查负载，也是跨组线性查找
 *      （host 的 `groupAndSort` 只保证组内有序，没有按 id 建索引）。
 *   4. state 直取上游字段，**不用 utilization 阈值反推**——实测 Qwen3.8-27B 在 20.1% 是 idle，
 *      而 GLM-5.3-Flash 在 100% 是 full，中间还夹着 69.5% 的 busy，阈值必然判错。
 *   5. **FREE 徽章只认 badgeLabel**。d3 / d3-flash / Clef 三个 Decision 模型上游
 *      `display_config.badge_label` 缺失（实测 `token_factory.badge.label` 反倒是 "Free"，
 *      那是给整页 section 用的，不是给这三个模型的），所以它们**不显示** FREE 徽章。
 */
window.__ModuleLoader__.load({
  id: "dsh-amd-model-load",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    //#region constants
    /** 插件名；同时也是插件行配置 key 的 bundle 部分（见 PLUGIN_ROW_KEY）。 */
    const NS = "dsh-amd-model-load";

    /**
     * 模型选择行徽章的 slot id。与配置页的 key 不同（两个 slot 各自独立，id 只在本 slot 内标识贡献者）。
     */
    const MODEL_ROW_ID = "dsh-amd-model-load.modelrow";

    /**
     * 注册优先级。**这个值不是可有可无的调优项，缺了功能会整体失效。**
     *
     * `conversation.input.model.label` 是 `kind:"single"` 的 slot，而宿主内置插件
     * `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` **已经占了它**
     * （`dsh-web-app/cordis.patch.yml` 第 415 行无条件加载，未 disabled）。
     *
     * slots 核心的 `register()` 对 single 的处理是：
     *   const occupant = rec.entries.find((e) => (e.options.priority ?? 0) === priority);
     *   if (occupant) throw new Error(`single slot "..." already has a registration at priority ...`);
     *
     * 即 **同 priority 再注册会直接抛错**，我们连条目都进不去。取 1 就落在不同 cell：
     * `entriesOfSlot()` 按 priority 升序，**第一个非 abdicated 的生效**（`lowest renders`）——
     * 内置那个 priority 0 会赢，我们必须比它低（更小的数字）才能盖过它。
     *
     * 所以取 **-1**：排在内置的 0 之前，成为 `entriesOfSlot()[0]`，即真正的渲染者。
     * 这也解释了为什么内置插件能"正常显示模型名"——它的组件在非 deepseek provider 上
     * 直接 `return model.name`，正好是我们之前看到的现象（名字在、徽章没有）。
     */
    const MODEL_ROW_PRIORITY = -1;

    /**
     * 插件行配置 slot 与它的注册 key（M5 起，取代旧的设置页 slot）。
     *
     * 宿主契约（`dsh-client-ui-plugin-manager`，从 DSH Desktop 0.14.0 asar 原文核对）：
     *   function rowConfigKey(bundle, rowId) { return `${bundle}#${rowId}`; }
     *   configure(pkg).has(row) === ledger.rows.has(rowConfigKey(pkg.name, row.rowId))
     * 行列表只在 ledger 里找到这个 key 才渲染「配置」按钮；行详情页把该 slot 渲染两次
     * （view:"summary" 填描述位、view:"page" 填 `div[data-plugin-config]` 配置区）。
     * slot 声明是 `kind:"keyed"` ⇒ spec 用 `key` 定位，id/order/label 在这个 slot 上无意义。
     *
     * 两个组成值都来自仓库文件，不写字面量第二次：
     *   - bundle 部分 = package.json 的 `"name"`（即 NS 常量）
     *   - rowId 部分  = cordis.patch.yml 的 `- id: amd-model-load`
     * client 半身跑在浏览器里**不能运行时读文件**，所以这里只能是常量；
     * test/client.test.mjs 会从那两个文件反推并断言相等 —— 将来改 id 时测试立刻红。
     */
    const ROW_CONFIG_SLOT = "plugins.row.config";
    const PLUGIN_ROW_ROW_ID = "amd-model-load";
    const PLUGIN_ROW_KEY = NS + "#" + PLUGIN_ROW_ROW_ID;

    /** 模型选择行徽章的 slot 名（apply 的注入清单与日志共用这一个常量）。 */
    const MODEL_LABEL_SLOT = "conversation.input.model.label";

    /** RPC 通道前缀，必须与 host 的 CHANNEL 完全一致。 */
    const CHANNEL = "/dsh-amd-model-load";

    /** 本地 RPC 轮询间隔。打的是内存快照，很便宜；60s 足够让读数看起来是活的。 */
    const CLIENT_POLL_MS = 60_000;

    /**
     * 只有 AMD provider 的模型才显示负载徽章。`provider.id` 就是 provider 的 key，
     * `cordis.patch.yml` 里 `providers.amd` 的那个就是 "amd"。
     * 其他 provider（腾讯云等）零侵入 —— 只渲染模型名，不碰任何负载数据。
     */
    const AMD_PROVIDER_ID = "amd";

    /**
     * 只有展开菜单里的**可选项**（placement === "option"）才显示徽章。
     *
     * 另外两个 placement 是 `trigger`（收起按钮）与 `menu`（菜单顶部「当前选择」那一行）：
     * 在 trigger 上显示会撑宽输入框下方的工具栏，在 menu 上显示会与下方 option 重复。
     */
    const PLACEMENT_OPTION = "option";

    /**
     * 状态配色。idle=绿 / busy=黄 / full=红 / 无数据或未知=灰。
     * 与 host 的分组排序无关，纯粹是视觉。配置页的 ModelRow 沿用这套亮色；
     * 模型行 chip 用压暗一档的 CHIP_ACCENT（见下）。
     */
    const STATE_COLOR = {
      idle: "#22c55e",
      busy: "#eab308",
      full: "#ef4444",
      unknown: "#9ca3af",
    };

    /** 状态中文名。未知状态按「无数据」处理，不崩、不猜。 */
    const STATE_TEXT = {
      idle: "空闲",
      busy: "繁忙",
      full: "满载",
      unknown: "无数据",
    };

    /**
     * 行内 chip 的语义 accent 色（模型选择列表专用，任务单 2026-11-15 §2.3）。
     *
     * 比 STATE_COLOR 压暗一档：6px 的小点会被 chip 的浅底衬出来，原亮色
     * （#22c55e 等）在浅底下偏「飘」，压暗后与文字同排更稳。点的最终颜色还要经
     * stateColor() 与主题文字色混合（currentColor 跟随深浅主题自动提亮/压暗）。
     */
    const CHIP_ACCENT = {
      idle: "#15803d",
      busy: "#b45309",
      full: "#dc2626",
      unknown: "#6b7280",
    };

    /**
     * 行内 chip 的容器样式（任务单 2026-11-15 §2.3 的规范性要求）。
     *
     * 一枚 18px 高的胶囊：背景与描边走宿主主题 token（fallback 供脱离宿主的
     * 测试/预览渲染用）。描边用 inset box-shadow 而不是 border —— border 会把
     * 盒高撑到 20px，模型行行高抖动。保持 M4 的行内契约：inline-flex、不换行、
     * 不设固定宽度（宽度由内容决定）。
     */
    const CHIP_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      height: "18px",
      padding: "0 6px",
      borderRadius: "999px",
      lineHeight: "18px",
      verticalAlign: "middle",
      whiteSpace: "nowrap",
      marginLeft: "6px",
      background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))",
      boxShadow: "inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127,127,127,0.22))",
    };

    /**
     * chip 内百分比文本：11px / 600 / tabular-nums，具名颜色而不是 opacity 压灰
     * —— 压灰无法算对比度，具名色才能在测试里真算（WCAG 公式）。
     *
     * fallback 取 #59636e：它对 chip 底（rgba(127,127,127,0.10) 叠白 ≈ #f4f4f5）的
     * 对比度实测 5.56:1，满足 §2.3 的 ≥ 4.5 硬指标。任务单原拟的 #6b7280 在同底上
     * 只有 4.40:1（WCAG 公式可复算），不达标，故压暗一档 —— 偏离已写进报告。
     */
    const CHIP_TEXT_STYLE = {
      fontSize: "11px",
      fontWeight: 600,
      fontVariantNumeric: "tabular-nums",
      letterSpacing: "0",
      color: "var(--sys-color-on-surface-subtle, #59636e)",
    };

    /**
     * FREE 徽章样式 —— **逐字段照抄 AMD 网页的 `.ma-badge` / `.ma-badge-free` 规则**
     * （2026-10-25 从 https://developer.amd.com.cn/radeon/tokenfactory 的 <style> 里抓到）：
     *
     *   .ma-badge      { font-size:10px; font-weight:800; letter-spacing:.04em;
     *                    text-transform:uppercase; padding:3px 7px; border-radius:4px;
     *                    white-space:nowrap; }
     *   .ma-badge-free { color:#5b3fd6; background:#efeafe; }
     *
     * 即淡紫底 #efeafe + 深紫字 #5b3fd6，10px/800 字重、0.04em 字距、大写、3px 7px 内边距、
     * 4px 圆角。用户要求「照抄进 AMD 模型负载页面的每个模型的 UI 里」，所以这些数值原样保留，
     * 不换成 design token。
     *
     * ⚠️ 只有配置页用它。模型选择列表行刻意**不显示** FREE 徽章 —— 列表行只要
     * 「点 + 百分比」（用户明确要求），徽章留给设置页看完整信息时用。
     */
    const FREE_BADGE_STYLE = {
      flex: "none",
      fontSize: "10px",
      fontWeight: 800,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      padding: "3px 7px",
      borderRadius: "4px",
      whiteSpace: "nowrap",
      color: "#5b3fd6",
      background: "#efeafe",
    };

    /**
     * 内置 1017 徽章的判定条件（**逐字照抄**内置插件，不要改动语义）。
     *
     * 来源：`@deepseek-ai/dsh-client-ui-deepseek-model-label-1017/lib/client.js`
     *   const MODEL_NAME = "DeepSeek-V4.1-Flash";
     *   if (!(provider.id === "deepseek-account" || provider.id === "deepseek-official")
     *       || model.id !== "deepseek-flash" || model.name !== MODEL_NAME) return model.name;
     *
     * 注意三个条件是 **AND**，且 `model.name` 必须精确等于 `DeepSeek-V4.1-Flash`
     * （不是 id，是 name）。少一个条件就会给不该加徽章的行加上 1017。
     */
    const DEEPSEEK_1017_PROVIDERS = ["deepseek-account", "deepseek-official"];
    const DEEPSEEK_1017_MODEL_ID = "deepseek-flash";
    const DEEPSEEK_1017_MODEL_NAME = "DeepSeek-V4.1-Flash";
    const DEEPSEEK_1017_LABEL = "1017";

    /**
     * 1017 徽章的样式 —— 照抄 `Tag tone="info"`。
     *
     * 内置插件用的是 primitives 的 `<Tag tone="info">`，其样式来自
     * `@deepseek-ai/dsh-client-ui-primitives/lib/Tag.module.css`：
     *
     *   .tag { display:inline-flex; align-items:center; border-radius:999px;
     *          corner-shape:round; padding:1px 8px; font-size:11px;
     *          line-height:17px; font-weight:500; white-space:nowrap; }
     *   .tag[data-tone='info'] {
     *          background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
     *          color: var(--dsw-alias-state-business-primary); }
     *
     * 这里用 CSS 变量原样复刻（不硬编码颜色），主题切换时跟随 DSH 配色。
     * `corner-shape` 是较新的 CSS 属性，部分环境不支持，保留但不影响圆角。
     */
    const DEEPSEEK_1017_BADGE_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      borderRadius: "999px",
      cornerShape: "round",
      padding: "1px 8px",
      fontSize: "11px",
      lineHeight: "17px",
      fontWeight: 500,
      whiteSpace: "nowrap",
      background: "color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)",
      color: "var(--dsw-alias-state-business-primary)",
    };

    /**
     * 1017 徽章的外层容器样式（内置插件用它保持 baseline 对齐）。
     * 来源同上 `.label { vertical-align:baseline; white-space:nowrap;
     *               align-items:center; gap:4px; display:inline-flex; }`
     */
    const DEEPSEEK_1017_LABEL_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      verticalAlign: "baseline",
      whiteSpace: "nowrap",
    };
    //#endregion

    //#region helpers
    /**
     * 复刻内置 1017 插件的渲染结果：命中时返回「模型名 + 1017 徽章」，
     * 否则只返回模型名（与内置插件 `return model.name` 一致）。
     *
     * 为什么需要它：我们以 `priority: -1` 抢占了 `conversation.input.model.label`，
     * 而内置的 `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` 原本也注册在这里
     * （priority 0）。single slot 同一时刻只有一个渲染者，我们赢了之后那个徽章就没人画了。
     * 用户明确要求保留它，所以由我们代画。
     *
     * ⚠️ 判定条件必须与内置插件**逐字一致**（三个条件是 AND）：
     *   1. `provider.id` ∈ {deepseek-account, deepseek-official}
     *   2. `model.id === "deepseek-flash"`
     *   3. `model.name === "DeepSeek-V4.1-Flash"`  ← 注意是 name 不是 id
     * 少任何一个都会给不该加徽章的行加上 1017。
     *
     * 文案固定 "1017"，不查 locale 字典 —— 内置插件的中英文字典值都是 "1017"。
     *
     * @param provider - 父级传入的 provider（可能畸形）。
     * @param model - 父级传入的 model（可能畸形）。
     * @param modelName - 已算好的展示名（name 缺失时回退 id）。
     * @returns {object} React 元素：纯文本，或「名字 + 徽章」的 span。
     */
    function deepSeek1017Name(provider, model, modelName) {
      const providerId = provider !== null && typeof provider === "object" ? provider.id : undefined;
      const isOfficial =
        typeof providerId === "string" && DEEPSEEK_1017_PROVIDERS.indexOf(providerId) !== -1;
      const isTargetModel =
        model !== null &&
        typeof model === "object" &&
        model.id === DEEPSEEK_1017_MODEL_ID &&
        model.name === DEEPSEEK_1017_MODEL_NAME;

      if (!isOfficial || !isTargetModel) return modelName;

      return React.createElement(
        "span",
        { style: DEEPSEEK_1017_LABEL_STYLE },
        React.createElement("span", null, modelName),
        " ",
        React.createElement("span", { style: DEEPSEEK_1017_BADGE_STYLE }, DEEPSEEK_1017_LABEL),
      );
    }

    /**
     * 把时间戳格式化成 HH:MM（24 小时制，本地时区）。
     * 无时间戳返回 null，由调用方显示「—」。
     *
     * @param {number|null} ts - 毫秒时间戳。
     * @returns {string|null}
     */
    function formatTime(ts) {
      if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
      const date = new Date(ts);
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      return hh + ":" + mm;
    }

    /**
     * 从 RPC 返回值里取出分组数组。
     *
     * 容错三层：value 不是对象 ⇒ []；groups 不是数组 ⇒ []；单个组畸形 ⇒ 跳过。
     * 这样任何一个上游形状变化都只会让页面变空，不会抛进 React 的渲染路径。
     *
     * @param {unknown} value - RPC 的 result.value。
     * @returns {Array<{label: string, models: object[]}>}
     */
    function groupsOf(value) {
      if (value === null || typeof value !== "object") return [];
      const groups = value.groups;
      if (!Array.isArray(groups)) return [];
      const out = [];
      for (const group of groups) {
        if (group === null || typeof group !== "object") continue;
        if (!Array.isArray(group.models) || group.models.length === 0) continue;
        out.push({
          label: typeof group.label === "string" ? group.label : "其他",
          models: group.models,
        });
      }
      return out;
    }

    /**
     * 在 catalog 数据里按模型 id 查该模型的负载读数。
     *
     * 为什么需要「查」而不是「取」：catalog 是**按分类分组**的结构
     * （`groups: [{label, models}]`），模型散落在 5 个组里。模型选择列表给我们的
     * `model.id` 没有组信息，所以必须跨组线性查找。
     *
     * 规模很小（15 个模型），不做索引 —— 一次渲染最多查 N 行 × 15，可忽略。
     *
     * 返回 null 表示「查不到」或「查到了但没有负载数据」，两种情况在 UI 上
     * 都是灰点 + `—`（对用户而言是同一件事：现在没有可用的繁忙度读数）。
     *
     * @param {Array<{label: string, models: object[]}>} groups - groupsOf() 的结果。
     * @param {string} id - 模型 id（与 catalog 里的 id 同一口径）。
     * @returns {{state: string, utilization: number|null, hasLoad: boolean}|null}
     */
    function findModelLoad(groups, id) {
      if (typeof id !== "string" || id === "") return null;
      for (const group of groups) {
        for (const model of group.models) {
          if (model === null || typeof model !== "object") continue;
          if (model.id !== id) continue;
          const state =
            typeof model.state === "string" && STATE_COLOR[model.state] !== undefined
              ? model.state
              : "unknown";
          const utilization =
            typeof model.utilization === "number" && Number.isFinite(model.utilization)
              ? model.utilization
              : null;
          return { state, utilization, hasLoad: model.hasLoad === true };
        }
      }
      return null;
    }
    //#endregion

    //#region 共享快照订阅器
    /**
     * 创建一个**共享的** catalog 快照订阅器。
     *
     * 不变量（每条都有对应测试）：
     *   - **全插件只有一个 interval**：第一个订阅者到来时启动，最后一个退订时停掉。
     *   - **并发拉取只发一次请求**：`pull()` 共用同一个 in-flight promise。
     *   - **失败保留旧数据**：只更新 `error`，`data` 保持上一次成功值（与 host 的纪律一致）。
     *   - **订阅即刻拿到当前快照**：新订阅者不用等下一个 tick。
     *   - 快照是**同一个对象引用**发给所有 listener ⇒ 两张卡的时间戳必然一致。
     *
     * @param {object|undefined} rpc - connection.rpc；connection 缺席时为 undefined。
     * @returns {{subscribe: Function, getSnapshot: Function, pull: Function, stop: Function, listenerCount: Function}}
     */
    function createSnapshotStore(rpc) {
      /** @type {Set<Function>} */
      const listeners = new Set();
      /** 当前快照。`loaded` 区分「还没拉到」与「拉到了但目录为空」。 */
      let state = { data: null, error: null, loaded: false };
      let timer = null;
      let inFlight = null;
      /** 把当前快照发给所有 listener。单个 listener 抛错不能影响其他 listener。 */
      function notify() {
        for (const listener of Array.from(listeners)) {
          try {
            listener(state);
          } catch {
            /* listener 自身的错误与数据分发无关，忽略。 */
          }
        }
      }

      /** 拉一次本地 RPC。失败只写 error，不动 data。 */
      function pull() {
        if (rpc === undefined || rpc === null) return Promise.resolve(state);
        if (inFlight !== null) return inFlight;
        inFlight = Promise.resolve(rpc.call(CHANNEL, "catalog", {}))
          .then((result) => {
            if (result !== null && typeof result === "object" && result.ok === true) {
              state = { data: result.value, error: null, loaded: true };
            } else {
              state = {
                data: state.data,
                error: (result && result.error && result.error.message) || "读取失败",
                loaded: state.loaded,
              };
            }
            notify();
            return state;
          })
          .catch((cause) => {
            state = {
              data: state.data,
              error: cause instanceof Error ? cause.message : String(cause),
              loaded: state.loaded,
            };
            notify();
            return state;
          })
          .finally(() => {
            inFlight = null;
          });
        return inFlight;
      }

      /** 启动节拍：立即拉一次，然后每 CLIENT_POLL_MS 一次。幂等。 */
      function start() {
        if (timer !== null) return;
        void pull();
        timer = setInterval(() => {
          void pull();
        }, CLIENT_POLL_MS);
        if (typeof timer?.unref === "function") timer.unref();
      }

      /** 停表。最后一个订阅者退订时调用。 */
      function stop() {
        if (timer === null) return;
        clearInterval(timer);
        timer = null;
      }

      /**
       * 订阅。返回退订函数。
       * 订阅即启动节拍（若尚未启动），并**立刻**把当前快照推给新订阅者。
       */
      function subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        listeners.add(listener);
        start();
        try {
          listener(state);
        } catch {
          /* 同上，忽略。 */
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) stop();
        };
      }

      return {
        subscribe,
        getSnapshot: () => state,
        pull,
        stop,
        listenerCount: () => listeners.size,
      };
    }

    /**
     * 把 store 接到组件 state 上的 hook。
     *
     * `useState(store.getSnapshot())` 只取首帧值，之后全靠 subscribe 推；
     * 订阅时 store 会立刻推一次当前快照，所以「挂载即有数据」不用额外分支。
     */
    /**
     * store 缺席时的空快照。**必须是模块级常量**：每次渲染新建对象会让 useState
     * 的初值不断变化，虽然不影响正确性，但会白白多一次比较。
     */
    const EMPTY_SNAPSHOT = { data: null, error: null, loaded: false };

    /**
     * 把 store 接到组件 state 上的 hook。
     *
     * `useState(store.getSnapshot())` 只取首帧值，之后全靠 subscribe 推；
     * 订阅时 store 会立刻推一次当前快照，所以「挂载即有数据」不用额外分支。
     *
     * ⚠️ `store` 可以为 null —— 这不是防御式编程，而是为了满足 Hooks 规则：
     * 调用方（ModelRowBadge）必须在**每个分支都调用本 hook**，否则同一组件实例
     * 在 placement 变化（option ↔ trigger）时 hook 数量会变，React 会抛
     * 「Rendered more hooks than during the previous render」。
     *
     * @param store - 快照订阅器，可为 null。
     */
    function useSnapshot(store) {
      const usable = store !== undefined && store !== null;
      const [snapshot, setSnapshot] = React.useState(usable ? store.getSnapshot() : EMPTY_SNAPSHOT);
      React.useEffect(() => {
        if (!usable) return undefined;
        return store.subscribe(setSnapshot);
      }, [store, usable]);
      return usable ? snapshot : EMPTY_SNAPSHOT;
    }
    //#endregion

    //#region 插件行配置页组件（原设置卡）
    /**
     * 一行模型读数：状态点 + 模型 id + 状态文字 + utilization + FREE 徽章。
     *
     * 顺序刻意是「状态点 → id → 徽章 → 状态 → 百分比」：徽章紧跟模型名，
     * 与 AMD 网页上「模型卡片右上角贴 FREE」的观感一致，同时保持行内对齐。
     * 没有负载数据时整行降到 55% 不透明度，避免它看起来和真实读数一样重。
     */
    function ModelRow(props) {
      const model = props.model !== null && typeof props.model === "object" ? props.model : {};
      const state = typeof model.state === "string" && STATE_COLOR[model.state] !== undefined ? model.state : "unknown";
      const color = STATE_COLOR[state];
      const stateText = STATE_TEXT[state];
      const utilization =
        typeof model.utilization === "number" && Number.isFinite(model.utilization) ? model.utilization : null;
      // free 由 host 依据 badgeLabel 判定；这里再校验一次类型，防止脏数据渲染出「undefined」。
      const free = model.free === true;

      return React.createElement(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "5px 0",
            opacity: model.hasLoad === true ? 1 : 0.55,
          },
        },
        React.createElement("span", {
          "aria-hidden": "true",
          style: {
            flex: "none",
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            background: color,
          },
        }),
        React.createElement("span", { style: { flex: "1 1 auto", fontSize: "12px" } }, String(model.id ?? "")),
        free ? React.createElement("span", { style: FREE_BADGE_STYLE }, "FREE") : null,
        React.createElement("span", { style: { flex: "none", fontSize: "11px", opacity: 0.7 } }, stateText),
        React.createElement(
          "span",
          {
            style: {
              flex: "none",
              width: "46px",
              textAlign: "right",
              fontSize: "11px",
              fontVariantNumeric: "tabular-nums",
              opacity: 0.8,
            },
          },
          utilization === null ? "—" : utilization.toFixed(1) + "%",
        ),
      );
    }

    /**
     * 一个分类分组：组标题 + 组内模型行。
     *
     * 组标题**原样显示 capability_label**（"VLM (Vision)" 等），不翻译 ——
     * 用户要求「直接按它的来分组显示」。
     */
    function Group(props) {
      const group = props.group;
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", marginTop: "8px" } },
        React.createElement(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "baseline",
              gap: "6px",
              paddingBottom: "2px",
              borderBottom: "1px solid rgba(127,127,127,0.18)",
            },
          },
          React.createElement("span", { style: { fontSize: "11px", fontWeight: 700, opacity: 0.85 } }, group.label),
          React.createElement(
            "span",
            { style: { fontSize: "10px", opacity: 0.45 } },
            String(group.models.length) + " 个",
          ),
        ),
        group.models.map((model, index) =>
          React.createElement(ModelRow, { key: String(model && model.id ? model.id : index), model: model }),
        ),
      );
    }

    /**
     * 插件行配置页：按 AMD 官方 5 分类分组的实时负载读数。
     *
     * 数据来自共享 store —— 与模型选择行徽章是**同一个快照对象**，所以两处的
     * 「更新于」必然一致。任何失败都只更新 error 文案，保留已有数据。
     *
     * 宿主的行详情页会把本组件渲染**两次**（任务单 2026-11-15 §3.6）：
     *   - view:"summary" —— 行描述位（description 为空时）。**只给单行摘要**，
     *     渲染整卡会把描述区撑成一大块；
     *   - view:"page"（或缺省）—— `div[data-plugin-config]` 配置区主体，渲染完整卡，
     *     但**不渲染页面级大标题**：行详情页自己已有「amd-model-load」标题，再顶一个
     *     会重复。「更新于 HH:MM」纪律与陈旧标记保留。
     */
    function Card(props) {
      const store = props.store;
      const snapshot = store === undefined || store === null
        ? { data: null, error: null, loaded: false }
        : useSnapshot(store);

      const data = snapshot.data;
      const error = snapshot.error;
      const groups = groupsOf(data);
      const updatedAt = formatTime(data !== null && typeof data === "object" ? data.loadTs : null);
      const stale = data !== null && typeof data === "object" && data.loadStale === true;

      // 行描述位：单行摘要「空闲 3 / 11 · 更新于 20:15」。无数据时也给一行占位，
      // 让描述位不至于空着。
      if (props.view === "summary") {
        const models = [];
        for (const group of groups) {
          for (const model of group.models) models.push(model);
        }
        const idle = models.filter(
          (model) => model !== null && typeof model === "object" && model.state === "idle",
        ).length;
        const time = updatedAt === null ? "尚未取到数据" : "更新于 " + updatedAt;
        const line =
          models.length === 0
            ? (error !== null ? "负载读取失败：" + error : "暂无数据")
            : STATE_TEXT.idle + " " + idle + " / " + models.length + " · " + time;
        return React.createElement(
          "p",
          { style: { margin: "0", fontSize: "11px", lineHeight: 1.6, opacity: 0.8 } },
          line,
        );
      }

      // 配置区主体：完整卡（无页面级大标题）。
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "6px" } },
        // 时间行：「更新于 HH:MM」+ 陈旧标记（大标题已去掉，行详情页自带标题）
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
          React.createElement(
            "span",
            { style: { fontSize: "11px", opacity: 0.55 } },
            updatedAt === null ? "尚未取到数据" : "更新于 " + updatedAt,
          ),
          stale
            ? React.createElement(
                "span",
                {
                  style: {
                    fontSize: "10px",
                    padding: "1px 5px",
                    borderRadius: "3px",
                    background: "rgba(234,179,8,0.18)",
                    color: "#b45309",
                  },
                },
                "陈旧",
              )
            : null,
        ),
        // 分组列表：host 已按官方分类顺序 + 组内繁忙度升序排好，这里只渲染。
        groups.length === 0
          ? React.createElement("div", { style: { fontSize: "11px", opacity: 0.55 } }, "目录尚未取到")
          : React.createElement(
              "div",
              { style: { display: "flex", flexDirection: "column" } },
              groups.map((group) => React.createElement(Group, { key: group.label, group: group })),
            ),
        // 错误行：保留数据的同时告诉用户为什么数字没动
        error !== null
          ? React.createElement(
              "div",
              { style: { fontSize: "11px", color: "#b45309", lineHeight: 1.5 } },
              "负载读取失败：" + error,
            )
          : null,
      );
    }

    //#endregion

    //#region 模型选择行徽章
    /**
     * 模型选择列表行徽章：在模型名右边追加一枚负载 chip（`[●] 20.1%`）。
     *
     * ## 为什么这个组件**任何分支都不返回 null**
     *
     * 父级用 `renderSlot(..., { fallback: model.name })` 把模型名的渲染责任交给我们。
     * 而 `fallback` 只在「该 slot 一个贡献者都没有」时生效（宿主
     * `dsh-client-ui-renderer/lib/client.js` 第 1175 行：`if (!entry) return ... fallback`）。
     * 我们注册之后 `entry` 恒存在，`fallback` 永不参与 —— 返回 null 会让那个
     * `<span data-model-id>` 变成空白，模型名消失。
     *
     * 所以本组件的**每个分支都渲染 `model.name`**，chip 只是「额外」追加：
     *   - `placement !== "option"`（trigger / menu）→ 只渲染名字
     *   - `provider.id !== "amd"`                → 只渲染名字
     *   - 查不到负载 / 无负载数据                 → 名字 + chip（虚线环点 + `—`）；
     *                                             chip 不能整个消失，否则像插件没装
     *   - 有负载                                 → 名字 + chip（形状点 + 百分比）
     *
     * ## 样式约束（行内元素，M5 重绘后仍成立）
     *
     * 父级把它塞进 `<span data-model-id>` 里，作为 model.name 的兄弟节点。所以：
     *   - 用 `inline-flex`（不是 flex，不能独占一行）
     *   - `marginLeft: 6px` 与名字拉开
     *   - `whiteSpace: "nowrap"` 不换行
     *   - **不设固定宽度**（宽度由内容决定，模型名长短不一）
     *   - `tabular-nums` 让百分比刷新时数字宽度稳定，列表不抖动
     *   - chip 高度固定 18px，用 inset box-shadow 描边而不是 border（盒高不变，行高不抖）
     */
    /**
     * 状态 → 形状映射（**纯函数**，不读也不写任何模块级状态）。
     *
     * 为什么需要形状：三态若只有色相差异，色觉障碍不可辨（WCAG 1.4.1），
     * 所以每个状态在颜色之外再编码一层形状：
     *   idle    实心圆
     *   busy    半填充圆（下半着色、上半透明 + 同色细环）
     *   full    方块（borderRadius 2px）
     *   unknown 虚线环（不填色）
     * 导出给测试：断言四态两两不等（「不只靠颜色」的可测形式）。
     */
    function shapeOf(state) {
      switch (state) {
        case "idle":
          return { shape: "circle", filled: true, halfFilled: false, dashed: false };
        case "busy":
          return { shape: "circle", filled: false, halfFilled: true, dashed: false };
        case "full":
          return { shape: "square", filled: true, halfFilled: false, dashed: false };
        default:
          return { shape: "circle", filled: false, halfFilled: false, dashed: true };
      }
    }

    /**
     * 状态点颜色：accent 与主题文字色按 sRGB 混合（70/30）。
     *
     * currentColor 跟随主题文字色 —— 深色主题下自动提亮，浅色下就是 accent 本色。
     * 不支持 color-mix 的环境整条声明失效（退化为透明底）：宿主是新版 Chromium
     *（color-mix 自 111 起支持），内联 style 也做不了「同一属性声明两次」的降级，
     * 任务单明确这个降级可接受。
     */
    function stateColor(accent) {
      return "color-mix(in srgb, " + accent + " 70%, currentColor)";
    }

    /** 状态点的内联样式：形状由 shapeOf 驱动，颜色由 stateColor 混合。 */
    function dotStyle(state) {
      const mixed = stateColor(CHIP_ACCENT[state] ?? CHIP_ACCENT.unknown);
      const shape = shapeOf(state);
      const base = { flex: "none", width: "6px", height: "6px" };

      if (shape.shape === "square") {
        // full：方块。borderRadius 2px 让角稍微圆一点，肉眼是「实心方块」。
        return { ...base, borderRadius: "2px", background: mixed };
      }
      if (shape.dashed) {
        // unknown：虚线环、不填色。虚线只能用 border 画（boxShadow 不支持 dashed），
        // border-box 把 6px 盒子连边框一起算，不改变盒高。
        return {
          ...base,
          borderRadius: "50%",
          background: "transparent",
          border: "1px dashed " + mixed,
          boxSizing: "border-box",
        };
      }
      if (shape.halfFilled) {
        // busy：下半着色、上半透明的圆，再叠一圈同色细环（boxShadow 不参与布局，不改变盒高）。
        return {
          ...base,
          borderRadius: "50%",
          background: "linear-gradient(to top, " + mixed + " 50%, transparent 50%)",
          boxShadow: "inset 0 0 0 1px " + mixed,
        };
      }
      // idle：实心圆。
      return { ...base, borderRadius: "50%", background: mixed };
    }

    /** badgeView 缓存。键 = 快照对象引用 + model.id。 */
    let BADGE_VIEW_CACHE = { data: undefined, id: undefined, view: null };

    /**
     * 把「快照 + 模型 id」压成渲染所需的全部派生值。
     *
     * 缓存只在快照引用或 id 变化时失效：store 在每次成功拉取时整体替换 state.data，
     * 所以这个键不会读到过期数据；而流式输出期间的上万次重渲染会全部命中缓存。
     *
     * M5 起返回值带齐四类字段，供 chip 与测试直接使用：
     *   - state   "idle" | "busy" | "full" | "unknown"（有读数时用上游 state，否则 unknown）
     *   - label   状态中文（STATE_TEXT[state]）
     *   - percent "20.1%"；无读数时是 "—"（**与 0.0% 是不同的串**，0 是读数、— 是没有读数）
     *   - title   悬浮文案（「AMD 负载：空闲 20.1%，更新于 17:20」）
     *   - aria    与 title 同文 —— chip 容器 role="img" 的可访问名
     *   - color   保留 M4 的亮色（兼容旧消费方；chip 的点用 dotStyle()，不再走这里）
     *
     * @param data - snapshot.data（可能为 null）。
     * @param id - 模型 id。
     * @returns {{color: string, state: string, label: string, percent: string, title: string, aria: string}}
     */
    function badgeView(data, id) {
      if (BADGE_VIEW_CACHE.data === data && BADGE_VIEW_CACHE.id === id) return BADGE_VIEW_CACHE.view;
      const load = findModelLoad(groupsOf(data), id);
      const hasReading = load !== null && load.hasLoad === true && load.utilization !== null;
      const state = hasReading ? load.state : "unknown";
      const percent = hasReading ? load.utilization.toFixed(1) + "%" : "—";
      const updatedAt = formatTime(data !== null && typeof data === "object" ? data.loadTs : null);
      const label = STATE_TEXT[state];
      const title =
        "AMD 负载：" +
        label +
        " " +
        percent +
        (updatedAt === null ? "" : "，更新于 " + updatedAt);
      const view = { color: STATE_COLOR[state], state, label, percent, title, aria: title };
      BADGE_VIEW_CACHE = { data, id, view };
      return view;
    }

    function ModelRowBadge(props) {
      // ⚠️ 渲染期**只读**：本函数体内不改任何模块级状态（P3，见 M5-RENDER-CHURN.md §4）。
      // React 并发渲染会丢弃或重放渲染，把计数写在渲染里会同时 under-count（丢弃）
      // 与 over-count（重放/StrictMode 双调用），让「渲染次数」这个判据自己失真。
      // 所有观测写入都放到下面的 useEffect（无依赖数组 ⇒ 每次提交跑一次）。
      const model = props.model !== null && typeof props.model === "object" ? props.model : {};
      const modelName = typeof model.name === "string" && model.name !== "" ? model.name : String(model.id ?? "");
      const provider = props.provider !== null && typeof props.provider === "object" ? props.provider : {};
      // ⚠️ Hooks 规则：useSnapshot 必须在**所有分支之前**无条件调用。
      // 父级用 <Comp {...props} /> 在同一位置无 key 直接渲染（renderer 的
      // renderEntry 就是 jsx(Comp, props)），placement 从 option 变 trigger
      //（菜单展开→收起）时 React 会复用同一个组件实例；若 hook 只在 option
      // 分支里调用，hook 数量会从 0 跳到 2，React 抛
      //「Rendered more hooks than during the previous render」并崩掉整个菜单。
      // 这类 bug 单测测不出（每次渲染都是新实例），只有真机切换才触发。
      const snapshot = useSnapshot(props.store);

      // ⚠️ 我们以 priority:-1 抢占了内置 1017 插件的 slot，**必须代它渲染 1017 徽章**，
      // 否则那个徽章会永久消失（用户明确要求保留）。原实现见 app.asar 内
      // `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017/lib/client.js`：
      //   if (!(provider.id === "deepseek-account" || provider.id === "deepseek-official")
      //       || model.id !== "deepseek-flash" || model.name !== "DeepSeek-V4.1-Flash")
      //     return model.name;
      //   return <span>{model.name} <Tag tone="info">1017</Tag></span>
      // 判定条件与文案（固定 "1017"，不走 locale 字典）逐字照抄，见 deepSeek1017Name()。
      const with1017 = deepSeek1017Name(provider, model, modelName);

      const isOption = props.placement === PLACEMENT_OPTION;
      const isAmd = provider.id === AMD_PROVIDER_ID;
      // 分支 1/2：不显示负载徽章的场景 —— 但仍然渲染模型名（可能带 1017）。
      // 不能返回 null：父级的 fallback 只在「该 slot 一个贡献者都没有」时生效，
      // 有贡献者时直接 jsx(Comp)，组件返回 null 那一行就变空白（模型名消失）。
      if (!isOption || !isAmd) {
        return with1017;
      }

      // 分支 3/4：option + amd —— 查负载并渲染「名字 + 负载 chip」。
      // 整段 try/catch：这里任何一处抛错（脏数据、形状变化）都会被宿主的
      // SlotErrorBoundary 捕获并把本条目 **abdicate**（让位给内置 1017）——
      // 表现就是「徽章莫名其妙消失、现象在不同模型间跳」。宁可降级为纯名字。
      try {
        // 渲染频率可达 130 次/秒（宿主父组件带动，见 M5-RENDER-CHURN.md §2），
        // 所以这里必须近乎零成本：按「快照引用 + model.id」缓存查表与拼串结果。
        // 快照引用只在成功拉取时整体替换，因此缓存不会读到过期数据。
        const view = badgeView(snapshot.data, typeof model.id === "string" ? model.id : "");

        return React.createElement(
          React.Fragment,
          null,
          modelName,
          React.createElement(
            "span",
            {
              // role="img" + aria-label：把「点 + 数字」读成一枚有语义的整体
              //（「AMD 负载：空闲 20.1%，更新于 17:20」），不让读屏念成孤立百分比。
              role: "img",
              title: view.title,
              "aria-label": view.aria,
              style: CHIP_STYLE,
            },
            React.createElement("span", { "aria-hidden": "true", style: dotStyle(view.state) }),
            React.createElement("span", { style: CHIP_TEXT_STYLE }, view.percent),
          ),
        );
      } catch (error) {
        // 降级：任何意外都只损失徽章，不损失模型名，更不损失整个条目
        //（宿主 SlotErrorBoundary 会把抛错的条目 abdicate，让位给内置 1017 ——
        // 那才是「徽章时有时无」的根源）。错误打点进 console.error。
        const message = error instanceof Error ? error.message : String(error);
        console.error(LOG_PREFIX + "模型行徽章渲染失败，降级为纯模型名：" + message, error);
        return with1017;
      }
    }
    //#endregion

    //#region 统一日志前缀
    /** 统一日志前缀：注册失败等异常都带此前缀打到浏览器 console，便于过滤。 */
    const LOG_PREFIX = "[amd-model-load] ";

    /**
     * slots.register 的观测包装：前后打日志，失败改记 console.error（不再静默抛）。
     *
     * 为什么吞掉错误：register 抛错发生在 slots.inject 的声明回调里，向上抛会走
     * `queueMicrotask(() => { throw failure })` 的 unhandled-rejection 路径 —— 只有
     * DevTools 能看到，且会把 slots.inject 的控制器 stop 掉。改成「记录 + 返回空
     * disposer」后：宿主机制保持健康、失败原因进 console.error。注册失败的最坏结果退化为「徽章不显示」，不再有连带损伤。
     *
     * @param ctx - 客户端根上下文。
     * @param tag - slot 名，只用于日志。
     * @param spec - 传给 ctx.slots.register 的注册 spec。
     * @param component - 组件。
     * @returns register 的 disposer；失败时返回空函数。
     */
    function safeRegister(ctx, tag, spec, component) {
      console.log(
        LOG_PREFIX +
          "slots.register → " +
          tag +
          "（priority=" +
          (spec.priority ?? 0) +
          "，id=" +
          String(spec.id ?? "(无)") +
          "）",
      );
      try {
        const dispose = ctx.slots.register(spec, component);
        console.log(LOG_PREFIX + "slots.register ← " + tag + " 成功，条目已进 ledger");
        return dispose;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(LOG_PREFIX + "slots.register ✗ " + tag + " 失败：" + message, error);
        return () => {};
      }
    }
    //#endregion

    //#region plugin body
    /** slots 注册两个挂载点；connection 提供 rpc 载体。 */
    const inject = ["slots", "connection"];

    /**
     * 装配 client 半身：建**一个**共享快照 store，然后把两个组件注册进各自的 slot。
     *
     * 卡片用 `plugins.row.config`（M5 起）：这是宿主插件管理器行详情页的 keyed slot，
     * 按 `key = rowConfigKey(包名, 行 id)` 定位（见 PLUGIN_ROW_KEY 注释），只有注册了
     * 这个 key，「插件 → 已安装 → dsh-amd-model-load」行才会出现「配置」按钮。旧的
     * 设置页 slot 已整体移除，**不做双注册**（两处都渲染会让人以为有两个设置页）。
     *
     * ⚠️ slots.inject 对未声明的 slot 是**静默等待**（不报错、不打日志）：宿主没有
     * `plugins.row.config`（DSH Desktop < 0.14.0 / 内嵌 dsh < 0.2.2-rc.1）时，配置页会
     * 无声消失。所以 apply 入口先打一行「将注册」日志 —— 真机上 grep 这一行就能区分
     * 「注册了但宿主没渲染」与「根本没注册」。
     *
     * 模型选择行用 `conversation.input.model.label`（父级
     * `dsh-client-ui-model-selection` 声明为 `kind:"single", scope:"session", inline:true`）。
     * 注意它的 scope 是 **session**，且 kind 是 **single** —— 同一时刻只有一个贡献者生效，
     * 所以不要在同一个 slot 上注册多个组件（我们只注册一个）。
     *
     * 两个 slot 的 `inject` 都返回**同一个 store 实例** —— 这是「配置页与列表徽章
     * 永远同一份数据、同一个时间戳」的实现要点。组件本身不认识 rpc，只认识 store，
     * 因此也不可能绕开共享节拍自己拉。
     *
     * @param ctx 客户端根上下文。
     */
    function apply(ctx) {
      console.log(
        LOG_PREFIX +
          "apply: connection=" +
          (ctx.connection === undefined || ctx.connection === null ? "缺席" : "在位") +
          "，建共享快照 store",
      );
      console.log(
        LOG_PREFIX +
          "apply: 将注册 slots=[" +
          ROW_CONFIG_SLOT +
          "（key=" +
          PLUGIN_ROW_KEY +
          "）, " +
          MODEL_LABEL_SLOT +
          "]",
      );
      const connection = ctx.connection;
      const rpc = connection === undefined || connection === null ? undefined : connection.rpc;

      // 整个插件生命周期内只有这一个 store（也只有一个 interval）。
      const store = createSnapshotStore(rpc);

      ctx.slots.inject(ROW_CONFIG_SLOT, () => {
        const dispose = safeRegister(
          ctx,
          ROW_CONFIG_SLOT,
          {
            name: ROW_CONFIG_SLOT,
            // keyed slot：宿主用 rowConfigKey(包名, 行 id) 定位条目，id/order/label 无意义。
            key: PLUGIN_ROW_KEY,
            inject: () => ({ store }),
          },
          Card,
        );
        return dispose;
      });

      ctx.slots.inject(MODEL_LABEL_SLOT, () => {
        const dispose = safeRegister(
          ctx,
          MODEL_LABEL_SLOT,
          {
            name: MODEL_LABEL_SLOT,
            id: MODEL_ROW_ID,
            // 必须带 priority：内置的 1017 插件已占用该 single slot（priority 0）。
            // 同 priority 会抛错；取 -1 才能排在它前面成为实际渲染者。详见常量注释。
            priority: MODEL_ROW_PRIORITY,
            inject: () => ({ store }),
          },
          ModelRowBadge,
        );
        return dispose;
      });
    }

    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    exports.name = NS;
    // 以下不属于宿主契约（宿主只读 apply / inject / name）——供 test/client.test.mjs
    // 与 scripts/render-usage-chip.mjs 直接驱动渲染逻辑，而不是经组件间接断言。
    exports.badgeView = badgeView;
    exports.shapeOf = shapeOf;
    return module.exports;
  },
});
