# dsh-amd-model-load

**English** · [简体中文](README.md)

Live load badges for **AMD Radeon TokenFactory** free models inside DeepSeek Harness (DSH Desktop).

Every row of the model selector gets a status dot plus a percentage — `● 20.1%` — and the settings page gets a card that lists all 15 free models grouped by AMD's five categories, sorted from idle to busy inside each group.

> The data comes from AMD's public load endpoint. **No API key required.**

---

## What it does

| Mount point | Effect |
| --- | --- |
| Settings → "AMD 模型负载" | Groups models under `VLM / LLM / Decision / TTS / OCR`; sorts by ascending utilization (idlest first); reproduces AMD's own `FREE` badge styling; shows the last refresh time and flips to stale when the data ages out |
| Model selector (`conversation.input.model.label`) | Appends "● percent" to each AMD model's `option` row; non-AMD rows, the collapsed trigger and the menu header stay untouched |
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

After that, `Settings → AMD 模型负载` should show the card and the log should contain `[amd-model-load] host loaded` and `catalog ok: 15 models`.

### Option 2 — plugin page

Use `Plugins → Add plugin` and enter the package name `dsh-amd-model-load` (installable once it is published to npm), or the local path / repository URL. This route is **not verified yet**; prefer Option 1 if anything misbehaves.

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
node test/client.test.mjs        # 72 cases: both slots, every render branch
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
lib/client.js       browser half: settings card + model-row badge, one shared snapshot store
cordis.patch.yml    bundle patch that inserts the plugin into the profile
test/               four suites + fixtures + with-stub.sh + e2e-live.mjs
```

Per-milestone verification notes and the dead ends we hit live in `M0-VERIFY.md`, `M1-REPORT.md`, `M3-REPORT.md` and `M4-*.md`.

## License

[MIT](LICENSE) © 2026 dengjiawei
