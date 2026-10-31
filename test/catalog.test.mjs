/**
 * dsh-amd-model-load — catalog.js 单测（零依赖，直接 `node test/catalog.test.mjs`）。
 *
 * 覆盖的边界：
 *   parseBootstrap     真实样本 / 畸形顶层 / cards 非数组 / cards 空 / 单条脏数据跳过 / 无前缀 id
 *   parseModelDetail   真实样本 / badge_label 缺失（d3 系）/ publisher 两种形状 / 畸形 / sort_order 缺失
 *   groupAndSort       5 组顺序 / 组内繁忙度升序 / **无负载数据排组末** / 同繁忙度按 id 稳定 /
 *                      未知分类归「其他」并排最后 / 空目录 / 重复 id / 全无负载数据 / free 只认 badgeLabel
 *   createCatalogSource 成功 / bootstrap 失败保留旧目录 / 详情全失败按失败处理 / 从没成功过用 fallback /
 *                      带 Origin 头 / 单详情失败跳过 / stop 真停表 / refresh 共用 in-flight
 *
 * 真实样本：`test/fixtures/{bootstrap,catalog,load}.json`（2026-10-25 从 AMD 站点抓取）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  CATEGORY_ORDER,
  FALLBACK_CATALOG,
  OTHER_LABEL,
  parseBootstrap,
  parseModelDetail,
  parseSharedModels,
  groupAndSort,
  createCatalogSource,
} from '../lib/catalog.js'

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

function section(title) {
  console.log(`\n# ${title}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))

const BOOTSTRAP = fixture('bootstrap.json')
const CATALOG = fixture('catalog.json')
const LOAD = fixture('load.json')
const FULL = fixture('full-catalog.json')

//#region parseBootstrap
section('parseBootstrap')

await test('真实样本：15 张卡片、section 三字段、id 去掉了 source 前缀', () => {
  const out = parseBootstrap(BOOTSTRAP)
  assert.ok(out !== null, '不应返回 null')
  assert.equal(out.cards.length, 15)
  assert.equal(out.section.key, 'public_free')
  assert.equal(out.section.title, 'Public Free Model APIs')
  assert.equal(out.section.subtitle, 'Ready-to-use free API endpoints')
  assert.equal(out.cards[0].id, 'MiMo-V2.6-Flash')
  assert.equal(out.cards[0].fullId, 'model_gateway:MiMo-V2.6-Flash')
  assert.equal(out.cards[0].detailUrl, '/radeon/api/tokenfactory/model?id=model_gateway%3AMiMo-V2.6-Flash')
  // 15 个 id 全部唯一（重复 id 会让 React key 撞车）
  assert.equal(new Set(out.cards.map((c) => c.id)).size, 15)
})

await test('畸形顶层（null / 数组 / 字符串 / 数字）→ null', () => {
  for (const raw of [null, undefined, [], 'x', 42, true]) {
    assert.equal(parseBootstrap(raw), null, `${JSON.stringify(raw)} 应返回 null`)
  }
})

await test('cards 不是数组 → null', () => {
  assert.equal(parseBootstrap({ section: {}, cards: {} }), null)
  assert.equal(parseBootstrap({ section: {}, cards: 'nope' }), null)
})

await test('cards 为空数组 → null（空目录等同本次失败，交给调用方保留旧目录）', () => {
  assert.equal(parseBootstrap({ cards: [] }), null)
})

await test('单条卡片畸形被跳过，不毁掉整份结果', () => {
  const out = parseBootstrap({
    cards: [null, 'x', { id: '' }, { id: 42 }, { id: 'model_gateway:Good' }, { id: 'Plain' }],
  })
  assert.ok(out !== null)
  assert.equal(out.cards.length, 2)
  assert.deepEqual(out.cards.map((c) => c.id), ['Good', 'Plain'])
  assert.equal(out.cards[1].fullId, 'Plain', '无前缀时 fullId 与 id 相同')
})

await test('全部卡片畸形 → null', () => {
  assert.equal(parseBootstrap({ cards: [null, { id: '' }, 'x'] }), null)
})

await test('section 缺失时三字段为 null 而不是崩', () => {
  const out = parseBootstrap({ cards: [{ id: 'a:b' }] })
  assert.deepEqual(out.section, { key: null, title: null, subtitle: null })
})
//#endregion

//#region parseModelDetail
section('parseModelDetail')

await test('真实样本（Free 模型）：分类、徽章、publisher、sort_order 全对', () => {
  const out = parseModelDetail({
    model: {
      id: 'model_gateway:MiMo-V2.6-Flash',
      label: 'MiMo-V2.6-Flash',
      sort_order: 0,
      display_config: {
        name: 'MiMo-V2.6-Flash',
        capability_key: 'vision',
        capability_label: 'VLM (Vision)',
        badge_label: 'Free',
        publisher: 'Radeon Cloud',
        description: 'MiMo-V2.6-Flash served by the AMD GPU Cloud',
      },
      token_factory: { badge: { label: 'Free', tone: 'free' }, capability: { key: 'vision', label: 'VLM (Vision)' } },
    },
  })
  assert.deepEqual(out, {
    id: 'MiMo-V2.6-Flash',
    fullId: 'model_gateway:MiMo-V2.6-Flash',
    displayName: 'MiMo-V2.6-Flash',
    capabilityKey: 'vision',
    capabilityLabel: 'VLM (Vision)',
    badgeLabel: 'Free',
    publisher: 'Radeon Cloud',
    description: 'MiMo-V2.6-Flash served by the AMD GPU Cloud',
    sortOrder: 0,
  })
})

await test('真实样本（d3）：badge_label 缺失 → badgeLabel 为 null，**不回退到 token_factory.badge**', () => {
  // 这是 M3 最关键的一条契约：d3 的 token_factory.badge.label 实测也是 "Free"，
  // 若拿它回退，d3/d3-flash/Clef 会被错加 FREE 徽章（网页上它们不显示 FREE）。
  const out = parseModelDetail({
    model: {
      id: 'model_gateway:d3',
      label: 'd3',
      sort_order: 7,
      display_config: {
        name: 'd3',
        capability_key: 'decision',
        capability_label: 'Decision (Classifier)',
        description: 'vLLM-SR 27B decision model',
        // 刻意不写 badge_label
      },
      token_factory: { badge: { label: 'Free', tone: 'free' }, publisher: { name: 'Radeon Cloud', mark: 'R' } },
    },
  })
  assert.equal(out.badgeLabel, null, 'badgeLabel 必须为 null')
  assert.equal(out.capabilityLabel, 'Decision (Classifier)')
  assert.equal(out.publisher, 'Radeon Cloud', 'publisher 从 token_factory.publisher.name 回退取')
})

await test('publisher 两种形状都能取：display_config 字符串优先于 token_factory 对象', () => {
  const fromDisplay = parseModelDetail({
    model: { id: 'a:b', display_config: { publisher: 'Google' }, token_factory: { publisher: { name: 'Other' } } },
  })
  assert.equal(fromDisplay.publisher, 'Google')
  const fromFactory = parseModelDetail({
    model: { id: 'a:b', display_config: {}, token_factory: { publisher: { name: 'Other' } } },
  })
  assert.equal(fromFactory.publisher, 'Other')
  const none = parseModelDetail({ model: { id: 'a:b' } })
  assert.equal(none.publisher, null)
})

await test('capability_label 缺失时用 capability_key 映射兜底', () => {
  const out = parseModelDetail({ model: { id: 'a:b', display_config: { capability_key: 'ocr' } } })
  assert.equal(out.capabilityLabel, 'OCR (Document)')
})

await test('capability 全缺 → 归「其他」', () => {
  const out = parseModelDetail({ model: { id: 'a:b' } })
  assert.equal(out.capabilityLabel, OTHER_LABEL)
  assert.equal(out.capabilityKey, null)
})

await test('sort_order 缺失 → MAX_SAFE_INTEGER（排在已知之后，不参与并列）', () => {
  const out = parseModelDetail({ model: { id: 'a:b' } })
  assert.equal(out.sortOrder, Number.MAX_SAFE_INTEGER)
})

await test('畸形输入 → null', () => {
  for (const raw of [null, undefined, [], 'x', 42, {}, { model: null }, { model: { id: '' } }]) {
    assert.equal(parseModelDetail(raw), null, `${JSON.stringify(raw)} 应返回 null`)
  }
})

await test('允许直接传 model 对象本身（不带 {model:...} 外壳）', () => {
  const out = parseModelDetail({ id: 'model_gateway:x', display_config: { capability_label: 'LLM (Text)' } })
  assert.equal(out.id, 'x')
  assert.equal(out.capabilityLabel, 'LLM (Text)')
})

await test('id 恒为「去前缀的全 id」，display_config.name 另存为 displayName', () => {
  // 实测坑：DeepSeek-V4.1-Flash 的 display_config.name 是 'DeepSeek-V4.1-Flash-1017'，
  // 而 load 端点的 key 是不带后缀的 'DeepSeek-V4.1-Flash'。用 name 当 id 会永远匹配不到负载。
  const out = parseModelDetail({
    model: {
      id: 'model_gateway:DeepSeek-V4.1-Flash',
      display_config: { name: 'DeepSeek-V4.1-Flash-1017' },
    },
  })
  assert.equal(out.id, 'DeepSeek-V4.1-Flash', 'id 必须是去前缀全 id')
  assert.equal(out.displayName, 'DeepSeek-V4.1-Flash-1017', 'display_config.name 存 displayName')
})

await test('displayName 回退链：display_config.name → model.label → null', () => {
  assert.equal(parseModelDetail({ model: { id: 'a:b', display_config: { name: 'N' } } }).displayName, 'N')
  assert.equal(parseModelDetail({ model: { id: 'a:b', label: 'L' } }).displayName, 'L')
  assert.equal(parseModelDetail({ model: { id: 'a:b' } }).displayName, null)
})
//#endregion

//#region groupAndSort
section('groupAndSort')

await test('真实样本端到端：15 个模型、5 个分组、顺序与官方 CATEGORY_ORDER 一致', () => {
  const groups = groupAndSort(CATALOG, LOAD.models, { stale: false })
  assert.equal(groups.length, 5)
  assert.deepEqual(groups.map((g) => g.label), CATEGORY_ORDER)
  assert.deepEqual(groups.map((g) => g.models.length), [7, 3, 3, 1, 1])
  assert.equal(groups.flatMap((g) => g.models).length, 15)
})

await test('真实样本：12 个 FREE 徽章，3 个无徽章且全是 Decision', () => {
  const groups = groupAndSort(CATALOG, LOAD.models, { stale: false })
  const all = groups.flatMap((g) => g.models)
  assert.equal(all.filter((m) => m.free).length, 12)
  const noBadge = all.filter((m) => !m.free)
  assert.equal(noBadge.length, 3)
  assert.deepEqual(noBadge.map((m) => m.id).sort(), ['Clef', 'd3', 'd3-flash'])
  for (const m of noBadge) assert.equal(m.badgeLabel, null)
})

await test('真实样本：VLM 组内严格按 utilization 升序', () => {
  const groups = groupAndSort(CATALOG, LOAD.models, { stale: false })
  const vlm = groups.find((g) => g.label === 'VLM (Vision)')
  const withLoad = vlm.models.filter((m) => m.utilization !== null).map((m) => m.utilization)
  assert.deepEqual(withLoad, [3.7, 18, 20.1, 69.5, 100, 100], `实际：${withLoad}`)
})

await test('无负载数据的排在该组末尾（哪怕 id 字典序更靠前）', () => {
  const catalog = [
    { id: 'AAA', capabilityLabel: 'LLM (Text)', badgeLabel: 'Free' },
    { id: 'ZZZ', capabilityLabel: 'LLM (Text)', badgeLabel: 'Free' },
    { id: 'MMM', capabilityLabel: 'LLM (Text)', badgeLabel: 'Free' },
  ]
  // AAA 无数据、ZZZ 有数据 ⇒ AAA 必须排在 ZZZ 之后
  const groups = groupAndSort(catalog, { ZZZ: { state: 'idle', utilization: 90 } })
  assert.deepEqual(groups[0].models.map((m) => m.id), ['ZZZ', 'AAA', 'MMM'])
  // 两个无数据项之间按 id 字典序
  assert.deepEqual(
    groups[0].models.filter((m) => m.utilization === null).map((m) => m.id),
    ['AAA', 'MMM'],
  )
})

await test('无数据项即使 utilization 字段是 null / 非数字，也排末尾', () => {
  const catalog = [
    { id: 'a', capabilityLabel: 'LLM (Text)' },
    { id: 'b', capabilityLabel: 'LLM (Text)' },
    { id: 'c', capabilityLabel: 'LLM (Text)' },
  ]
  const groups = groupAndSort(catalog, {
    a: { state: 'unknown', utilization: null },
    b: { state: 'idle', utilization: 'abc' },
    c: { state: 'idle', utilization: 5 },
  })
  assert.deepEqual(groups[0].models.map((m) => m.id), ['c', 'a', 'b'])
  assert.equal(groups[0].models[0].utilization, 5)
  assert.equal(groups[0].models[1].utilization, null)
})

await test('同 utilization 时按 id 字典序 —— 结果可重复，不依赖 sort 稳定性', () => {
  const catalog = [
    { id: 'ccc', capabilityLabel: 'TTS (Speech)' },
    { id: 'aaa', capabilityLabel: 'TTS (Speech)' },
    { id: 'bbb', capabilityLabel: 'TTS (Speech)' },
  ]
  const loads = {
    aaa: { state: 'full', utilization: 100 },
    bbb: { state: 'full', utilization: 100 },
    ccc: { state: 'full', utilization: 100 },
  }
  const first = groupAndSort(catalog, loads)[0].models.map((m) => m.id)
  assert.deepEqual(first, ['aaa', 'bbb', 'ccc'])
  // 输入顺序反过来，输出必须一样（全序比较器，不靠稳定排序）
  const second = groupAndSort([...catalog].reverse(), loads)[0].models.map((m) => m.id)
  assert.deepEqual(second, first)
})

await test('未知分类归「其他」且排在所有官方分类之后', () => {
  const catalog = [
    { id: 'x', capabilityLabel: 'Unknown (Thing)' },
    { id: 'y', capabilityLabel: 'OCR (Document)' },
    { id: 'z', capabilityLabel: null },
  ]
  const groups = groupAndSort(catalog, {})
  assert.deepEqual(groups.map((g) => g.label), ['OCR (Document)', OTHER_LABEL])
  assert.deepEqual(groups[1].models.map((m) => m.id), ['x', 'z'])
})

await test('只出现目录里真实存在的分类（空分类不出空标题）', () => {
  const groups = groupAndSort([{ id: 'only', capabilityLabel: 'OCR (Document)' }], {})
  assert.deepEqual(groups.map((g) => g.label), ['OCR (Document)'])
})

await test('空目录 / 非数组 → []（不崩）', () => {
  for (const catalog of [null, undefined, [], 'x', 42, {}]) {
    assert.deepEqual(groupAndSort(catalog, {}), [])
  }
})

await test('全无负载数据时：每组内全部按 id 字典序，且 hasLoad 为 false', () => {
  const groups = groupAndSort(CATALOG, {}, { stale: true })
  const all = groups.flatMap((g) => g.models)
  assert.equal(all.length, 15)
  assert.ok(all.every((m) => m.hasLoad === false))
  assert.ok(all.every((m) => m.utilization === null))
  assert.ok(all.every((m) => m.state === 'unknown'))
  assert.ok(all.every((m) => m.stale === false), '没有负载就没有「陈旧」可言')
  const vlm = groups.find((g) => g.label === 'VLM (Vision)')
  const ids = vlm.models.map((m) => m.id)
  assert.deepEqual(ids, [...ids].sort())
})

await test('重复 id 只保留第一条（防 React key 撞车）', () => {
  const groups = groupAndSort(
    [
      { id: 'dup', capabilityLabel: 'LLM (Text)', badgeLabel: 'Free' },
      { id: 'dup', capabilityLabel: 'LLM (Text)', badgeLabel: null },
    ],
    {},
  )
  assert.equal(groups.flatMap((g) => g.models).length, 1)
  assert.equal(groups[0].models[0].free, true, '保留的是第一条（有徽章的那条）')
})

await test('stale 逐项继承快照的陈旧标记', () => {
  const catalog = [{ id: 'a', capabilityLabel: 'LLM (Text)' }]
  const fresh = groupAndSort(catalog, { a: { state: 'idle', utilization: 1 } }, { stale: false })
  assert.equal(fresh[0].models[0].stale, false)
  const old = groupAndSort(catalog, { a: { state: 'idle', utilization: 1 } }, { stale: true })
  assert.equal(old[0].models[0].stale, true)
})

await test('free 只认 badgeLabel，非字符串 / 空串都算无徽章', () => {
  const groups = groupAndSort(
    [
      { id: 'a', capabilityLabel: 'LLM (Text)', badgeLabel: 'Free' },
      { id: 'b', capabilityLabel: 'LLM (Text)', badgeLabel: null },
      { id: 'c', capabilityLabel: 'LLM (Text)', badgeLabel: '   ' },
      { id: 'd', capabilityLabel: 'LLM (Text)', badgeLabel: 42 },
    ],
    {},
  )
  const byId = Object.fromEntries(groups[0].models.map((m) => [m.id, m]))
  assert.equal(byId.a.free, true)
  assert.equal(byId.b.free, false)
  assert.equal(byId.c.free, false, '空白字符串不算徽章')
  assert.equal(byId.d.free, false, '非字符串不算徽章')
})

await test('接受上游 snake_case 字段（fixtures 原样）与 camelCase（parseModelDetail 输出）两种形状', () => {
  const snake = groupAndSort([{ id: 'a', capability_label: 'LLM (Text)', badge_label: 'Free' }], {})
  const camel = groupAndSort([{ id: 'a', capabilityLabel: 'LLM (Text)', badgeLabel: 'Free' }], {})
  assert.deepEqual(snake, camel)
})

await test('目录条目畸形被跳过', () => {
  const groups = groupAndSort([null, 'x', 42, { id: '' }, { id: 'ok', capabilityLabel: 'LLM (Text)' }], {})
  assert.equal(groups.flatMap((g) => g.models).length, 1)
})
//#endregion

//#region FALLBACK_CATALOG
section('FALLBACK_CATALOG')

await test('15 条、12 个 Free、3 个无徽章，与真实样本一致', () => {
  assert.equal(FALLBACK_CATALOG.length, 15)
  assert.equal(FALLBACK_CATALOG.filter((e) => e.badgeLabel !== null).length, 12)
  const noBadge = FALLBACK_CATALOG.filter((e) => e.badgeLabel === null).map((e) => e.id).sort()
  assert.deepEqual(noBadge, ['Clef', 'd3', 'd3-flash'])
})

await test('fallback 自身能分组出 5 组 15 个模型（UI 永远有东西可显示）', () => {
  const groups = groupAndSort(FALLBACK_CATALOG, {})
  assert.equal(groups.length, 5)
  assert.equal(groups.flatMap((g) => g.models).length, 15)
})

await test('与 fixtures/catalog.json 逐条对齐（id / 分类 / 徽章）', () => {
  const live = new Map(CATALOG.map((e) => [e.id, e]))
  for (const entry of FALLBACK_CATALOG) {
    const truth = live.get(entry.id)
    assert.ok(truth !== undefined, `fixtures 里没有 ${entry.id}`)
    assert.equal(entry.capabilityLabel, truth.capability_label, `${entry.id} 分类不一致`)
    assert.equal(entry.badgeLabel, truth.badge_label, `${entry.id} 徽章不一致`)
    assert.equal(entry.fullId, truth.full_id, `${entry.id} fullId 不一致`)
    assert.equal(entry.sortOrder, truth.sort_order, `${entry.id} sort_order 不一致`)
  }
})

await test('FALLBACK_CATALOG 是冻结的（调用方改不动）', () => {
  assert.equal(Object.isFrozen(FALLBACK_CATALOG), true)
})
//#endregion

//#region createCatalogSource
section('createCatalogSource')

/** 造一个按 URL 路由的假 fetch。 */
function routedFetch(routes, log = []) {
  const impl = async (url, init) => {
    log.push({ url, init })
    const handler = routes[url]
    if (handler === undefined) return { ok: false, status: 404, json: async () => ({}) }
    const out = handler(url, init)
    if (out instanceof Error) throw out
    return { ok: out.ok ?? true, status: out.status ?? 200, json: async () => out.body }
  }
  impl.log = log
  return impl
}

