# M0-VERIFY.md — dsh-amd-model-load 安装机制验证报告

> 任务：M0-B（共享任务板 task-2）
> 验证人：install-verifier（独立验证线，**不修改插件源码**，发现缺陷只报告）
> 项目：AMD Radeon TokenFactory 免费模型负载徽章插件
> 报告状态：**已挂载、待重启验证（PENDING）**

---

## 0. 当前结论（先读这节）

**M0 的代码与挂载层面已全部完成并逐项取证**：骨架 4 文件齐备且语法通过、两处会卡住加载的硬缺陷已抓出并修复、`link:` 挂载成功、`node_modules` symlink 的 `realpath` 确认指向工作区、三条模块解析路径全通。

**唯一未完成的是重启后的运行时核验**——因为重启会中断当前正在运行的会话，必须由用户主动执行。四项运行时结论因此统一冻结为 **PENDING（未验证）**，这不是能力不足，而是诚实的边界：没有重启就没有运行时证据，不能凭机制分析冒充实测。

**M0 要证伪的最高风险（自研第三方插件能否被本机 DSH 加载）已在机制层面取证通过**：本轮真正抓出的两个硬错——`exports` 缺 `./cordis.patch.yml`、client slot 名 `settings.plugin.item` 不存在——都属于「必然导致加载失败或静默失效」的错误，且已修复。剩余动作只是「重启后看一眼日志与设置页」，不构成新的机制风险。

**重启后的核验步骤见 §10，可独立执行，不依赖本会话记忆。**

---

## 0.1 阶段状态摘要

| 阶段 | 状态 | 说明 |
|---|---|---|
| 步骤 1 备份 | ✅ 完成 | 两份备份，以脚本那份为准（见 §3） |
| 步骤 2 改 package.json | ✅ 完成（Lead 代跑） | 受本会话权限限制移交，见 §2 |
| 步骤 3 pnpm install | ✅ 完成（Lead 代跑） | `Done in 2.8s using pnpm v10.34.5` |
| 步骤 4 确认 symlink | ✅ 完成并独立复核 | realpath = 工作区 |
| 步骤 5 重启 Desktop | ⏸ PENDING | 需用户主动执行（重启会中断当前会话） |
| 6a host 打点 | ⏸ PENDING | 未验证（待重启），判据见 §5.3 |
| 6b 市场日志 | ⏸ PENDING | 未验证（待重启），判据见 §5.4 |
| 6c 市场页/设置项 | ⏸ PENDING | 未验证（待重启），判据见 §5.5 |
| 6d 可停用 | ⏸ 未执行 | 预案见 §5.6 |

---

## 1. 环境事实（已核实）

| 项 | 值 | 核实方式 |
|---|---|---|
| DSH_HOME | `/Users/dengjiawei/Library/Application Support/dsh-desktop/harness` | 启动日志 `[harness-node] DSH_HOME=...` |
| profile 目录 | `$DSH_HOME/profiles/web` | 实际存在 |
| 主进程日志 | `~/Library/Logs/DSH Desktop/harness.log` | 重启前基线 **5857 行** |
| 重启前日志基线时间 | **2026-10-25T08:34:56Z / 5857 行** | 由 Lead 提供，本次独立复核一致 |
| 市场状态真源 | `$DSH_HOME/profiles/web/.dsh-market/state.json` 的 `disabled` | 当前 `{"disabled":[]}` |
| 市场操作日志 | `$DSH_HOME/profiles/web/.dsh-market/log.ndjson` | 384 行，18 种 event |
| Desktop 内嵌 dsh 版本 | **0.2.1-rc.2** | 启动日志兼容性告警文本 |
| CLI dsh 版本（homebrew） | 0.1.7-rc.2（与 Desktop 不同，**勿混用**） | `require(pkg).version` |
| 桌面内置 pnpm | `$DSH_HOME/.desktop-bin/pnpm`（v10.34.5） | 可执行 |
| 工作区 | `/Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load` | — |

### 1.1 先例形态（dsh-zcode-connect，已比对一致）

