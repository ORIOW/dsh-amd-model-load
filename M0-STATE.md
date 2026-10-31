# M0 状态快照（重启前后交接用）

> 写于 2026-10-25 16:36（Asia/Shanghai）· 重启前

## 一句话
插件已挂载进 profile，代码两处缺陷已修，**只差重启后的日志核验**。

## 已完成
| 项 | 状态 |
|---|---|
| M0-A 骨架（package.json / cordis.patch.yml / lib/index.js / lib/client.js） | ✅ 完成（plugin-coder，task-1） |
| `package.json` exports 补 `./cordis.patch.yml` | ✅ 已修（Lead）——原本 `ERR_PACKAGE_PATH_NOT_EXPORTED`，是卡住加载的硬错 |
| client slot 名 `settings.plugin.item` → `settings.section` | ✅ 已修（Lead）——前者在宿主 asar 里出现 0 次 |
| 挂载进 `profiles/web`（deps link: + bundles 26 项 + pnpm install） | ✅ 完成 |
| symlink 指向工作区 | ✅ realpath 已核 |
| 重启后四项核验 | ⏳ **待做** |
| M0-VERIFY.md | ⏳ install-verifier 正在写 |

## 关键路径与事实
- 工作区：`/Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load`
- 备份：`/tmp/m0-backup-20261025-083005/`（脚本自建，为准）
- 重启前日志基线：**5857 行 / 2026-10-25T08:34:56Z**
- 08:30:07Z 那条 `cannot resolve profile bundle "dsh-amd-model-load"` 是 **pnpm install 完成前的 HMR 时序假阳性**，不是缺陷
- 08:30 之后 HMR 再未触发（touch 两个文件都无新日志）⇒ 必须重启才能验

## 重启后要做的三件事
1. 从 `~/Library/Logs/DSH Desktop/harness.log` 取新 boot 时间戳，切 08:34:56Z 之后的窗口。
2. 查 `[amd-model-load] host loaded` 是否出现（6a）；`.dsh-market/log.ndjson` 是否有记录且 exit=0（6b）。
3. 让 install-verifier 出 M0-VERIFY.md 结论；GUI 侧确认 Settings 导航出现「AMD 模型负载」（6c，同时是 client 半身证据）。

## 已知待定
- 6d（停用验证）默认**不执行**，理由：需两次重启，且 M0 核心风险已被 6a–6c 覆盖；若 6a–6c 任一 FAIL 则转为必做。
- `m0-mount.mjs` 的 `[5/5]` 判 NO 是脚本缺陷（相对 readlink 比绝对路径），install-verifier 正在修。

## 下一步（M1 起点）
`inject: []` → `['webServer']`，用 `ctx.inject(['webServer'], ...)` 延迟注册；`setInterval(pollMs)` 塞进现有 `ctx.effect`（其 disposer 即停表点）；加 loopback-only RPC 路由。client 半身 inject 扩 `connection`，用 `ctx.connection.rpc.call(...)` 取快照。