const ORIGIN = 'https://example.test'
const SHARED_URL = `${ORIGIN}/shared`
const CARDS_URL = `${ORIGIN}/bootstrap`

/** 首选路径（一次拿全）的路由：直接把 fixtures/full-catalog.json 当响应体。 */
function sharedRoutes() {
  return { [SHARED_URL]: () => ({ body: FULL }) }
}

/** 回退路径（cards + 逐卡 GET）的路由。 */
function cardRoutes(detailFor = () => null) {
  const routes = {}
  routes[CARDS_URL] = () => ({ body: BOOTSTRAP })
  for (const card of BOOTSTRAP.cards) {
    const url = `${ORIGIN}${card.detail_url}`
    routes[url] = () => {
      const override = detailFor(card)
      if (override !== null) return override
      const entry = CATALOG.find((e) => e.full_id === card.id)
      return {
        body: {
          model: {
            id: card.id,
            label: entry.id,
            sort_order: entry.sort_order,
            display_config: {
              name: entry.id,
              capability_key: entry.capability_key,
              capability_label: entry.capability_label,
              badge_label: entry.badge_label,
              publisher: entry.publisher,
              description: entry.description,
            },
          },
        },
      }
    }
  }
  return routes
}

await test('首选路径：一次请求拿全 15 条，source=shared', async () => {
  const fetchImpl = routedFetch(sharedRoutes())
  let clock = 1000
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl,
    pollMs: 0,
    now: () => clock,
  })
  const snap = await source.refresh()
  assert.equal(snap.error, null)
  assert.equal(snap.source, 'shared')
  assert.equal(snap.entries.length, 15)
  assert.equal(snap.ts, 1000)
  assert.equal(fetchImpl.log.length, 1, '首选路径只发 1 个请求')
  assert.deepEqual(snap.entries.map((e) => e.sortOrder), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
})