```
profiles/web/package.json:  "dsh-zcode-connect": "link:/Users/.../dsh-zcode-connector"
profiles/web/package.json:  dsh.profile.bundles 数组内含 "dsh-zcode-connect"
profiles/web/node_modules/dsh-zcode-connect -> /Users/.../dsh-zcode-connector   (symlink)
```

挂载前基线：`dependencies` 21 项、`dsh.profile.bundles` 25 项、`dsh-amd-model-load` 出现 **0** 次。

---

## 2. 权限边界（本报告的关键前提）

本会话启动时被固定为 **workspace-write** 沙箱，且**审批提示被禁用**（approval prompts disabled）。因此对 `$DSH_HOME` 的任何写入都会被自动拒绝，**无法在本会话内提权**——这不是操作失误，而是会话权限上限。按指令未重试越权路径。

### 2.1 实测的三条写入路径，全部失败

| # | 命令 | 结果 |
|---|---|---|
| 1 | `echo probe > $PROFILE/.m0-write-probe` | `Operation not permitted` |
| 2 | `echo x > $PROFILE/package.json` | `Operation not permitted` |
| 3 | `dsh plugin --profile web ...` | `EPERM: open '.../profiles/web/package.json.lock'` |

第 3 条值得记录：**官方 CLI 自己也要写 `package.json.lock`**，所以「用官方命令绕开手改」在本沙箱下同样走不通。

### 2.2 可写性对照

| 路径 | 写入 |
|---|---|
| `/tmp/...` | ✅ OK |
| 会话工作区 | ✅ OK |
| `$DSH_HOME` 及 `profiles/web` | ❌ EPERM |

### 2.3 读权限

完全正常。`package.json` / `harness.log` / `state.json` / `log.ndjson` / `node_modules` 均可读 —— **步骤 6 的四项核验在本会话内可以完成**。

> **处置**：按 Lead 指令走方案 B —— 步骤 2–4 由 Lead 以更高权限代跑，本验证线收缩为「只读核验 + 报告」。为避免手敲出错，步骤 2–4 已固化为幂等脚本 `m0-mount.mjs`。

### 2.4 提权说明（对应 task-2「每次提权请在报告中说明理由」）

本验证线**全程未提权**。所有 `$DSH_HOME` 写入由 Lead 在其自有权限下执行，理由：本会话权限在启动时固定且审批禁用，无法扩权；该步骤属 task-2 步骤 2–4，已由 Lead 承担。

---

## 3. 步骤 1 备份（✅ 完成）

### 3.1 实际命令

```bash
TS=$(date +%Y%m%d-%H%M%S); B="/tmp/m0-backup-$TS"; mkdir -p "$B"
cp -p "$P/package.json"           "$B/package.json"
cp -p "$P/pnpm-lock.yaml"         "$B/pnpm-lock.yaml"
cp -p "$P/.dsh-market/state.json" "$B/state.json"
```

### 3.2 备份产物（两份，勿混淆）

| 备份目录 | 建立者 | 时点 | 用途 |
|---|---|---|---|
| `/tmp/m0-backup-20261025-162707/` | install-verifier | 挂载前（人工） | **交叉校验** |
| **`/tmp/m0-backup-20261025-083005/`** | `m0-mount.mjs` | 挂载前一刻（脚本自建） | **回滚以这份为准** |

两份均含 `package.json` / `pnpm-lock.yaml` / `state.json`。

---

## 4. 步骤 2–4 执行记录（Lead 代跑）

### 4.1 执行载体

```bash
cd /Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load
node m0-mount.mjs --check      # 只读查当前状态
node m0-mount.mjs              # 执行挂载（步骤 2-4，幂等）
node m0-mount.mjs --rollback   # 从最近备份回滚
```

### 4.2 实际改动

| 项 | 改前 | 改后 |
|---|---|---|
| `dependencies["dsh-amd-model-load"]` | 不存在 | `link:/Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load` |
| `dsh.profile.bundles` 长度 | 25 | **26**（含该包） |
| `node_modules/dsh-amd-model-load` | 不存在 | symlink → 工作区 |

### 4.3 pnpm install 输出

```
Done in 2.8s using pnpm v10.34.5
```

