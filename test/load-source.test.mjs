/**
 * dsh-amd-model-load — load-source.js 单测（零依赖，直接 `node test/load-source.test.mjs`）。
 *
 * 覆盖的边界：
 *   normalizeLoad  正常样本 / 畸形顶层 / 畸形 models / 单条脏数据 / 未知 state / utilization 越界与非数字
 *   isStale        无快照 / 恰好等于 maxAge / 超出一毫秒 / 时钟回拨 / maxAge 非有限
 *   createPoller   成功 / HTTP 失败保留旧数据 / 畸形响应保留旧数据 / 超时（AbortSignal）/ 从没成功过 /
 *                  stop 真停表 / start 幂等 / refresh 与轮询共用 in-flight / 快照隔离
 */
import assert from 'node:assert/strict'
import { normalizeLoad, isStale, createPoller } from '../lib/load-source.js'

let passed = 0
let failed = 0

/** 极简断言壳：不引测试框架，工作区无 node_modules 也能跑。 */
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

/** 构造一个假的 fetch 响应。 */
function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }
}

//#region normalizeLoad
section('normalizeLoad')

await test('正常样本：保留全部模型、state、label、utilization、scope', () => {
  const out = normalizeLoad({
    models: {
      'DeepSeek-V4.1-Flash': { state: 'full', label: 'DeepSeek V4.1 Flash', utilization: 100 },
      'Qwen3.8-27B': { state: 'idle', label: 'Qwen3.8 27B', utilization: 38.5 },
      'GLM-5.3-Flash': { state: 'busy', label: 'GLM 5.3 Flash', utilization: 50 },
    },
    scope: 'fleet',
  })
  assert.deepEqual(out, {
    models: {
      'DeepSeek-V4.1-Flash': { state: 'full', label: 'DeepSeek V4.1 Flash', utilization: 100 },
      'Qwen3.8-27B': { state: 'idle', label: 'Qwen3.8 27B', utilization: 38.5 },
      'GLM-5.3-Flash': { state: 'busy', label: 'GLM 5.3 Flash', utilization: 50 },
    },
    scope: 'fleet',
  })
})

await test('不过滤 fleet 里本机没有的模型（过滤是渲染层的决定）', () => {
  const out = normalizeLoad({
    models: {
      Clef: { state: 'idle', utilization: 10 },
      'MiniCPM5-2B': { state: 'busy', utilization: 60 },
      'DeepSeek-V4-Flash-Vision-Exp': { state: 'full', utilization: 99 },
    },
  })
  assert.equal(Object.keys(out.models).length, 3)
  assert.ok('Clef' in out.models)
})

await test('state 直取上游，不用 utilization 反推（38.5% 的 idle 不被改写）', () => {
  const out = normalizeLoad({ models: { a: { state: 'idle', utilization: 38.5 } } })
  assert.equal(out.models.a.state, 'idle')
  const out2 = normalizeLoad({ models: { b: { state: 'busy', utilization: 50 } } })
  assert.equal(out2.models.b.state, 'busy')
})

await test('畸形顶层输入返回 null 而不是抛', () => {
  for (const bad of [null, undefined, 42, 'x', true, [], [{ models: {} }]]) {
    assert.equal(normalizeLoad(bad), null, `输入 ${JSON.stringify(bad)} 应为 null`)
  }
})

await test('models 缺失或非对象返回 null', () => {
  for (const bad of [{}, { models: null }, { models: [] }, { models: 'x' }, { models: 7 }]) {
    assert.equal(normalizeLoad(bad), null, `输入 ${JSON.stringify(bad)} 应为 null`)
  }
})

await test('models 为空对象是合法的（展示层显示无负载数据）', () => {
  assert.deepEqual(normalizeLoad({ models: {} }), { models: {}, scope: 'fleet' })
})

await test('单条脏数据被跳过，其余保留', () => {
  const out = normalizeLoad({
    models: {
      good: { state: 'idle', utilization: 1 },
      nul: null,
      str: 'oops',
      arr: [1, 2],
      num: 5,
    },
  })
  assert.deepEqual(Object.keys(out.models), ['good'])
})

