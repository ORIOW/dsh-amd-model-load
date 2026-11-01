/**
 * dsh-amd-model-load — client 半身冒烟测试（在 node 里伪造浏览器环境）。
 *
 * 验的是「信封能被加载、两个 slot 注册形状对、设置卡按 5 分类分组渲染、FREE 徽章只给有 badge
 * 的模型、模型选择行徽章只在 option+amd 时出现、模型名在任何分支都可见、
 * 两个挂载点共用同一个快照订阅器」。
 * 不验真实 DOM —— 真实渲染必须目视 GUI（见 M4-REPORT.md 的待验项）。
 *
 * 手法：造一个 `window.__ModuleLoader__`，把 lib/client.js 当脚本 eval 进 vm，
 * 用一个**微型 React 渲染器**（hooks + 函数组件展开 + 异步 effect + 重渲染）驱动组件，
 * 再对拍平后的文本/元素树做断言。这样 store.subscribe → setState → 重渲染这条真实路径也被覆盖。
 *
 * M4 的边界分工（刻意）：
 *   - **分组与排序在 host 算**（lib/catalog.js 有 50 个用例覆盖），client 只按序渲染。
 *     所以设置卡的断言是「host 给的顺序被原样保留」，而不是「client 自己排对了」。
 *   - **模型选择行徽章**只做两件事：按 `model.id` 在 catalog 里查负载（跨组线性查找），
 *     以及**在所有分支都渲染 model.name**（因为宿主 fallback 只在无贡献者时生效）。
 *   - **共享订阅器**：断言「全插件只有一个 timer」「两个订阅者拿到同一个对象」。
 *
 * 跑法：`node test/client.test.mjs`（client 不 import 任何包，不需要 schemastery 桩）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

//#region 微型 React
/**
 * 造一份微型 React。hooks 按调用顺序存在 `slots` 数组里（真实 React 也是这个模型），
 * `render` 每次重置索引；effect 只在首次渲染后执行，state 变化触发重渲染。
 */
function createMiniReact() {
  /** @type {any[]} */
  const slots = []
  let cursor = 0
  /** @type {Array<() => (() => void)|void>} */
  let pendingEffects = []
  /** @type {Array<() => void>} */
  let cleanups = []

  const React = {
    createElement(type, props, ...children) {
      return { __el: true, type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(slots[index]) : next
        if (Object.is(value, slots[index])) return
        slots[index] = value
        rerenderRequested = true
      }
      return [slots[index], set]
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      // 与真实 React 一致：**没有依赖数组 ⇒ 每次提交都跑**；有数组则浅比较。
      // P3 把渲染计数挪到「无依赖 effect」之后，微型渲染器必须支持这条语义，
      // 否则「5000 次渲染只产生少量上报」这类用例根本测不出来。
      const depsKey = Array.isArray(deps) ? deps : null
      const previous = slots[index]
      const first = previous === undefined
      const changed =
        first ||
        depsKey === null ||
        !Array.isArray(previous.deps) ||
        previous.deps.length !== depsKey.length ||
        depsKey.some((value, i) => !Object.is(value, previous.deps[i]))
      if (changed) {
        slots[index] = { deps: depsKey }
        pendingEffects.push(fn)
      }
    },
  }

  let rerenderRequested = false
  let tree = null

  /** 渲染一次并跑完 effect + 微任务，必要时重渲染，直到稳定。 */
  async function render(Component, props, maxPasses = 6) {
    let pass = 0
    do {
      rerenderRequested = false
      cursor = 0
      pendingEffects = []
      tree = Component(props)
      for (const effect of pendingEffects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      // 放行 effect 里的 promise（store.subscribe → pull → setSnapshot）
      await new Promise((resolve) => setImmediate(resolve))
      pass += 1
    } while (rerenderRequested && pass < maxPasses)
    return tree
  }

  function unmount() {
    for (const cleanup of cleanups) cleanup()
    cleanups = []
  }

  /**
   * 清空 hook 状态。**每次新 mount 必须调用**：真实 React 的 hook 槽位挂在组件实例上，
   * 而本微型渲染器只有一份全局槽位数组。不 reset 的话，第二次 mount 会命中
   * `index in slots` 而跳过 useEffect，effect 永不执行 —— 表现为「永远没数据」。
   */
  function reset() {
    unmount()
    slots.length = 0
    cursor = 0
    pendingEffects = []
    rerenderRequested = false
    tree = null
  }

  return { React, render, unmount, reset }
}

/** 展开元素树：函数组件被调用展开，得到纯 host 元素树。 */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap(expand)
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (typeof node !== 'object' || !node.__el) return []
  if (typeof node.type === 'function') {
    // 函数组件：直接调用（props 含 key 也无妨）
    return expand(node.type(node.props))
  }
  return node.children.flatMap(expand)
}

/** 拍平成文本。 */
function textOf(node) {
  return expand(node).join('')
}

/** 收集所有 host 元素（用于断言 style 等）。 */
function collect(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (typeof node !== 'object' || !node.__el) return out
  if (typeof node.type === 'function') {
    collect(node.type(node.props), out)
    return out
  }
  out.push(node)
  collect(node.children, out)
  return out
}
//#endregion

/** 加载 client.js，返回插件 exports + 定时器计数。 */
function loadPlugin() {
  let captured = null
  const mini = createMiniReact()
  /** 记录 setInterval / clearInterval 调用次数 —— 用于断言「全插件只有一个 timer」。 */
  const timers = { created: 0, cleared: 0 }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          captured = spec
        },
      },
    },
    setInterval: () => {
      timers.created += 1
      return { unref() {} }
    },
    clearInterval: () => {
      timers.cleared += 1
    },
    setImmediate,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Date,
    JSON,
    Error,
    Math,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured !== null, 'client.js 应调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-amd-model-load')
  const plugin = captured.factory((id) => {
    assert.equal(id, 'react', 'client 只应 require react')
    return mini.React
  })
  return { plugin, mini, timers }
}

const { plugin, mini, timers } = loadPlugin()

/**
 * 装配并拿到**两个**注册项。
 *
 * 每个 slot 名都被记录，测试据此断言注册进的是正确的 slot。
 * 每次 mount 前 reset 微型渲染器的 hook 槽位。
 */
function mount(plugin, rpc, options = {}) {
  mini.reset()
  const registered = []
  const slotsInjected = []
  const ctx = {
    connection: rpc === undefined ? undefined : { rpc },
    slots: {
      inject(name, cb) {
        slotsInjected.push(name)
        cb()
      },
      register(spec, Component) {
        if (options.failRegisterFor === spec.name) {
          throw new Error(`single slot "${spec.name}" already has a registration at priority ${spec.priority ?? 0} — register at a different priority to shadow it (lowest renders)`)
        }
        // 与宿主同语义：single slot 同 priority 只能有一个占位者。
        // 同 priority 的第二条注册必须抛错（与宿主一致）。
        const conflict = registered.some(
          (entry) => entry.spec.name === spec.name && (entry.spec.priority ?? 0) === (spec.priority ?? 0),
        )
        if (conflict) {
          throw new Error(
            `single slot "${spec.name}" already has a registration at priority ${spec.priority ?? 0} (registered by ${spec.id ?? '(匿名)'}) — register at a different priority to shadow it (lowest renders)`,
          )
        }
        const entry = { spec, Component }
        registered.push(entry)
        // 返回真 disposer：探针注册成功后立刻撤销，不会污染「只应有两个注册项」。
        return () => {
          const index = registered.indexOf(entry)
          if (index !== -1) registered.splice(index, 1)
        }
      },
      // 与宿主同语义的只读视图：entries = 原始条目表（含被 shadow 的），
      // entriesOfSlot = 每个 cell 的 winner（single 只有一个 cell ⇒ 只给 priority 最小的那条）。
      // 形状必须与宿主一致：条目对外暴露的是 `options`（即 register 的 spec），
      // 不是 `spec` —— 与宿主保持同形状，避免用例依赖到错误的对象结构。
      entries(name) {
        return registered.filter((entry) => entry.spec.name === name).map((entry) => ({ options: entry.spec }))
      },
      entriesOfSlot(name) {
        const list = registered
          .filter((entry) => entry.spec.name === name)
          .sort((a, b) => (a.spec.priority ?? 0) - (b.spec.priority ?? 0))
        return list.length === 0 ? [] : [{ options: list[0].spec }]
      },
    },
  }
  plugin.apply(ctx)
  const bySlot = (name) => registered.find((entry) => entry.spec.name === name)
  return {
    registered,
    slotsInjected,
    bySlot,
    settings: bySlot('settings.section'),
    modelRow: bySlot('conversation.input.model.label'),
  }
}

