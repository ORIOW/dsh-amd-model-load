# dsh-amd-model-load

[English](README.en.md) · **简体中文**

在 DeepSeek Harness（DSH Desktop）里给 **AMD Radeon TokenFactory** 的免费模型显示实时负载徽章。

模型选择列表里每一行会多出一个「状态点 + 百分比」，比如 `● 20.1%`，同时设置页有一张卡片把 15 个免费模型按 AMD 官网的五类分组列出、组内按繁忙度从空闲到繁忙排序。

> 数据来自 AMD 公开的负载接口，**不需要 API Key**。

---

## 功能

| 挂载点 | 效果 |
| --- | --- |
| 设置页「AMD 模型负载」 | 按 `VLM / LLM / Decision / TTS / OCR` 五类分组；组内按 utilization 升序（空闲在前）；带 `FREE` 徽章的模型照抄 AMD 官网样式；顶部显示最后更新时间，超时自动标记为过期 |
| 模型选择列表（`conversation.input.model.label`） | 每个 AMD 模型的 `option` 行追加「● 百分比」；非 AMD 行、收起按钮、菜单顶部保持原样 |
| 兼容性 | 不覆盖 DeepSeek 官方的 `1017` 徽章：本插件在 `priority: -1` 注册，代渲染官方的「模型名 + 1017」形态后再追加自己的徽章 |

轮询节奏：**负载 10 分钟**一次（AMD 的 VLM/LLM 只有十几到三十 tokens/s，更快没有意义），**目录 6 小时**一次。

## 安装

本插件是 DSH 第三方插件，两种装法：`link:` 挂载（**已实测**）和插件页添加（未实测）。

### 方式一：link 挂载（已验证）

1. 把本仓库克隆到本地任意位置。
2. 编辑当前 profile 的 `package.json`（Desktop 默认在
   `~/Library/Application Support/dsh-desktop/harness/profiles/web/package.json`），在 `dependencies` 里加一行：

   ```json
   "dsh-amd-model-load": "link:/absolute/path/to/dsh-amd-model-load"
   ```

3. 在同一目录跑 `pnpm install`，生成 `node_modules` 里的符号链接。
4. **重启 DSH Desktop**（宿主只在启动时重新组合插件；改 profile 触发的 HMR 在依赖未就绪时不重试）。

装好后：`设置 → AMD 模型负载` 应出现卡片，日志里能看到 `[amd-model-load] host loaded` 与 `catalog ok: 15 models`。

### 方式二：插件页添加

在产品界面 `插件 → 添加插件` 里填本地路径或仓库地址。这条路径**尚未验证**，遇到问题请优先用方式一。

### 校验安装

```sh
# 宿主日志（Desktop）
tail -f "/Users/dengjiawei/Library/Logs/DSH Desktop/harness.log" | grep amd-model-load
```

正常时依次出现：

```
[amd-model-load] host loaded
[amd-model-load] pollers started (load pollMs=600000, timeoutMs=40000; catalog pollMs=21600000)
[amd-model-load] catalog ok: 15 models, source=shared
[amd-model-load] load ok: 13 models, scope=fleet
```

`catalog ok` 要等一次成功拉取，`load ok` 首次要等约 26 秒（AMD 接口本身的响应时间）。

## 配置

所有字段都有默认值，通常不需要改。可覆盖项（写在挂载条目的 `config` 里）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `pollMs` | `600000` | 负载轮询间隔（毫秒），10 分钟 |
| `timeoutMs` | `40000` | 负载请求超时；必须大于 AMD 的 ~26 秒响应时间 |
| `staleAfterMs` | `660000` | 超过该时长未刷新即标记为过期（11 分钟） |
| `loadUrl` | AMD load 端点 | 负载接口地址 |
| `catalogPollMs` | `21600000` | 目录轮询间隔，6 小时 |
| `catalogUrl` | `bootstrap?section=dedicated` | 目录首选端点（一次拿全 15 条） |
| `catalogFallbackUrl` | `bootstrap?directory=true` | 目录回退端点（拿卡片列表后逐个查详情） |
| `catalogTimeoutMs` | `20000` | 目录请求超时 |

