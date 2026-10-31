/**
 * dsh-amd-model-load — host half (M3).
 *
 * 职责：后台轮询 AMD Radeon TokenFactory 的**模型目录**与**免费模型负载**两个端点，
 * 把结果留在内存里，经一条 loopback RPC 通道暴露给浏览器半身。
 *
 * 为什么必须是「host 轮询 + client 读缓存」而不是 client 直接拉上游：
 *   - load 端点实测响应 ~26 秒，渲染路径上同步拉会让设置页卡死；
 *   - 目录是「bootstrap + 15 个详情」共 16 次请求，更不可能在浏览器里做；
 *   - 上游两个端点都要求 `Origin: https://developer.amd.com.cn`，跨源配置放在 host 更稳。
 * 因此 client 只调本地 RPC（毫秒级、打内存快照），上游拉取只发生在这里。
 *
 * M3 的两个节奏（用户明确要求）：
 *   - 负载 10 分钟一次（600000ms）：dsh 能导入的 VLM/LLM 都慢（十几到三十 tokens/s），
 *     繁忙度变化本就缓慢，5 分钟太密。
 *   - 目录 6 小时一次（21600000ms）：15 个模型的分类/徽章几乎不变。
 *
 * 两个已踩过的坑，本文件的写法是刻意规避的结果：
 *   1. `ctx.logger.info` 永不进 harness.log（dsh-desktop-log-bridge 的 exporter 只放行
 *      error/warn），要留痕必须 `console.log` / `console.error`。
 *   2. 路由必须用 `ctx.inject(['connection','webServer'], cb)` **延迟注册**：组合期
 *      carrier 未起，直接 `ctx.get('webServer')` 得到 undefined，路由会静默消失且无报错。
 *
 * RPC 契约（照抄 dsh-pause 的 mountRpcChannel，见其 lib/index.js 第 125–270 行）：
 *   请求  POST <channel>/<method>  content-type: application/json
 *         {type:"client-request", rpcId, method, payload}
 *   响应  {type:"server-response", rpcId, result:{ok:true,value}|{ok:false,error:{...}}}
 *   信任  connection.requestRejection(req) === undefined 才放行
 *   method 必须等于路径末段，否则回 gateway/bad-request
 *
 * @module dsh-amd-model-load
 */
import z from '@deepseek-ai/schemastery'
import { createPoller, isStale } from './load-source.js'
import { createCatalogSource, groupAndSort, DEFAULT_BOOTSTRAP_URL, DEFAULT_SHARED_URL } from './catalog.js'

/** 插件名即配置项 id，与 cordis.patch.yml 里的 name 一致。 */
export const name = 'dsh-amd-model-load'

/**
 * 本插件依赖的服务。
 *
 * 刻意留空：M0 已验证 `inject = []` 能加载，而 carrier（connection/webServer）在组合期
 * 尚未就绪。真正的依赖声明走 `ctx.inject([...], cb)` 延迟注册，见 apply 内注释。
 */
export const inject = []

/** AMD TokenFactory 免费模型负载端点。免 key，实测响应 ~26s。 */
export const DEFAULT_LOAD_URL = 'https://developer.amd.com.cn/radeon/api/tokenfactory/load'

/** 目录「一次拿全」端点（首选）。需 `Origin` 头，实测 0.37s / 58KB 返回 15 条 shared_models。 */
export const DEFAULT_CATALOG_URL = DEFAULT_SHARED_URL

/** RPC 通道前缀。client 侧必须以同一个字符串调用。 */
export const CHANNEL = '/dsh-amd-model-load'

/**
 * 请求体上限。本通道的请求体只有一个空对象，给 64 KiB 足够；
 * 远小于 dsh-pause 的 300 MiB（那个要传 base64 图片）。
 */
const MAX_BODY_BYTES = 65_536

