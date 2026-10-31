/**
 * dsh-amd-model-load — 负载数据源（纯 JS，零依赖，可裸跑单测）。
 *
 * 本模块**不 import 任何包**（包括 @deepseek-ai/schemastery），
 * 这样 `node --input-type=module -e "import('./lib/load-source.js')"` 就能直接测，
 * 不需要工作区有 node_modules（宿主靠 host-module-fallback 兜底，但单测不该依赖它）。
 *
 * 三条被 PLAN.md 固化的设计约束，全部落在本文件：
 *   1. AMD load 端点响应 ~26 秒 ⇒ 拉取只发生在 host 侧后台轮询，浏览器半身永远只读内存快照。
 *   2. 失败**必须保留旧数据**并标 stale，绝不把 snapshot 清空 —— 清空会让 UI 从「有数」跳到
 *      「无数据」，用户会误判成「所有模型都空闲」。
 *   3. 上游返回的模型集合与本机 amd provider 的模型集合不一致是常态 ⇒ normalize 只做形状规整，
 *      不做任何取舍/过滤；「显不显示」是展示层（client.js）的决定。
 *
 * @module dsh-amd-model-load/load-source
 */

/** 上游可能给出的状态值。其余一律归为 'unknown'，不猜。 */
const KNOWN_STATES = new Set(['idle', 'busy', 'full'])

/** 上游缺省 scope 时的回退值（实测端点返回 "fleet"）。 */
const DEFAULT_SCOPE = 'fleet'

/**
 * 规整单个模型的 utilization：接受有限数字或数字字符串，夹到 0–100；其余返回 null。
 *
 * @param {unknown} raw - 上游原始值。
 * @returns {number|null} 百分比；无法解释时为 null。
 */
function normalizeUtilization(raw) {
  let value
  if (typeof raw === 'number') value = raw
  else if (typeof raw === 'string' && raw.trim() !== '') value = Number(raw)
  else return null
  if (!Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

/**
 * 规整单个模型的状态：只认 idle/busy/full，大小写与空白容忍；其余归 'unknown'。
 *
 * @param {unknown} raw - 上游原始值。
 * @returns {'idle'|'busy'|'full'|'unknown'}
 */
function normalizeState(raw) {
  if (typeof raw !== 'string') return 'unknown'
  const value = raw.trim().toLowerCase()
  return KNOWN_STATES.has(value) ? value : 'unknown'
}

/**
 * 把 AMD load 端点的响应规整成内部快照形状。
 *
 * 畸形输入返回 null 而不是抛：轮询路径上的异常会被当成「本次失败」处理（保留旧数据），
 * 而抛异常会让调用栈里多一条无法归因的错误。
 *
 * 单条模型畸形（null / 非对象）**跳过该条**，不让一条脏数据毁掉整份快照。
 * 顶层 models 为空对象视为合法（返回 `{models:{}, scope}`），由展示层显示「无负载数据」。
 *
 * ⚠️ 实测（2026-10-25 17:20 真实样本）：上游的 `label` **不是模型名**，而是状态文案
 * —— "Idle" / "Busy" / "At capacity"。所以它**不能**当展示用的模型显示名。
 * 这里保留原值（不丢弃、不改写），但展示层应当用模型 id；`label` 只在缺失时回退成 id。
 * M3 若要做友好名，必须另建本地 id→名称映射，不能指望这个字段。
 *
 * @param {unknown} raw - JSON.parse 之后的响应体。
 * @returns {{models: Record<string, {state: string, label: string, utilization: number|null}>, scope: string}|null}
 */
export function normalizeLoad(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const models = raw.models
  if (models === null || typeof models !== 'object' || Array.isArray(models)) return null

  /** @type {Record<string, {state: string, label: string, utilization: number|null}>} */
  const normalized = {}
  for (const [id, entry] of Object.entries(models)) {
    if (typeof id !== 'string' || id === '') continue
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label : id
    normalized[id] = {
      state: normalizeState(entry.state),
      label,
      utilization: normalizeUtilization(entry.utilization),
    }
  }

  const scope = typeof raw.scope === 'string' && raw.scope !== '' ? raw.scope : DEFAULT_SCOPE
  return { models: normalized, scope }
}

/**
 * 判断快照是否已过期。
 *
 * 边界约定（单测覆盖）：
 *   - 无快照 / ts 不是有限数字 ⇒ true（没有数据就等于「不可信」）；
 *   - age > maxAgeMs ⇒ true；age === maxAgeMs ⇒ false（恰好到点不算过期，用 `>` 而非 `>=`）；
 *   - age < 0（系统时钟回拨）⇒ false，不把未来时间当成过期；
 *   - maxAgeMs 非有限数字 ⇒ 视为不过期（false），避免配置写错就把全部数据标陈旧。
 *
 * @param {{ts?: unknown}|null|undefined} snapshot - 快照。
 * @param {number} now - 当前毫秒时间戳。
 * @param {number} maxAgeMs - 允许的最大年龄（毫秒）。
 * @returns {boolean}
 */
export function isStale(snapshot, now, maxAgeMs) {
  if (snapshot === null || typeof snapshot !== 'object') return true
  const ts = snapshot.ts
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return true
  if (typeof now !== 'number' || !Number.isFinite(now)) return true
  if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs)) return false
  const age = now - ts
  if (age < 0) return false
  return age > maxAgeMs
}