/** 只取设置卡的注册项（M3 的 29 个用例全用它）。 */
function mountCard(plugin, rpc) {
  return mount(plugin, rpc).settings
}

/**
 * 造一份 host 侧的 catalog RPC 返回值。
 *
 * 形状与 lib/index.js 的 catalogPayload() 一致：分组已在 host 排好序，
 * 每项含 {id, state, utilization, free, badgeLabel, hasLoad, stale}。
 */
function catalogValue(overrides = {}) {
  return {
    ts: Date.now(),
    source: 'shared',
    error: null,
    stale: false,
    loadTs: new Date(2026, 9, 25, 17, 20, 0).getTime(),
    loadStale: false,
    // 与真实 host 输出同形：15 个模型、5 组、组内已按繁忙度升序、无数据项在组末。
    groups: [
      {
        label: 'VLM (Vision)',
        models: [
          { id: 'MiniCPM-V-4.7-35B-A3B', state: 'idle', utilization: 3.7, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
          { id: 'Gemma-4-31B-IT', state: 'idle', utilization: 18, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
          { id: 'Qwen3.8-27B', state: 'idle', utilization: 20.1, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
          { id: 'Qwen3.8-Flash-Next', state: 'busy', utilization: 69.5, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
          { id: 'DeepSeek-V4.1-Flash', state: 'full', utilization: 100, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
          { id: 'MiMo-V2.6-Flash', state: 'full', utilization: 100, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
          { id: 'MiniCPM-V-4.7-1B', state: 'unknown', utilization: null, free: true, badgeLabel: 'Free', hasLoad: false, stale: false },
        ],
      },
      {
        label: 'LLM (Text)',
        models: [
          { id: 'MiniCPM5-2B', state: 'idle', utilization: 6.2, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
          { id: 'DeepSeek-V4-Flash', state: 'busy', utilization: 78.9, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
          { id: 'GLM-5.3-Flash', state: 'full', utilization: 100, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
        ],
      },
      {
        label: 'Decision (Classifier)',
        models: [
          { id: 'Clef', state: 'idle', utilization: 0.8, free: false, badgeLabel: null, hasLoad: true, stale: false },
          { id: 'd3', state: 'unknown', utilization: null, free: false, badgeLabel: null, hasLoad: false, stale: false },
          { id: 'd3-flash', state: 'unknown', utilization: null, free: false, badgeLabel: null, hasLoad: false, stale: false },
        ],
      },
      {
        label: 'TTS (Speech)',
        models: [
          { id: 'OmniVoice', state: 'unknown', utilization: null, free: true, badgeLabel: 'Free', hasLoad: false, stale: false },
        ],
      },
      {
        label: 'OCR (Document)',
        models: [
          { id: 'MinerU2.5-Pro', state: 'unknown', utilization: null, free: true, badgeLabel: 'Free', hasLoad: false, stale: false },
        ],
      },
    ],
    ...overrides,
  }
}

/** 渲染一次设置卡，返回 { text, nodes }。 */
async function renderCard(plugin, mini, rpcResult) {
  const { spec, Component } = mountCard(plugin, { call: async () => rpcResult })
  const tree = await mini.render(Component, spec.inject())
  const result = { text: textOf(tree), nodes: collect(tree) }
  mini.unmount()
  return result
}

/**
 * 渲染一次模型选择行徽章，返回 { text, nodes, tree }。
 *
 * 默认 props 是「AMD + option」——最常见的场景。需要测其他分支时传 `props`。
 */
async function renderModelRow(plugin, mini, rpcResult, props = {}) {
  const mounted = mount(plugin, { call: async () => rpcResult })
  const merged = {
    provider: { id: 'amd', name: 'AMD' },
    model: { id: 'Qwen3.8-27B', name: 'Qwen3.8-27B' },
    placement: 'option',
    selected: false,
    ...props,
    ...mounted.modelRow.spec.inject(),
  }
  const tree = await mini.render(mounted.modelRow.Component, merged)
  const result = { text: textOf(tree), nodes: collect(tree), tree }
  mini.unmount()
  return result
}

/** 取出所有 FREE 徽章元素（用配色特征识别，不依赖 class）。 */
function freeBadges(nodes) {
  return nodes.filter(
    (n) =>
      n.type === 'span' &&
      n.props.style &&
      n.props.style.color === '#5b3fd6' &&
      n.props.style.background === '#efeafe',
  )
}

/** 取出所有状态点（圆形 span）。 */
function statusDots(nodes) {
  return nodes.filter((n) => n.type === 'span' && n.props.style && n.props.style.borderRadius === '50%')
}

//#region 信封与注册
console.log('# 信封与注册')

await test('信封 id 与 name 正确', () => {
  assert.equal(plugin.name, 'dsh-amd-model-load')
})

await test('inject 扩为 ["slots","connection"]', () => {
  // vm 里的数组来自另一个 realm，deepEqual 会因原型不同失败 ⇒ 比对内容
  assert.equal(Array.from(plugin.inject).join(','), 'slots,connection')
})

await test('apply 注册进 settings.section，带 id/order/label/inject', () => {
  const mounted = mount(plugin, { call: async () => ({ ok: true, value: null }) })
  assert.ok(mounted.slotsInjected.includes('settings.section'))
  const { spec, Component } = mounted.settings
  assert.equal(spec.name, 'settings.section')
  assert.equal(spec.id, 'dsh-amd-model-load')
  assert.equal(spec.order, 60)
  assert.equal(typeof spec.label, 'function')
  assert.equal(spec.label(), 'AMD 模型负载')
  assert.ok(spec.inject().store !== undefined, 'inject 应提供共享 store')
  assert.equal(typeof Component, 'function')
})

await test('apply 同时注册进 conversation.input.model.label，id 与设置卡不同', () => {
  const mounted = mount(plugin, { call: async () => ({ ok: true, value: null }) })
  assert.ok(
    mounted.slotsInjected.includes('conversation.input.model.label'),
    `应注入 conversation.input.model.label，实际：${mounted.slotsInjected.join(',')}`,
  )
  const { spec, Component } = mounted.modelRow
  assert.equal(spec.name, 'conversation.input.model.label')
  assert.equal(spec.id, 'dsh-amd-model-load.modelrow')
  assert.notEqual(spec.id, 'dsh-amd-model-load', '两个 slot 的 id 不能相同')
  assert.equal(typeof Component, 'function')
})

/**
 * 回归：`priority` 必须存在且为负数。
 *
 * 这是 M4 首轮真机完全失效的根因，必须锁住：
 *
 * 宿主内置插件 `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`
 * 已经注册了同一个 `conversation.input.model.label`，**没传 priority**（默认 0）。
 * 而 slots 核心对 `kind:"single"` 的处理是：
 *
 *   const priority = options.priority ?? 0;
 *   const occupant = rec.entries.find((e) => (e.options.priority ?? 0) === priority);
 *   if (occupant) throw new Error(`single slot "..." already has a registration at priority ${priority}
 *                                 — register at a different priority to shadow it (lowest renders)`);
 *
 * 即**同 priority 再注册直接抛错**，我们的条目连进都进不去。更糟的是这个错误
 * 发生在 `slots.inject` 的回调里，不写 harness.log、不弹 UI —— 表现为「模型名正常
 * 显示（内置组件渲染的）、徽章永远不出现」，与 M4 首轮真机的现象完全一致。
 *
 * 修法：priority 取 **-1**。核心注释明确写了 `lowest renders`（priority 最小者渲染），
 * 所以 -1 排在内置的 0 之前，成为 entriesOfSlot()[0] 即真正的渲染者。
 *
 * 这条断言防「有人把 priority 删掉或改成 0」——那会让功能静默失效且没有任何报错。
 */
await test('**模型行注册必须带负数 priority**（否则被内置 1017 插件占用而静默失效）', () => {
  const mounted = mount(plugin, { call: async () => ({ ok: true, value: null }) })
  const { spec } = mounted.modelRow

  assert.ok(
    Object.prototype.hasOwnProperty.call(spec, 'priority'),
    'spec 必须显式带 priority —— 缺省值 0 会与内置 1017 插件撞车并抛错',
  )
  assert.equal(typeof spec.priority, 'number', `priority 必须是数字，实际：${typeof spec.priority}`)
  assert.ok(
    spec.priority < 0,
    `priority 必须为负数才能 shadow 内置插件（内置是 0，lowest renders），实际：${spec.priority}`,
  )
})

await test('不再注册 conversation.input.right（M2 工具行卡已按用户裁定移除）', () => {
  const mounted = mount(plugin, { call: async () => ({ ok: true, value: null }) })
  assert.ok(
    !mounted.slotsInjected.includes('conversation.input.right'),
    `不应再注入 conversation.input.right，实际：${mounted.slotsInjected.join(',')}`,
  )
  assert.equal(mounted.registered.length, 2, '只应有两个注册项：设置卡 + 模型行徽章')
})

await test('两个 slot 拿到的是**同一个** store 实例（共享订阅器的前提）', () => {
  const mounted = mount(plugin, { call: async () => ({ ok: true, value: null }) })
  const settingsStore = mounted.settings.spec.inject().store
  const modelRowStore = mounted.modelRow.spec.inject().store
  assert.ok(settingsStore !== undefined)
  assert.equal(settingsStore, modelRowStore, '必须是同一个对象，不能各建一个')
})

await test('connection 缺席时 inject().rpc 为 undefined 而不抛', () => {
  // M2 起 inject 交出去的是 store 而不是裸 rpc（组件不该自己拉），
  // 但「connection 缺席」这条边界必须仍然不抛 —— 原用例的意图保留，断言对象随重构调整。
  const { spec } = mountCard(plugin, undefined)
  const injected = spec.inject()
  assert.equal(injected.rpc, undefined, 'rpc 不再直接交给组件')
  assert.ok(injected.store !== undefined, 'store 应始终存在（内部处理 rpc 缺席）')
})

await test('connection 缺席时 store 不崩，快照为空', () => {
  const { spec } = mountCard(plugin, undefined)
  const store = spec.inject().store
  assert.equal(store.getSnapshot().data, null)
  assert.equal(store.getSnapshot().error, null)
})

await test('rpc 为 undefined 时渲染不崩（只有空态）', async () => {
  const { spec, Component } = mountCard(plugin, undefined)
  const tree = await mini.render(Component, spec.inject())
  const text = textOf(tree)
  assert.ok(text.includes('AMD 模型负载'))
  assert.ok(text.includes('目录尚未取到'), '没有目录时应显示空态文案')
  mini.unmount()
})
//#endregion

//#region 拉取契约
console.log('\n# 拉取契约')

await test('挂载时调的是 catalog 端点，不是 load', async () => {
  const calls = []
  const { spec, Component } = mountCard(plugin, {
    call: async (channel, method, payload) => {
      calls.push({ channel, method, payload })
      return { ok: true, value: catalogValue() }
    },
  })
  await mini.render(Component, spec.inject())
  assert.equal(calls.length, 1, '挂载后应只拉 1 次')
  assert.equal(calls[0].channel, '/dsh-amd-model-load', '通道必须与 host 的 CHANNEL 一致')
  assert.equal(calls[0].method, 'catalog', 'M3 只调 catalog（它已内嵌负载读数）')
  // vm 沙箱里的对象原型与主 realm 不同，deepEqual 会失败 ⇒ 比 JSON
  assert.equal(JSON.stringify(calls[0].payload), '{}')
  mini.unmount()
})

await test('卸载时清掉 interval（不泄漏）', async () => {
  let calls = 0
  const { spec, Component } = mountCard(plugin, {
    call: async () => {
      calls += 1
      return { ok: true, value: null }
    },
  })
  await mini.render(Component, spec.inject())
  const after = calls
  mini.unmount()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls, after, '卸载后不应继续拉取')
})

await test('并发拉取只发一次请求（store 共用 in-flight）', async () => {
  let calls = 0
  const { spec } = mountCard(plugin, {
    call: async () => {
      calls += 1
      return { ok: true, value: catalogValue() }
    },
  })
  const store = spec.inject().store
  await Promise.all([store.pull(), store.pull(), store.pull()])
  assert.equal(calls, 1, `并发 3 次应只发 1 个请求，实际 ${calls}`)
  mini.unmount()
  store.stop()
})
//#endregion

//#region 共享订阅器
console.log('\n# 共享订阅器（M2 核心）')

await test('全插件只创建一个 timer（两个订阅者不会各起一个）', async () => {
  const before = timers.created
  const { settings, modelRow } = mount(plugin, { call: async () => ({ ok: true, value: catalogValue() }) })
  const settingsStore = settings.spec.inject().store
  const modelRowStore = modelRow.spec.inject().store

  // 依次挂两张卡（真实 React 里也是先后 mount）
  const seenBySettings = []
  const seenByToolRow = []
  const off1 = settingsStore.subscribe((s) => seenBySettings.push(s))
  const off2 = modelRowStore.subscribe((s) => seenByToolRow.push(s))

  assert.equal(timers.created - before, 1, `两张卡应共用一个 timer，实际创建 ${timers.created - before} 个`)
  assert.ok(seenBySettings.length > 0)
  assert.ok(seenByToolRow.length > 0)

  off1()
  off2()
  mini.unmount()
})

await test('两个订阅者拿到**同一个快照对象**（时间戳必然一致）', async () => {
  const { settings, modelRow } = mount(plugin, { call: async () => ({ ok: true, value: catalogValue() }) })
  const settingsStore = settings.spec.inject().store
  const modelRowStore = modelRow.spec.inject().store

  const got = { settings: null, modelRow: null }
  const off1 = settingsStore.subscribe((s) => {
    got.settings = s
  })
  const off2 = modelRowStore.subscribe((s) => {
    got.modelRow = s
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(got.settings, got.modelRow, '必须是同一个对象引用')
  assert.equal(got.settings.data.loadTs, got.modelRow.data.loadTs, 'loadTs 必须相同')
  off1()
  off2()
  mini.unmount()
})

await test('订阅即刻拿到当前快照（不用等下一个 tick）', () => {
  const { spec } = mountCard(plugin, { call: async () => ({ ok: true, value: catalogValue() }) })
  const store = spec.inject().store
  let received = null
  const off = store.subscribe((s) => {
    received = s
  })
  assert.ok(received !== null, 'subscribe 应同步回调一次')
  assert.equal(typeof received.loaded, 'boolean')
  off()
  mini.unmount()
})

await test('最后一个订阅者退订后停表；再有订阅者则重新启动', () => {
  const before = { created: timers.created, cleared: timers.cleared }
  const { spec } = mountCard(plugin, { call: async () => ({ ok: true, value: catalogValue() }) })
  const store = spec.inject().store

  const off1 = store.subscribe(() => {})
  assert.equal(timers.created - before.created, 1, '首个订阅者启动 timer')
  off1()
  assert.equal(timers.cleared - before.cleared, 1, '最后一个退订时停表')
  assert.equal(store.listenerCount(), 0)

  const off2 = store.subscribe(() => {})
  assert.equal(timers.created - before.created, 2, '再次订阅应重启 timer')
  off2()
  mini.unmount()
})

await test('多个订阅者时退订其一不停表', () => {
  const before = { created: timers.created, cleared: timers.cleared }
  const { spec } = mountCard(plugin, { call: async () => ({ ok: true, value: catalogValue() }) })
  const store = spec.inject().store

  const off1 = store.subscribe(() => {})
  const off2 = store.subscribe(() => {})
  assert.equal(timers.created - before.created, 1, '两个订阅者仍只一个 timer')

  off1()
  assert.equal(timers.cleared - before.cleared, 0, '还有订阅者时不停表')
  assert.equal(store.listenerCount(), 1)

  off2()
  assert.equal(timers.cleared - before.cleared, 1, '最后一个退订才停表')
  mini.unmount()
})

await test('单个 listener 抛错不影响其他 listener', async () => {
  const { spec } = mountCard(plugin, { call: async () => ({ ok: true, value: catalogValue() }) })
  const store = spec.inject().store
  let secondCalled = 0
  const off1 = store.subscribe(() => {
    throw new Error('第一个 listener 炸了')
  })
  const off2 = store.subscribe(() => {
    secondCalled += 1
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(secondCalled > 0, '第二个 listener 仍应被调用')
  off1()
  off2()
  mini.unmount()
})

await test('失败保留旧数据：第二次拉取失败时 data 不变、error 更新', async () => {
  let round = 0
  const { spec } = mountCard(plugin, {
    call: async () => {
      round += 1
      if (round === 1) return { ok: true, value: catalogValue() }
      return { ok: false, error: { code: 'internal', message: 'boom' } }
    },
  })
  const store = spec.inject().store
  await store.pull()
  const first = store.getSnapshot()
  assert.equal(first.error, null)
  assert.ok(first.data !== null)

  await store.pull()
  const second = store.getSnapshot()
  assert.equal(second.data, first.data, 'data 必须保留')
  assert.equal(second.error, 'boom')
  mini.unmount()
  store.stop()
})

await test('rpc 抛异常时保留旧数据并记 error', async () => {
  let round = 0
  const { spec } = mountCard(plugin, {
    call: async () => {
      round += 1
      if (round === 1) return { ok: true, value: catalogValue() }
      throw new Error('network down')
    },
  })
  const store = spec.inject().store
  await store.pull()
  const first = store.getSnapshot()
  await store.pull()
  const second = store.getSnapshot()
  assert.equal(second.data, first.data, 'data 必须保留')
  assert.equal(second.error, 'network down')
  mini.unmount()
  store.stop()
})
//#endregion

//#region 分组渲染
console.log('\n# 分组渲染')

await test('渲染 5 个分组，组标题用 capability_label 原文', async () => {
  const { text } = await renderCard(plugin, mini, { ok: true, value: catalogValue() })
  for (const label of ['VLM (Vision)', 'LLM (Text)', 'Decision (Classifier)', 'TTS (Speech)', 'OCR (Document)']) {
    assert.ok(text.includes(label), `应显示组标题 ${label}`)
  }
  // 组标题必须是原文，不能被翻译成中文
  assert.ok(!text.includes('视觉'), '组标题不应被翻译')
  assert.ok(!text.includes('决策'), '组标题不应被翻译')
})

await test('15 个模型全部渲染', async () => {
  const { text } = await renderCard(plugin, mini, { ok: true, value: catalogValue() })
  const ids = [
    'MiniCPM-V-4.7-35B-A3B', 'Gemma-4-31B-IT', 'Qwen3.8-27B', 'Qwen3.8-Flash-Next',
    'DeepSeek-V4.1-Flash', 'MiMo-V2.6-Flash', 'MiniCPM-V-4.7-1B',
    'MiniCPM5-2B', 'DeepSeek-V4-Flash', 'GLM-5.3-Flash',
    'Clef', 'd3', 'd3-flash',
    'OmniVoice', 'MinerU2.5-Pro',
  ]
  for (const id of ids) assert.ok(text.includes(id), `应渲染 ${id}`)
})

await test('组内顺序原样保留 host 给的顺序（client 不重排）', async () => {
  // 刻意给一个「不是按 utilization 升序」的顺序：client 必须原样渲染
  const value = catalogValue({
    groups: [
      {
        label: 'LLM (Text)',
        models: [
          { id: 'ZZZ-high', state: 'full', utilization: 99, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
          { id: 'AAA-low', state: 'idle', utilization: 1, free: true, badgeLabel: 'Free', hasLoad: true, stale: false },
        ],
      },
    ],
  })
  const { text } = await renderCard(plugin, mini, { ok: true, value })
  assert.ok(
    text.indexOf('ZZZ-high') < text.indexOf('AAA-low'),
    `client 不应重排；实际：${text}`,
  )
})

await test('空分组（models 为空数组）不渲染组标题', async () => {
  const value = catalogValue({
    groups: [
      { label: 'VLM (Vision)', models: [{ id: 'only', state: 'idle', utilization: 1, free: true, badgeLabel: 'Free', hasLoad: true, stale: false }] },
      { label: 'LLM (Text)', models: [] },
    ],
  })
  const { text } = await renderCard(plugin, mini, { ok: true, value })
  assert.ok(text.includes('VLM (Vision)'))
  assert.ok(!text.includes('LLM (Text)'), '空分组不应出空标题')
})

await test('分组标题旁显示模型个数', async () => {
  const { text } = await renderCard(plugin, mini, { ok: true, value: catalogValue() })
  assert.ok(text.includes('7 个'), 'VLM 应有 7 个')
  assert.ok(text.includes('3 个'), 'LLM / Decision 应有 3 个')
})
//#endregion

//#region FREE 徽章
console.log('\n# FREE 徽章')

await test('12 个模型显示 FREE 徽章，3 个 Decision 模型不显示', async () => {
  const { nodes } = await renderCard(plugin, mini, { ok: true, value: catalogValue() })
  const badges = freeBadges(nodes)
  assert.equal(badges.length, 12, `应有 12 个 FREE 徽章，实际 ${badges.length}`)
  for (const badge of badges) assert.equal(textOf(badge), 'FREE')
})

await test('FREE 徽章样式照抄 AMD 的 .ma-badge-free：淡紫底 #efeafe + 深紫字 #5b3fd6', async () => {
  const { nodes } = await renderCard(plugin, mini, { ok: true, value: catalogValue() })
  const badge = freeBadges(nodes)[0]
  assert.ok(badge !== undefined, '应至少有一个徽章')
  assert.equal(badge.props.style.color, '#5b3fd6', '文字色必须取自 .ma-badge-free')
  assert.equal(badge.props.style.background, '#efeafe', '底色必须取自 .ma-badge-free')
})

await test('FREE 徽章其余排版也照抄 .ma-badge：10px / 800 / 0.04em / 大写 / 3px 7px / 4px 圆角', async () => {
  const { nodes } = await renderCard(plugin, mini, { ok: true, value: catalogValue() })
  const style = freeBadges(nodes)[0].props.style
  assert.equal(style.fontSize, '10px')
  assert.equal(style.fontWeight, 800)
  assert.equal(style.letterSpacing, '0.04em')
  assert.equal(style.textTransform, 'uppercase')
  assert.equal(style.padding, '3px 7px')
  assert.equal(style.borderRadius, '4px')
  assert.equal(style.whiteSpace, 'nowrap')
})

await test('d3 / d3-flash / Clef 三个 Decision 模型没有徽章', async () => {
  const value = catalogValue({
    groups: [
      {
        label: 'Decision (Classifier)',
        models: [
          { id: 'Clef', state: 'idle', utilization: 0.8, free: false, badgeLabel: null, hasLoad: true, stale: false },
          { id: 'd3', state: 'unknown', utilization: null, free: false, badgeLabel: null, hasLoad: false, stale: false },
          { id: 'd3-flash', state: 'unknown', utilization: null, free: false, badgeLabel: null, hasLoad: false, stale: false },
        ],
      },
    ],
  })
  const { nodes, text } = await renderCard(plugin, mini, { ok: true, value })
  assert.equal(freeBadges(nodes).length, 0, '三个 Decision 模型都不该有徽章')
  assert.ok(!text.includes('FREE'), `不应出现 FREE 字样；实际：${text}`)
})

await test('free 非布尔 true（脏数据）时不渲染徽章', async () => {
  const value = catalogValue({
    groups: [
      {
        label: 'LLM (Text)',
        models: [
          { id: 'a', state: 'idle', utilization: 1, free: 'yes', badgeLabel: 'Free', hasLoad: true, stale: false },
          { id: 'b', state: 'idle', utilization: 2, free: 1, badgeLabel: 'Free', hasLoad: true, stale: false },
        ],
      },
    ],
  })
  const { nodes } = await renderCard(plugin, mini, { ok: true, value })
  assert.equal(freeBadges(nodes).length, 0, '只认严格的 true')
})
//#endregion

//#region 读数与状态
console.log('\n# 读数与状态')

await test('有数据时显示状态文字、utilization、且带「更新于 HH:MM」', async () => {
  const { text } = await renderCard(plugin, mini, { ok: true, value: catalogValue() })
  assert.ok(text.includes('更新于 17:20'), `应显示「更新于 17:20」，实际：${text}`)
  assert.ok(text.includes('3.7%'), '应显示一位小数 utilization')
  assert.ok(text.includes('100.0%'), '100 应显示成 100.0%')
  assert.ok(text.includes('空闲'), 'idle → 空闲')
  assert.ok(text.includes('繁忙'), 'busy → 繁忙')
  assert.ok(text.includes('满载'), 'full → 满载')
  assert.ok(!text.includes('陈旧'), '新鲜快照不应显示陈旧')
})

await test('无负载数据的行显示「无数据」+「—」，并降透明度', async () => {
  const { text, nodes } = await renderCard(plugin, mini, { ok: true, value: catalogValue() })
  assert.ok(text.includes('无数据'))
  assert.ok(text.includes('—'), 'utilization 为 null 应显示破折号')
  const rows = nodes.filter((n) => n.type === 'div' && n.props.style && n.props.style.padding === '5px 0')
  const faded = rows.filter((r) => r.props.style.opacity === 0.55)
  // catalogValue 里 5 个无数据：MiniCPM-V-4.7-1B / d3 / d3-flash / OmniVoice / MinerU2.5-Pro
  assert.equal(faded.length, 5, `应有 5 行降透明度，实际 ${faded.length}`)
  const solid = rows.filter((r) => r.props.style.opacity === 1)
  assert.equal(solid.length, 10, `应有 10 行正常透明度，实际 ${solid.length}`)
})

await test('状态点颜色：idle 绿 / busy 黄 / full 红 / 无数据灰', async () => {
  const { nodes } = await renderCard(plugin, mini, { ok: true, value: catalogValue() })
  const colors = statusDots(nodes).map((d) => d.props.style.background)
  assert.equal(colors.length, 15, `应有 15 个状态点，实际 ${colors.length}`)
  assert.ok(colors.includes('#22c55e'), 'idle 绿')
  assert.ok(colors.includes('#eab308'), 'busy 黄')
  assert.ok(colors.includes('#ef4444'), 'full 红')
  assert.equal(colors.filter((c) => c === '#9ca3af').length, 5, '五个无数据应为灰')
})

await test('未知 state 归「无数据」而不是崩', async () => {
  const value = catalogValue({
    groups: [
      {
        label: 'LLM (Text)',
        models: [{ id: 'weird', state: 'bogus', utilization: null, free: true, badgeLabel: 'Free', hasLoad: true, stale: false }],
      },
    ],
  })
  const { text, nodes } = await renderCard(plugin, mini, { ok: true, value })
  assert.ok(text.includes('无数据'))
  assert.equal(statusDots(nodes)[0].props.style.background, '#9ca3af')
})

await test('loadStale 为 true 时显示「陈旧」标记', async () => {
  const { text } = await renderCard(plugin, mini, {
    ok: true,
    value: catalogValue({ loadStale: true }),
  })
  assert.ok(text.includes('陈旧'))
})

await test('loadTs 为 null 时显示「尚未取到数据」', async () => {
  const { text } = await renderCard(plugin, mini, {
    ok: true,
    value: catalogValue({ loadTs: null }),
  })
  assert.ok(text.includes('尚未取到数据'))
})

await test('M0 的占位文案必须消失', async () => {
  const { text } = await renderCard(plugin, mini, { ok: true, value: catalogValue() })
  assert.ok(!text.includes('骨架已加载'))
})
//#endregion

//#region 模型选择行徽章：placement / provider 分支
console.log('\n# 模型选择行徽章：placement / provider 分支')

await test('placement="option" + amd + 有负载 → 渲染模型名 + 点 + 百分比', async () => {
  const { text, nodes } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() })
  // catalogValue 里 Qwen3.8-27B 是 20.1%
  assert.ok(text.includes('Qwen3.8-27B'), `应渲染模型名，实际：${text}`)
  assert.ok(text.includes('20.1%'), `应渲染百分比，实际：${text}`)
  assert.equal(statusDots(nodes).length, 1, '应有一个状态点')
})

await test('placement="trigger" → 不渲染徽章，但模型名仍可见', async () => {
  const { text, nodes } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
    placement: 'trigger',
  })
  assert.equal(text, 'Qwen3.8-27B', `trigger 只应有模型名，实际：${text}`)
  assert.ok(!text.includes('%'), 'trigger 不应出现百分比（否则撑宽工具栏）')
  assert.equal(statusDots(nodes).length, 0, 'trigger 不应有状态点')
})

await test('placement="menu" → 不渲染徽章，但模型名仍可见', async () => {
  const { text, nodes } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
    placement: 'menu',
  })
  assert.equal(text, 'Qwen3.8-27B', `menu 只应有模型名，实际：${text}`)
  assert.ok(!text.includes('%'), 'menu 不应出现百分比（否则与下方 option 重复）')
  assert.equal(statusDots(nodes).length, 0, 'menu 不应有状态点')
})

await test('provider 不是 amd → 不渲染徽章，但模型名仍可见', async () => {
  const { text, nodes } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
    provider: { id: 'tencent', name: '腾讯云' },
    model: { id: 'hunyuan-turbo', name: 'Hunyuan Turbo' },
  })
  assert.equal(text, 'Hunyuan Turbo', `非 amd 只应有模型名，实际：${text}`)
  assert.ok(!text.includes('%'), '非 amd 不应出现百分比')
  assert.equal(statusDots(nodes).length, 0)
})

await test('**模型名在四种分支下都可见**（宿主 fallback 只在无贡献者时生效，返回 null 会变空白）', async () => {
  const cases = [
    { placement: 'option', provider: { id: 'amd' }, label: 'option+amd' },
    { placement: 'trigger', provider: { id: 'amd' }, label: 'trigger' },
    { placement: 'menu', provider: { id: 'amd' }, label: 'menu' },
    { placement: 'option', provider: { id: 'other' }, label: 'option+非 amd' },
  ]
  for (const c of cases) {
    const { text } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
      placement: c.placement,
      provider: c.provider,
    })
    assert.ok(text.includes('Qwen3.8-27B'), `${c.label} 分支下模型名必须可见，实际：${text}`)
  }
})

await test('模型名取 model.name，缺失时回退到 model.id（不渲染成 undefined）', async () => {
  const withName = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
    model: { id: 'Qwen3.8-27B', name: 'Qwen 3.8 27B' },
  })
  assert.ok(withName.text.includes('Qwen 3.8 27B'), `应优先用 model.name，实际：${withName.text}`)

  const noName = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
    model: { id: 'Qwen3.8-27B' },
  })
  assert.ok(noName.text.includes('Qwen3.8-27B'), `无 name 时应回退 id，实际：${noName.text}`)
  assert.ok(!noName.text.includes('undefined'), '不应渲染 undefined')
})