/** 部署侧配置。 */
export const Config = z.object({
  /**
   * 负载轮询间隔（毫秒）。默认 **10 分钟**（用户明确要求）。
   * 理由：dsh 能导入的只有 VLM/LLM，都比较慢（十几到三十 tokens/s），繁忙度变化缓慢；
   * 而上游单次就要 ~26s，更密也没有意义。
   */
  pollMs: z.number().default(600_000),
  /** 单次请求超时（毫秒）。必须 ≥40s：实测响应 ~26s，低于它必然假超时。 */
  timeoutMs: z.number().default(40_000),
  /** 负载端点。留成配置项是为了上游改地址时不用改代码。 */
  loadUrl: z.string().default(DEFAULT_LOAD_URL),
  /**
   * 超过这个年龄的快照标为「陈旧」。默认 11 分钟 = pollMs + 1 分钟，
   * 留一分钟余量避免正常轮询间隙被误标（M1 的 6 分钟对应 5 分钟间隔，同一逻辑）。
   */
  staleAfterMs: z.number().default(660_000),
  /** 目录轮询间隔（毫秒）。分类与徽章几乎不变，默认 6 小时。 */
  catalogPollMs: z.number().default(21_600_000),
  /** 目录「一次拿全」端点（首选路径，返回 shared_models）。 */
  catalogUrl: z.string().default(DEFAULT_CATALOG_URL),
  /** 目录回退端点（cards + 逐卡 GET，需 `?directory=true` 才返回 cards）。 */
  catalogFallbackUrl: z.string().default(DEFAULT_BOOTSTRAP_URL),
  /** 目录请求超时（毫秒）。实测 bootstrap 0.18s、单详情 ~0.3s，20s 足够宽。 */
  catalogTimeoutMs: z.number().default(20_000),
})

//#region rpc channel（形状照抄 dsh-pause 的 mountRpcChannel / serve / reply）
/** 端点路径段的合法字符集，与官方 ENDPOINT_SEGMENT_PATTERN 一致。 */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/
/** 唯一接受的 content-type，与官方信封契约一致。 */
const JSON_MIME = 'application/json'

/** 请求体超限的标记错误，由 serve 决定如何回写与断开。 */
class PayloadTooLargeError extends Error {}

/**
 * 挂载 RPC 通道。webServer 或 connection 缺席时不挂载，插件其余功能不受影响。
 *
 * @param ctx - 插件上下文。
 * @param channel - 绝对通道前缀。
 * @param handler - `(endpoint, payload) => Promise<result>`，result 已是 `{ok,...}` 信封。
 * @param maxBodyBytes - 请求体上限。
 */
function mountRpcChannel(ctx, channel, handler, maxBodyBytes) {
  // 必须延迟注册：组合期 webServer 还没起，ctx.get 会拿到 undefined，
  // 而 register 一个 undefined 不会报错，路由就此静默消失。
  ctx.inject(['connection', 'webServer'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'prefix',
          path: channel,
          handler: (req, res) => serve(scope.connection, channel, handler, maxBodyBytes, req, res),
        }),
      `${channel}: rpc channel`,
    )
  })
}

/**
 * 处理一次 HTTP 请求：信任判定、端点解析、信封校验、结果回写。
 *
 * @param connection - connection 服务，用其信任判定。
 * @param channel - 本通道前缀。
 * @param handler - 端点处理器。
 * @param maxBodyBytes - 请求体上限。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function serve(connection, channel, handler, maxBodyBytes, req, res) {
  // 非 loopback / 非受信来源：requestRejection 返回数字，原样回写并断开。
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method !== 'POST') return missing(res)

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const prefix = `${channel}/`
  if (!pathname.startsWith(prefix)) return missing(res)
  const endpoint = pathname.slice(prefix.length)
  if (!endpoint.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && SEGMENT.test(part))) {
    return missing(res)
  }

  if (!isJsonContentType(req)) {
    res.writeHead(415)
    res.end('unsupported media type')
    return
  }

  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBodyBytes) return tooLarge(req, res)

  let raw
  try {
    raw = await readBody(req, maxBodyBytes)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return tooLarge(req, res)
    res.writeHead(400)
    res.end('body read failed')
    return
  }

  let message
  try {
    message = JSON.parse(raw)
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }

  const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
  if (message.type !== 'client-request' || typeof message.method !== 'string') {
    return reply(res, rpcId, {
      ok: false,
      error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} },
    })
  }
  if (message.method !== endpoint) {
    return reply(res, rpcId, {
      ok: false,
      error: {
        code: 'gateway/bad-request',
        message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: {},
      },
    })
  }

  const controller = new AbortController()
  const onClose = () => {
    controller.abort(new Error('client disconnected'))
  }
  res.on('close', onClose)

  let result
  try {
    result = await handler(endpoint, message.payload, controller.signal)
  } catch (error) {
    result = {
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
    }
  } finally {
    res.off('close', onClose)
  }
  reply(res, rpcId, result)
}

/** 路径不匹配或方法不符时统一 404，与官方未认领端点一致。 */
function missing(res) {
  res.writeHead(404)
  res.end('not found')
}