await test('首选路径解析出的分类/徽章与 fixtures/catalog.json 完全一致', async () => {
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl: routedFetch(sharedRoutes()),
    pollMs: 0,
  })
  const snap = await source.refresh()
  const truth = new Map(CATALOG.map((e) => [e.id, e]))
  for (const entry of snap.entries) {
    const expected = truth.get(entry.id)
    assert.ok(expected !== undefined, `fixtures 里没有 ${entry.id}`)
    assert.equal(entry.capabilityLabel, expected.capability_label, `${entry.id} 分类`)
    assert.equal(entry.badgeLabel, expected.badge_label, `${entry.id} 徽章`)
    assert.equal(entry.fullId, expected.full_id, `${entry.id} fullId`)
    assert.equal(entry.sortOrder, expected.sort_order, `${entry.id} sort_order`)
  }
})

await test('首选路径请求带 Origin 与 content-type（少 Origin 就 403）', async () => {
  const fetchImpl = routedFetch(sharedRoutes())
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl,
    pollMs: 0,
  })
  await source.refresh()
  assert.equal(fetchImpl.log.length, 1)
  assert.equal(fetchImpl.log[0].init.method, 'POST')
  assert.equal(fetchImpl.log[0].init.headers.origin, ORIGIN)
  assert.equal(fetchImpl.log[0].init.headers['content-type'], 'application/json')
  assert.equal(fetchImpl.log[0].init.headers.accept, 'application/json')
})