await test('placement 缺失 / 未知值 → 当作非 option，只渲染模型名', async () => {
  for (const placement of [undefined, null, 'bogus', '']) {
    const { text, nodes } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, { placement })
    assert.equal(text, 'Qwen3.8-27B', `placement=${JSON.stringify(placement)} 应只渲染名字，实际：${text}`)
    assert.equal(statusDots(nodes).length, 0)
  }
})

/**
 * Hooks 规则回归：**useSnapshot 必须在每个分支都被调用**，不能只在 option 分支里。
 *
 * 真实场景：父级用 `<Comp {...props} />` 在同一位置无 key 直接渲染，菜单
 * 展开→收起时 placement 从 option 变 trigger，React 复用同一个组件实例。
 * 若 useSnapshot 只在 option 分支里调用，hook 数会从 2 变 0，React 抛
 * 「Rendered more hooks than during the previous render」并崩掉整个模型菜单。
 *
 * 微型渲染器复现不了 React 的 hook 数校验（它按索引存槽位、不会抛），所以这里
 * 直接**数 store 被访问的次数**：useSnapshot 内部会调用 store.getSnapshot()，
 * 因此「trigger 分支也调用了 store.getSnapshot()」等价于「hook 被无条件调用」。
 * 这是本测试唯一能真正抓住该 bug 的判据。
 */
