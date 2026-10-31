/**
 * dsh-amd-model-load — host 半身装配测试（假 ctx 驱动 apply，零依赖）。
 *
 * 验证的是「apply 真的把东西挂上去了」，不是「cordis 本身能跑」：
 *   - ctx.inject(['connection','webServer'], cb) 被调用（延迟注册，不是 ctx.get）
 *   - cb 里 webServer.register 收到 kind:'prefix' + 正确 path
 *   - register 返回的 disposer 被 scope.effect 收走，dispose 时路由真被摘掉
 *   - 轮询器进 effect，dispose 时真停表（interval 不泄漏）
 *   - handler 经完整 HTTP 路径（serve）返回 {type:"server-response", result:{ok:true,value:{...}}}
 *   - 信封契约：method 与 endpoint 不符 → gateway/bad-request；非 JSON → 415；非 POST → 404；
 *     requestRejection 非 undefined → 直接回该状态码
 *
 * 跑法：`node test/host.test.mjs`
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
    console.log(`       ${error instanceof Error ? error.stack : String(error)}`)
  }
}

function section(title) {
  console.log(`\n# ${title}`)
}

//#region 假 ctx / 假 req-res
/**
 * 造一个假 ctx，记录 inject / effect / register 的全部交互。
 *
 * 关键：`inject` 是**记录**而不是立即执行 —— 这样才能断言「用的是延迟注册」。
 * 需要真跑时显式调 `fake.flushInject()`。
 */
function fakeCtx() {
  const effects = []
  const injects = []
  const registrations = []
  const logs = []

  const ctx = {
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
      return disposer
    },
    inject(deps, cb) {
      injects.push({ deps, cb })
      // 不立即调用：模拟 carrier 尚未就绪。
      return () => {}
    },
    get() {
      // 组合期拿不到服务 —— 这正是不能直接 ctx.get('webServer') 的原因。
      return undefined
    },
  }

  const fake = {
    ctx,
    effects,
    injects,
    registrations,
    logs,
    /** 模拟 carrier 起来了，执行所有延迟注册回调。 */
    flushInject() {
      const scope = {
        connection: {
          requestRejection: () => undefined,
        },
        webServer: {
          register(spec) {
            registrations.push(spec)
            let active = true
            return () => {
              active = false
              spec.disposed = true
            }
          },
        },
        effect(fn, label) {
          const disposer = fn()
          effects.push({ label, disposer })
          return disposer
        },
      }
      for (const { cb } of injects) cb(scope)
      return scope
    },
    /** 逆序执行全部 disposer，模拟插件卸载。 */
    disposeAll() {
      for (const { disposer } of [...effects].reverse()) {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  return fake
}

/** 假 IncomingMessage：可迭代 body + headers + method + url。 */
function fakeRequest({ method = 'POST', url = '/', headers = {}, body = '' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    destroy() {
      this.destroyed = true
    },
  }
}

/** 假 ServerResponse：记录 writeHead 与 end。 */
function fakeResponse() {
  const listeners = new Map()
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    ended: false,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers ?? null
    },
    end(body) {
      res.ended = true
      if (typeof body === 'string') res.body = body
    },
    on(event, fn) {
      listeners.set(event, fn)
    },
    off(event) {
      listeners.delete(event)
    },
  }
  return res
}

