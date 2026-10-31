#!/bin/bash
# 临时桩跑 host 装配测试。
#
# 为什么需要桩：lib/index.js 只 import 了 @deepseek-ai/schemastery，而工作区没有
# node_modules（link: 型插件靠宿主 Resources/host-module-fallback.mjs 兜底到 Desktop
# 安装锚点）。裸 node 跑测试时没有那条兜底，会 ERR_MODULE_NOT_FOUND。
#
# 本脚本建一个**最小 schemastery 桩**（只实现 z.object/number/string + default），
# 跑完无论成败都删除 —— 桩绝不能留在工作区（会让宿主误解析到假包）。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STUB="$ROOT/node_modules/@deepseek-ai/schemastery"

cleanup() {
  rm -rf "$ROOT/node_modules"
  echo ""
  echo "[with-stub] 已删除临时桩 $STUB"
}
trap cleanup EXIT INT TERM

mkdir -p "$STUB"

cat > "$STUB/package.json" <<'JSON'
{
  "name": "@deepseek-ai/schemastery",
  "version": "0.0.0-stub",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js" }
}
JSON

cat > "$STUB/index.js" <<'JS'
/**
 * schemastery 最小桩 —— 仅供本工作区的 host 装配测试使用。
 * 只实现被 lib/index.js 用到的形状：z.object / z.number().default / z.string().default。
 * 真正的校验语义不在这里验（那是宿主的事），这里只保证 Config 可调用、默认值正确。
 */

/** 一个"字段"：只记默认值。 */
class Field {
  constructor(kind, defaultValue) {
    this.kind = kind
    this.defaultValue = defaultValue
  }
  default(value) {
    return new Field(this.kind, value)
  }
}

/** 一个对象 schema：调用时按字段默认值填出配置对象。 */
class ObjectSchema {
  constructor(shape) {
    this.shape = shape
  }
  call(value) {
    const input = value !== null && typeof value === 'object' ? value : {}
    const out = {}
    for (const [key, field] of Object.entries(this.shape)) {
      out[key] = input[key] !== undefined ? input[key] : field.defaultValue
    }
    return out
  }
}

function object(shape) {
  const schema = new ObjectSchema(shape)
  const fn = (value) => schema.call(value)
  // 让 schema 本身也可被当函数调用（cordis 的 Config 就是直接调用）
  fn.shape = shape
  return fn
}

const number = () => new Field('number', undefined)
const string = () => new Field('string', undefined)
const boolean = () => new Field('boolean', undefined)

export default { object, number, string, boolean }
export { object, number, string, boolean }
JS

echo "[with-stub] 临时桩就位：$STUB"
echo ""

cd "$ROOT" || exit 1

# 可选参数：传 e2e 跑真实端点端到端，否则跑装配测试。
case "${1:-host}" in
  e2e) node test/e2e-live.mjs ;;
  *)   node test/host.test.mjs ;;
esac
status=$?
exit $status