await test('**useSnapshot 在每个分支都被调用**（trigger 分支也必须访问 store）', async () => {
  const mounted = mount(plugin, { call: async () => ({ ok: true, value: catalogValue() }) })
  const base = mounted.modelRow.spec.inject()

  // 用计数代理包住 store，记录 getSnapshot 被调用次数。
  let getSnapshotCalls = 0
  const countingStore = {
    getSnapshot() {
      getSnapshotCalls += 1
      return base.store.getSnapshot()
    },
    subscribe(listener) {
      return base.store.subscribe(listener)
    },
    pull: base.store.pull,
    stop: base.store.stop,
    listenerCount: base.store.listenerCount,
  }

  const baseProps = {
    provider: { id: 'amd', name: 'AMD' },
    model: { id: 'Qwen3.8-27B', name: 'Qwen3.8-27B' },
    selected: false,
    store: countingStore,
  }

  // trigger 分支：不显示徽章，但 useSnapshot 仍必须被调用 → getSnapshot 至少 +1
  getSnapshotCalls = 0
  const triggerTree = await mini.render(mounted.modelRow.Component, { ...baseProps, placement: 'trigger' })
  assert.equal(textOf(triggerTree), 'Qwen3.8-27B', 'trigger 只渲染模型名')
  assert.ok(
    getSnapshotCalls > 0,
    `trigger 分支也必须调用 useSnapshot（hook 不能在条件之后）。getSnapshot 实际调用 ${getSnapshotCalls} 次`,
  )

  // 非 amd 分支同理
  getSnapshotCalls = 0
  await mini.render(mounted.modelRow.Component, { ...baseProps, placement: 'option', provider: { id: 'tencent' } })
  assert.ok(
    getSnapshotCalls > 0,
    `非 amd 分支也必须调用 useSnapshot。getSnapshot 实际调用 ${getSnapshotCalls} 次`,
  )

  // option + amd：正常渲染徽章
  getSnapshotCalls = 0
  const optionTree = await mini.render(mounted.modelRow.Component, { ...baseProps, placement: 'option' })
  const optionText = textOf(optionTree)
  assert.ok(optionText.includes('Qwen3.8-27B'), `option 模型名可见，实际：${optionText}`)
  assert.equal(statusDots(collect(optionTree)).length, 1, 'option 应有状态点')

  mini.unmount()
})
//#endregion