/** 组装一个标准 client-request 信封请求。 */
function rpcRequest(channel, method, payload = {}, extra = {}) {
  return fakeRequest({
    method: 'POST',
    url: `${channel}/${method}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method, payload }),
    ...extra,
  })
}

/** 从响应体里解出 result。 */
function parseResult(res) {
  const envelope = JSON.parse(res.body)
  return { envelope, result: envelope.result }
}
//#endregion

// 动态 import：被测模块 import 了 @deepseek-ai/schemastery，
// 工作区无 node_modules 时需要临时桩（见 test/README 或 M1-REPORT.md）。
let mod
try {
  mod = await import('../lib/index.js')
} catch (error) {
  console.error('\n无法 import lib/index.js：' + error.message)
  console.error('工作区无 node_modules 时，schemastery 由宿主 host-module-fallback 兜底，裸 node 会 ERR_MODULE_NOT_FOUND。')
  console.error('请先用 `node test/with-stub.mjs`（临时桩，验完删除）或 M1-REPORT.md 里的命令。')
  process.exit(2)
}

/**
 * 离线 fetch：所有上游请求都返回 fixtures 里的真实样本，绝不联网。
 *
 * 为什么必须注入：真实 load 端点要 ~26 秒，装配测试会被拖到分钟级；
 * 而且 CI/离线环境根本跑不了。`apply(ctx, config, {fetchImpl})` 就是为这个开的注入口。
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const FULL_CATALOG = JSON.parse(readFileSync(join(FIXTURES, 'full-catalog.json'), 'utf8'))
const LOAD_FIXTURE = JSON.parse(readFileSync(join(FIXTURES, 'load.json'), 'utf8'))

const OFFLINE_FETCH = async (url) => {
  if (url.includes('section=dedicated')) {
    return { ok: true, status: 200, json: async () => FULL_CATALOG }
  }
  if (url.includes('tokenfactory/load')) {
    return { ok: true, status: 200, json: async () => LOAD_FIXTURE }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

//#region 装配
section('apply 装配')

await test('inject 保持为空数组（M0 已验证 inject=[] 能加载）', () => {
  assert.deepEqual(mod.inject, [])
})

await test('Config 七个字段且默认值正确（M3 把 pollMs 改成 10 分钟）', () => {
  const cfg = mod.Config
  assert.ok(cfg, 'Config 应存在')
  // 用户明确要求：轮询间隔 10 分钟
  assert.equal(cfg({}).pollMs, 600_000)
  assert.equal(cfg({}).timeoutMs, 40_000)
  assert.equal(cfg({}).loadUrl, 'https://developer.amd.com.cn/radeon/api/tokenfactory/load')
  // 11 分钟 = pollMs + 1 分钟余量
  assert.equal(cfg({}).staleAfterMs, 660_000)
  // 目录 6 小时
  assert.equal(cfg({}).catalogPollMs, 21_600_000)
  assert.equal(cfg({}).catalogUrl, 'https://developer.amd.com.cn/radeon/api/tokenfactory/bootstrap?section=dedicated')
  assert.equal(cfg({}).catalogFallbackUrl, 'https://developer.amd.com.cn/radeon/api/tokenfactory/bootstrap?directory=true')
  assert.equal(cfg({}).catalogTimeoutMs, 20_000)
})

await test('apply 用 ctx.inject([...]) 延迟注册，不直接 ctx.get', () => {
  const fake = fakeCtx()
  mod.apply(fake.ctx, { pollMs: 0, catalogPollMs: 0 }, { fetchImpl: OFFLINE_FETCH })
  assert.equal(fake.injects.length, 1, '应恰好有一次延迟注册')
  assert.deepEqual(fake.injects[0].deps, ['connection', 'webServer'])
  // 未 flush 前不应有任何路由（证明没有在组合期硬注册）
  assert.equal(fake.registrations.length, 0)
  fake.disposeAll()
})

await test('flush 后 webServer.register 收到 kind:prefix + path:/dsh-amd-model-load', () => {
  const fake = fakeCtx()
  mod.apply(fake.ctx, { pollMs: 0, catalogPollMs: 0 }, { fetchImpl: OFFLINE_FETCH })
  fake.flushInject()
  assert.equal(fake.registrations.length, 1)
  assert.equal(fake.registrations[0].kind, 'prefix')
  assert.equal(fake.registrations[0].path, '/dsh-amd-model-load')
  assert.equal(typeof fake.registrations[0].handler, 'function')
  fake.disposeAll()
})

await test('dispose 摘掉路由并停表', () => {
  const fake = fakeCtx()
  mod.apply(fake.ctx, { pollMs: 0, catalogPollMs: 0 }, { fetchImpl: OFFLINE_FETCH })
  fake.flushInject()
  fake.disposeAll()
  assert.equal(fake.registrations[0].disposed, true, 'dispose 后路由应被摘掉')
})
//#endregion

//#region handler 契约
section('handler 返回结构')

/** 建一个装配好、且已注入一份成功快照的环境。 */
async function mounted() {
  const fake = fakeCtx()
  mod.apply(fake.ctx, { pollMs: 0, catalogPollMs: 0 }, { fetchImpl: OFFLINE_FETCH })
  const scope = fake.flushInject()
  const handler = fake.registrations[0].handler
  return { fake, scope, handler }
}

await test('load 端点：200 + server-response 信封 + ok:true + value 四字段', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'load'), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json')
  const { envelope, result } = parseResult(res)
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, 'rpc-1')
  assert.equal(result.ok, true)
  // value 的形状就是 client 消费的契约
  const value = result.value
  assert.deepEqual(Object.keys(value).sort(), ['error', 'models', 'scope', 'stale', 'ts'])
  assert.equal(typeof value.stale, 'boolean')
  assert.equal(typeof value.models, 'object')
  // 注入的 fetch 是同步的，启动时那次拉取已完成 ⇒ ts 有值、stale 为 false。
  // （真实环境上游要 26s，此时会是 ts=null / stale=true；两种都合法，见 M3-REPORT）
  assert.equal(typeof value.ts, 'number')
  assert.equal(value.stale, false)
  assert.ok(Object.keys(value.models).length > 0, '应已拿到负载数据')
  fake.disposeAll()
})

await test('refresh 端点：强制刷一次后返回 ok:true', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'refresh'), res)
  const { result } = parseResult(res)
  assert.equal(result.ok, true)
  // M3 起 refresh 同时刷负载与目录，返回 catalog 形状（含 groups）——
  // 因为设置页只消费 catalog，手动刷新必须让它看到新数据。
  assert.deepEqual(
    Object.keys(result.value).sort(),
    ['error', 'groups', 'loadStale', 'loadTs', 'source', 'stale', 'ts'],
  )
  fake.disposeAll()
})

await test('catalog 端点：返回分组结果，5 组 15 个模型、顺序与官方分类一致', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'catalog'), res)

  assert.equal(res.statusCode, 200)
  const { result } = parseResult(res)
  assert.equal(result.ok, true)
  const value = result.value
  assert.deepEqual(
    Object.keys(value).sort(),
    ['error', 'groups', 'loadStale', 'loadTs', 'source', 'stale', 'ts'],
  )
  assert.equal(value.groups.length, 5)
  assert.deepEqual(
    value.groups.map((g) => g.label),
    ['VLM (Vision)', 'LLM (Text)', 'Decision (Classifier)', 'TTS (Speech)', 'OCR (Document)'],
  )
  assert.deepEqual(value.groups.map((g) => g.models.length), [7, 3, 3, 1, 1])
  assert.equal(value.groups.flatMap((g) => g.models).length, 15)
  fake.disposeAll()
})

await test('catalog 端点：12 个 FREE 徽章，3 个 Decision 模型无徽章', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'catalog'), res)
  const all = parseResult(res).result.value.groups.flatMap((g) => g.models)
  assert.equal(all.filter((m) => m.free).length, 12)
  const noBadge = all.filter((m) => !m.free).map((m) => m.id).sort()
  assert.deepEqual(noBadge, ['Clef', 'd3', 'd3-flash'])
  fake.disposeAll()
})

await test('catalog 端点：组内按 utilization 升序，无负载数据的排在组末', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'catalog'), res)
  const groups = parseResult(res).result.value.groups

  for (const group of groups) {
    const withLoad = group.models.filter((m) => m.utilization !== null)
    const withoutLoad = group.models.filter((m) => m.utilization === null)
    // 升序
    for (let i = 1; i < withLoad.length; i += 1) {
      assert.ok(
        withLoad[i - 1].utilization <= withLoad[i].utilization,
        `${group.label} 组内未升序：${withLoad.map((m) => m.utilization)}`,
      )
    }
    // 无数据的全部在末尾
    if (withoutLoad.length > 0 && withLoad.length > 0) {
      const lastWithLoad = group.models.lastIndexOf(withLoad[withLoad.length - 1])
      const firstWithoutLoad = group.models.indexOf(withoutLoad[0])
      assert.ok(
        lastWithLoad < firstWithoutLoad,
        `${group.label} 的无数据项必须排在组末：${group.models.map((m) => m.id)}`,
      )
    }
  }
  fake.disposeAll()
})

await test('catalog 端点：VLM 组的具体顺序（真实样本）', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'catalog'), res)
  const vlm = parseResult(res).result.value.groups.find((g) => g.label === 'VLM (Vision)')
  assert.deepEqual(vlm.models.map((m) => m.id), [
    'MiniCPM-V-4.7-35B-A3B', // 3.7%
    'Gemma-4-31B-IT', // 18.0%
    'Qwen3.8-27B', // 20.1%
    'Qwen3.8-Flash-Next', // 69.5%
    'DeepSeek-V4.1-Flash', // 100.0%，同 100 按 id 字典序
    'MiMo-V2.6-Flash', // 100.0%
    'MiniCPM-V-4.7-1B', // 无数据 → 组末
  ])
  fake.disposeAll()
})

await test('catalog 端点：目录未取到时仍有 fallback 分组（UI 不空白）', async () => {
  // 用一个只让 load 成功、目录全失败的 fetch
  const fake = fakeCtx()
  mod.apply(
    fake.ctx,
    { pollMs: 0, catalogPollMs: 0 },
    {
      fetchImpl: async (url) =>
        url.includes('tokenfactory/load')
          ? { ok: true, status: 200, json: async () => LOAD_FIXTURE }
          : { ok: false, status: 500, json: async () => ({}) },
    },
  )
  fake.flushInject()
  const handler = fake.registrations[0].handler
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'catalog'), res)
  const value = parseResult(res).result.value
  assert.equal(value.source, 'fallback', '应标出数据源是 fallback')
  assert.equal(value.groups.length, 5, 'fallback 目录也有 5 组')
  assert.equal(value.groups.flatMap((g) => g.models).length, 15)
  fake.disposeAll()
})

await test('catalog 端点：分组排序随负载快照变化（换一份负载 → 顺序跟着变）', async () => {
  const fake = fakeCtx()
  // 反转负载：原本空闲的变满载，原本满载的变空闲
  const flipped = {
    models: Object.fromEntries(
      Object.entries(LOAD_FIXTURE.models).map(([id, entry]) => [
        id,
        { ...entry, utilization: entry.utilization === null ? 0 : 100 - entry.utilization },
      ]),
    ),
    scope: 'fleet',
  }
  mod.apply(
    fake.ctx,
    { pollMs: 0, catalogPollMs: 0 },
    {
      fetchImpl: async (url) =>
        url.includes('section=dedicated')
          ? { ok: true, status: 200, json: async () => FULL_CATALOG }
          : { ok: true, status: 200, json: async () => flipped },
    },
  )
  fake.flushInject()
  const handler = fake.registrations[0].handler
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'catalog'), res)
  const vlm = parseResult(res).result.value.groups.find((g) => g.label === 'VLM (Vision)')
  // 原本 3.7% 的 MiniCPM-V-4.7-35B-A3B 现在 96.3%，应该排到后面
  assert.equal(vlm.models[0].id, 'DeepSeek-V4.1-Flash', `实际首位：${vlm.models[0].id}`)
  fake.disposeAll()
})

await test('refresh 端点：同时刷负载与目录，返回 catalog 形状', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'refresh'), res)
  const { result } = parseResult(res)
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.value.groups), 'refresh 返回 catalog 形状（含 groups）')
  assert.equal(result.value.groups.length, 5)
  fake.disposeAll()
})

await test('未知 method 不可能到达 handler（被 serve 的 endpoint 校验拦下）', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'nope'), res)
  const { result } = parseResult(res)
  // 走到 handler 的 default 分支（因为 method 与 endpoint 都是 nope，校验通过）
  assert.equal(result.ok, false)
  assert.match(result.error.message, /unknown endpoint/)
  fake.disposeAll()
})
//#endregion

//#region serve 的 HTTP 层校验
section('serve 信封与传输校验')

await test('method 与 endpoint 不符 → gateway/bad-request', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(
    fakeRequest({
      method: 'POST',
      url: '/dsh-amd-model-load/load',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'refresh', payload: {} }),
    }),
    res,
  )
  const { envelope, result } = parseResult(res)
  assert.equal(envelope.rpcId, 'x')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'gateway/bad-request')
  assert.match(result.error.message, /does not match endpoint/)
  fake.disposeAll()
})

await test('非 POST → 404 not found', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(fakeRequest({ method: 'GET', url: '/dsh-amd-model-load/load' }), res)
  assert.equal(res.statusCode, 404)
  assert.equal(res.body, 'not found')
  fake.disposeAll()
})

await test('路径不在通道下 → 404', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(
    fakeRequest({
      method: 'POST',
      url: '/other/load',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    res,
  )
  assert.equal(res.statusCode, 404)
  fake.disposeAll()
})

await test('content-type 不是 application/json → 415', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(
    fakeRequest({
      method: 'POST',
      url: '/dsh-amd-model-load/load',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    }),
    res,
  )
  assert.equal(res.statusCode, 415)
  fake.disposeAll()
})

await test('content-type 带 charset 仍接受', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(
    fakeRequest({
      method: 'POST',
      url: '/dsh-amd-model-load/load',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'load', payload: {} }),
    }),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(parseResult(res).result.ok, true)
  fake.disposeAll()
})

await test('body 不是 JSON → 400', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(
    fakeRequest({
      method: 'POST',
      url: '/dsh-amd-model-load/load',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    }),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.equal(res.body, 'body is not JSON')
  fake.disposeAll()
})

await test('信封 type 不对 → gateway/bad-request（rpcId 回填 invalid-request）', async () => {
  const { fake, handler } = await mounted()
  const res = fakeResponse()
  await handler(
    fakeRequest({
      method: 'POST',
      url: '/dsh-amd-model-load/load',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'server-response', method: 'load', payload: {} }),
    }),
    res,
  )
  const { envelope, result } = parseResult(res)
  assert.equal(envelope.rpcId, 'invalid-request')
  assert.equal(result.error.code, 'gateway/bad-request')
  fake.disposeAll()
})

await test('requestRejection 返回 401 → 原样回写并 end', async () => {
  const fake = fakeCtx()
  mod.apply(fake.ctx, { pollMs: 0, catalogPollMs: 0 }, { fetchImpl: OFFLINE_FETCH })
  const scope = fake.flushInject()
  scope.connection.requestRejection = () => 401
  const handler = fake.registrations[0].handler
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'load'), res)
  assert.equal(res.statusCode, 401)
  assert.equal(res.body, 'unauthorized')
  fake.disposeAll()
})

await test('requestRejection 返回 403 → forbidden', async () => {
  const fake = fakeCtx()
  mod.apply(fake.ctx, { pollMs: 0, catalogPollMs: 0 }, { fetchImpl: OFFLINE_FETCH })
  const scope = fake.flushInject()
  scope.connection.requestRejection = () => 403
  const handler = fake.registrations[0].handler
  const res = fakeResponse()
  await handler(rpcRequest('/dsh-amd-model-load', 'load'), res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body, 'forbidden')
  fake.disposeAll()
})
//#endregion

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
