# M0 结案 · dsh-amd-model-load

> 2026-10-25 · 结论：**安装机制验证通过**

## 判定

| 项 | 结论 | 证据 |
|---|---|---|
| 6a host 加载（日志打点） | **无法用日志判定** | 原判据设计错误：`ctx.logger.info` 被 `dsh-desktop-log-bridge` 过滤，只放行 error/warn。已改用 `console.log`，下次重启自然出现 |
| 6b 市场日志 | **无记录（非缺陷）** | 手工 `link:` 挂载不走市场安装流程，`.dsh-market/log.ndjson` 本就不该有记录 |
| 6c 设置项可见 | **PASS** | 用户目视：Settings 侧栏有「AMD 模型负载」，点进去显示「AMD 模型负载（骨架已加载）」 |

## 为什么 6c 足以结案

client 半身的 JS 由 host 侧 bundle 系统投递到浏览器。卡片能注册进 `settings.section` 并渲染出正确文案，反证了整条链路：

1. `dependencies` 的 `link:` 规格被正确解析
2. `dsh.profile.bundles` 里的条目被 boot 读取
3. 插件的 `cordis.patch.yml` 被 insert（否则 host 半身不加载、bundle 无 client 资产）
4. `lib/client.js` 的 `__ModuleLoader__` 信封被浏览器执行
5. `settings.section` slot 注册成功（这是修正后的 slot 名，证明修正有效）

这比一条 console.log 强得多——日志只能证明 host 的 apply 跑到了，UI 能证明整条链。

## 本轮修掉的两个硬错（均由 6c 证实修复有效）

1. **`package.json` exports 缺 `"./cordis.patch.yml"`** → 原本 `ERR_PACKAGE_PATH_NOT_EXPORTED`，bundle 解析直接失败。
2. **client slot 名 `settings.plugin.item` → `settings.section`** → 前者在宿主 asar 里出现 0 次，用了就是静默失效。

## 待补（不需专门重启）

`lib/index.js` 的打点已从 `ctx.logger.info` 改为 `console.log`，下次正常重启时 harness.log 会出现：
```
[amd-model-load] host loaded
[amd-model-load] effect mounted (pollMs=300000)
```
届时可把 6a 补记为 PASS。

## 未验证（留待后续）

- **6d 可停用**：未执行。profile patch 层本插件 0 行，停用需新增 override 行 + 改 `state.json` 的 disabled 数组，两处都要改才让界面状态一致。留待 M2 交付前验证。
- **`dsh-zcode-connect` 设置卡是否真的缺失**：此前结论是「基于 slot 名不存在」的**代码推断，未目视验证**，不应作为已证实事实引用。

## 回滚

`node m0-mount.mjs --rollback`（备份 `/tmp/m0-backup-20261025-083005/`）。