//#region 模型选择行徽章：读数与容错
console.log('\n# 模型选择行徽章：读数与容错')

/**
 * 回归：**必须代内置 1017 插件渲染它的徽章**。
 *
 * 背景：我们以 `priority: -1` 抢占了 `conversation.input.model.label`，而内置
 * `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` 原本注册在这里（priority 0）。
 * single slot 同一时刻只有一个渲染者 ⇒ 我们赢了之后那个徽章就没人画了。
 * 用户明确要求保留，所以由我们代画。
 *
 * 判定条件必须与内置插件逐字一致（三个 AND）：
 *   provider.id ∈ {deepseek-account, deepseek-official}
 *   && model.id === "deepseek-flash"
 *   && model.name === "DeepSeek-V4.1-Flash"
 */
await test('**代渲染内置 1017 徽章**：命中三个条件时名字后出现 1017', async () => {
  const { text, nodes } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
    provider: { id: 'deepseek-official', name: 'DeepSeek' },
    model: { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
    placement: 'option',
  })
  assert.ok(text.includes('DeepSeek-V4.1-Flash'), `模型名必须可见，实际：${text}`)
  assert.ok(text.includes('1017'), `必须出现 1017 徽章，实际：${text}`)
  // 徽章是胶囊 span（borderRadius 999px），与负载徽章的点/百分比区分开
  const badge = nodes.find((n) => n.type === 'span' && n.props.style && n.props.style.borderRadius === '999px')
  assert.ok(badge !== undefined, '1017 徽章应是 borderRadius:999px 的胶囊')
  assert.equal(badge.props.style.fontSize, '11px')
  assert.equal(badge.props.style.fontWeight, 500)
})

