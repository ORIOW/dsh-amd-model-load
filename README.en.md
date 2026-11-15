# dsh-amd-model-load

**English** · [简体中文](README.md)

Live load badges for **AMD Radeon TokenFactory** free models inside DeepSeek Harness (DSH Desktop).

Every row of the model selector gets a load chip — a status dot plus a percentage, `[●] 20.1%` — and the plugin's config page (`Plugins → Installed → dsh-amd-model-load` → the row's "Configure" button) gets a card listing all 15 free models grouped by AMD's five categories, sorted from idle to busy inside each group. The plugin no longer registers a settings page; the config entry lives under Plugins → Installed → dsh-amd-model-load.

> The data comes from AMD's public load endpoint. **No API key required.**

---

**Contents:** [Quick start](#quick-start) · [Preview](#preview) · [What it does](#what-it-does) · [Installation](#installation) · [Configuration](#configuration) · [Data sources](#data-sources) · [Known limitations](#known-limitations) · [Development](#development) · [License](#license)

## Quick start

DSH Desktop 0.12.1 or newer (which embeds dsh 0.2.1-rc.2) is enough to install the plugin, but the **config entry** (the row's "Configure" button) needs 0.14.0+ (embedded dsh ≥ 0.2.2-rc.1, see [Known limitations](#known-limitations)). Also `pnpm` on your machine.

```sh
git clone https://github.com/ORIOW/dsh-amd-model-load.git
```

Open the active profile's `package.json` (on Desktop usually
`~/Library/Application Support/dsh-desktop/harness/profiles/web/package.json`) and add to `dependencies`:

```json
"dsh-amd-model-load": "link:/absolute/path/to/dsh-amd-model-load"
```

Run `pnpm install` in that same directory, then **restart DSH Desktop**. Afterwards the `dsh-amd-model-load` row under `Plugins → Installed` should show a "Configure" button that opens the load card — that means you are done; see [Verifying the install](#verifying-the-install) for the log check.

## Preview

This is a **text sketch, not a screenshot** — the real UI follows your DSH theme, so colours and spacing vary:

```text
Plugins → Installed → dsh-amd-model-load → Configure
  VLM (Vision)                                   ← group title is the upstream capability_label, verbatim
    ● MiMo-V2.6-Flash      FREE   idle    20.1%   ← sorted by activity inside the group, idlest first
    ● MiniCPM-V-4.7-1B     FREE   busy    61.8%
  LLM (Text)
    ● DeepSeek-V4.1-Flash-1017 FREE idle    5.7%
    ● GLM-5.3-Flash        FREE   busy    33.2%
  OCR (Document)
    ● MinerU2.5-Pro        FREE   idle    12.4%

Model selector
  DeepSeek-V4.1-Flash-1017   [●] 5.7%             ← chip added by this plugin, right after the official 1017 badge
  GLM-5.3-Flash              [●] 33.2%
```

A row always reads "status dot → model id → FREE badge → state text → percentage". Rows without load data drop to 55% opacity and show `—` on the right instead of inventing a number.

## What it does

| Mount point | Effect |
| --- | --- |
| Plugin-row config page (`plugins.row.config`, key `dsh-amd-model-load#amd-model-load`) | Groups models under `VLM / LLM / Decision / TTS / OCR`; sorts by ascending utilization (idlest first); reproduces AMD's own `FREE` badge styling; shows the last refresh time and flips to stale when the data ages out |
| Model selector (`conversation.input.model.label`) | Appends a load chip (status dot + percentage, full semantics available to hover and screen readers) to each AMD model's `option` row; non-AMD rows, the collapsed trigger and the menu header stay untouched |
| Compatibility | Does not swallow DeepSeek's official `1017` badge: the plugin registers at `priority: -1` and re-renders the official "model name + 1017" shape before appending its own badge |

Polling cadence: **load every 10 minutes** (AMD's VLM/LLM models only produce tens of tokens per second, so finer polling buys nothing) and **catalog every 6 hours**.

## Installation

This is a DSH third-party plugin. Two routes: `link:` mounting (**verified**) and adding it from the plugin page (not verified).

### Option 1 — `link:` mount (verified)

1. Clone this repository anywhere on disk.
2. Edit the active profile's `package.json` (on Desktop usually
   `~/Library/Application Support/dsh-desktop/harness/profiles/web/package.json`) and add to `dependencies`:

   ```json
   "dsh-amd-model-load": "link:/absolute/path/to/dsh-amd-model-load"
   ```

3. Run `pnpm install` in that directory so the symlink exists under `node_modules`.
4. **Restart DSH Desktop** — the host only recomposes plugins at startup, and the profile-change HMR pass does not retry once a dependency is missing.

After that, the `dsh-amd-model-load` row under `Plugins → Installed` should show the "Configure" button, and the log should contain `[amd-model-load] host loaded` and `catalog ok: 15 models`.

### Option 2 — plugin page

Use `Plugins → Add plugin` with a local path or a repository URL. This route is **not verified yet**; prefer Option 1 if anything misbehaves.

> ⚠️ The plugin is **not published to npm** as of v0.1.1, so entering the package name `dsh-amd-model-load` will not install anything.

### Verifying the install

```sh
tail -f "/Users/dengjiawei/Library/Logs/DSH Desktop/harness.log" | grep amd-model-load
```

Expected sequence:

```
[amd-model-load] host loaded
[amd-model-load] pollers started (load pollMs=600000, timeoutMs=40000; catalog pollMs=21600000)
[amd-model-load] catalog ok: 15 models, source=shared
[amd-model-load] load ok: 13 models, scope=fleet
```

`catalog ok` appears after the first successful catalog fetch; the first `load ok` takes roughly 26 seconds because that is how long AMD's endpoint itself takes.

## Configuration

Every field has a default; you normally do not need to touch them. Overridable via the mount entry's `config`:

| Field | Default | Meaning |
| --- | --- | --- |
| `pollMs` | `600000` | Load polling interval (ms), 10 minutes |
| `timeoutMs` | `40000` | Load request timeout; must exceed AMD's ~26 s response time |
| `staleAfterMs` | `660000` | Mark data stale after this long without a refresh (11 minutes) |
| `loadUrl` | AMD load endpoint | Load API address |
| `catalogPollMs` | `21600000` | Catalog polling interval, 6 hours |
| `catalogUrl` | `bootstrap?section=dedicated` | Preferred catalog endpoint (all 15 entries in one request) |
| `catalogFallbackUrl` | `bootstrap?directory=true` | Fallback catalog endpoint (card list, then per-model detail) |
| `catalogTimeoutMs` | `20000` | Catalog request timeout |

## Data sources

Both endpoints live under `https://developer.amd.com.cn`. They need **no key**, but they do require the header `Origin: https://developer.amd.com.cn` — without it you get 403 `Invalid request origin`. The plugin sends it.

- Catalog: `POST /radeon/api/tokenfactory/bootstrap?section=dedicated` → `shared_models[]`, ~0.4 s / 58 KB.
- Load: `GET /radeon/api/tokenfactory/load` → `{ models: { <id>: { state, label, utilization } }, scope: "fleet" }`, **~26 s**.

Models are matched by the full id with the `model_gateway:` prefix stripped. Never match on `display_config.name`: `DeepSeek-V4.1-Flash` reports `DeepSeek-V4.1-Flash-1017`, which never matches a load key. Badges come only from `display_config.badge_label`.

## Known limitations

- **The config entry requires DSH Desktop ≥ 0.14.0 (embedded dsh ≥ 0.2.2-rc.1)**: `plugins.row.config` is a slot that 0.2.2-rc.1 introduced, and `slots.inject` silently waits on undeclared slots (no error, no log) — on older hosts the "Configure" button and the config page never appear, with nothing in the logs. v0.1.1 and earlier registered a settings page instead; this plugin **no longer registers a settings page, the config entry lives under Plugins → Installed → dsh-amd-model-load**.
- **Only the 15 models in AMD's Public Free section** are covered; the 3 Dedicated models are intentionally excluded.
- It depends on AMD's public endpoints, so an upstream change breaks it. The first load takes ~26 seconds — that is the endpoint, not the plugin.
- If `dsh-reasoning-effort` **0.8.1 or earlier** is installed, the model-list badges will not appear: that version replaced the composer's model selector outright at `priority: -100` and never renders the `conversation.input.model.label` child slot, so even the official `1017` badge disappears. **Upstream fixed this in 0.9.0 by wrapping the native component.** The investigation is written up in [M4-UPSTREAM-FINDING.md](M4-UPSTREAM-FINDING.md).
- **The collapsed model row (`placement: "trigger"`) is re-rendered very frequently by the host parent during streaming** (measured: ~8/s idle, 105–129/s while streaming). On that path this plugin only does one O(1) cached lookup and writes nothing during render; diagnostics are no longer reported per render either. The churn itself is host behaviour and out of scope here — see [M5-RENDER-CHURN.md](M5-RENDER-CHURN.md).
- While chasing the two issues above a temporary diagnostic layer was carried (`reportDiag`, `probeLedger`, a heartbeat, a diagnostic line on the settings card). **v0.1.1 removed all of it**: the release no longer writes `client-diag` lines into the host log and holds no diagnostic timers. What remains is a single `console.error` when a slot registration fails, prefixed with `[amd-model-load]` and visible only in the browser console.

## Development

No build step, plain ESM. Tests use Node's built-in runner:

```sh
node test/load-source.test.mjs   # 32 cases: normalisation, staleness, poller
node test/catalog.test.mjs       # 50 cases: catalog parsing, grouping, sorting
node test/client.test.mjs        # 82 cases: both slots, every render branch
bash test/with-stub.sh           # 24 cases: host half (stubs schemastery, cleans up on exit)
```

> The host suite must run through `bash test/with-stub.sh`: the plugin ships no dependencies, so a bare `node --test test/*.test.mjs` fails with `MODULE_NOT_FOUND` on `@deepseek-ai/schemastery`.

Hit the real endpoints once (~30 s):

```sh
node test/e2e-live.mjs
```

Layout:

```
lib/index.js        host half: two pollers + loopback RPC channel (load / catalog / refresh / diag)
lib/load-source.js  load data source (zero deps, unit-testable standalone)
lib/catalog.js      catalog data source + five-category grouping and sorting (zero deps)
lib/client.js       browser half: plugin-row config page + model-row chip, one shared snapshot store
cordis.patch.yml    bundle patch that inserts the plugin into the profile
test/               four suites + fixtures + with-stub.sh + e2e-live.mjs
```

Per-milestone verification notes and the dead ends we hit live in `M0-VERIFY.md`, `M1-REPORT.md`, `M3-REPORT.md` and `M4-*.md`.

## License

[MIT](LICENSE) © 2026 dengjiawei