## 数据来源

两个端点都在 `https://developer.amd.com.cn`，**免 Key**，但要求请求头 `Origin: https://developer.amd.com.cn`，否则返回 403 `Invalid request origin`——插件已自动带上。

- 目录：`POST /radeon/api/tokenfactory/bootstrap?section=dedicated` → `shared_models[]`，约 0.4 秒 / 58 KB。
- 负载：`GET /radeon/api/tokenfactory/load` → `{ models: { <id>: { state, label, utilization } }, scope: "fleet" }`，**约 26 秒**。

匹配模型时只认「去掉 `model_gateway:` 前缀的全 id」，不能用 `display_config.name`（`DeepSeek-V4.1-Flash` 的 name 带 `-1017` 后缀，会永远匹配不到负载）；徽章只认 `display_config.badge_label`。

## 已知限制

- **只覆盖 Public Free 区的 15 个模型**，Dedicated 区（MiniCPM 系列）按设计不显示。
- 依赖 AMD 的公开接口，对方改版就会失效；`load` 端点单次响应约 26 秒，首次出数是慢的，属正常。
- 与 `dsh-reasoning-effort` **0.8.1 及更早**同装时，模型列表的徽章不会显示：那个版本以 `priority: -100` 整个替换了 composer 的模型选择器，且从不渲染 `conversation.input.model.label` 子 slot，连官方 `1017` 徽章也会一起消失。**0.9.0 起上游改成「包裹原生组件」，已修好**。排查过程见 [M4-UPSTREAM-FINDING.md](M4-UPSTREAM-FINDING.md)。
- **收起态的模型行（`placement: "trigger"`）会随流式输出被宿主父组件频繁重渲染**（实测空闲 ~8 次/秒、流式期间 105–129 次/秒）。本插件在这条路径上只做一次 O(1) 缓存查找、渲染期不写任何副作用，日志也不再按次上报；该重渲染属宿主行为，不在本插件修复范围。分析与测法见 [M5-RENDER-CHURN.md](M5-RENDER-CHURN.md)。
- 定位上述两个问题期间曾临时带一层诊断设施（`reportDiag` / `probeLedger` / heartbeat / 设置卡诊断行）。**v0.1.1 已全部摘除**：发布版不再向宿主日志写 `client-diag`，也不再持有任何诊断定时器；保留的只有注册失败时的一条 `console.error`（带 `[amd-model-load]` 前缀，只进浏览器 console）。

## 开发

无需构建步骤，纯 ESM。测试用 Node 内置 test runner：

```sh
node test/load-source.test.mjs   # 32 用例：归一化、过期判定、轮询器
node test/catalog.test.mjs       # 50 用例：目录解析、五分类分组、排序
node test/client.test.mjs        # 72 用例：两个 slot 的注册与渲染分支
bash test/with-stub.sh           # 24 用例：host 半身（临时建 schemastery 桩，退出即删）
```

> `host` 套件必须走 `bash test/with-stub.sh`：插件本身不带依赖，直接 `node --test test/*.test.mjs` 会因缺 `@deepseek-ai/schemastery` 桩而 `MODULE_NOT_FOUND`。

连真实端点跑一次（约 30 秒）：

```sh
node test/e2e-live.mjs
```

目录结构：

```
lib/index.js        host 半身：双轮询器 + loopback RPC 通道（load / catalog / refresh / diag）
lib/load-source.js  负载数据源（零依赖，可裸跑单测）
lib/catalog.js      目录数据源 + 五分类分组排序（零依赖）
lib/client.js       浏览器半身：设置卡 + 模型行徽章，共用唯一快照订阅器
cordis.patch.yml    bundle 补丁：把插件 insert 进 profile
test/               四个套件 + fixtures + with-stub.sh + e2e-live.mjs
```

各里程碑的验证记录与踩坑在 `M0-VERIFY.md`、`M1-REPORT.md`、`M3-REPORT.md`、`M4-*.md` 里。

## 许可证

[MIT](LICENSE) © 2026 dengjiawei
