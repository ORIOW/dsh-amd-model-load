#!/usr/bin/env node
/**
 * M0 步骤 2–4 的挂载脚本（需要 workspace-write 之外的写权限才能执行）。
 *
 * 背景：install-verifier 会话被固定为 workspace-write 沙箱且审批被禁用，
 * 对 $DSH_HOME 的任何写入都会 EPERM，因此把该步骤固化为此脚本，
 * 交由有 danger-full-access 的一方执行。
 *
 * 用法：
 *   node m0-mount.mjs            # 执行挂载（幂等）
 *   node m0-mount.mjs --check    # 只检查当前状态，不写入
 *   node m0-mount.mjs --rollback # 回滚到备份
 *
 * 做的事（严格对应 task-2 步骤 2–4）：
 *   1. 备份 package.json / pnpm-lock.yaml / .dsh-market/state.json 到 /tmp/m0-backup-<ts>/
 *   2. dependencies 增加 "dsh-amd-model-load": "link:<本工作区绝对路径>"
 *   3. dsh.profile.bundles 数组追加 "dsh-amd-model-load"
 *   4. 调用 .desktop-bin/pnpm install
 *   5. 校验 node_modules/dsh-amd-model-load 是指向本工作区的 symlink
 *
 * 注意：不重启 DSH Desktop。重启由 Lead 确认后另行执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DSH_HOME = '/Users/dengjiawei/Library/Application Support/dsh-desktop/harness';
const PROFILE = path.join(DSH_HOME, 'profiles/web');
const PLUGIN_NAME = 'dsh-amd-model-load';
const WORKSPACE = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const PKG = path.join(PROFILE, 'package.json');
const LOCK = path.join(PROFILE, 'pnpm-lock.yaml');
const STATE = path.join(PROFILE, '.dsh-market/state.json');
const PNPM = path.join(DSH_HOME, '.desktop-bin/pnpm');

const mode = process.argv.includes('--check') ? 'check'
  : process.argv.includes('--rollback') ? 'rollback' : 'apply';

const log = (m) => console.log(m);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function snapshotState() {
  const pkg = readJson(PKG);
  const linkPath = path.join(PROFILE, 'node_modules', PLUGIN_NAME);
  let linkTarget = null;
  let linkResolved = null;
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      linkTarget = fs.readlinkSync(linkPath);
      // pnpm 写的是相对链接（如 ../../../../../../Documents/...），
      // 直接拿它比绝对路径必然不等 —— 必须先 realpath 解析。
      linkResolved = fs.realpathSync(linkPath);
    } else {
      linkTarget = '(not a symlink)';
    }
  } catch { linkTarget = '(missing)'; }
  return {
    inDependencies: Object.hasOwn(pkg.dependencies || {}, PLUGIN_NAME),
    depSpec: (pkg.dependencies || {})[PLUGIN_NAME] ?? null,
    inBundles: (pkg.dsh?.profile?.bundles || []).includes(PLUGIN_NAME),
    bundlesLength: (pkg.dsh?.profile?.bundles || []).length,
    linkTarget,
    linkResolved,
    linkResolvesToWorkspace: linkResolved !== null
      && path.resolve(linkResolved) === path.resolve(WORKSPACE),
  };
}

if (mode === 'check') {
  log(`工作区: ${WORKSPACE}`);
  log(JSON.stringify(snapshotState(), null, 2));
  process.exit(0);
}

if (mode === 'rollback') {
  const dirs = fs.readdirSync('/tmp').filter((d) => d.startsWith('m0-backup-')).sort();
  if (!dirs.length) { console.error('未找到 /tmp/m0-backup-* 备份'); process.exit(1); }
  const b = path.join('/tmp', dirs[dirs.length - 1]);
  for (const [src, dst] of [[path.join(b, 'package.json'), PKG],
                             [path.join(b, 'pnpm-lock.yaml'), LOCK],
                             [path.join(b, 'state.json'), STATE]]) {
    if (fs.existsSync(src)) { fs.copyFileSync(src, dst); log(`restored ${dst}`); }
  }
  log('回滚完成。注意：node_modules 里的 symlink 需手动删除，或重新执行 pnpm install。');
  process.exit(0);
}

// ---- apply ----
const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const backupDir = `/tmp/m0-backup-${ts}`;
fs.mkdirSync(backupDir, { recursive: true });
for (const f of [PKG, LOCK, STATE]) {
  if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backupDir, path.basename(f)));
}
log(`[1/5] 备份 -> ${backupDir}`);

const pkg = readJson(PKG);
pkg.dependencies ||= {};
pkg.dependencies[PLUGIN_NAME] = `link:${WORKSPACE}`;
pkg.dsh ||= {};
pkg.dsh.profile ||= {};
pkg.dsh.profile.bundles ||= [];
if (!pkg.dsh.profile.bundles.includes(PLUGIN_NAME)) {
  pkg.dsh.profile.bundles.push(PLUGIN_NAME);
}
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
log(`[2/5] package.json: dependencies += ${PLUGIN_NAME} = link:${WORKSPACE}`);
log(`[3/5] package.json: dsh.profile.bundles += ${PLUGIN_NAME} (共 ${pkg.dsh.profile.bundles.length} 项)`);

log(`[4/5] ${PNPM} install  (cwd=${PROFILE})`);
try {
  const out = execFileSync(PNPM, ['install'], {
    cwd: PROFILE, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, PATH: `${path.dirname(PNPM)}:${process.env.PATH}` },
  });
  log(out.trim().split('\n').slice(-25).join('\n'));
} catch (e) {
  console.error('pnpm install 失败:');
  console.error((e.stdout || '') + (e.stderr || '') || e.message);
  process.exit(2);
}

const s = snapshotState();
log(`[5/5] 校验 symlink: ${s.linkTarget}`);
log(`      -> 指向工作区? ${s.linkResolvesToWorkspace ? 'YES' : 'NO'}`);
log(JSON.stringify(s, null, 2));
if (!s.linkResolvesToWorkspace) { console.error('symlink 校验失败'); process.exit(3); }
log('挂载完成。下一步需要重启 DSH Desktop 才会加载（等待 Lead 确认）。');