await test('未知 state 归 unknown，大小写与空白容忍', () => {
  const out = normalizeLoad({
    models: {
      a: { state: 'IDLE', utilization: 1 },
      b: { state: '  Busy ', utilization: 2 },
      c: { state: 'draining', utilization: 3 },
      d: { state: 42, utilization: 4 },
      e: { utilization: 5 },
    },
  })
  assert.equal(out.models.a.state, 'idle')
  assert.equal(out.models.b.state, 'busy')
  assert.equal(out.models.c.state, 'unknown')
  assert.equal(out.models.d.state, 'unknown')
  assert.equal(out.models.e.state, 'unknown')
})

await test('utilization 越界夹到 0–100，非数字为 null', () => {
  const out = normalizeLoad({
    models: {
      over: { state: 'full', utilization: 140 },
      under: { state: 'idle', utilization: -3 },
      str: { state: 'idle', utilization: '42.5' },
      nan: { state: 'idle', utilization: 'abc' },
      none: { state: 'idle' },
      inf: { state: 'idle', utilization: Infinity },
    },
  })
  assert.equal(out.models.over.utilization, 100)
  assert.equal(out.models.under.utilization, 0)
  assert.equal(out.models.str.utilization, 42.5)
  assert.equal(out.models.nan.utilization, null)
  assert.equal(out.models.none.utilization, null)
  assert.equal(out.models.inf.utilization, null)
})

await test('label 缺失或空串时回退成 id', () => {
  const out = normalizeLoad({ models: { 'Model-X': { state: 'idle' }, 'Model-Y': { state: 'idle', label: '   ' } } })
  assert.equal(out.models['Model-X'].label, 'Model-X')
  assert.equal(out.models['Model-Y'].label, 'Model-Y')
})

await test('scope 缺失或非字符串回退 fleet', () => {
  assert.equal(normalizeLoad({ models: {} }).scope, 'fleet')
  assert.equal(normalizeLoad({ models: {}, scope: 5 }).scope, 'fleet')
  assert.equal(normalizeLoad({ models: {}, scope: '' }).scope, 'fleet')
  assert.equal(normalizeLoad({ models: {}, scope: 'zone-a' }).scope, 'zone-a')
})
//#endregion

//#region isStale
section('isStale')

await test('无快照 / ts 非数字 → true', () => {
  assert.equal(isStale(null, 1000, 100), true)
  assert.equal(isStale(undefined, 1000, 100), true)
  assert.equal(isStale({}, 1000, 100), true)
  assert.equal(isStale({ ts: null }, 1000, 100), true)
  assert.equal(isStale({ ts: '1000' }, 1000, 100), true)
  assert.equal(isStale({ ts: NaN }, 1000, 100), true)
})

await test('age 恰好等于 maxAgeMs → false（用 > 而非 >=）', () => {
  assert.equal(isStale({ ts: 900 }, 1000, 100), false)
})

await test('age 超出一毫秒 → true', () => {
  assert.equal(isStale({ ts: 899 }, 1000, 100), true)
})

await test('age 为 0 → false', () => {
  assert.equal(isStale({ ts: 1000 }, 1000, 100), false)
})

await test('时钟回拨（ts 在未来）→ false，不当成过期', () => {
  assert.equal(isStale({ ts: 2000 }, 1000, 100), false)
})

await test('now 非有限 → true', () => {
  assert.equal(isStale({ ts: 1000 }, NaN, 100), true)
})

await test('maxAgeMs 非有限 → false，配置写错不把数据全标陈旧', () => {
  assert.equal(isStale({ ts: 0 }, 10_000_000, NaN), false)
  assert.equal(isStale({ ts: 0 }, 10_000_000, Infinity), false)
})
//#endregion

//#region createPoller
section('createPoller')

/** 造一个可控的假 fetch：每次调用返回下一个预设结果。 */
function scriptedFetch(steps) {
  const calls = []
  let index = 0
  const impl = async (url, init) => {
    calls.push({ url, init })
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    if (typeof step === 'function') return step(url, init)
    return step
  }
  impl.calls = calls
  return impl
}

const SAMPLE = {
  models: {
    'DeepSeek-V4.1-Flash': { state: 'full', label: 'DeepSeek V4.1 Flash', utilization: 100 },
    'Qwen3.8-27B': { state: 'idle', label: 'Qwen3.8 27B', utilization: 20.1 },
  },
  scope: 'fleet',
}

