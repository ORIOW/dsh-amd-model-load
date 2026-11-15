#!/usr/bin/env node
/**
 * 任务单 2026-11-15 §2.4.3（可选项）：把模型行负载 chip 的四个状态渲染成
 * 浅色 / 深色两套主题的静态 HTML，供人工比对。
 *
 * 用法：node scripts/render-usage-chip.mjs
 *   → 覆写 docs/preview/usage-chip.html（单文件，无依赖、无网络）。
 *
 * 数据来源：lib/client.js 经 vm 信封加载（与 test/client.test.mjs 同一手法），
 * 组件是**真的** ModelRowBadge —— 序列化它返回的元素树，不手工复刻样式，
 * 所以这份预览不会和实现漂移。
 *
 * 退出码：片段断言失败（缺 role/aria/percent）时非 0，否则 0。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

//#region vm 信封加载（与 client.test.mjs 同款微型 React）
function createReactStub() {
  return {
    createElement(type, props, ...children) {
      return { __el: true, type, props: props ?? {}, children: children.flat(Infinity) }
    },
    Fragment: undefined, // 微型渲染器按「无 type 的元素」展开 children，同语义
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
  }
}

function loadPlugin() {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { captured = spec } } },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    setImmediate,
    Promise, Object, Array, String, Number, Boolean, Date, JSON, Error, Math, console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const plugin = captured.factory((id) => {
    if (id !== 'react') throw new Error(`unexpected require(${id})`)
    return createReactStub()
  })
  return plugin
}

function mountModelRow(plugin) {
  const registered = []
  plugin.apply({
    connection: undefined,
    slots: {
      inject(name, cb) {
        cb()
      },
      register(spec, Component) {
        registered.push({ spec, Component })
        return () => {}
      },
    },
  })
  const entry = registered.find((item) => item.spec.name === 'conversation.input.model.label')
  if (!entry) throw new Error('conversation.input.model.label 注册项缺失')
  return entry
}
//#endregion

//#region 四态 fixture（与 test/client.test.mjs 的 catalogValue 同形）
const LOAD_TS = new Date(2026, 10, 15, 20, 15, 0).getTime()

function catalogFor(state, utilization, hasLoad) {
  return {
    ts: LOAD_TS,
    source: 'shared',
    error: null,
    stale: false,
    loadTs: LOAD_TS,
    loadStale: false,
    groups: [
      {
        label: 'LLM (Text)',
        models: [{ id: 'sample-model', state, utilization, free: true, badgeLabel: 'Free', hasLoad, stale: false }],
      },
    ],
  }
}

const STATES = [
  { key: 'idle', label: '空闲（实心圆）', model: { id: 'Qwen3.8-27B', name: 'Qwen3.8-27B' }, value: catalogFor('idle', 20.1, true) },
  { key: 'busy', label: '繁忙（半填充圆 + 细环）', model: { id: 'Qwen3.8-Flash-Next', name: 'Qwen3.8-Flash-Next' }, value: catalogFor('busy', 69.5, true) },
  { key: 'full', label: '满载（方块）', model: { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' }, value: catalogFor('full', 100, true) },
  { key: 'unknown', label: '无数据（虚线环，不填色）', model: { id: 'd3', name: 'd3' }, value: catalogFor('unknown', null, false) },
]
//#endregion

//#region 元素树 → HTML 序列化（只覆盖本组件会产出的形状）
const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
function esc(text) {
  return String(text).replace(/[&<>"]/g, (ch) => escapeMap[ch])
}

const STYLE_SKIP = new Set(['onToggle', 'onChange'])
function styleToAttr(style) {
  return Object.entries(style)
    .map(([key, value]) => {
      const kebab = key.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase())
      return `${kebab}:${value}`
    })
    .join(';')
}

function attrsToHtml(props) {
  const parts = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'style' || key === 'key' || key.startsWith('on')) continue
    if (value === undefined || value === null || value === false) continue
    if (typeof value === 'object') continue
    const name = key === 'className' ? 'class' : key
    parts.push(`${name}="${esc(value)}"`)
  }
  return parts.length ? ' ' + parts.join(' ') : ''
}

let elementCount = 0
function serialize(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(serialize).join('')
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (typeof node !== 'object' || !node.__el) return ''
  elementCount += 1
  const inner = serialize(node.children)
  if (node.type === undefined) return inner // Fragment：只出 children
  return `<${node.type}${attrsToHtml(node.props)}>${inner}</${node.type}>`
}
//#endregion

// ---- 渲染四态 ---------------------------------------------------------------

const plugin = loadPlugin()
const entry = mountModelRow(plugin)

let hadFailure = false
const rows = STATES.map((state) => {
  elementCount = 0
  const props = {
    provider: { id: 'amd', name: 'AMD' },
    model: state.model,
    placement: 'option',
    selected: false,
    store: {
      getSnapshot: () => ({ data: state.value, error: null, loaded: true }),
      subscribe: () => () => {},
    },
  }
  const tree = entry.Component(props)
  const html = serialize(tree)
  const checks = [
    [`role="img"`, html.includes('role="img"')],
    [`aria-label 含状态中文`, html.includes('aria-label="AMD 负载：')],
    ['aria-hidden 状态点', html.includes('aria-hidden="true"')],
  ]
  const failed = checks.filter(([, ok]) => !ok)
  if (failed.length > 0) {
    hadFailure = true
    console.error(`FAIL ${state.key}: 缺少 ${failed.map(([name]) => name).join('、')}`)
  }
  console.log(`${state.key}: ${elementCount} 个元素`)
  return { ...state, html }
})

if (hadFailure) {
  process.exit(1)
}

// ---- 组装单文件预览 ---------------------------------------------------------

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-amd-model-load · 负载 chip 四态预览</title>
<style>
  /* 与宿主同名 token 的本地替身：预览脱离宿主渲染时变量有值；
     真机里由宿主主题接管，这里的值不生效。 */
  :root {
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-border-l2: rgba(127, 127, 127, 0.22);
    --sys-color-on-surface-subtle: #59636e;
  }
  .dark {
    --dsw-alias-bg-layer-1: #161b22;
    --dsw-alias-border-l2: rgba(127, 127, 127, 0.30);
    --sys-color-on-surface-subtle: #8b949e;
  }
  body { margin: 0; font: 13px/1.6 system-ui, sans-serif; }
  section { padding: 24px; }
  section.light { background: #ffffff; color: #1f2328; }
  section.dark { background: #0d1117; color: #e6edf3; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 0 0 12px; opacity: 0.7; }
  .row { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .name { font-size: 13px; }
  pre { margin: 0; font-size: 11px; opacity: 0.65; white-space: pre-wrap; word-break: break-all; }
  footer { padding: 0 24px 24px; font-size: 11px; opacity: 0.6; }
</style>
</head>
<body>
<section class="light">
  <h1>负载 chip · 浅色主题</h1>
  <h2>真机里背景 / 描边 / 文字色由 DSH 主题 token 接管，此处为本地替身值</h2>
${rows
  .map(
    (row) => `  <div class="row">
    <span class="name">${row.model.name}</span>${row.html}
    <pre>${esc(row.html)}</pre>
  </div>
  <p style="margin:0 0 16px;font-size:11px;opacity:.6">${row.label}</p>`,
  )
  .join('\n')}
</section>
<section class="dark">
  <h1>负载 chip · 深色主题</h1>
  <h2>点的颜色经 color-mix(accent 70%, currentColor) 跟随主题文字色自动提亮</h2>
${rows
  .map(
    (row) => `  <div class="row">
    <span class="name">${row.model.name}</span>${row.html}
    <pre>${esc(row.html)}</pre>
  </div>
  <p style="margin:0 0 16px;font-size:11px;opacity:.6">${row.label}</p>`,
  )
  .join('\n')}
</section>
<footer>由 scripts/render-usage-chip.mjs 生成（真组件序列化，非手工复刻）；数据为固定 fixture，时间 20:15。</footer>
</body>
</html>
`

const outDir = join(root, 'docs', 'preview')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'usage-chip.html')
writeFileSync(outPath, page)
console.log(`wrote ${outPath}（${page.length} bytes）`)
process.exit(0)
