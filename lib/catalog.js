/**
 * dsh-amd-model-load — 模型目录数据源（纯 JS，零依赖，可裸跑单测）。
 *
 * 本模块**不 import 任何包**，理由同 load-source.js：`node --test` 之外裸 node 也能直接跑，
 * 不需要工作区有 node_modules（宿主靠 host-module-fallback 兜底，但单测不该依赖它）。
 *
 * 职责边界：
 *   - 解析 AMD TokenFactory 的两个目录端点（bootstrap 卡片列表 / model 详情）
 *   - 把「目录」与「负载快照」合成为**已分组、已排序**的展示结构
 *   - 提供一个可注入 fetch 的目录轮询器（失败保留旧目录，首次失败退到 FALLBACK_CATALOG）
 *
 * 三条被真实样本固化的契约事实（2026-10-25 实测，见 M3-REPORT.md）：
 *   1. 分类**不必硬编码**：`display_config.capability_label` 原文即
 *      "VLM (Vision)" / "LLM (Text)" / "Decision (Classifier)" / "TTS (Speech)" / "OCR (Document)"。
 *   2. FREE 徽章**只能**取 `display_config.badge_label`。`token_factory.badge.label`
 *      对 d3 / d3-flash / Clef **也是 "Free"**（实测），用它当回退会给三个 Decision 模型
 *      错加 FREE 徽章 —— 这与网页上的实际显示不符。故此处**不做任何回退**。
 *   3. 两个端点都必须带 `Origin: https://developer.amd.com.cn`，否则 403。
 *
 * @module dsh-amd-model-load/catalog
 */

/**
 * AMD 官方 5 个分类的**展示顺序**（用户明确要求按这个顺序分组）。
 * 字符串取自上游 `capability_label` 原文，不翻译、不改写 —— 用户要求「直接按它的来」。
 */
export const CATEGORY_ORDER = [
  'VLM (Vision)',
  'LLM (Text)',
  'Decision (Classifier)',
  'TTS (Speech)',
  'OCR (Document)',
]

/** 未知 / 缺失分类的归属组名。永远排在最末。 */
export const OTHER_LABEL = '其他'

/** `capability_key` → 官方 `capability_label` 的兜底映射（仅在 label 缺失时用）。 */
export const CAPABILITY_LABELS = {
  vision: 'VLM (Vision)',
  text: 'LLM (Text)',
  decision: 'Decision (Classifier)',
  speech: 'TTS (Speech)',
  ocr: 'OCR (Document)',
}

/** AMD 站点 origin。目录端点全部要求带这个 Origin 头，否则 403。 */
export const AMD_ORIGIN = 'https://developer.amd.com.cn'

/** bootstrap 端点（POST，带 `?directory=true` 才返回 cards 全量）。回退路径用。 */
export const DEFAULT_BOOTSTRAP_URL = `${AMD_ORIGIN}/radeon/api/tokenfactory/bootstrap?directory=true`

/**
 * 「一次拿全」端点。实测 2026-10-25：HTTP 200 / 58355B / 0.37s，返回 15 条 `shared_models`
 * （每条自带 display_config 与 token_factory，与单查 model 的 `{model:...}` 内部对象同构）。
 *
 * 注意参数名是 `section=dedicated`，但返回的 `section.key` 是 **`public_free`** ——
 * 即「Public Free Model APIs」区的 15 个免费模型。Dedicated 区的 3 个模型（MiniCPM5-2B /
 * MiniCPM-v46 / MiniCPM5-1B 另一套）**不在**这个响应里；按用户裁定只显示这 15 个免费模型。
 */
export const DEFAULT_SHARED_URL = `${AMD_ORIGIN}/radeon/api/tokenfactory/bootstrap?section=dedicated`

/**
 * 内置目录兜底常量（15 条，与 2026-10-25 实测样本逐字段一致）。
 *
 * 存在的理由：目录拉取链路是「bootstrap + 15 个详情」共 16 次请求，任何一次全链路失败
 * （离线、上游改版、403）都不能让设置页变成空白。有兜底至少还能显示分组骨架与负载读数。
 * 它**不是**真值来源：一旦目录拉取成功，立即被真实目录覆盖。
 *
 * @type {ReadonlyArray<{id: string, fullId: string, capabilityKey: string, capabilityLabel: string, badgeLabel: string|null, publisher: string|null, description: string, sortOrder: number}>}
 */