### 4.4 步骤 4 symlink 独立复核（验证人实测，非采信他人结论）

```
$ ls -la profiles/web/node_modules/dsh-amd-model-load
lrwxr-xr-x  1 dengjiawei  staff  69 Oct 25 16:30 dsh-amd-model-load ->
  ../../../../../../../Documents/work/dsh-plugin-develop/amd-model-load

$ readlink  →  ../../../../../../../Documents/work/dsh-plugin-develop/amd-model-load
$ realpath  →  /Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load
```

**结论：symlink 成立且解析到工作区 ✅**

### 4.5 三条解析路径验证

| 路径 | 结果 |
|---|---|
| `dsh-amd-model-load` → `lib/index.js` | ✅ |
| `dsh-amd-model-load/package.json` | ✅ |
| `dsh-amd-model-load/cordis.patch.yml` | ✅ |

> 第 3 条此前**失败**（`ERR_PACKAGE_PATH_NOT_EXPORTED`），因 `exports` 未导出该路径；Lead 已补 `"./cordis.patch.yml": "./cordis.patch.yml"`，现通过。这是真正会卡住 bundle 加载的硬错，记录为 **D2**（见 §6.2）。

---

## 5. 步骤 6 四项核验

### 5.1 判据（重启前固定，防止事后找理由）

| 项 | 通过判据 | 证据来源 |
|---|---|---|
| **6a** host 加载 | 启动窗口内出现 `[amd-model-load] host loaded`，且**无**该插件相关 import/activation failure | `harness.log` |
| **6b** 市场记录 | `log.ndjson` 有该插件 install/hot-mount 记录且 `exit=0` | `log.ndjson` |
| **6c** 市场页可见 | **主证**：GUI Settings 侧栏出现「AMD 模型负载」（同时即 client 半身确认）；**辅助**：`state.json` 归组情况。未归组记「未归组（非缺陷）」 | GUI + `state.json` |
| **6d** 可停用 | 双文件口径：`cordis.patch.yml` 行 `id: amd-model-load` + `disabled: true`，且 `state.json` 的 `disabled` 加包名；重启后不再加载、不刷死行错 | `state.json` + `cordis.patch.yml` + `harness.log` |

### 5.2 日志窗口切分

以重启后新 boot 行时间为下界、重启前基线 `08:34:56Z / 5857 行` 为起点：

```bash
L="$HOME/Library/Logs/DSH Desktop/harness.log"
sed -n '5858,$p' "$L"                      # 基线之后
sed -n '5858,$p' "$L" | grep -i "amd-model-load"
```

### 5.3 6a — host 加载

**状态：`PENDING`（未验证，待重启）**

判据：重启后的日志窗口内出现 `[amd-model-load] host loaded`，且无该插件相关 import / activation failure。

取证命令：

```bash
L="$HOME/Library/Logs/DSH Desktop/harness.log"
sed -n '5858,$p' "$L" | grep -F "[amd-model-load] host loaded"
```

### 5.4 6b — 市场记录

**状态：`PENDING`（未验证，待重启）**

判据：`log.ndjson` 出现该插件记录且 `exit=0`。

取证命令：

```bash
grep "dsh-amd-model-load" \
  "$DSH_HOME/profiles/web/.dsh-market/log.ndjson"
```

### 5.5 6c — 市场页 / 设置项

**状态：`PENDING`（未验证，待重启）**

判据：**主证** = GUI 打开 Settings，左侧导航出现「AMD 模型负载」一项（这一项同时就是 client 半身加载成功的确认）；**辅助** = `state.json` 的 `groups` 是否含该包。若 `state.json` 未归组，记为「未归组（非缺陷）」，不影响判定。

> 注意：**不能只看日志判定 6c**。`slots.inject` 在 slot 未声明时静默返回（见 §6.1），日志会干净但界面无卡。

### 5.6 6d — 可停用（⏸ 未执行 + 预案）

#### 5.6.1 未执行（状态说明）

**标注：未执行。本插件当前处于「已挂载、未停用」状态。**