await test('1017 徽章：三个条件缺一个都不出现', async () => {
  const cases = [
    { provider: { id: 'deepseek-account' }, model: { id: 'deepseek-flash', name: 'Wrong-Name' }, why: 'name 不符' },
    { provider: { id: 'deepseek-account' }, model: { id: 'other-model', name: 'DeepSeek-V4.1-Flash' }, why: 'id 不符' },
    { provider: { id: 'amd' }, model: { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, why: 'provider 不是官方' },
    { provider: { id: 'tencent' }, model: { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, why: 'provider 不是官方' },
  ]
  for (const c of cases) {
    const { text } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
      provider: c.provider,
      model: c.model,
      placement: 'option',
    })
    assert.ok(!text.includes('1017'), `${c.why} 时不应出现 1017，实际：${text}`)
  }
})

await test('1017 徽章：trigger / menu 等非 option 位置也要保留（内置插件在所有位置都渲染它）', async () => {
  for (const placement of ['trigger', 'menu']) {
    const { text } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
      provider: { id: 'deepseek-official' },
      model: { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
      placement,
    })
    assert.ok(text.includes('DeepSeek-V4.1-Flash'), `${placement} 下模型名可见`)
    assert.ok(text.includes('1017'), `${placement} 下也应保留 1017 徽章（内置插件行为），实际：${text}`)
  }
})