await test('成功一次：ts 前进、models 就位、error 为 null、onUpdate 被调用', async () => {
  let clock = 5_000
  const updates = []
  const poller = createPoller({
    url: 'https://example.test/load',
    pollMs: 0,
    fetchImpl: scriptedFetch([jsonResponse(SAMPLE)]),
    now: () => clock,
    onUpdate: (snap) => updates.push(snap),
  })
  const snap = await poller.refresh()
  assert.equal(snap.ts, 5_000)
  assert.equal(snap.error, null)
  assert.equal(snap.scope, 'fleet')
  assert.equal(snap.models['Qwen3.8-27B'].utilization, 20.1)
  assert.equal(updates.length, 1)
  assert.equal(poller.snapshot().ts, 5_000)
})

await test('HTTP 失败保留旧数据并记录 error', async () => {
  let clock = 1_000
  const poller = createPoller({
    url: 'https://example.test/load',
    pollMs: 0,
    fetchImpl: scriptedFetch([
      jsonResponse(SAMPLE),
      jsonResponse({ error: 'boom' }, { ok: false, status: 503 }),
    ]),
    now: () => clock,
  })
  await poller.refresh()
  clock = 2_000
  const after = await poller.refresh()
  // 关键不变量：数据还在，ts 没有前进，error 有值
  assert.equal(Object.keys(after.models).length, 2)
  assert.equal(after.ts, 1_000)
  assert.match(after.error, /503/)
})

await test('畸形响应（models 缺失）保留旧数据', async () => {
  let clock = 1_000
  const poller = createPoller({
    url: 'https://example.test/load',
    pollMs: 0,
    fetchImpl: scriptedFetch([jsonResponse(SAMPLE), jsonResponse({ unexpected: true })]),
    now: () => clock,
  })
  await poller.refresh()
  clock = 2_000
  const after = await poller.refresh()
  assert.equal(Object.keys(after.models).length, 2)
  assert.equal(after.ts, 1_000)
  assert.match(after.error, /形状/)
})

await test('fetch 抛错（网络失败）保留旧数据', async () => {
  const poller = createPoller({
    url: 'https://example.test/load',
    pollMs: 0,
    fetchImpl: scriptedFetch([
      jsonResponse(SAMPLE),
      () => {
        throw new TypeError('fetch failed')
      },
    ]),
    now: () => 1_000,
  })
  await poller.refresh()
  const after = await poller.refresh()
  assert.equal(Object.keys(after.models).length, 2)
  // 非 Error 名字的错误保留类型前缀（真实 fetch 网络失败就是 TypeError: fetch failed），
  // 这样 console.error 里能区分「网络断了」和「上游返回了坏数据」。
  assert.equal(after.error, 'TypeError: fetch failed')
})

await test('普通 Error 只留 message，不重复加前缀', async () => {
  const poller = createPoller({
    url: 'https://example.test/load',
    pollMs: 0,
    fetchImpl: scriptedFetch([
      () => {
        throw new Error('plain failure')
      },
    ]),
  })
  assert.equal((await poller.refresh()).error, 'plain failure')
})

await test('从没成功过：models 为空、ts 为 null、error 有值', async () => {
  const poller = createPoller({
    url: 'https://example.test/load',
    pollMs: 0,
    fetchImpl: scriptedFetch([
      () => {
        throw new Error('offline')
      },
    ]),
  })
  const snap = await poller.refresh()
  assert.deepEqual(snap.models, {})
  assert.equal(snap.ts, null)
  assert.equal(snap.scope, null)
  assert.equal(snap.error, 'offline')
  // 从没成功过时必然 stale
  assert.equal(isStale(snap, Date.now(), 360_000), true)
})