理由：M0 的核心风险（本机 DSH 能否加载自研第三方插件）已在机制层面取证完成；6d 需连改两次配置并重启两次，成本高且不增加 M0 结论强度。**停用能力留待 M2 交付前验证。**

**触发条件**：若 6a–6c 任一在重启后核验为失败，则 6d 转为**必做**（用于确认插件能被干净停掉）。

> ⚠️ 措辞纪律：本报告**不声称**本插件「已验证可停用」。6d 的能力结论在 M0 阶段为**未验证**。

#### 5.6.2 关键机制事实：本插件没有任何 profile 级 override 行

独立实测：

```
$ grep -c "amd-model-load" profiles/web/cordis.patch.yml
0            (exit=1)

# 对照（已有 override 行的插件）
$ grep -c "dsh-pause\|zcode-connect" profiles/web/cordis.patch.yml
3
```

⇒ **本插件的挂载完全依靠三件套**：

| # | 机制 | 实测状态 |
|---|---|---|
| 1 | `package.json` 的 `dependencies` 含 `link:` 规格 | ✅ |
| 2 | `node_modules/dsh-amd-model-load` → 工作区的 symlink | ✅（realpath 已验） |
| 3 | `dsh.profile.bundles` 数组含包名 | ✅（26 项） |

**这正是 M0 要验证的机制本身**：第三方插件以 `link:` 方式挂载，不需要在 profile 的用户 patch 层写任何行，也不依赖市场安装流程。用户 patch 层只在「停用/覆盖」时才需要出现对应行。

#### 5.6.3 执行预案（已只读预演，可直接照做）

1. 备份：`cp -p cordis.patch.yml cordis.patch.yml.bak-amdload-<ts>`
2. 在 profile `cordis.patch.yml` 顶层列表追加：
   ```yaml
   - id: amd-model-load
     disabled: true
   ```
3. `state.json` 的 `disabled` 数组加入 `"dsh-amd-model-load"`
4. 校验（**去 `!!js ` 前缀再 parse**，否则 js-yaml 会报未知 tag）：
   ```bash
   node -e '
   const yaml=require("'$P'/node_modules/js-yaml"), fs=require("fs");
   const t=fs.readFileSync("'$P'/cordis.patch.yml","utf8").replace(/!!js\s+/g,"");
   yaml.load(t); console.log("YAML OK");'
   ```
5. `diff` 逐行确认，然后重启
6. 验证：`[amd-model-load] host loaded` **消失**，且无 `failed to apply loader entry amd-model-load` 死行错
7. 恢复：移除上述两处改动 → 重启 → 打点复现

> **⚠️ 预演发现的事实修正**：profile `cordis.patch.yml` 当前对本插件有 **0 行**（`grep -c "amd-model-load"` → 0，exit=1）。所以 6d 是**新增 override 行**，不是"改已有行"。这与 `dsh-pause`（模板已带 `- id: dsh-pause` / `disabled: false`）不同，执行时不要去找不存在的行。
> 插件的**活行**在插件自己的 `cordis.patch.yml` 里（`- insert: - id: amd-model-load / name: dsh-amd-model-load`），由 bundle 正常 insert，因此新增 override 不会刷 not found。
> 预演同时确认：js-yaml 可加载（`profiles/web/node_modules/js-yaml`），profile patch 去 `!!js` 前缀后可正常 parse（顶层 array，20 项）。

---

## 6. 缺陷与风险（只报告，不修改源码）

### 6.1 🔴 D1：client 卡片 slot 名错误（已由 Lead 修复）

**现象**：`lib/client.js` 原向 `settings.plugin.item` 注册卡片，但该 slot 在 Desktop 0.2.1-rc.2 **不存在**。

**证据（字节级字面量计数）**：

| slot 名 | `app.asar` 中字面量出现次数 |
|---|---|
| `settings.plugin.item` | **0** |
| `settings.section` | **33** |
| `plugins.bundle.config` | 15 |
| `plugins.row.config` | 15 |
| `settings.plugins.tab` | 23 |

> **方法学注记**：初次用 `grep -c "settings.plugin.item"` 得到 94，是正则里 `.` 匹配任意字符造成的**假阳性**。改用 Python `data.count(b"...")` 字面量计数，确认为 **0**。记录以免后续复核踩同一坑。