export const FALLBACK_CATALOG = Object.freeze([
  { id: 'MiMo-V2.6-Flash', fullId: 'model_gateway:MiMo-V2.6-Flash', capabilityKey: 'vision', capabilityLabel: 'VLM (Vision)', badgeLabel: 'Free', publisher: 'Radeon Cloud', description: 'MiMo-V2.6-Flash served by the AMD GPU Cloud', sortOrder: 0 },
  { id: 'DeepSeek-V4.1-Flash', fullId: 'model_gateway:DeepSeek-V4.1-Flash', capabilityKey: 'vision', capabilityLabel: 'VLM (Vision)', badgeLabel: 'Free', publisher: 'DeepSeek', description: 'DeepSeek-V4.1-Flash-1017 served by the AMD GPU Cloud', sortOrder: 1 },
  { id: 'DeepSeek-V4-Flash', fullId: 'model_gateway:DeepSeek-V4-Flash', capabilityKey: 'text', capabilityLabel: 'LLM (Text)', badgeLabel: 'Free', publisher: 'DeepSeek', description: 'DeepSeek V4 Flash 0731 served by the AMD GPU Cloud', sortOrder: 2 },
  { id: 'GLM-5.3-Flash', fullId: 'model_gateway:GLM-5.3-Flash', capabilityKey: 'text', capabilityLabel: 'LLM (Text)', badgeLabel: 'Free', publisher: 'Z.ai', description: 'GLM-5.3-Flash served by the AMD GPU Cloud', sortOrder: 3 },
  { id: 'Qwen3.8-Flash-Next', fullId: 'model_gateway:Qwen3.8-Flash-Next', capabilityKey: 'vision', capabilityLabel: 'VLM (Vision)', badgeLabel: 'Free', publisher: 'Qwen', description: 'Qwen3.8-Flash-Next served by the AMD GPU Cloud', sortOrder: 4 },
  { id: 'Qwen3.8-27B', fullId: 'model_gateway:Qwen3.8-27B', capabilityKey: 'vision', capabilityLabel: 'VLM (Vision)', badgeLabel: 'Free', publisher: 'Qwen', description: 'Qwen3.8-27B served by the AMD GPU Cloud', sortOrder: 5 },
  { id: 'Gemma-4-31B-IT', fullId: 'model_gateway:Gemma-4-31B-IT', capabilityKey: 'vision', capabilityLabel: 'VLM (Vision)', badgeLabel: 'Free', publisher: 'Google', description: 'Gemma-4-31B-IT served by the AMD GPU Cloud', sortOrder: 6 },
  { id: 'd3', fullId: 'model_gateway:d3', capabilityKey: 'decision', capabilityLabel: 'Decision (Classifier)', badgeLabel: null, publisher: null, description: "vLLM-SR's 27B decision model: typed questions about text, images or video, answered with probabilities on /v1/systemone.", sortOrder: 7 },
  { id: 'd3-flash', fullId: 'model_gateway:d3-flash', capabilityKey: 'decision', capabilityLabel: 'Decision (Classifier)', badgeLabel: null, publisher: null, description: "vLLM-SR's 9B decision model, faster than d3: typed questions about text, images or video, answered with probabilities.", sortOrder: 8 },
  { id: 'Clef', fullId: 'model_gateway:Clef', capabilityKey: 'decision', capabilityLabel: 'Decision (Classifier)', badgeLabel: null, publisher: null, description: "Cloudflare's 27B decision model: answers typed questions about a situation with probabilities, on /v1/systemone.", sortOrder: 9 },
  { id: 'MiniCPM-V-4.7-35B-A3B', fullId: 'model_gateway:MiniCPM-V-4.7-35B-A3B', capabilityKey: 'vision', capabilityLabel: 'VLM (Vision)', badgeLabel: 'Free', publisher: 'OpenBMB', description: 'MiniCPM-V-4.7-35B-A3B served by the AMD GPU Cloud', sortOrder: 10 },
  { id: 'MiniCPM-V-4.7-1B', fullId: 'model_gateway:MiniCPM-V-4.7-1B', capabilityKey: 'vision', capabilityLabel: 'VLM (Vision)', badgeLabel: 'Free', publisher: 'OpenBMB', description: 'MiniCPM-V-4.7-1B served by the AMD GPU Cloud', sortOrder: 11 },
  { id: 'MiniCPM5-2B', fullId: 'model_gateway:MiniCPM5-2B', capabilityKey: 'text', capabilityLabel: 'LLM (Text)', badgeLabel: 'Free', publisher: 'OpenBMB', description: 'MiniCPM5-2B served by the AMD GPU Cloud', sortOrder: 12 },
  { id: 'OmniVoice', fullId: 'model_gateway:OmniVoice', capabilityKey: 'speech', capabilityLabel: 'TTS (Speech)', badgeLabel: 'Free', publisher: 'Radeon Cloud', description: 'Multilingual text-to-speech on /v1/audio/speech, with preset, described or cloned voices. Non-commercial use only.', sortOrder: 13 },
  { id: 'MinerU2.5-Pro', fullId: 'model_gateway:MinerU2.5-Pro', capabilityKey: 'ocr', capabilityLabel: 'OCR (Document)', badgeLabel: 'Free', publisher: 'Radeon Cloud', description: 'MinerU2.5-Pro served by the AMD GPU Cloud', sortOrder: 14 },
])