await test('回退路径：首选失败 → 走 cards + 逐卡 GET，source=cards', async () => {
  const fetchImpl = routedFetch({ ...cardRoutes() }) // 没有 shared 路由 ⇒ 404
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl,
    pollMs: 0,
  })
  const snap = await source.refresh()
  assert.equal(snap.error, null, '回退成功就不算失败')
  assert.equal(snap.source, 'cards')
  assert.equal(snap.entries.length, 15)
  // 1 次首选（失败）+ 1 次 bootstrap + 15 次详情
  assert.equal(fetchImpl.log.length, 17, `应发 17 个请求，实际 ${fetchImpl.log.length}`)
  assert.equal(fetchImpl.log[0].url, SHARED_URL, '第一个请求是首选路径')
  assert.equal(fetchImpl.log[1].url, CARDS_URL, '第二个是回退的 bootstrap')
  for (const entry of fetchImpl.log) assert.equal(entry.init.headers.origin, ORIGIN)
})

await test('回退路径：单个详情失败只跳过该条，其余照常', async () => {
  const fetchImpl = routedFetch(cardRoutes((card) => (card.id === 'model_gateway:d3' ? { ok: false, status: 500 } : null)))
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl,
    pollMs: 0,
  })
  const snap = await source.refresh()
  assert.equal(snap.error, null, '一条失败不算整次失败')
  assert.equal(snap.source, 'cards')
  assert.equal(snap.entries.length, 14)
  assert.ok(!snap.entries.some((e) => e.id === 'd3'))
})