**为什么日志抓不到**：`slots.inject(key, cb)` 在 slot 未声明时**静默等待**。源码 `reconcile()`：

```js
const spec = this._core.specDynamic(key);
if (spec === void 0) return;   // 静默返回，不抛错、不打日志
```

⇒ 重启后 `harness.log` **不会有任何错误**，但设置页里就是没有这张卡。**因此 6c 不能只看日志，必须目视 GUI。**

**修复**：Lead 已将 slot 改为 `settings.section`，行选项 `{name, id, order: 60, label}`。验证人复核：`settings.section` 在宿主中 33 次，且先例 `dsh-watcher/lib/client.js:8967` 确实使用该 slot。

**⚠️ 验证人自我修正**：我最初建议的替代席位是 `plugins.bundle.config` / `settings.plugins.tab`，**这是错的**。经 Lead 核对宿主源码：`settings.plugins.tab` 是父 section 自声明的子 slot，**只对内置插件开放**，第三方注册属越界；第三方注册自己设置页的官方席位是 **`settings.section`**。此处以 Lead 结论为准。

**⚠️ 先例 bug 警示**：`dsh-zcode-connect` 用的也是 `settings.plugin.item`，所以它那张设置卡**一直是静默不显示的**。先例不等于正确依据。

### 6.2 🔴 D2：`exports` 缺 `./cordis.patch.yml`（已由 Lead 修复）

**现象**：`require.resolve('dsh-amd-model-load/cordis.patch.yml')` 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，**直接卡住 bundle 加载**。

**对照**：`dsh-pause` / `dsh-reasoning-effort` 都显式导出了该路径。

**修复**：Lead 已补 `"./cordis.patch.yml": "./cordis.patch.yml"`。验证人复核 exports 现含该键，解析通过。

### 6.3 ✅ 已排除的假警报：schemastery 解析失败

插件源码目录无 `node_modules`，直接 `node -e import('@deepseek-ai/schemastery')` 报 `ERR_MODULE_NOT_FOUND`，看似缺陷。

**但** `Resources/host-module-fallback.mjs` 明确为此设计：link: 型插件 import `@deepseek-ai/*` 失败时，自动回退到 Desktop 安装锚点解析。源码注释原文：

> Let linked Profile plugins consume the Harness packages carried by Desktop. Node resolves a symlinked plugin's imports from the plugin's physical source directory. That directory normally has no node_modules of its own, while the peer packages intentionally live beside the bundled DSH entry.

⇒ **不是缺陷**，不记入失败项。

### 6.4 ✅ 已排除的假警报：08:30:07Z 的 resolve 失败（HMR 时序）

`harness.log` 在 `2026-10-25T08:30:07Z` 记录：

```
cannot resolve profile bundle "dsh-amd-model-load" from the dsh installation or .../profiles/web
```

**这不是插件缺陷**：HMR 在 `pnpm install` 完成**之前**就 reconcile 了 `package.json`，彼时 `node_modules/dsh-amd-model-load` symlink 尚不存在。属**时序假阳性**。

**但必须注意**：08:30 之后 HMR **再未被触发**（`touch package.json` / `cordis.patch.yml` 均无新日志）。因此「无新日志」**不代表加载成功**——必须重启才能验。这是 6a 必须基于重启后窗口判定的原因。

### 6.5 ⚠️ 口径提醒 R1：`dsh.profile.bundles` 是派生字段

asar 内注释原文：

> `dsh.profile.bundles` stays derived. Launch projection and bundle healing may re-add an installed bundle there.

⇒ 手改 bundles 能生效也不会被删，但**真正决定加载的是 `dependencies` + `node_modules` symlink**。因此步骤 4 的 symlink 校验是硬指标，不能只看 bundles 数组。

### 6.6 🐛 工具缺陷 D3：`m0-mount.mjs` 的 symlink 判定误报（已修，非插件源码）

**现象**：脚本 `[5/5]` 输出 `linkResolvesToWorkspace: NO`，看似挂载失败。