//#region 小工具
/** 非空字符串才算有效值（上游大量字段是 null 或 ""）。 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 有限数字才算有效值。 */
function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 浅判「对象字典」（排除 null / 数组）。 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 从目录条目里取一个字段，**同时接受 camelCase 与上游的 snake_case**。
 *
 * 为什么两种都收：本模块的条目来源有两个 —— `parseModelDetail()`（camelCase，本模块
 * 自己的规范形状），以及 `test/fixtures/catalog.json`（上游字段原样落盘的 snake_case
 * 样本）。让 `groupAndSort` 对两者都成立，测试就能直接用真实样本，不必先手工转换。
 *
 * @param {object} entry
 * @param {string} camel - camelCase 键名。
 * @param {string} snake - snake_case 键名。
 * @returns {unknown}
 */
function pick(entry, camel, snake) {
  if (Object.prototype.hasOwnProperty.call(entry, camel)) return entry[camel]
  if (Object.prototype.hasOwnProperty.call(entry, snake)) return entry[snake]
  return undefined
}
//#endregion

//#region 解析
/**
 * 解析 bootstrap 响应。
 *
 * 实测形状（2026-10-25，HTTP 200，2494B，0.18s）：
 * `{section:{key,title,subtitle}, cards:[{key,id,detail_url}]}`
 * 其中 `id` 是带 source 前缀的全 id（`model_gateway:MiMo-V2.6-Flash`）。
 *
 * 单条卡片畸形（非对象 / 无 id）**跳过该条**；`cards` 不是数组或为空 ⇒ 返回 null
 * （空目录等于「本次失败」，交给调用方保留旧目录，而不是把 UI 清空）。
 *
 * @param {unknown} raw - JSON.parse 之后的响应体。
 * @returns {{section: {key: string|null, title: string|null, subtitle: string|null}, cards: Array<{id: string, fullId: string, detailUrl: string|null}>}|null}
 */
export function parseBootstrap(raw) {
  if (!isRecord(raw)) return null
  const cards = raw.cards
  if (!Array.isArray(cards) || cards.length === 0) return null

  const parsed = []
  for (const card of cards) {
    if (!isRecord(card)) continue
    const fullId = text(card.id)
    if (fullId === null) continue
    // "model_gateway:MiMo-V2.6-Flash" → "MiMo-V2.6-Flash"；没有前缀就原样用。
    const cut = fullId.indexOf(':')
    const id = cut >= 0 && cut < fullId.length - 1 ? fullId.slice(cut + 1) : fullId
    parsed.push({ id, fullId, detailUrl: text(card.detail_url) })
  }
  if (parsed.length === 0) return null

  const section = isRecord(raw.section) ? raw.section : {}
  return {
    section: {
      key: text(section.key),
      title: text(section.title),
      subtitle: text(section.subtitle),
    },
    cards: parsed,
  }
}

