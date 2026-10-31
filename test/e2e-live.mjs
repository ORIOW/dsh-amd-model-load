/**
 * dsh-amd-model-load — 真实端点端到端验证（会真的打 AMD 上游，耗时 ~30s）。
 *
 * 与 test/host.test.mjs 的区别：那个用假 fetch 验契约，这个用**真 fetch** 验
 * 「apply → 两个轮询器 → 真实上游 → handler → 信封 → 分组排序」整条链，
 * 并抓一份真实的 catalog RPC 返回 JSON 写进 M3-REPORT.md 当契约样例。
 *
 * M3 起验的是两条链：
 *   1. 目录（首选 `bootstrap?section=dedicated` 一次拿全）→ 15 条 → 5 组
 *   2. 负载（`tokenfactory/load`，~26s）→ 与目录 join → 组内按繁忙度升序
 *
 * 跑法：`./test/with-stub.sh e2e` 或（工作区有 schemastery 时）`node test/e2e-live.mjs`
 *
 * 注意：本脚本只读上游，不发任何写请求，不需要 key。
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let mod
try {
  mod = await import('../lib/index.js')
} catch (error) {
  console.error('无法 import lib/index.js（缺 @deepseek-ai/schemastery）：' + error.message)
  console.error('请用 ./test/with-stub.sh e2e（会建临时桩并在结束时删除）。')
  process.exit(2)
}

//#region 最小假 ctx（与 host.test.mjs 同形状，只留需要的部分）
function fakeCtx() {
  const effects = []
  const injects = []
  const registrations = []
  return {
    ctx: {
      effect(fn, label) {
        effects.push({ label, disposer: fn() })
      },
      inject(deps, cb) {
        injects.push({ deps, cb })
      },
      get() {
        return undefined
      },
    },
    effects,
    injects,
    registrations,
    flushInject() {
      const scope = {
        connection: { requestRejection: () => undefined },
        webServer: {
          register(spec) {
            registrations.push(spec)
            return () => {
              spec.disposed = true
            }
          },
        },
        effect(fn, label) {
          effects.push({ label, disposer: fn() })
        },
      }
      for (const { cb } of injects) cb(scope)
    },
    disposeAll() {
      for (const { disposer } of [...effects].reverse()) if (typeof disposer === 'function') disposer()
    },
  }
}

function fakeRequest(url, body) {
  return {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
    destroy() {},
  }
}

function fakeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? null
    },
    end(body) {
      if (typeof body === 'string') this.body = body
    },
    on() {},
    off() {},
  }
}

async function call(handler, method) {
  const res = fakeResponse()
  await handler(
    fakeRequest(
      `/dsh-amd-model-load/${method}`,
      JSON.stringify({ type: 'client-request', rpcId: 'e2e-1', method, payload: {} }),
    ),
    res,
  )
  return { status: res.statusCode, envelope: JSON.parse(res.body) }
}
//#endregion

const started = Date.now()
console.log('[e2e] apply（pollMs=0 / catalogPollMs=0：只拉一次，不排下一轮）…')

const fake = fakeCtx()
mod.apply(fake.ctx, { pollMs: 0, catalogPollMs: 0, timeoutMs: 60_000 })
fake.flushInject()
const handler = fake.registrations[0].handler

// 启动即拉一次。refresh 会等两个轮询器都完成（共用 in-flight，不会二次请求）。
console.log('[e2e] 等真实上游返回（负载 ~26s，超时 60s）…')
const t0 = Date.now()
const first = await call(handler, 'refresh')
const elapsed = Date.now() - t0
console.log(`[e2e] 上游往返 ${(elapsed / 1000).toFixed(1)}s`)

// 再调 catalog（纯读缓存 + 纯计算），应当毫秒级返回同一份数据
const t1 = Date.now()
const second = await call(handler, 'catalog')
const cacheLatency = Date.now() - t1
console.log(`[e2e] catalog 读缓存耗时 ${cacheLatency}ms`)

//#region 断言：信封
assert.equal(first.status, 200)
assert.equal(first.envelope.type, 'server-response')
assert.equal(first.envelope.rpcId, 'e2e-1')
assert.equal(first.envelope.result.ok, true)

const value = second.envelope.result.value
assert.equal(typeof value.ts, 'number', '目录 ts 应是成功时刻的毫秒时间戳')
assert.equal(typeof value.stale, 'boolean')
assert.equal(typeof value.loadTs, 'number', '负载 ts 应有值')
assert.ok(Array.isArray(value.groups), 'groups 应是数组')
//#endregion

//#region 断言：分组结构（M3 的核心契约）
console.log(`[e2e] 目录数据源：${value.source}，目录 ${value.groups.length} 组`)

assert.equal(value.groups.length, 5, `应有 5 个分组，实际 ${value.groups.length}`)
assert.deepEqual(
  value.groups.map((g) => g.label),
  ['VLM (Vision)', 'LLM (Text)', 'Decision (Classifier)', 'TTS (Speech)', 'OCR (Document)'],
  '分组顺序必须是 AMD 官方 5 分类顺序',
)

const all = value.groups.flatMap((g) => g.models)
assert.equal(all.length, 15, `应显示 15 个模型（Public Free 区），实际 ${all.length}`)

// 12 个 FREE 徽章，3 个 Decision 模型无徽章
const withBadge = all.filter((m) => m.free)
assert.equal(withBadge.length, 12, `应有 12 个 FREE 徽章，实际 ${withBadge.length}`)
const noBadge = all.filter((m) => !m.free).map((m) => m.id).sort()
assert.deepEqual(noBadge, ['Clef', 'd3', 'd3-flash'], `无徽章模型应恰好是 3 个 Decision，实际 ${noBadge}`)

// 每个模型都必须带齐 client 渲染契约字段
for (const model of all) {
  assert.deepEqual(
    Object.keys(model).sort(),
    ['badgeLabel', 'free', 'hasLoad', 'id', 'stale', 'state', 'utilization'],
    `${model.id} 字段形状不符`,
  )
  assert.equal(typeof model.free, 'boolean')
  assert.ok(['idle', 'busy', 'full', 'unknown'].includes(model.state), `${model.id} state 非法: ${model.state}`)
  assert.ok(
    model.utilization === null || (model.utilization >= 0 && model.utilization <= 100),
    `${model.id} utilization 越界`,
  )
}
//#endregion

//#region 断言：组内排序（无数据排组末）
for (const group of value.groups) {
  const withLoad = group.models.filter((m) => m.utilization !== null)
  const withoutLoad = group.models.filter((m) => m.utilization === null)

  for (let i = 1; i < withLoad.length; i += 1) {
    assert.ok(
      withLoad[i - 1].utilization <= withLoad[i].utilization,
      `${group.label} 组内未按繁忙度升序：${withLoad.map((m) => m.utilization)}`,
    )
  }
  if (withLoad.length > 0 && withoutLoad.length > 0) {
    const lastWith = group.models.lastIndexOf(withLoad[withLoad.length - 1])
    const firstWithout = group.models.indexOf(withoutLoad[0])
    assert.ok(
      lastWith < firstWithout,
      `${group.label} 的无负载数据项必须排在组末：${group.models.map((m) => m.id)}`,
    )
  }
  console.log(
    `[e2e]   ${group.label.padEnd(22)} ${String(group.models.length).padStart(2)} 个` +
      `（有数据 ${withLoad.length} / 无数据 ${withoutLoad.length}）`,
  )
}
//#endregion

//#region 断言：load 端点仍是纯读缓存
const t2 = Date.now()
const loadOnly = await call(handler, 'load')
const loadLatency = Date.now() - t2
assert.equal(loadOnly.envelope.result.ok, true)
assert.ok(loadLatency < 1000, `load 读缓存应 <1s，实际 ${loadLatency}ms`)
assert.ok(cacheLatency < 1000, `catalog 读缓存应 <1s，实际 ${cacheLatency}ms`)
//#endregion

//#region 落盘样例
const sample = {
  capturedAt: new Date().toISOString(),
  upstreamRoundTripMs: elapsed,
  catalogReadLatencyMs: cacheLatency,
  loadReadLatencyMs: loadLatency,
  responseEnvelope: second.envelope,
  groupSummary: value.groups.map((g) => ({ label: g.label, count: g.models.length })),
}
const out = join(root, 'test', 'e2e-sample.json')
writeFileSync(out, JSON.stringify(sample, null, 2) + '\n', 'utf8')
console.log(`[e2e] 样例已写入 ${out}`)
//#endregion

console.log('\n[e2e] 分组视图（host 已排好序）：')
for (const group of value.groups) {
  console.log(`  ${group.label}`)
  for (const model of group.models) {
    const pct = model.utilization === null ? '—' : model.utilization.toFixed(1) + '%'
    console.log(
      `    ${model.id.padEnd(24)} ${model.state.padEnd(8)} ${pct.padStart(6)}  ${model.free ? 'FREE' : '    '}`,
    )
  }
}

fake.disposeAll()
console.log(`\nPASS  e2e 通过，总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