/** 回写一个 server-response 信封。 */
function reply(res, rpcId, result) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/** 先回 413 再销毁连接：顺序反了 socket 已断，413 永远发不出去。 */
function tooLarge(req, res) {
  res.writeHead(413, { connection: 'close' })
  res.end('payload too large')
  req.destroy()
}

/** content-type 必须声明为 application/json，charset 等参数可忽略。 */
function isJsonContentType(req) {
  const header = req.headers['content-type']
  if (typeof header !== 'string') return false
  const mime = header.split(';', 1)[0]
  return mime !== undefined && mime.trim().toLowerCase() === JSON_MIME
}

/** 读取并限长请求体，超限抛 PayloadTooLargeError，由调用方回写 413。 */
async function readBody(req, maxBodyBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > maxBodyBytes) throw new PayloadTooLargeError('rpc channel: request body exceeds limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
//#endregion

/**
 * 装配 host 半身：起两个轮询器（负载 + 目录）+ 挂 RPC 通道。
 *
 * @param ctx - cordis 上下文。
 * @param config - 已解析的 Config。
 */
export function apply(ctx, config, deps) {
  const pollMs = config?.pollMs ?? 600_000
  const timeoutMs = config?.timeoutMs ?? 40_000
  const loadUrl = config?.loadUrl ?? DEFAULT_LOAD_URL
  const staleAfterMs = config?.staleAfterMs ?? 660_000
  const catalogPollMs = config?.catalogPollMs ?? 21_600_000
  const catalogUrl = config?.catalogUrl ?? DEFAULT_CATALOG_URL
  const catalogFallbackUrl = config?.catalogFallbackUrl ?? DEFAULT_BOOTSTRAP_URL
  const catalogTimeoutMs = config?.catalogTimeoutMs ?? 20_000

  /**
   * 注入点：cordis 调 apply(ctx, config) 时 deps 为 undefined，走真实 fetch。
   * 单测传 `{fetchImpl}` 就能完全离线跑装配测试 —— 否则每个用例都要等 26 秒上游响应。
   */
  const fetchImpl = deps !== null && typeof deps === 'object' && typeof deps.fetchImpl === 'function'
    ? deps.fetchImpl
    : (...args) => globalThis.fetch(...args)

  // 打点必须走 console.log，不能走 ctx.logger.info：log-bridge 的 exporter 只放行 error/warn。
  // 这行是 M0 遗留的加载证据，别删。
  console.log('[amd-model-load] host loaded')

  const poller = createPoller({
    url: loadUrl,
    timeoutMs,
    pollMs,
    fetchImpl,
    // 轮询失败用 console.error：这是唯一能进 harness.log 的级别。
    onUpdate: (snap) => {
      const count = Object.keys(snap.models).length
      console.log(`[amd-model-load] load ok: ${count} models, scope=${snap.scope ?? '?'}`)
    },
    onError: (error, snap) => {
      const kept = Object.keys(snap.models).length
      console.error(`[amd-model-load] load failed: ${error.message} (kept ${kept} models from last success)`)
    },
  })

  const catalogSource = createCatalogSource({
    sharedUrl: catalogUrl,
    bootstrapUrl: catalogFallbackUrl,
    timeoutMs: catalogTimeoutMs,
    pollMs: catalogPollMs,
    fetchImpl,
    onUpdate: (snap) => {
      console.log(`[amd-model-load] catalog ok: ${snap.entries.length} models, source=${snap.source}`)
    },
    onError: (error, snap) => {
      // 失败保留旧目录；从没成功过时 entries 就是 FALLBACK_CATALOG，UI 不会空白。
      console.error(
        `[amd-model-load] catalog failed: ${error.message} (kept ${snap.entries.length} entries, source=${snap.source})`,
      )
    },
  })

  /** 组装负载 RPC 返回值。stale 在**每次调用时**重算，不能缓存——它随时间推移而变。 */
  function loadPayload() {
    const snap = poller.snapshot()
    return {
      ts: snap.ts,
      models: snap.models,
      scope: snap.scope,
      stale: isStale(snap, Date.now(), staleAfterMs),
      error: snap.error,
    }
  }

  /**
   * 组装目录 RPC 返回值：**分组与排序都在 host 侧算好**，client 只按顺序渲染。
   *
   * 这样做的理由：分组排序规则（官方 5 分类顺序、组内繁忙度升序、无数据排组末）
   * 是纯逻辑，放在 host 可被单测覆盖；client 半身在 vm 里只能靠伪造 React 渲染验证，
   * 把规则留在那边等于把可测性让给「目视 GUI」。
   *
   * `load` 与 `catalog` 是**两个独立的端点**，但 catalog 的 value 内嵌了当前负载读数
   * （每项的 state/utilization/free/stale），所以设置页只需调 catalog 一次。
   */
  function catalogPayload() {
    const snap = catalogSource.snapshot()
    const load = loadPayload()
    return {
      ts: snap.ts,
      source: snap.source,
      error: snap.error,
      // 目录自身的陈旧判定：目录 6 小时一拉，用 2 个周期作阈值，别让正常的 6 小时
      // 间隔把整页标成陈旧。catalogPollMs <= 0（只手动刷）时传 Infinity，
      // isStale 对非有限阈值返回 false —— 即「不会过期」，符合手动模式语义。
      stale: isStale(snap, Date.now(), catalogPollMs > 0 ? catalogPollMs * 2 : Number.POSITIVE_INFINITY),
      loadTs: load.ts,
      loadStale: load.stale,
      groups: groupAndSort(snap.entries, load.models, { stale: load.stale }),
    }
  }

  const handler = async (endpoint, payload) => {
    switch (endpoint) {
      case 'load':
        // 只读内存快照，毫秒级返回。绝不在这里触发上游拉取。
        return { ok: true, value: loadPayload() }
      case 'catalog':
        // 同上：只读内存快照。分组排序是纯计算，毫秒级。
        return { ok: true, value: catalogPayload() }
      case 'refresh':
        // 强制拉一次再返回。注意：上游 26s，这个端点会等那么久 —— 只给「手动刷新」按钮用。
        await Promise.all([poller.refresh(), catalogSource.refresh()])
        return { ok: true, value: catalogPayload() }
      case 'diag':
        // 客户端诊断上报：只写 stdout（console.log 会落进 harness.log），不落盘、不外发。
        // 用途：把「client 半身执行到哪一步、行组件被调用几次」变成可直接 grep 的日志，
        // 不再依赖人打开设置页念数字，也不需要 DevTools。
        try {
          console.log(`[amd-model-load] client-diag ${JSON.stringify(payload)}`)
        } catch (error) {
          console.log(`[amd-model-load] client-diag (unserializable) ${String(error)}`)
        }
        return { ok: true, value: { logged: true } }
      default:
        return {
          ok: false,
          error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} },
        }
    }
  }

  mountRpcChannel(ctx, CHANNEL, handler, MAX_BODY_BYTES)

  // 轮询定时器进 effect：disposer 真停表，不泄漏 interval。
  ctx.effect(() => {
    poller.start()
    catalogSource.start()
    console.log(
      `[amd-model-load] pollers started (load pollMs=${pollMs}, timeoutMs=${timeoutMs}; catalog pollMs=${catalogPollMs})`,
    )
    return () => {
      poller.stop()
      catalogSource.stop()
      console.log('[amd-model-load] pollers stopped')
    }
  }, 'amd-model-load: pollers')
}