/**
 * 解析 model 详情响应，抽出展示所需字段。
 *
 * 实测形状：`{model:{id, label, description, sort_order, display_config:{...}, token_factory:{...}}}`
 *
 * ⚠️ 三条被实测证伪的「想当然」：
 *   1. `display_config.badge_label` **只在真有徽章时存在**。d3 / d3-flash / Clef 三个
 *      Decision 模型该字段缺失，但 `token_factory.badge.label` 仍是 "Free" ——
 *      **不能**拿后者做回退，否则会给它们错加 FREE 徽章。
 *   2. `display_config.publisher` 是字符串，而 `token_factory.publisher` 是 `{name,mark}`
 *      对象；两者形状不同，回退时必须分别取。
 *   3. **`id` 必须取「去前缀的全 id」，不能取 `display_config.name`**。实测
 *      `DeepSeek-V4.1-Flash` 的 `display_config.name` 是 `DeepSeek-V4.1-Flash-1017`、
 *      `DeepSeek-V4-Flash` 的是 `DeepSeek-V4-Flash-0731` —— 而 load 端点的 key 是
 *      不带后缀的 `DeepSeek-V4.1-Flash`。用 name 当 id 会让这两个模型永远匹配不到负载，
 *      白白显示成「无负载数据」。`display_config.name` 另存为 `displayName` 备查。
 *
 * @param {unknown} raw - JSON.parse 之后的响应体（允许直接传 model 对象本身）。
 * @returns {{id: string, fullId: string, displayName: string|null, capabilityKey: string|null, capabilityLabel: string, badgeLabel: string|null, publisher: string|null, description: string, sortOrder: number}|null}
 */
export function parseModelDetail(raw) {
  if (!isRecord(raw)) return null
  const model = isRecord(raw.model) ? raw.model : raw
  const fullId = text(model.id)
  if (fullId === null) return null

  const display = isRecord(model.display_config) ? model.display_config : {}
  const factory = isRecord(model.token_factory) ? model.token_factory : {}

  // 规范 id = 去前缀的全 id。理由见上方第 3 条：它才是 load 端点的 key。
  const cut = fullId.indexOf(':')
  const stripped = cut >= 0 && cut < fullId.length - 1 ? fullId.slice(cut + 1) : fullId

  const capabilityKey = text(display.capability_key) ?? (isRecord(factory.capability) ? text(factory.capability.key) : null)
  const capabilityLabel =
    text(display.capability_label) ??
    (isRecord(factory.capability) ? text(factory.capability.label) : null) ??
    (capabilityKey !== null && CAPABILITY_LABELS[capabilityKey] !== undefined ? CAPABILITY_LABELS[capabilityKey] : OTHER_LABEL)

  // 只认 display_config.badge_label —— 见上方注释，不回退到 token_factory.badge。
  const badgeLabel = text(display.badge_label)

  const publisher =
    text(display.publisher) ??
    (isRecord(factory.publisher) ? text(factory.publisher.name) : null) ??
    null

  const description = text(display.description) ?? text(model.description) ?? ''
  const sortOrder = numberOrNull(model.sort_order)

  return {
    id: stripped,
    fullId,
    displayName: text(display.name) ?? text(model.label),
    capabilityKey,
    capabilityLabel,
    badgeLabel,
    publisher,
    description,
    sortOrder: sortOrder === null ? Number.MAX_SAFE_INTEGER : sortOrder,
  }
}

/**
 * 解析「一次拿全」的 bootstrap 响应（`POST bootstrap?section=dedicated`）。
 *
 * 实测形状（2026-10-25，HTTP 200，58355B，0.37s）：
 * `{section:{key,title,subtitle}, shared_models:[<完整 model 对象>, ...]}`
 * 每条 `shared_models` 与 `model?id=` 单查的 `{model:...}` **内部对象同构**，
 * 所以直接复用 `parseModelDetail`。
 *
 * 这是**首选路径**：一次请求拿全 15 条，省掉「先 cards 再 15 次 GET」。
 * `cards` 路径保留为回退（上游若撤掉 `section` 参数仍有路可走）。
 *
 * ⚠️ 该端点返回的是 **Public Free 区**的 15 条（section.key === 'public_free'）。
 * 页面上的 Dedicated Model APIs 是另一个区，不在这个响应里 —— 按用户裁定只显示这 15 个。
 *
 * @param {unknown} raw - JSON.parse 之后的响应体。
 * @returns {{section: {key: string|null, title: string|null, subtitle: string|null}, entries: Array<object>}|null}
 */