await test('回退路径：全部详情失败 → 本次按失败处理（不清空目录）', async () => {
  const fetchImpl = routedFetch(cardRoutes(() => ({ ok: false, status: 500 })))
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl,
    pollMs: 0,
  })
  const snap = await source.refresh()
  assert.match(snap.error, /全部模型详情解析失败/)
  assert.equal(snap.entries.length, 15, '仍是 fallback 的 15 条')
})

await test('两条路径都失败 → 保留上一次成功目录并标 error，ts 不前进', async () => {
  const routes = sharedRoutes()
  const fetchImpl = routedFetch(routes)
  let clock = 1000
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl,
    pollMs: 0,
    now: () => clock,
  })
  await source.refresh()
  assert.equal(source.snapshot().entries.length, 15)

  routes[SHARED_URL] = () => ({ ok: false, status: 503 })
  clock = 2000
  const snap = await source.refresh()
  assert.equal(snap.entries.length, 15, '旧目录必须保留')
  assert.equal(snap.ts, 1000, 'ts 不前进')
  // 首选 503、回退路径在本测试里没有路由（404）⇒ error 是最后那条
  assert.match(snap.error, /HTTP \d{3}/)
  assert.equal(snap.source, 'shared', 'source 仍是上一次成功值')
})

await test('从没成功过时 entries 就是 FALLBACK_CATALOG 的副本（UI 永远有内容）', () => {
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl: routedFetch({}),
    pollMs: 0,
  })
  const snap = source.snapshot()
  assert.equal(snap.ts, null)
  assert.equal(snap.source, 'fallback')
  assert.equal(snap.entries.length, 15)
  assert.deepEqual(snap.entries.map((e) => e.id), FALLBACK_CATALOG.map((e) => e.id))
})