await test('AMD 模型不会被误加 1017 徽章', async () => {
  const { text } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
    provider: { id: 'amd' },
    model: { id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek-V4.1-Flash' },
    placement: 'option',
  })
  assert.ok(!text.includes('1017'), `AMD 的 DeepSeek-V4.1-Flash 不应有 1017（id 不是 deepseek-flash），实际：${text}`)
})


await test('有负载数据 → 状态点颜色跟随 state', async () => {
  const value = catalogValue({
    groups: [
      {
        label: 'LLM (Text)',
        models: [{ id: 'busy-one', state: 'busy', utilization: 55, free: true, badgeLabel: 'Free', hasLoad: true, stale: false }],
      },
    ],
  })
  const { nodes, text } = await renderModelRow(plugin, mini, { ok: true, value }, {
    model: { id: 'busy-one', name: 'Busy One' },
  })
  assert.ok(text.includes('55.0%'), `实际：${text}`)
  const dots = statusDots(nodes)
  assert.equal(dots.length, 1)
  assert.equal(dots[0].props.style.background, '#eab308', 'busy 应是黄点')
})

await test('查不到该模型 → 灰点 + 「—」', async () => {
  const { nodes, text } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
    model: { id: 'Not-In-Catalog', name: 'Not In Catalog' },
  })
  assert.ok(text.includes('Not In Catalog'), '模型名仍要显示')
  assert.ok(text.includes('—'), `应显示破折号，实际：${text}`)
  assert.equal(statusDots(nodes)[0].props.style.background, '#9ca3af', '应是灰点')
})

await test('查到了但 hasLoad 为 false → 灰点 + 「—」', async () => {
  // catalogValue 里 MiniCPM-V-4.7-1B 是 hasLoad:false, utilization:null
  const { nodes, text } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
    model: { id: 'MiniCPM-V-4.7-1B', name: 'MiniCPM-V-4.7-1B' },
  })
  assert.ok(text.includes('—'), `应显示破折号，实际：${text}`)
  assert.equal(statusDots(nodes)[0].props.style.background, '#9ca3af')
})

await test('rpc 失败 / 抛异常 → 灰点 + 「—」，模型名仍可见', async () => {
  const failed = await renderModelRow(plugin, mini, { ok: false, error: { code: 'internal', message: 'boom' } })
  assert.ok(failed.text.includes('Qwen3.8-27B'), '模型名仍要显示')
  assert.ok(failed.text.includes('—'))
  assert.equal(statusDots(failed.nodes)[0].props.style.background, '#9ca3af')

  const mounted = mount(plugin, {
    call: async () => {
      throw new Error('network down')
    },
  })
  const props = {
    provider: { id: 'amd' },
    model: { id: 'Qwen3.8-27B', name: 'Qwen3.8-27B' },
    placement: 'option',
    ...mounted.modelRow.spec.inject(),
  }
  const tree = await mini.render(mounted.modelRow.Component, props)
  const text = textOf(tree)
  assert.ok(text.includes('Qwen3.8-27B'))
  assert.ok(text.includes('—'))
  mini.unmount()
})

await test('title 带状态中文与时间；无数据时 title 仍可读', async () => {
  const { nodes } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() })
  const badge = nodes.find((n) => n.type === 'span' && n.props.title !== undefined)
  assert.ok(badge !== undefined, '应有带 title 的 span')
  assert.ok(badge.props.title.includes('AMD 负载'), `实际：${badge.props.title}`)
  assert.ok(badge.props.title.includes('空闲'), 'Qwen3.8-27B 是 idle')
  assert.ok(badge.props.title.includes('20.1%'))
  assert.ok(badge.props.title.includes('17:20'), '应带更新时间')

  const noData = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, {
    model: { id: 'Not-In-Catalog', name: 'X' },
  })
  const noDataBadge = noData.nodes.find((n) => n.type === 'span' && n.props.title !== undefined)
  assert.ok(noDataBadge.props.title.includes('无数据'), `实际：${noDataBadge.props.title}`)
})

await test('徽章不显示 FREE 字样（列表行只要点 + 百分比）', async () => {
  const { nodes, text } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() })
  assert.equal(freeBadges(nodes).length, 0, '列表行不应有 FREE 徽章')
  assert.ok(!text.includes('FREE'), `不应出现 FREE，实际：${text}`)
})

await test('徽章不显示「更新于」（只在 title 里）', async () => {
  const { text } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() })
  assert.ok(!text.includes('更新于'), `正文不应出现「更新于」，实际：${text}`)
})

await test('样式：inline-flex + marginLeft + nowrap + tabular-nums，且不设固定宽度', async () => {
  const { nodes } = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() })
  const badge = nodes.find((n) => n.type === 'span' && n.props.style && n.props.style.display === 'inline-flex')
  assert.ok(badge !== undefined, '应有一个 inline-flex 的外层')
  assert.equal(badge.props.style.alignItems, 'center')
  assert.equal(badge.props.style.gap, '5px')
  assert.equal(badge.props.style.marginLeft, '6px')
  assert.equal(badge.props.style.fontSize, '11px')
  assert.equal(badge.props.style.fontVariantNumeric, 'tabular-nums')
  assert.equal(badge.props.style.whiteSpace, 'nowrap')
  assert.equal(badge.props.style.width, undefined, '不能设固定宽度')
  const dot = statusDots(nodes)[0]
  assert.equal(dot.props.style.width, '6px')
  assert.equal(dot.props.style.height, '6px')
})

await test('selected 为 true 时不改变徽章渲染（选中态由父级样式负责）', async () => {
  const on = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, { selected: true })
  const off = await renderModelRow(plugin, mini, { ok: true, value: catalogValue() }, { selected: false })
  assert.equal(on.text, off.text, 'selected 不应影响我们渲染的内容')
})
//#endregion

//#region 容错
console.log('\n# 容错')

await test('value 为 null 时显示空态而不崩', async () => {
  const { text } = await renderCard(plugin, mini, { ok: true, value: null })
  assert.ok(text.includes('目录尚未取到'))
  assert.ok(!text.includes('FREE'), '没有目录就没有徽章')
})

await test('groups 不是数组时显示空态而不崩', async () => {
  const { text } = await renderCard(plugin, mini, { ok: true, value: { groups: 'nope' } })
  assert.ok(text.includes('目录尚未取到'))
})

await test('单个分组畸形（models 不是数组）被跳过，其余照常渲染', async () => {
  const value = catalogValue({
    groups: [
      null,
      { label: 'broken', models: 'nope' },
      { label: 'LLM (Text)', models: [{ id: 'ok', state: 'idle', utilization: 1, free: true, badgeLabel: 'Free', hasLoad: true, stale: false }] },
    ],
  })
  const { text } = await renderCard(plugin, mini, { ok: true, value })
  assert.ok(text.includes('ok'))
  assert.ok(text.includes('LLM (Text)'))
  assert.ok(!text.includes('broken'), '畸形分组不应渲染')
})

await test('rpc 返回 ok:false 时显示错误文案', async () => {
  const { text } = await renderCard(plugin, mini, { ok: false, error: { code: 'internal', message: 'boom' } })
  assert.ok(text.includes('负载读取失败'), '应显示错误行')
  assert.ok(text.includes('boom'), '应带上错误 message')
})