export function parseSharedModels(raw) {
  if (!isRecord(raw)) return null
  const shared = raw.shared_models
  if (!Array.isArray(shared) || shared.length === 0) return null

  const entries = []
  const seen = new Set()
  for (const model of shared) {
    const entry = parseModelDetail(model)
    if (entry === null || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  if (entries.length === 0) return null

  entries.sort((a, b) => a.sortOrder - b.sortOrder)

  const section = isRecord(raw.section) ? raw.section : {}
  return {
    section: {
      key: text(section.key),
      title: text(section.title),
      subtitle: text(section.subtitle),
    },
    entries,
  }
}
//#endregion

//#region 分组排序
/**
 * 组内排序比较器。
 *
 * 三层键，全部是**全序**，不依赖 Array#sort 的稳定性：
 *   1. 有可用 utilization 的排在没数据的前面；
 *   2. 有数据的按 utilization **升序**（用户要求「按繁忙程度从低到高」）；
 *   3. 其余一律按 id 字典序（ASCII，`<`/`>` 比较，不受 locale 影响）。
 *
 * 「无负载数据排组末」由第 1 层保证：无论数据条数多少、原始顺序如何，缺数据项
 * 一定全部落在有数据项之后；它们之间再按 id 字典序，因此同一份输入永远得到同一份输出
 * （可重复、可断言，UI 不会在两次轮询之间无谓抖动）。
 *
 * @param {{id: string, utilization: number|null}} a
 * @param {{id: string, utilization: number|null}} b
 * @returns {number}
 */
function compareModels(a, b) {
  const aHas = a.utilization !== null
  const bHas = b.utilization !== null
  if (aHas !== bHas) return aHas ? -1 : 1
  if (aHas && a.utilization !== b.utilization) return a.utilization - b.utilization
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/**
 * 把目录 + 负载快照合成为「按官方 5 分类分组、组内按繁忙度升序」的展示结构。
 *
 * 输出只含**非空组**（空分类不渲染空标题），顺序为 CATEGORY_ORDER，未知分类归
 * `其他` 并永远排最后。目录为空 ⇒ 返回 `[]`（调用方显示空态，而不是崩）。
 *
 * 每项的字段即 client 的渲染契约：
 *   `{id, state, utilization, free, badgeLabel, hasLoad, stale}`
 *
 * @param {ReadonlyArray<object>|null|undefined} catalog - parseModelDetail 的结果数组。
 * @param {Record<string, {state?: string, utilization?: number|null}>|null|undefined} loadModels - 负载快照的 models 字典。
 * @param {{stale?: boolean}} [options] - `stale` 表示整份负载快照是否陈旧（逐项继承）。
 * @returns {Array<{label: string, models: Array<{id: string, state: string, utilization: number|null, free: boolean, badgeLabel: string|null, hasLoad: boolean, stale: boolean}>}>}
 */
export function groupAndSort(catalog, loadModels, options = {}) {
  if (!Array.isArray(catalog) || catalog.length === 0) return []
  const snapshotStale = options !== null && typeof options === 'object' && options.stale === true
  const loads = isRecord(loadModels) ? loadModels : {}

  /** 分类 label → 条目数组。 */
  const buckets = new Map()
  /** 同一 id 只留第一条：避免 React key 重复，也避免上游重复卡片造成重复行。 */
  const seen = new Set()

  for (const entry of catalog) {
    if (!isRecord(entry)) continue
    const id = text(pick(entry, 'id', 'id'))
    if (id === null || seen.has(id)) continue
    seen.add(id)

    const label = text(pick(entry, 'capabilityLabel', 'capability_label')) ?? OTHER_LABEL
    const raw = loads[id]
    const hasLoad = isRecord(raw)
    const utilization = hasLoad ? numberOrNull(raw.utilization) : null
    const state = hasLoad && text(raw.state) !== null ? text(raw.state) : 'unknown'
    const badgeLabel = text(pick(entry, 'badgeLabel', 'badge_label'))

    const item = {
      id,
      state,
      utilization,
      // FREE 徽章只由 badgeLabel 决定；null 的（d3/d3-flash/Clef）就是 false。
      free: badgeLabel !== null,
      badgeLabel,
      hasLoad,
      stale: hasLoad && snapshotStale,
    }

    const bucket = buckets.get(label)
    if (bucket === undefined) buckets.set(label, [item])
    else bucket.push(item)
  }

  /** @type {Array<{label: string, models: object[]}>} */
  const groups = []
  for (const label of CATEGORY_ORDER) {
    const models = buckets.get(label)
    if (models === undefined || models.length === 0) continue
    models.sort(compareModels)
    groups.push({ label, models })
    buckets.delete(label)
  }

  // 剩下的全部是未知分类，合并进「其他」，组内同样按繁忙度升序。
  if (buckets.size > 0) {
    const rest = []
    for (const models of buckets.values()) rest.push(...models)
    rest.sort(compareModels)
    groups.push({ label: OTHER_LABEL, models: rest })
  }

  return groups
}
//#endregion

//#region 目录轮询器
/**
 * 创建一个目录轮询器：一次请求拿全目录（失败则回落逐卡 GET），合成目录快照。
 *
 * 不变量（与 load-source 的 createPoller 同纪律）：
 *   - 失败**只写 error**，`entries` / `ts` 保持上一次成功值；`ts` 不前进即自动变陈旧。
 *   - 从没成功过时 `entries === FALLBACK_CATALOG`（克隆）、`ts === null` —— UI 永远有东西可画。
 *   - 单个模型详情失败只**跳过该条**，不让一条脏数据毁掉整份目录；但若**一条都没成功**，
 *     本次刷新按失败处理（保留旧目录）。
 *   - `refresh()` 与轮询共用同一个 in-flight promise；`start()` 幂等；`stop()` 真清 interval。
 *
 * 数据源优先级（`source` 字段如实反映实际走的那条）：
 *   1. `shared` —— 一次拿全（`bootstrap?section=dedicated` 的 `shared_models`），1 次请求；
 *   2. `cards` —— 回退到「bootstrap cards + 逐卡 GET」，1 + N 次请求；
 *   3. `fallback` —— 两条都失败且从没成功过，用内置常量。
 *
 * @param {object} options
 * @param {string} [options.sharedUrl] - 「一次拿全」端点。
 * @param {string} [options.bootstrapUrl] - 回退用的 cards 端点。
 * @param {string} [options.origin] - 请求必须携带的 Origin 头；缺省从 sharedUrl 推导。
 * @param {number} [options.timeoutMs=20000] - 单次请求超时。
 * @param {number} [options.pollMs=21600000] - 轮询间隔（默认 6 小时）；<= 0 只手动 refresh。
 * @param {number} [options.concurrency=6] - 详情请求并发上限（仅回退路径用）。
 * @param {Function} [options.fetchImpl] - 注入用（单测传假实现）。
 * @param {() => number} [options.now] - 注入时钟。
 * @param {ReadonlyArray<object>} [options.fallback] - 首次失败时的兜底目录。
 * @param {(snapshot: object) => void} [options.onUpdate]
 * @param {(error: Error, snapshot: object) => void} [options.onError]
 * @param {(error: Error) => void} [options.onFallback] - 首选路径失败、正在回落时回调。
 * @returns {{start: () => void, stop: () => void, snapshot: () => object, refresh: () => Promise<object>}}
 */
export function createCatalogSource(options = {}) {
  const {
    sharedUrl = DEFAULT_SHARED_URL,
    bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
    timeoutMs = 20_000,
    pollMs = 21_600_000,
    concurrency = 6,
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    fallback = FALLBACK_CATALOG,
    onUpdate,
    onError,
    onFallback,
  } = options

  /** Origin 必须与端点同源；实测少这个头直接 403。 */
  const origin = (() => {
    const explicit = text(options.origin)
    if (explicit !== null) return explicit
    try {
      return new URL(sharedUrl).origin
    } catch {
      return AMD_ORIGIN
    }
  })()

  /** 兜底目录的独立副本：调用方改到它不能污染常量。 */
  function cloneFallback() {
    return Array.isArray(fallback) ? fallback.map((entry) => ({ ...entry })) : []
  }

  let state = { ts: null, entries: cloneFallback(), error: null, source: 'fallback' }
  let timer = null
  let inFlight = null
  let stopped = false

  function snapshot() {
    return {
      ts: state.ts,
      entries: state.entries.map((entry) => ({ ...entry })),
      error: state.error,
      source: state.source,
    }
  }

  function emit(callback, ...args) {
    if (typeof callback !== 'function') return
    try {
      callback(...args)
    } catch {
      /* 回调自身的错误与轮询无关。 */
    }
  }

  function describe(error) {
    if (error instanceof Error) return error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
    return String(error)
  }

  /** 发一次带 Origin 的请求并解析 JSON。 */
  async function requestJson(url, init) {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: 'application/json',
        origin,
        ...(init !== undefined && init.headers !== undefined ? init.headers : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response === null || typeof response !== 'object') throw new Error('fetch 未返回响应对象')
    if (response.ok === false) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }

  /** 并发受限的 map；单项失败返回 null（由调用方跳过）。 */
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length)
    let cursor = 0
    const width = Math.max(1, Math.min(limit, items.length))
    const workers = Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        try {
          results[index] = await fn(items[index], index)
        } catch {
          results[index] = null
        }
      }
    })
    await Promise.all(workers)
    return results
  }

  /** 详情 URL：优先用 bootstrap 给的 detail_url（相对路径），否则按 id 拼。 */
  function detailUrlFor(card) {
    const raw = text(card.detailUrl)
    if (raw !== null) {
      try {
        return new URL(raw, `${origin}/`).toString()
      } catch {
        /* 落到下面的兜底拼装 */
      }
    }
    return `${origin}/radeon/api/tokenfactory/model?id=${encodeURIComponent(card.fullId ?? card.id)}`
  }

  /**
   * 首选路径：一次请求拿全（`bootstrap?section=dedicated` → `shared_models`）。
   * 实测 58KB / 0.37s，比「cards + 15 次 GET」少 14 次往返。
   * 失败（网络 / 上游撤掉 section 参数 / 形状变了）返回 null，由调用方回退。
   */
  async function fetchSharedModels() {
    const raw = await requestJson(sharedUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    const parsed = parseSharedModels(raw)
    return parsed === null ? null : parsed.entries
  }

  /**
   * 回退路径：先拿 cards 列表，再并发逐个 GET 详情。
   * 仅在首选路径失败时走；单条失败只跳过该条。
   */
  async function fetchPerCard() {
    const bootstrapRaw = await requestJson(bootstrapUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    const bootstrap = parseBootstrap(bootstrapRaw)
    if (bootstrap === null) throw new Error('bootstrap 响应形状不符（cards 缺失或为空）')

    const details = await mapLimit(bootstrap.cards, concurrency, async (card) => {
      const raw = await requestJson(detailUrlFor(card), { method: 'GET' })
      return parseModelDetail(raw)
    })
    const entries = details.filter((entry) => entry !== null && entry !== undefined)
    if (entries.length === 0) throw new Error('全部模型详情解析失败')
    return entries
  }

  async function refreshOnce() {
    try {
      // 两级数据源：一次拿全优先，逐卡 GET 兜底。两级都失败才保留旧目录。
      let entries = null
      let source = 'shared'
      try {
        entries = await fetchSharedModels()
      } catch (error) {
        emit(onFallback, error instanceof Error ? error : new Error(describe(error)))
        entries = null
      }
      if (entries === null) {
        entries = await fetchPerCard()
        source = 'cards'
      }

      // 上游 sort_order 决定同繁忙度时的次序，这里先按它排一遍，保持与网页一致的观感。
      entries.sort((a, b) => a.sortOrder - b.sortOrder)

      state = { ts: now(), entries, error: null, source }
      const current = snapshot()
      emit(onUpdate, current)
      return current
    } catch (error) {
      // 关键：entries/ts 原样保留；从没成功过时 entries 仍是 fallback 副本。
      state = { ...state, error: describe(error) }
      const current = snapshot()
      emit(onError, error instanceof Error ? error : new Error(describe(error)), current)
      return current
    }
  }

  function refresh() {
    if (inFlight !== null) return inFlight
    inFlight = refreshOnce().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  function start() {
    if (stopped || timer !== null) return
    void refresh()
    if (typeof pollMs === 'number' && Number.isFinite(pollMs) && pollMs > 0) {
      timer = setInterval(() => {
        void refresh()
      }, pollMs)
      if (typeof timer?.unref === 'function') timer.unref()
    }
  }

  function stop() {
    stopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return { start, stop, snapshot, refresh }
}
//#endregion