await test('快照是副本：改它不污染内部状态与 FALLBACK_CATALOG', () => {
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl: routedFetch({}),
    pollMs: 0,
  })
  const snap = source.snapshot()
  snap.entries[0].id = 'mutated'
  snap.entries.length = 0
  assert.equal(source.snapshot().entries.length, 15)
  assert.equal(FALLBACK_CATALOG[0].id, 'MiMo-V2.6-Flash')
})

await test('refresh 与轮询共用 in-flight：并发调三次只发一轮请求', async () => {
  const fetchImpl = routedFetch(sharedRoutes())
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl,
    pollMs: 0,
  })
  await Promise.all([source.refresh(), source.refresh(), source.refresh()])
  assert.equal(fetchImpl.log.length, 1, `并发 3 次应只发 1 个请求，实际 ${fetchImpl.log.length}`)
})

await test('pollMs <= 0 时 start 只拉一次、不起 interval', async () => {
  const fetchImpl = routedFetch(sharedRoutes())
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl,
    pollMs: 0,
  })
  source.start()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(fetchImpl.log.length, 1)
  source.stop()
})

await test('stop 后不再拉取；start 幂等', async () => {
  const fetchImpl = routedFetch(sharedRoutes())
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl,
    pollMs: 20,
  })
  source.start()
  source.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  source.stop()
  const count = fetchImpl.log.length
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(fetchImpl.log.length, count, 'stop 后不应再有请求')
})

await test('onUpdate 抛错不打断刷新', async () => {
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl: routedFetch(sharedRoutes()),
    pollMs: 0,
    onUpdate: () => {
      throw new Error('回调炸了')
    },
  })
  const snap = await source.refresh()
  assert.equal(snap.error, null)
  assert.equal(snap.entries.length, 15)
})

await test('onFallback 在首选失败、回落逐卡时被调用', async () => {
  const seen = []
  const source = createCatalogSource({
    sharedUrl: SHARED_URL,
    bootstrapUrl: CARDS_URL,
    fetchImpl: routedFetch(cardRoutes()),
    pollMs: 0,
    onFallback: (error) => seen.push(error.message),
  })
  await source.refresh()
  assert.equal(seen.length, 1)
  assert.match(seen[0], /HTTP 404/)
})
//#endregion

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