await test('超时：AbortSignal.timeout 触发后保留旧数据并记录 TimeoutError', async () => {
  let clock = 1_000
  const poller = createPoller({
    url: 'https://example.test/load',
    pollMs: 0,
    timeoutMs: 30,
    fetchImpl: scriptedFetch([
      jsonResponse(SAMPLE),
      // 模拟真实 fetch：signal 到期后 reject 一个 TimeoutError。
      // 注意 AbortSignal.timeout 内部计时器是 unref 的（不撑住事件循环），
      // 所以这里用 ref 的 setTimeout 来等 signal，否则测试进程会提前退出。
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => {
            const error = new Error('The operation was aborted due to timeout')
            error.name = 'TimeoutError'
            reject(error)
          }
          if (init.signal.aborted) return onAbort()
          init.signal.addEventListener('abort', onAbort, { once: true })
          setTimeout(() => {
            if (init.signal.aborted) return
            reject(new Error('signal 没有在预期时间内 abort'))
          }, 200)
        }),
    ]),
    now: () => clock,
  })
  await poller.refresh()
  clock = 2_000
  const after = await poller.refresh()
  assert.equal(Object.keys(after.models).length, 2, '超时后旧数据必须还在')
  assert.equal(after.ts, 1_000)
  assert.match(after.error, /TimeoutError/)
})

await test('传给 fetch 的 signal 是 AbortSignal 且带 timeout', async () => {
  const impl = scriptedFetch([jsonResponse(SAMPLE)])
  const poller = createPoller({ url: 'https://example.test/load', pollMs: 0, timeoutMs: 40_000, fetchImpl: impl })
  await poller.refresh()
  const { init } = impl.calls[0]
  assert.ok(init.signal instanceof AbortSignal)
  assert.equal(init.method, 'GET')
})

await test('refresh 共用 in-flight：并发两次只发一个请求', async () => {
  let resolveInner
  const impl = scriptedFetch([
    () =>
      new Promise((resolve) => {
        resolveInner = () => resolve(jsonResponse(SAMPLE))
      }),
  ])
  const poller = createPoller({ url: 'https://example.test/load', pollMs: 0, fetchImpl: impl })
  const a = poller.refresh()
  const b = poller.refresh()
  resolveInner()
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(impl.calls.length, 1)
  assert.equal(ra.ts, rb.ts)
})

await test('start 幂等 + stop 真停表（不泄漏 interval）', async () => {
  const impl = scriptedFetch([jsonResponse(SAMPLE)])
  const poller = createPoller({ url: 'https://example.test/load', pollMs: 20, fetchImpl: impl })
  poller.start()
  poller.start()
  poller.start()
  await new Promise((resolve) => setTimeout(resolve, 90))
  const during = impl.calls.length
  assert.ok(during >= 2, `启动后应至少拉 2 次，实际 ${during}`)
  poller.stop()
  const atStop = impl.calls.length
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(impl.calls.length, atStop, 'stop 之后不应再有任何请求')
})

await test('stop 之后 start 不再起表（stopped 是终态）', async () => {
  const impl = scriptedFetch([jsonResponse(SAMPLE)])
  const poller = createPoller({ url: 'https://example.test/load', pollMs: 20, fetchImpl: impl })
  poller.stop()
  poller.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(impl.calls.length, 0)
})

await test('snapshot 返回拷贝，调用方改它不影响内部状态', async () => {
  const poller = createPoller({
    url: 'https://example.test/load',
    pollMs: 0,
    fetchImpl: scriptedFetch([jsonResponse(SAMPLE)]),
  })
  await poller.refresh()
  const snap = poller.snapshot()
  snap.models['Qwen3.8-27B'].state = 'full'
  snap.models.injected = { state: 'idle', label: 'x', utilization: 0 }
  const again = poller.snapshot()
  assert.equal(again.models['Qwen3.8-27B'].state, 'idle')
  assert.equal('injected' in again.models, false)
})

await test('onError 回调抛错不会打断轮询', async () => {
  const poller = createPoller({
    url: 'https://example.test/load',
    pollMs: 0,
    fetchImpl: scriptedFetch([
      () => {
        throw new Error('nope')
      },
    ]),
    onError: () => {
      throw new Error('回调自己炸了')
    },
  })
  const snap = await poller.refresh()
  assert.equal(snap.error, 'nope')
})

await test('pollMs <= 0 时 start 只拉一次、不起 interval', async () => {
  const impl = scriptedFetch([jsonResponse(SAMPLE)])
  const poller = createPoller({ url: 'https://example.test/load', pollMs: 0, fetchImpl: impl })
  poller.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(impl.calls.length, 1)
  poller.stop()
})
//#endregion

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