**根因**：pnpm 写的是**相对** symlink（`../../../../../../../Documents/...`），脚本拿它直接与绝对路径 `WORKSPACE` 比较，必然不等。

**修复**：改用 `fs.realpathSync(linkPath)` 解析后再比较。修复后 `--check` 实测：

```json
{
  "inDependencies": true,
  "depSpec": "link:/Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load",
  "inBundles": true,
  "bundlesLength": 26,
  "linkTarget": "../../../../../../../Documents/work/dsh-plugin-develop/amd-model-load",
  "linkResolved": "/Users/dengjiawei/Documents/work/dsh-plugin-develop/amd-model-load",
  "linkResolvesToWorkspace": true
}
```

> 该修复只动验证工具，**未触碰插件源码**。

---

## 7. 回滚预案与实际记录

### 7.1 挂载回滚（步骤 2–4）

```bash
node m0-mount.mjs --rollback
rm -f "$DSH_HOME/profiles/web/node_modules/dsh-amd-model-load"
```

### 7.2 停用回滚（步骤 6d）

- `state.json` 的 `disabled` 移除 `"dsh-amd-model-load"`
- profile `cordis.patch.yml` 移除 `- id: amd-model-load` / `disabled: true` 两行块
- 重启

### 7.3 全量回滚

```bash
B=/tmp/m0-backup-20261025-083005
cp "$B/package.json"   "$DSH_HOME/profiles/web/package.json"
cp "$B/pnpm-lock.yaml" "$DSH_HOME/profiles/web/pnpm-lock.yaml"
cp "$B/state.json"     "$DSH_HOME/profiles/web/.dsh-market/state.json"
rm -f "$DSH_HOME/profiles/web/node_modules/dsh-amd-model-load"
```

### 7.4 实际回滚记录

| 时间 | 原因 | 操作 | 结果 |
|---|---|---|---|
| — | **未发生回滚** | — | 挂载一次成功，无需回滚 |

---

## 8. 骨架静态检查（只读）

| 检查项 | 结果 |
|---|---|
| 四文件齐全 | ✅ package.json / cordis.patch.yml / lib/index.js / lib/client.js |
| `node --check lib/index.js` | ✅ |
| `node --check lib/client.js` | ✅ |
| `JSON.parse(package.json)` | ✅ name=dsh-amd-model-load, v0.1.0 |
| `dsh.bundle.patch` | ✅ `./cordis.patch.yml` |
| `exports` 含 `./cordis.patch.yml` | ✅（D2 修复后） |
| client slot 名 | ✅ `settings.section`（D1 修复后） |
| `dsh.client.inject` 三项 | `@deepseek-ai/dsh-client-runtime` / `dsh-client-ui-slots` / `dsh-client-ui-settings` —— loader 仅用其做**激活排序**、不 import，不构成解析风险 |

---

## 9. 时间线

| 时间（本地） | 事件 |
|---|---|
| 16:26 | 读取 task-2；确认 task-1 未完成、工作区为空 |
| 16:27 | 建立备份 `/tmp/m0-backup-20261025-162707/`；探测权限，确认 EPERM |
| 16:28 | 向 Lead 报告阻塞；Lead 裁定方案 B |
| 16:29 | 产出 `m0-mount.mjs`，`--check` 通过 |
| 16:30 | 骨架落地；静态检查全通过；Lead 执行挂载（`/tmp/m0-backup-20261025-083005/`），symlink 成立 |
| 16:31+ | 只读机制核查：发现 D1（slot 名）、D2（exports 缺项）、排除两处假警报 |
| 16:3x | Lead 修复 D1/D2；验证人独立复核通过 |
| 16:4x | 修复工具缺陷 D3（realpath）；6d 只读预演完成；基线 5857 行核对一致 |
| 16:36 | 复核确认尚未重启（5861 行、基线后 0 条 boot 行）；报告定稿为 PENDING 冻结 |
| — | ⏸ 待用户主动重启后，按 §10 清单核验 |

---

## 10. 重启后核验清单（可独立执行，不依赖本会话记忆）