/**
 * 创建一个后台轮询器：定时拉取 AMD load 端点，把结果留在内存里。
 *
 * 不变量：
 *   - 失败**只写 error**，`models` / `ts` / `scope` 保持上一次成功值（`ts` 不前进 ⇒ 自动变 stale）。
 *   - 从没成功过时 `ts === null`、`models === {}`、`error` 是最近一次失败原因。
 *   - `stop()` 必须真的清掉 interval；`start()` 幂等。
 *   - `refresh()` 与轮询共用同一个 in-flight promise，不会并发拉两次。
 *
 * @param {object} options
 * @param {string} options.url - load 端点。
 * @param {number} [options.timeoutMs=40000] - 单次请求超时；实测响应 ~26s，故默认 40s。
 * @param {number} [options.pollMs=300000] - 轮询间隔；<= 0 表示只手动 refresh。
 * @param {Function} [options.fetchImpl] - 注入用（单测传假实现）；缺省用全局 fetch。
 * @param {() => number} [options.now] - 注入时钟（单测用）。
 * @param {(snapshot: object) => void} [options.onUpdate] - 成功回调。
 * @param {(error: Error, snapshot: object) => void} [options.onError] - 失败回调。
 * @returns {{start: () => void, stop: () => void, snapshot: () => object, refresh: () => Promise<object>}}
 */
export function createPoller(options = {}) {
  const {
    url,
    timeoutMs = 40_000,
    pollMs = 300_000,
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    onUpdate,
    onError,
  } = options

  /** 内部状态：ts 只在成功时前进，所以「失败保留旧数据」是结构上成立的，不靠额外分支。 */
  let state = { ts: null, models: {}, scope: null, error: null }
  let timer = null
  let inFlight = null
  let stopped = false

  /** 返回一份浅拷贝，避免调用方改到内部状态。 */
  function snapshot() {
    /** @type {Record<string, object>} */
    const models = {}
    for (const [id, entry] of Object.entries(state.models)) models[id] = { ...entry }
    return { ts: state.ts, models, scope: state.scope, error: state.error }
  }

  /** 安全调用外部回调：回调抛错不能打断轮询。 */
  function emit(callback, ...args) {
    if (typeof callback !== 'function') return
    try {
      callback(...args)
    } catch {
      /* 回调自身的错误与轮询无关，忽略。 */
    }
  }

  /** 把任意异常压成一行可读文本，用于 error 字段。 */
  function describe(error) {
    if (error instanceof Error) return error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
    return String(error)
  }

  /** 真正发一次请求。成功推进 ts；失败只写 error。 */
  async function loadOnce() {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response === null || typeof response !== 'object') throw new Error('fetch 未返回响应对象')
      if (response.ok === false) throw new Error(`HTTP ${response.status}`)
      const raw = await response.json()
      const normalized = normalizeLoad(raw)
      if (normalized === null) throw new Error('响应形状不符合 load 契约（models 缺失或非对象）')
      state = { ts: now(), models: normalized.models, scope: normalized.scope, error: null }
      const current = snapshot()
      emit(onUpdate, current)
      return current
    } catch (error) {
      // 关键：只覆盖 error，models/ts/scope 原样保留。
      state = { ...state, error: describe(error) }
      const current = snapshot()
      emit(onError, error instanceof Error ? error : new Error(describe(error)), current)
      return current
    }
  }

  /** 共用同一个 in-flight promise：轮询 tick 与手动 refresh 不会并发拉。 */
  function refresh() {
    if (inFlight !== null) return inFlight
    inFlight = loadOnce().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  function start() {
    if (stopped || timer !== null) return
    // 启动立即拉一次，不等第一个 interval —— 否则设置页开局 5 分钟内没有任何数据。
    void refresh()
    if (typeof pollMs === 'number' && Number.isFinite(pollMs) && pollMs > 0) {
      timer = setInterval(() => {
        void refresh()
      }, pollMs)
      // interval 不应该成为宿主退出时的阻塞源；有其它服务时它照样在跑。
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