await test('rpc 抛异常时不崩，显示错误文案', async () => {
  const { spec, Component } = mountCard(plugin, {
    call: async () => {
      throw new Error('network down')
    },
  })
  const tree = await mini.render(Component, spec.inject())
  const text = textOf(tree)
  assert.ok(text.includes('负载读取失败'))
  assert.ok(text.includes('network down'))
  mini.unmount()
})

await test('模型行在 rpc 失败时降级为灰点 + 「—」，模型名仍可见', async () => {
  const { text, nodes } = await renderModelRow(plugin, mini, { ok: false, error: { code: 'internal', message: 'boom' } })
  assert.ok(text.includes('Qwen3.8-27B'), `模型名仍要显示，实际：${text}`)
  assert.ok(text.includes('—'), `应显示破折号，实际：${text}`)
  assert.equal(statusDots(nodes)[0].props.style.background, '#9ca3af')
})

await test('模型行在 rpc 抛异常时降级为灰点 + 「—」，模型名仍可见', async () => {
  const mounted = mount(plugin, {
    call: async () => {
      throw new Error('network down')
    },
  })
  const tree = await mini.render(mounted.modelRow.Component, {
    provider: { id: 'amd' },
    model: { id: 'Qwen3.8-27B', name: 'Qwen3.8-27B' },
    placement: 'option',
    ...mounted.modelRow.spec.inject(),
  })
  const text = textOf(tree)
  assert.ok(text.includes('Qwen3.8-27B'), `模型名仍要显示，实际：${text}`)
  assert.ok(text.includes('—'))
  mini.unmount()
})
//#endregion

//#region M4 诊断与防静默（真机排查后永久保留）
console.log('\n# M4 诊断与防静默')

/** 临时替换 console.log/error，收集调用；返回恢复函数。 */
function captureConsole() {
  const logCalls = []
  const errorCalls = []
  const origLog = console.log
  const origError = console.error
  console.log = (...args) => logCalls.push(args.map(String).join(' '))
  console.error = (...args) => errorCalls.push(args.map(String).join(' '))
  return {
    logCalls,
    errorCalls,
    restore() {
      console.log = origLog
      console.error = origError
    },
  }
}

await test('apply 入口与每次 register 都打统一前缀的日志（不再无迹可寻）', async () => {
  const captured = captureConsole()
  try {
    mount(plugin, { call: async () => ({ ok: true, value: null }) })
  } finally {
    captured.restore()
  }
  const logs = captured.logCalls.filter((line) => line.includes('[amd-model-load]'))
  assert.ok(
    logs.some((line) => line.includes('apply:')),
    `应有 apply 入口日志，实际：${JSON.stringify(logs)}`,
  )
  assert.ok(
    logs.some((line) => line.includes('slots.register → settings.section')),
    '应有 settings.section 注册前日志',
  )
  assert.ok(
    logs.some((line) => line.includes('slots.register → conversation.input.model.label')),
    '应有模型行注册前日志',
  )
  assert.ok(
    logs.some((line) => line.includes('slots.register ← conversation.input.model.label 成功')),
    '应有模型行注册成功日志',
  )
})

await test('register 抛错时 apply 不再向上抛，且 console.error 带统一前缀（防静默）', () => {
  const captured = captureConsole()
  let threw = null
  try {
    // 只让模型行的 register 抛错（模拟宿主同 priority 冲突等场景）
    mount(plugin, { call: async () => ({ ok: true, value: null }) }, {
      failRegisterFor: 'conversation.input.model.label',
    })
  } catch (error) {
    threw = error
  } finally {
    captured.restore()
  }
  assert.equal(threw, null, `apply 不应向上抛错，实际：${threw}`)
  assert.ok(
    captured.errorCalls.some((line) => line.includes('[amd-model-load]') && line.includes('conversation.input.model.label')),
    `register 失败应 console.error 带统一前缀，实际：${JSON.stringify(captured.errorCalls)}`,
  )
})

await test('发布版不含诊断层：设置卡只注入 store，且不再额外起定时器', async () => {
  const createdBefore = timers.created
  const mounted = mount(plugin, { call: async () => ({ ok: true, value: null }) })
  const injected = mounted.settings.spec.inject()
  assert.deepEqual(Object.keys(injected), ['store'], '设置卡 inject 只应提供 store')
  assert.equal(mounted.registered.length, 2, '仍应注册两个挂载点')
  // 诊断心跳（每 30 秒一条）若还在，apply 期间就会多出一个 interval。
  // 现在 apply 只建 store、不起表 —— store 的节拍在**首个订阅者**出现时才启动。
  assert.equal(timers.created - createdBefore, 0, 'apply 期间不应创建任何定时器')

  // 渲染设置卡（= 首个订阅者）后才允许出现唯一的那一个定时器。
  const beforeRender = timers.created
  await mini.render(mounted.settings.Component, injected)
  assert.equal(timers.created - beforeRender, 1, '首个订阅者应只启动 store 的一个节拍')
  mini.unmount()
  mini.unmount()
})


await test('option+amd 分支抛错时降级为纯模型名（防宿主 abdicate 让徽章时有时无）', async () => {
  // 造一份「访问 groups 属性即抛错」的快照数据：模拟任何意外脏数据。
  // groupsOf 会对 value.groups 取属性 —— get trap 抛错会进入组件的 try/catch。
  const poisoned = new Proxy(
    {},
    {
      get() {
        throw new Error('脏数据炸了')
      },
    },
  )
  const captured = captureConsole()
  let text = ''
  let dots = []
  try {
    const mounted = mount(plugin, { call: async () => ({ ok: true, value: null }) })
    const tree = await mini.render(mounted.modelRow.Component, {
      provider: { id: 'amd', name: 'AMD' },
      model: { id: 'Qwen3.8-27B', name: 'Qwen3.8-27B' },
      placement: 'option',
      selected: false,
      store: {
        getSnapshot: () => poisoned,
        subscribe: () => () => {},
      },
    })
    text = textOf(tree)
    dots = statusDots(collect(tree))
  } finally {
    captured.restore()
  }
  assert.ok(text.includes('Qwen3.8-27B'), `必须降级为纯模型名，实际：${text}`)
  assert.equal(dots.length, 0, '降级时不应渲染状态点')
  assert.ok(
    captured.errorCalls.some((line) => line.includes('模型行徽章渲染失败')),
    '降级应打 console.error（带原因），实际：' + JSON.stringify(captured.errorCalls),
  )
})

await test('trigger 布局只输出纯模型名（收起按钮不显示负载，也不显示 1017）', async () => {
  const mounted = mount(plugin, { call: async () => ({ ok: true, value: catalogValue() }) })
  const tree = await mini.render(mounted.modelRow.Component, {
    provider: { id: 'apigoto', name: 'API' },
    model: { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
    placement: 'trigger',
    selected: true,
    ...mounted.modelRow.spec.inject(),
  })
  // trigger 是收起状态的按钮：只出模型名（1017 只在 option 行代渲染）。
  assert.equal(tree, 'DeepSeek-V4.1-Flash', `trigger 应只返回纯模型名，实际：${JSON.stringify(tree)}`)
  mini.unmount()
})


await test('useSnapshot 抛错时向上抛，不吞错（由宿主 SlotErrorBoundary 接管）', () => {
  const mounted = mount(plugin, { call: async () => ({ ok: true, value: null }) })
  const boomStore = {
    getSnapshot() {
      throw new Error('boom')
    },
    subscribe: () => () => {},
  }
  let threw = false
  try {
    mounted.modelRow.Component({
      provider: { id: 'amd', name: 'AMD' },
      model: { id: 'Clef', name: 'Clef' },
      placement: 'option',
      selected: false,
      store: boomStore,
    })
  } catch {
    threw = true
  }
  assert.equal(threw, true, '渲染期异常不应被渲染函数吞掉：宿主负责 abdicate 与兜底')
})

//#endregion

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