> 本节供下一个会话窗口直接照做。前置事实：插件**已挂载**（`dependencies` 含 `link:`、`node_modules` symlink 指向工作区、`bundles` 26 项），**尚未重启**，四项运行时结论均为 `PENDING`。

### 10.0 前置常量

```bash
DSH_HOME="/Users/dengjiawei/Library/Application Support/dsh-desktop/harness"
P="$DSH_HOME/profiles/web"
L="$HOME/Library/Logs/DSH Desktop/harness.log"
BASELINE_LINES=5857          # 重启前基线行数（2026-10-25T08:34:56Z）
```

### 10.1 第一步：确认真的重启了，并取新 boot 时间戳

```bash
# 新 boot 行的特征串
grep -n "\[desktop\] launch requested (web profile)" "$L" | tail -3
```

- 最后一次**旧** boot 行在 `5757:[2026-10-24T11:35:29.887Z]`。
- 若 `tail -1` 的行号 **> 5757 且时间晚于 2026-10-25T08:34:56Z**，说明已重启；记下该行的时间戳与行号。
- 若仍是 5757 行，说明**还没重启**——不要往下判，直接回报「未重启」。

取新总行数：

```bash
wc -l < "$L"
```

### 10.2 第二步：切日志窗口并核验 6a（host 加载）

```bash
# 从基线之后开始取
sed -n "$((BASELINE_LINES+1)),\$p" "$L" > /tmp/m0-window.log

# 6a 核心打点
grep -F "[amd-model-load] host loaded" /tmp/m0-window.log

# 6a 反证：不应出现该插件的 import / activation 失败
grep -iE "amd-model-load.*(import|activation).*(fail|error)|failed to apply loader entry amd-model-load" /tmp/m0-window.log
```

判定：有 `host loaded` 打点、且反证为空 ⇒ 6a 通过。

### 10.3 第三步：核验 6b（市场记录）

```bash
grep "dsh-amd-model-load" "$P/.dsh-market/log.ndjson"
grep -c "dsh-amd-model-load" "$P/.dsh-market/log.ndjson"
```

判定：有该包记录且带 `exit=0` ⇒ 6b 通过。

> 注意：`link:` 手工挂载**可能不产生**市场 install 记录（市场日志只记市场自己的安装动作）。若 `log.ndjson` 无记录，需区分「未走市场流程」与「加载失败」——以后者看 6a 为准，并在报告中如实记为「无市场记录（手工 link: 挂载，非市场流程，非缺陷）」。

### 10.4 第四步：核验 6c（设置项可见）— 必须目视 GUI

**这一步不能只看日志**：`slots.inject` 在 slot 未声明时静默返回，日志会干净但界面无卡。

- 打开 DSH Desktop → Settings → 左侧导航，查找 **「AMD 模型负载」**。
- 出现 ⇒ 6c 通过（同时即 client 半身加载成功）。
- 未出现 ⇒ 6c 不通过；先确认 `lib/client.js` 用的是 `settings.section`（§6.1），再查浏览器控制台是否有 `slot entry crashed`。

辅助证据（不作主证）：

```bash
node -e 'const s=require("'"$P"'/.dsh-market/state.json");
console.log("disabled:", s.disabled);
console.log("grouped:", Object.entries(s.groups||{}).filter(([,v])=>v.includes("dsh-amd-model-load")));'
```

未归组 → 记「未归组（非缺陷）」，不影响 6c 判定。

### 10.5 第五步：把结论回填本报告 §5.3–§5.5

把 `PENDING` 改为实测结论，并附上原始日志片段（含时间戳）。四项全部有结论后，M0-B 才算真正闭合。

### 10.6 若需要回滚（任一环节出问题）

```bash
B=/tmp/m0-backup-20261025-083005
cp "$B/package.json"   "$P/package.json"
cp "$B/pnpm-lock.yaml" "$P/pnpm-lock.yaml"
cp "$B/state.json"     "$P/.dsh-market/state.json"
rm -f "$P/node_modules/dsh-amd-model-load"
# 然后重启 Desktop
```

回滚后需重启才能生效；回滚动作与结果应记入 §7.4。
