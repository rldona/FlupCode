# OpenCode V2 migration audit

- **Status:** Audit, not started. No code has changed.
- **Date:** 2026-09-30
- **Question:** "We run OpenCode 1.18.33. OpenCode V2.0.20 exists. Can FlupCode move to the V2 engine by
  changing the version, or what does FlupCode need to change to work with V2?"
- **Short answer:** No, it is not a version bump. V2 is a separate product line on a different
  upstream branch, and it removes every engine contract FlupCode uses to run turns:
  - the legacy HTTP routes;
  - the `message.*` SSE events;
  - the V1 plugin loader;
  - `@opencode-ai/sdk`.

  Moving to V2 means five things:
  1. Rewrite the engine client layer in `harness` and `harness-server` onto `/api/*`.
  2. Port all 14 engine plugins to the V2 plugin API.
  3. Re-home our engine patches: memory, `plan_exit`, the permission floor, message compat.
  4. Handle the one-way database migration that V2 runs on the shared `opencode.db`.
  5. Accept that V2 no longer ships a few features: LSP, `todowrite`, MCP OAuth over HTTP, config
     PATCH, and SSE-only MCP transports.

  In return, the V2 plugin API is good enough that most of our engine fork can be removed.

Sources:
- **V1 source:** upstream `dev@0f549842ee`, which is exactly our tree.
- **V2 source:** tag `v2.0.20` (`84c9be93a5`), from the in-repo git refs.
- **Official docs:** <https://opencode.ai/v2/docs>, <https://opencode.ai/v2/docs/migrate-v1>
  (also in-tree at `services/www/src/docs/content/migrate-v1.mdx` on `v2`).
- **npm dist-tags:** queried on 2026-09-30.
- **Unverified findings:** anything that needs a running engine to confirm is marked **UNKNOWN** or
  "inferred".

---

## 1. Our current engine

### 1.1 Exact version

| Fact | Value | Evidence |
|---|---|---|
| Engine version string | `1.18.32` | `packages/opencode/package.json`, `packages/sdk/js/package.json` |
| Upstream tree we carry | upstream `dev@0f549842ee` ("fix(stats): attribute Hy4 preview traffic to Tencent (#51050)", 2026-09-24) | `git diff fc741878ac 0f549842ee` is empty. `fc741878ac` is the second parent of our last sync merge `53d05dd59c` (PR #334). |
| Relation to `v1.18.33` | `v1.18.33` (`51ef4be1d3`, 2026-09-28) is a release commit cut from dev at `1eacc1bdb9` (2026-09-27), three days after our sync. We are **between 1.18.32 and 1.18.33**. The difference is bugfixes only. | `git merge-base v1.18.33 upstream/dev` |
| Integration model | **Vendored fork.** The whole upstream monorepo is in-tree. Our `dev` mirrors upstream `dev` with rewritten SHAs, and `power` merges `dev` (ADR-0001). There is no submodule or npm dependency. | `docs/adr/0001-fork-and-upstream-sync.md` |
| Our engine patches | 108 files, +8,146/−248 in upstream packages (§5.1) | `git diff 0f549842ee power -- packages/{core,opencode,server,protocol,schema,client,sdk,plugin,llm,session-ui}` |

### 1.2 How the engine runs

| Launcher | Command | Auth |
|---|---|---|
| `harness-desktop` main (`src/main/server.ts:145-275`) | `$FLUPCODE_OPENCODE serve --port 4096`. In dev: `bun run ./src/index.ts serve` in `packages/opencode`. Otherwise `opencode serve` from the `PATH`. **The packaged app does not bundle the engine.** | Generates `OPENCODE_SERVER_PASSWORD` (Basic, user `opencode`). Health check on `GET /global/health`. |
| `harness-desktop`, second sidecar | `flupcode-harness` (harness-server) on port 4097 | `FLUPCODE_ENGINE_AUTH`, `FLUPCODE_BROWSER_TOKEN` |
| `flupcode remote` (`flupcode-cli/src/index.ts:117-298`) | `opencode serve --hostname --port` if nothing answers on `/global/health` | `OPENCODE_SERVER_PASSWORD` |
| `script/restart-engine.sh` | `bun run ./src/index.ts serve --port 4096 --cors …` in `packages/opencode` | Unsets the password, so no auth |
| Before every spawn | `installEnginePlugins()` writes 14 `flupcode-*.js` files into `~/.config/opencode/plugins` | `packages/remote/src/engine-plugins.ts:2942` |

The version is pinned only at build time: `harness/vite.config.ts` copies the `sdk/js` version into
`__FLUPCODE_ENGINE_VERSION__`. At runtime it is compared with `/global/health.version` for a drift
warning. `GET /api/memory` tells a FlupCode-patched engine apart from a stock one.

### 1.3 Layered flow

```
Harness UI (Solid, packages/harness: desktop renderer / app.flupcode.com / phone PWA)
 ├─ engineFetch (Basic, 60 s timeout) ── HTTP/SSE/WS ──▶ engine :4096 (`opencode serve`)
 │     packages/opencode  ── legacy instance routes (/session, /event, /mcp, /config, /permission…)
 │                        └─ protocol routes /api/* (packages/server ← packages/protocol ← packages/schema)
 │       └─ packages/core (legacy runner in packages/opencode/session/prompt.ts; SessionV2 dormant for turns)
 │            └─ packages/llm / AI SDK → provider (models.dev catalog)
 │       └─ FlupCode engine plugins (~/.config/opencode/plugins/flupcode-*.js, V1 Hooks API)
 │            ── HTTP ──▶ harness-server /harness/adaptive/*, /harness/actions*, /harness/artifacts
 └─ Bearer ──▶ harness-server :4097 (NOT a proxy; owns runs, routines, artifacts, adaptive, vault, browser)
                 ── @opencode-ai/sdk/v2/client (Basic) ──▶ engine (polls; never subscribes to SSE)
Remote: phone PWA ═E2E═▶ relay (opaque) ═▶ host (desktop or `flupcode remote`) ─ serveTunnel ─▶ engine (any path)
        host also watches /api/event + /harness/events → Web Push
```

### 1.4 Client and contract surface

- **The only SDK is `@opencode-ai/sdk/v2/client`** (the legacy hey-api SDK, `packages/sdk/js`),
  plus raw `fetch`.
  - Consumers: `harness/src/client.ts` (single adapter) and `harness-server/src/engine.ts` (the
    `Engine` class).
  - Nobody imports `@opencode-ai/client`, `sdk-next`, core or server. `docs/ARCHITECTURE.md` §2 and
    ADR-0009 are stale on this point.
- **Turns run on the legacy V1 runtime.**
  - `session.send` → `POST /session/:id/prompt_async`.
  - The transcript streams on the per-folder legacy SSE `GET /event?directory=` (`message.part.delta`,
    `message.part.updated`, `message.updated`, `session.status`, `session.idle`).
  - It is converted to V2-like shapes by `harness/src/transcript.ts` (`fromLegacy`).
  - Only skills and sessions created through `/api` use the `SessionV2` runner.
- **The UI also consumes the global `/api/event`:** `session.next.*`, `permission.v2.asked`,
  `question.v2.asked`, `catalog.updated`.
- **Legacy routes in use.** The full table is in the working notes; the families are:
  - `/session/*`: `prompt_async`, `message`, `status`, `abort`, `summarize`, `revert`, `unrevert`,
    `revert/commit`, `fork`, `shell`, `command`, `share`, `children`, `todo`.
  - `/permission`, `/question`, `/mcp*`, `/experimental/resource`.
  - `/config`, `/global/config`, `/config/reload` (our patch), `/config/providers`.
  - `/global/health`, `/global/dispose`, `/path`, `/agent`, `/provider*`, `/auth/*`, `/vcs*`,
    `/pty*`.
  - `/experimental/{worktree,console,tool/ids,control-plane/move-session}`.
- **harness-server** drives runs through the same legacy calls: `POST /session` with `parentID` and
  `permission`, `prompt_async`, polling `/session/status` every 1 s, reading
  `/session/:id/message` for `tokens`/`cost`, `/session/:id/abort`, `/mcp?directory=`, and
  `/experimental/worktree`.

---

## 2. What `v2.0.20` actually is (decision A)

| Fact | Evidence |
|---|---|
| V2 is developed on the upstream branch **`v2`**, which split from `dev` at `0e2dd4ad15` on 2026-06-26. Since then `v2` has about 3,950 commits and `dev` about 1,290. | `git merge-base v2.0.20 0f549842ee`, `git log --oneline` counts |
| `v2.0.20` = `84c9be93a5`, "release: v2.0.20", 2026-09-29. `v2.0.0` was on 2026-09-11, so there were 21 releases in 18 days. | git tags |
| It ships under a **new npm scope**: `@opencode/cli`, `@opencode/client`, `@opencode/plugin`, `@opencode/sdk`, all with `latest` = **2.0.20**. V1 remains `opencode-ai` / `@opencode-ai/*`, `latest` = **1.18.33**. | npm dist-tags; `packages/script/src/index.ts` forces versions ≥ 2.0.0 |
| **GitHub Releases** still shows v1.18.33 as *Latest*. V2 releases aren't published there; binaries come from `opencode.ai/files/bin/<version>/`, npm, `curl opencode.ai/v2/install` and `brew anomalyco/tap/opencode-v2`. | `gh release view v2.0.20` returns "not found" |
| The main docs site is still V1, with a banner pointing to `/v2/docs`. The V2 docs have no beta label. **There is no end-of-life notice for V1**, and 1.18.31, .32 and .33 all shipped after v2.0.0. | opencode.ai/docs, /v2/docs |
| Upstream's V2 `AGENTS.md` names `v2` as the default branch. | `S/v2/AGENTS.md` |

**Conclusion A:**
- `v2.0.20` is the current stable release of the V2 line, and it is the right V2 engine to target.
- It is not the next version on the branch we track. Our fork follows `dev` (1.x). Targeting V2
  means **switching the upstream branch we follow** (`dev` → `v2`), or better, consuming V2 as an
  external engine (§12).
- V2 is shipped and stable-versioned, but upstream does not yet treat it as the default: V1 still
  gets releases, keeps the legacy package names and holds the "Latest" GitHub release.
- It is moving fast. Any target should be a pinned `2.0.x`, not `latest`.

**Note on V2 code already in our tree:** dev (our tree) already contains an early V2 core:
- `SessionV2`, `SessionExecution`, `session_input`, `EventV2`, `PermissionV2`;
- 61 `/api` routes in `packages/server`;
- `packages/llm`.

That is where `session.next.*` and `/api/*` come from. It is **not** what V2.0.20 ships:
- V2 renamed `session.next.*` → `session.*` and flattened the prompt payload;
- it replaced `session_input` with `session_inbox`, and System Context with Instructions;
- it has about 140 `/api` endpoints.

The "V2 Session Core" section of our `AGENTS.md` describes the dev-era design, not v2.0.20.

---

## 3. V1 (1.18.32) vs V2 (2.0.20): technical diff

### 3.1 Packages and structure

- **Removed:** `packages/opencode` (the whole V1 engine, legacy routes and legacy runner; commit
  `44b6938b2a`), `packages/sdk/js` (the legacy SDK), `packages/sdk-next`, `packages/llm` (now
  `packages/ai`, `@opencode/ai`), `packages/docs`.
- **Added:** `packages/{ai, util, theme, plugin-browser, simulation, latex, merman}` and
  `services/www` (the V2 docs).
- **npm scope:** `@opencode-ai/*` becomes `@opencode/*` (commit `a5312e169b`).
- **Our architecture rule still holds in V2:** Schema → Core and Protocol → Server, with Client
  depending on Schema and Protocol. The SDK is regenerated with `bun run generate` in
  `packages/client`, using `@opencode/httpapi-codegen` over `ClientApi` from
  `@opencode/protocol/client`. `@opencode/sdk` is now an **in-process host**, not an HTTP SDK.

### 3.2 Core engine

| Area | V1 (what FlupCode uses) | V2.0.20 |
|---|---|---|
| Execution | `SessionPrompt.loop` + `SessionProcessor`, an in-memory multi-step AI SDK `streamText` loop (`opencode/src/session/prompt.ts`) | Durable inbox. `Session.prompt` writes `session_inbox`, then `SessionExecution.wake`. `SessionRunCoordinator` runs one drain per session, and sessions run in parallel. `SessionRunner` makes one `llm.stream` call per attempt and reloads history between steps. |
| Prompt while busy | Joins the running loop. FlupCode keeps a client-side queue (`pending-prompts.ts`). | **steer** (next step boundary) or **queue** (delivered at idle), both on the server. Inbox items can be listed, switched between modes and cancelled. |
| Crash recovery | None | Write-ahead execution claim; resumes on startup, with attempts counted |
| Interrupt | abort | `interrupt?resume=`, returns `{interrupted}` |
| Subagents / background | `task` tool, blocking | `subagent` tool with `background: true`, the `Job` service, parent notified on completion, `/api/session/:id/background` |
| Messages | `message` + `part` rows (`MessageV2`); parts `text`, `reasoning`, `file`, `agent`, `compaction`, `subtask`, `retry`, `step-*`, `snapshot`, `patch`, `tool` | One ordered `session_message` table with `seq`; kinds `user`, `synthetic`, `system`, `skill`, `shell`, `assistant`, `tool`, `text`, `reasoning`, `compaction`, `*-switched`, `idle` |
| Tool state | `pending`, `running`, `completed`, `error` (error is a string) | `streaming{input:string}`, `running`, `completed{content: NonEmpty}`, `error{StructuredError}` |
| Events | `Bus` + `event-v2-bridge` | Durable per-aggregate sequenced log, projected into read models; volatile `/api/event` plus a replayable `/session/:id/log` |
| Tools | bash, edit, write, apply_patch, glob, grep, read, **lsp**, task, **todo**, question, skill, webfetch, websearch, plan | shell, edit, write, patch, glob, grep, read, question, skill, subagent, webfetch, websearch, MCP resources, session_rename/move. **No LSP, no todowrite.** Tools default to **Code Mode**. |
| Permissions | Rules grouped by tool | Ordered `[{action, resource, effect}]` with typed Declined, Corrected and Blocked errors and saved approvals. Questions become **forms**. |
| Compaction / context | `compaction.ts`, prune, tail turns | Checkpoint compaction with `keep.tokens` and provider-native compaction. **Instructions** (delta-stored) replace System Context and Context Epoch. |
| Providers | AI SDK by default; native `llm` behind a flag | Native `@opencode/ai` by default, with an AI SDK adapter kept. Reasoning variants in `variant.ts`; effort changes keep the provider cache. |
| Cost | `cost: number`, `tokens{…}` | `cost: Money.USD`, `TokenUsage`, `session/usage.ts` with **tiered pricing by context size**, `SessionStats`, `session.usage.*` events |
| Server model | One `opencode serve` per launcher | Also a **shared background service per user** (`serve --service`), plus `--stdio`, `--standalone` and `--server URL` |

### 3.3 HTTP API

**The legacy routes are all removed.** V2 serves only `/api/*` (about 140 endpoints, list in
`packages/protocol/src/groups/*`). These are the replacements that matter to FlupCode:

| V1 used by FlupCode | V2 |
|---|---|
| `GET /global/health` | `GET /api/info` → `{version, pid, urls, paths}` |
| `POST /session/:id/prompt_async`, `/message` | `POST /api/session/:id/prompt {id?, text, files?, agents?, skills?, metadata?, delivery?, resume?}` returns `Inbox.User`. The body is flat, with no `parts`. |
| `GET /event?directory=`, `/global/event` | `GET /api/event` (global; filter on `location.directory`; volatile, and a slow consumer is disconnected) plus `GET /api/experimental/session/:id/log?after=&follow=` for replay |
| `/session/status`, `session.idle` | `session.execution.*` events, `GET /api/session/active`, `POST /api/experimental/session/:id/wait` |
| `/session/:id/abort` | `POST /api/session/:id/interrupt` |
| `/session/:id/summarize` | `POST /api/session/:id/compact` (a durable admission) |
| `/session/:id/revert`, `unrevert`, `revert/commit` | `revert.stage`, `DELETE …/revert`, `revert.commit` |
| `/session/:id/children` | `GET /api/session?parentID=` |
| `/session/:id/todo`, `share`, `init`, message and part delete | **Removed** |
| `POST /session` with `parentID`, `permission` | `POST /api/session`. The public payload **has no `parentID`**; use `metadata`. Permissions are set with `PATCH /api/session/:id {permissions}`. |
| `/permission`, `/permission/:id/reply` | `/api/session/:id/permission/:rid/reply {decision: once|always|reject}` |
| `/question*` | **Forms**: `/api/session/:id/form[/:id/reply]`, reply `{answer: Record<…>}` |
| `/mcp`, `/mcp/:n/{connect,disconnect}`, `POST /mcp` | `GET /api/mcp` (returns an array plus `location`), `PUT/DELETE/POST /api/experimental/mcp/:server[/connect\|disconnect]` |
| `/mcp/:n/auth*` | **Removed from HTTP.** Runs through the integration OAuth flow (`/api/integration/:id/connect/oauth…`) |
| `/experimental/resource` | `GET /api/mcp/resource` |
| `GET/PATCH /config`, `/global/config`, `/config/reload` | `GET /api/config` (normalized `Config.Entry[]`), `PATCH /api/experimental/config` (**only `shell`**), `POST /api/location/reload` |
| `/global/dispose`, `/path`, `/lsp`, `/experimental/console`, `/experimental/tool/ids` | Removed |
| `/provider/auth`, `/provider/:id/oauth/*`, `/auth/:id` | `/api/integration/*`, `/api/credential*` |
| `/vcs*` | `/api/vcs{,/base,/branch,/diff,/status}` (no apply, no raw diff) |
| `/find/symbol`, text find | Removed (`/api/fs/{list,read,find}` and `experimental/fs/write` remain) |
| `/experimental/worktree` | `/api/worktree` |
| `/pty*` | `/api/pty*` (same shape) |
| `/tui/*` | Removed; plugin RPC `/api/rpc/:id/:method` is the extension point |
| `?directory=` / `?workspace=` | `?location[directory]=` or `x-opencode-directory`. **`?directory=` is ignored** and workspaces are gone. |

- **OperationIds lost the `v2.` prefix;** experimental routes use `experimental.*`.
- **Errors** are always tagged `{_tag, message}`. The old `{name, data}` NamedError body is gone.
- **Upstream publishes no changelog of breaking changes.** The authoritative record is
  `V2_HTTP_API_AUDIT.md` at the v2 repo root.

### 3.4 Events

- **Renamed `session.next.*` → `session.*`** (commit `394e0b9045`):
  - `prompted`/`prompt.admitted` → `session.inbox.{enqueued,delivered,cancelled}`;
  - `agent.switched` → `session.agent.selected`;
  - `context.updated` → `session.instructions.updated`;
  - `retried` → `session.retry.scheduled`.
- **Text and reasoning deltas** are now keyed by `ordinal`, not `textID`.
- **Removed:** `message.updated`, `message.removed`, `message.part.{updated,removed,delta}`,
  `session.updated`, `session.error`, `session.diff`, `session.compacted`, `todo.updated`,
  `permission.v2.*` (→ `permission.asked/replied`), `question.*` (→ `form.*`), `catalog.updated`
  (→ `model.updated`, `provider.updated`…), `server.heartbeat` (now an SSE comment),
  `file.watcher.updated`, `lsp.updated`.
- **Added:**
  - `session.execution.{started,succeeded,failed,interrupted}`;
  - `session.usage.{recorded,updated}`;
  - `session.{created,deleted,forked,renamed,metadata.updated}`;
  - `mcp.status.changed`, `mcp.resources.changed`, `rpc.<name>`.
- **Envelope:** `{id, type, created, data, location?, durable?}`.

### 3.5 Auth

- **Password handling:**
  - `OPENCODE_PASSWORD` is read first, then `OPENCODE_SERVER_PASSWORD`.
  - **A password is always required.** If none is set, one is generated and printed, so
    `restart-engine.sh`'s passwordless mode stops working.
  - The username is fixed to `opencode`; `OPENCODE_SERVER_USERNAME` is removed.
- **New credentials:** signed session tokens, a cookie, and one-time pairing links
  (`POST /api/pair`, `GET /auth/connect/:code`).
- **Unchanged:** Basic auth and `?auth_token=`.
- **CORS:** `--cors` still exists.

### 3.6 Config (`opencode.json[c]`)

- **V2 reads V1 config as-is.** `ConfigNormalize` + `ConfigMigrateV1` convert it in memory, and the
  file is never rewritten. Native V2 keys win on conflict.
- **Main renames:**
  - `agent`/`mode` → `agents` (`prompt` → `system`);
  - `permission` + `tools` → ordered `permissions` (`bash` → `shell`, `task` → `subagent`,
    `write`/`patch` → `edit`);
  - `mcp.{n}` → `mcp.servers.{n}` (`enabled` → `disabled`; `timeout` → `{catalog, execution}`);
  - `provider` → `providers` (`npm` → `package`);
  - `command` → `commands`, `plugin` → `plugins`;
  - `small_model` → `agents.title.model`;
  - `autoupdate` → `update`, `snapshot` → `snapshots`, `attachment` → `media`.
- **Unknown keys are silently dropped**, so our `flupcode` and `memory` blocks disappear from the
  engine's view.
- **The global `config.json` is no longer read.**
- **TUI config** moves to one global `cli.json`. FlupCode doesn't use it.

### 3.7 Data (important)

- **V2 uses the same data directory and the same `opencode.db`** (`packages/cli/src/database-path.ts`).
- **Its extra migrations change the schema:**
  - `20260804233008_loose_psylocke` **drops** `session_input`, `session_context_epoch` and
    `data_migration`, and adds `session_v2`;
  - `20260910120000_clear_v1_session_permission` **sets `session_v2.permission` to NULL**;
  - `20260805200742_import_legacy_credentials` imports `auth.json`.
- **Background session import:** `core/src/database/v1-migration.bun.ts` first runs
  `DELETE FROM event`, then copies V1 `session`/`message`/`part` into `session_v2`/`session_message`.
  It runs **once**; sessions created in V1 afterwards never appear in V2. Status is at
  `GET /api/experimental/migration/v1`.
- **After a rollback,** V1's legacy tables are kept, so the legacy runner should still work.
  Anything in V1 that depends on the dev-era `/api` core, such as `session_input`, breaks. This is
  **UNKNOWN**: it has not been tested.
- **Our memory migration** (`20260914143517_add_memory`) is out of order against V2's list, which
  runs up to `20260923…`.

### 3.8 Performance

- **Neither tree and no release note contains runtime benchmarks.**
- **What exists:** `perf/test-suite.md` (test-suite speed only, identical in both trees) and V2's
  `packages/core/script/benchmark-location{,-memory}.ts`, with no committed results.
- **No numbers are given here.** §11 lists what to measure.

---

## 4. Plugins

### 4.1 The V2 loader contract

- **Package:** `@opencode/plugin` (`.`, `./effect`, `./tui`).
- **Discovery:**
  - the config `plugins` array (entries are strings, `{package, options}` or `"-name"`);
  - `plugin/` and `plugins/` directories inside every config directory;
  - npm packages.

  A local path configured directly must be a directory.
- **Required module shape:** `export default { id, setup(ctx) }` or `{ id, effect }`. Anything else
  fails with *"Plugin must export a default definition with an id and an effect or setup function."*
  (`core/src/plugin/module.ts:111`).
- **No V1 compatibility layer exists.** V1 named-export `Hooks` plugins are rejected at load time.
- **Hooks that exist and are verified at their call sites:**
  - `session.hook("context")`: mutable `system`, `messages`, `tools`, `options`. It fires on every
    primary request.
  - `session.hook("compaction")`: can supply the summary itself.
  - `session.hook("prompt" | "title" | "model.request" | "http.request" | "http.response" | "retry")`
  - `tool.hook("execute.before" | "execute.after")`: `result` is mutable.
  - `tool.transform(add)`: registers tools, with JSON Schema input.
  - `permission.hook("evaluate")`
  - `ctx.event.subscribe`, `ctx.storage` (scoped key-value), `ctx.rpc.register` (typed HTTP
    endpoints at `/api/rpc`)
- **Gaps:**
  - `ctx.catalog` is missing; use `ctx.model` or `ctx.provider` instead.
  - Transform editors are synchronous.
  - **There is no per-call `ctx.ask` in the tool context.**
- **`docs/V2-HOOKS.md` is out of date.** It says V2 has no tool registration and no message or
  compaction seams, but that was measured against the dev-era core. V2.0.20 has all of them.

### 4.2 Plugin inventory

All live in `packages/remote/src/engine-plugins.ts` (`PLUGINS`, about line 2924).

| Plugin | API today | On V2.0.20 | Port to |
|---|---|---|---|
| `flupcode-reasoning-variants` | Embedded-v2 `{id,setup}`, `ctx.catalog.transform` (async) | **BREAKING:** loads, then `setup` throws because `ctx.catalog` doesn't exist | `ctx.model.transform` with a synchronous editor; read `models.json` before registering |
| `flupcode-tool-uses` | V1 `tool.execute.before/after` | **BREAKING** (refused at load) | `tool.hook("execute.*")` (`id` replaces `callID`) |
| `flupcode-runtime-probe` | V1 `system.transform`, `event` (`session.next.*`) | BREAKING | `session.hook("context")`, `event.subscribe` on `session.*`; redesign how turns are classified |
| `flupcode-system-prompt` | V1 `system.transform` | BREAKING | `session.hook("context").system` |
| `flupcode-artifact-write` | V1 `tool` | BREAKING | `tool.transform(add)` |
| `flupcode-deliver` | V1 `tool` | BREAKING | `tool.transform(add)` |
| `flupcode-actions` (web actions) | V1 `tool` + **`ctx.ask`** on each call | **BREAKING, needs a redesign** | Static permission + `permission.hook("evaluate")`, or the form API. **UNKNOWN** which works. |
| `flupcode-episode-events` | V1 `event` (`message.part.updated`, `session.error`) | BREAKING | `event.subscribe` on `session.tool.failed`, `session.step.failed`, `session.execution.failed` |
| `flupcode-relevance` | V1 `messages.transform` (per-turn pinned line) | BREAKING, portable | `session.hook("context").messages`; keep the tail pin for the cache |
| `flupcode-guardrails` | V1 `tool.execute.before`, `event` | BREAKING, portable | `tool.hook("execute.before")` (rejects with `Tool.Error`) |
| `flupcode-session-metrics` | V1 `event` | BREAKING, portable | `event.subscribe` on `session.step.ended`, `session.usage.*`, `session.tool.*` |
| `flupcode-compaction-anchors` | V1 `messages.transform`, `tool.execute.after`, `session.compacting` | BREAKING, portable, **better on V2** | `session.hook("context")`, `tool.hook("execute.after")`, `session.hook("compaction")` |
| `flupcode-tool-trim` (+ `evidence_read`) | V1 `tool.execute.after`, `tool` | BREAKING, portable | `tool.hook("execute.after")`, `tool.transform(add)` |
| `flupcode-cache-selection` | V1 `messages.transform` | BREAKING, portable | `session.hook("context")` |
| `.opencode/tool/github-*.ts` (upstream repo tooling) | V1 | Ignored: V2 doesn't discover `tool/` directories. Already disabled. | None |

**Result:** 13 plugins are refused at load and 1 fails in `setup`. The engine keeps running without
them, so nothing crashes, but every adaptive feature goes silent. `harness-server/src/adaptive/runtime.ts`
would also misclassify turns, because it keys on `session.next.*`.

---

## 5. FlupCode dependency classification

The classes are **SAFE** (no change), **COMPATIBLE** (works, should be adapted), **BREAKING**
(mandatory change) and **UNKNOWN** (needs a live test).

### 5.1 Engine patches (in-tree upstream packages)

| Area / files | Contract | V2 behaviour | Class | Action |
|---|---|---|---|---|
| Memory layer: `core/src/memory*`, `tool/memory.ts`, `config/memory.ts`, migration `20260914143517_add_memory`, `schema/src/memory.ts`, `protocol/src/groups/memory.ts`, `server/src/handlers/memory.ts`, `location-services.ts` | runner system array, projector delete hook, DB migrations, protocol API | Not present. `runner/llm.ts` has been restructured into `model-request.ts`. | BREAKING | Re-implement as a V2 plugin: `session.hook("context")` + `tool.transform` + `rpc.register` + its own storage (§8) |
| `plan_exit` tool, `PLAN_SYSTEM` (`core/src/tool/plan-exit.ts`, `plugin/agent.ts`) | ToolRegistry, QuestionV2, AgentV2 | V2 ships `opencode.plan` (a plugin; plan mode lasts until the user switches) and has no `plan_exit` | BREAKING | Plugin tool using forms, or adopt upstream's plan UX |
| Session message compat + backfill (`session/message-compat.ts`, `script/session-message-backfill.ts`) | `SessionMessage` decode | Schema rewritten; V2 has its own `v1-migration.bun.ts` | BREAKING | Drop after checking that upstream's migration handles the same rows; keep the script only as a one-off |
| Permission floor (`permission.ts` `{rules, floor}`, `session/info.ts`, `schema/src/session.ts`) | `PermissionV2.evaluate`, `session_v2.permission` | V2 merges agent and session rules **without a floor**, and a migration NULLs stored session permissions | BREAKING | Write the V2 `permissions` shape; re-apply the floor via `permission.hook("evaluate")` or propose it upstream; expect stored modes to be wiped |
| Config reload (`POST /config/reload`, `reload()` on Agent, Command, Skill, ToolRegistry) | V1 HttpApi | V2 reloads config itself when files change; `POST /api/location/reload` exists | COMPATIBLE | Drop the patch; call `/api/location/reload` |
| `revertCommit` | V1 HttpApi | Native `revert.commit` | SAFE (drop) | Drop |
| GitHub Copilot device flow + headers (`plugin/provider/github-copilot.ts`, `runner/model.ts`, `opencode/src/auth/index.ts`) | Integration/Credential | V2 ships the same device flow (same `clientID`) and headers natively | SAFE (drop) | Drop; verify headers match |
| `catalog.ts` `markExplicit`, keyless custom providers, `disabled_providers`, `small_model` | Catalog API | `catalog.ts` is gone (now `provider.ts`, `model-resolver.ts`); `normalize.ts` handles `small_model`/`disabled_providers` | UNKNOWN | Re-test keyless custom providers on V2; port only what is missing |
| `flupcode` config block in the engine schema (`v1/config/config.ts:51`) | V1 config schema | Dropped silently | BREAKING | Move to FlupCode-owned config, read by harness-server |
| LLM fixes (`llm/protocols/openai-chat.ts`, `route/executor.ts` retries 2→5, retryable transport errors) | `@opencode-ai/llm` | Package is now `@opencode/ai`; `session.hook("retry")` exists | COMPATIBLE | Check upstream; use the `retry` hook |
| Hidden `cowork` agent, `serve.ts` port error, `processor.ts` guard | V1 | V1 is gone | COMPATIBLE | `cowork` becomes a plugin `ctx.agent.transform`; drop the rest |
| session-ui tool image attachments (`message-part.tsx`, `message-file.ts`) | V1 ToolPart `state.attachments` | Content lives in `completed.content` | BREAKING | Read V2 `content` |

### 5.2 FlupCode packages

| File / symbol | Contract | V2 | Class | Change |
|---|---|---|---|---|
| `harness/src/client.ts` (the whole adapter), `harness-server/src/engine.ts` `Engine` | `@opencode-ai/sdk/v2/client` (legacy SDK) | Package deleted; `@opencode/client` has renamed singular namespaces and flat payloads | BREAKING | New adapter on `@opencode/client` (§9) |
| `client.ts` `session.send` → `promptAsync` | `POST /session/:id/prompt_async` | Removed | BREAKING | `session.prompt({sessionID, text, files, agents, delivery})`; model and agent via `/model` and `/agent` or the session defaults |
| `app.tsx` `followDirectory` (~2894), `transcript.ts` `applyDelta`, `applyPart`, `fromLegacy`, `ORPHANED_PARTS`, `partTypesByID` | `GET /event?directory=`, `message.part.*` | Removed | BREAKING | Reduce `session.text/reasoning/tool.*` events keyed by `assistantMessageID`+`ordinal`; the upstream reference is `client/src/solid/data.ts` `createData` |
| `app.tsx` `trackActivity` (~367), `watchRun`, `resyncRuns` | `session.status` busy/idle/retry, `session.idle` | No emitter left in V2 (the schema still defines the event) | BREAKING | `session.execution.*`, `Idle{outcome}`, `session.retry.scheduled` |
| `app.tsx` `/api/event` handlers (~2680-2790), `replay.ts`, `remote/src/notifier.ts:95-131` | `session.next.*`, `permission.v2.asked`, `question.v2.asked`, `catalog.updated`, `properties` envelope | Renamed or removed | BREAKING | Rename the handlers; map `catalog.updated` → `model.updated`/`provider.updated`; `/history` → `/log` |
| `client.ts` `blocked.*` (~904), `PermissionDock`, `QuestionDock`, `pending-questions.ts` | `/permission`, `/question` | Permissions under `/api/session/:id/permission`, `decision`; questions become forms | BREAKING | Port; the question UI becomes a form UI (typed fields) |
| `pending-prompts.ts`, `DeliveryMenu.tsx` | Client-side queue | Server inbox with steer and queue | COMPATIBLE | Replace with the inbox API (simplification) |
| `client.ts` MCP (~1072-1118), `McpManager.tsx`, `mcp.ts`, `app.tsx:1290` `mcpDirectory` | `/mcp*`, `?directory=`, MCP OAuth routes | `/api/mcp*`, `location[directory]`, OAuth through integrations | BREAKING | §6 |
| `client.ts:296-372,683`, `ConfigPanel.tsx` | `GET/PATCH /config`, `/global/config`, `/config/reload`, `/global/dispose`, `/path`, `/global/health` | `GET /api/config` (entries), no general PATCH, `/api/location/reload`, `/api/info` | BREAKING | Read `/api/config`; write config files through harness-server; `/api/info` for version and health |
| `client.ts` provider OAuth, `/auth/*` | legacy routes | `/api/integration/*`, `/api/credential*` | BREAKING | Port to integrations |
| `client.ts` `vcs.*`, `Terminal.tsx` `/pty*` | `/vcs*`, `/pty*` | `/api/vcs*` (no apply), `/api/pty*` (same shape) | COMPATIBLE | Change paths and location parameter |
| `client.ts` `session.children`, `todo`, `share`, `shell`, `command`, `fork`, `summarize`, `revert*` | legacy session routes | `?parentID=`; **todo and share removed**; `shell`, `command`, `fork`, `compact`, `revert.*` exist | BREAKING (todo, share) / COMPATIBLE (rest) | Remove the "Tasks" aside (todo) or rebuild it; drop share or reimplement it |
| `client.ts` `/experimental/console*`, `/experimental/tool/ids`, `/experimental/resource` | legacy | Removed / `GET /api/mcp/resource` | BREAKING | Drop console org (CO-1) or rebuild on integrations; tool ids from `/api/agent` or plugins |
| `engine-types.ts` re-exports (`SessionV2Info`, `SessionMessage*`, `PermissionV2Request`, `QuestionV2Request`, `ModelV2Info`…) | dev-era protocol shapes | Renamed (`Session.Info`, …); `QuestionV2Request` gone | BREAKING (types) | Re-point at `@opencode/client` types |
| `harness-server` `runner.ts` (`createSession` with `parentID` + `permission`, `waitForIdle` polling, `lastAnswer`, `interrupt`) | legacy `/session*`, `/session/status` | No `parentID` on public create; `wait` and `execution.*`; `interrupt` | BREAKING | `metadata{runID,taskID}`, `PATCH {permissions}`, `experimental.session.wait` |
| `harness-server/src/engine.ts` `isRunningTool` | V1 and dev-era tool part | Already handles both shapes | COMPATIBLE | Retarget the V2 field names |
| `harness-server/src/adaptive/runtime.ts` `watchRuntime` | `session.next.*`, `/global/health` | Renamed; `/api/info` | BREAKING | Classify by a plugin acknowledgement (RPC ping) |
| `harness-desktop/src/main/server.ts` `resolveEngine`, `ensureServer`, `ensureEngineCredentials` | `opencode serve --port`, `OPENCODE_SERVER_PASSWORD`, `/global/health` | `serve --port` and the password still work; `/global/health` is gone; V1 and V2 both install `opencode` | BREAKING (health) / UNKNOWN (binary name) | Health via `/api/info`; resolve a V2 binary explicitly (`$FLUPCODE_OPENCODE`), never an ambiguous `opencode` from the `PATH` |
| `OPENCODE_SERVER_USERNAME` (desktop, cli, harness-server) | V1 env | Removed; the username is fixed to `opencode` | COMPATIBLE | Stop sending it |
| `script/restart-engine.sh` | Passwordless `serve` inside `packages/opencode` | `packages/opencode` is gone; a password is required | BREAKING | Rewrite for the V2 binary with an explicit password |
| `flupcode-cli` | `opencode serve`, `/global/health` | As for desktop | BREAKING (health) | `/api/info` |
| `remote/src/tunnel.ts` `serveTunnel` | Opaque path proxy + Basic | Unchanged model | SAFE | None (the auth header still works) |
| `relay` | None | None | SAFE | None |
| harness-server routes with no engine calls (`artifacts`, `actions`, `routines`, `browser`, `vault`, `git/*`, `context`, …) | Filesystem, SQLite | Not affected | SAFE | None, except the files written by plugins (`system-prompt`, `tool-uses`), which follow the plugin port |
| `.opencode/opencode.jsonc`, `agent/*.md`, `command/*.md`, `skills/*` | V1 config | Normalized on load | COMPATIBLE | None; optionally rewrite in the V2 shape |
| Global `config.json` read by harness-server (`config-files.ts:114`, `action-config.ts:25`) and plugins | Engine used to read it | The V2 engine no longer reads it | COMPATIBLE | FlupCode still reads it; don't rely on the engine for it |
| `OPENCODE_CONFIG_DIR` handling (`config-files.ts:139`, `context.ts:46`) | V1 adds it as a layer | V2 **replaces** the global directory | COMPATIBLE | Review the layering assumptions |
| `OPENCODE_CONFIG_CONTENT` in replay (`replay/spawn.ts:31`) | env | Still honoured | SAFE | None |
| Code Mode default for MCP and tools | n/a | Tools are called through the Code Mode wrapper | UNKNOWN | Check how it affects `tool-uses`, guardrails and the tool accounting in the UI |

---

## 6. MCP

| Aspect | V1 | V2 | Class |
|---|---|---|---|
| Config | `mcp.{n}` local/remote, `enabled`, `timeout` ms, `oauth{clientId…}` | `mcp.servers.{n}`, `disabled`, `timeout{startup,catalog,execution}`, `oauth{client_id…}`, `codemode`, `protocol`; the V1 shape is migrated | COMPATIBLE |
| Transports | stdio; Streamable HTTP **with fallback to SSE** | stdio; **Streamable HTTP only** | BREAKING for servers that only speak SSE |
| Status | `GET /mcp` returns `Record<name,{status}>`, including `needs_client_registration` | `GET /api/mcp` returns `{location, data:[{name,status,integrationID?}]}`, new `pending` status, plus the `mcp.status.changed` event | BREAKING (shape) |
| Add / connect | `POST /mcp`, `/mcp/:n/connect`, `/disconnect` | `PUT/DELETE /api/experimental/mcp/:server`, `POST …/connect`, `…/disconnect` | BREAKING |
| OAuth (`auth/start`) | `POST /mcp/:n/auth` → `{authorizationUrl}`, callback, `authenticate`, `DELETE auth`; fixed port 19876 | Each remote server becomes an **integration** `mcp_<hash>`; `POST /api/integration/:id/connect/oauth`, then poll, complete, or cancel; credentials removed via `/api/credential/:id`. The callback port comes from `callback_port`, then the port in `redirect_uri`, then an **ephemeral** port. | BREAKING; pre-registered OAuth clients must set `callback_port` |
| Discovery / init | All servers connect synchronously on the first `MCP.status` for an instance | Initial connections are forked in the background; servers report `pending` | Improvement |
| Tool naming | `server_tool` | Same, but called through Code Mode by default | UNKNOWN (UI accounting) |
| Resources | `/experimental/resource` | `GET /api/mcp/resource`; prompts become commands | BREAKING (route) |
| Directory | `?directory=` / header / `cwd` | `?location[directory]=` / header / `cwd`; `?directory=` is ignored | BREAKING |

**The `GET /mcp` without `?directory=` issue.**

- **The workaround is in `harness/src/app.tsx:1290-1310`** (commit `2243cef6a8`):
  `mcpDirectory() = vcsDirectory() ?? enginePaths().directory ?? enginePaths().state`, sent as
  `?directory=` on the MCP list, resources and config calls.
- **499 means the client aborted.** It is Effect's status for a client disconnect, with an empty
  body. The harness gives up after its 60 s `AbortSignal.timeout` (`transport.ts:107`); the handler
  never refused the request.
- **Inferred root cause (not reproduced):**
  1. With no directory, V1 boots a cold instance for `process.cwd()`. In desktop dev that is
     `packages/opencode`, inside this repo.
  2. Booting waits for `plugin.init`: the background dependency install for the 14 external
     plugins, plus their startup probes to harness-server.
  3. `MCP.status` then connects **every** server synchronously. A dead remote server can spend
     30 s on Streamable HTTP and 30 s more on SSE.

  Stock OpenCode answers 200 because its cwd instance is already warm and it has no external
  plugins.
- **What V2 changes:** MCP connections run in the background and there is no per-directory
  dependency install, so **the timeout cause goes away**.
- **What stays the same:** a request with no location still resolves to a cold `cwd` Location,
  which may be the wrong project.
- **What to do:** keep the workaround, but **rewrite it**:
  - send `location[directory]`, because `?directory=` is ignored;
  - check `response.location`;
  - drop the `state` fallback, which only shows global servers.

  Its purpose changes from "avoid the 499" to "target the right project".
- **An existing bug that should be fixed on V1 too:** MCP writes in `client.ts` (~1085-1118:
  connect, disconnect, add, auth) send **no** directory, so they can act on a different instance
  than the list shows.

---

## 7. UI and UX semantics

What still maps directly:
- The harness already renders a **V2-like model**: `SessionMessageAssistant`/`Text`/`Reasoning`/`Tool`.
- It already converts legacy parts into that model (`fromLegacy`).
- Its **run, routine, artifact and cost** concepts belong to FlupCode, not to the engine.

What changes meaning:

1. **Streaming:** part-id deltas become `text/reasoning.{started,delta,ended}` keyed by `ordinal`.
   Part-type bookkeeping goes away.
2. **Status:** busy/idle/retry becomes an execution lifecycle (`started` → `succeeded`, `failed` or
   `interrupted` with a reason) plus a durable `Idle{outcome}` message and `retry.scheduled`. The
   UI can show *why* a session stopped, which is new.
3. **Queue:** the client queue becomes the server inbox (steer and queue, cancel, switch mode).
   Queued prompts survive an interrupt and a reload. `DeliveryMenu` maps directly onto it.
4. **Tools:** `pending` becomes `streaming{input:string}`. Errors are structured. Time fields are
   `created/ran/completed`, and `pruned` is gone.
5. **New message kinds:** `synthetic`, `system`, `skill`, `shell`, `*-switched`, `idle`, and
   compaction with a lifecycle. Subtask parts become subagent jobs; patch and snapshot parts become
   `assistant.snapshot`.
6. **Permissions:** `source.callID` becomes `source.id`; replies are once/always/reject; the V2
   error types also give "declined with feedback".
7. **Questions become forms:** typed fields (`string`, `number`, `boolean`, `multiselect`,
   `external`) and a different answer schema. `QuestionDock` needs a redesign.
8. **Removed:** todos (the "Tasks" aside), share, LSP diagnostics, console org, vcs apply, symbol
   search.
9. **Cost:** field names are stable, but `Money.USD` is a branded type. Totals arrive on
   `step.ended` and `usage.updated`.
10. **Errors:** `session.error` becomes `execution.failed.error`, `step.failed.error` and
    `assistant.error`, all using the structured `SessionError`.
11. **MCP:** polling becomes the `mcp.status.changed` and `mcp.resources.changed` events; a
    `pending` state is added.
12. **Models and agents:** `catalog.updated` becomes `model.updated` and `provider.updated`. Variants
    use `provider/model#variant`.

Every screen still makes sense on V2. None becomes wrong in concept, but every data source changes,
and Tasks, Share, Console org and LSP lose their data entirely.

---

## 8. Runs, artifacts and what V2 lets us simplify

| FlupCode concept | Today | V2 primitive | Recommendation |
|---|---|---|---|
| Runs / tasks (`harness-server/src/runner.ts`, `workflow.ts`, `policy.ts`) | One engine session per task; polls `/session/status` every 1 s; `abort` then `interrupt` | `SessionExecution` + `experimental.session.wait`, `session.execution.*`, `interrupt`, `session.log?after=` (catch-up by sequence number), `SessionMetadata` inherited by children | **Keep** the workflow graph, gates and worktrees in harness-server. Replace polling with `wait` or events; tag task sessions with `metadata{runID,taskID}`. |
| Routines (`scheduler.ts`) | FlupCode-only | None | Keep |
| Artifacts (`documents.ts`, `packs.ts`, `artifact_write` plugin) | FlupCode-only + a V1 plugin tool | `tool.transform(add)` | Keep; port the tool |
| Cost / usage (`usage.ts`, `session_metrics`, `metrics.ts`) | Built from message `tokens/cost` + a metrics plugin | `session/usage.ts` (tiered pricing), `SessionStats` (`/api/experimental/session/stats`), `session.usage.*` | **Simplify:** keep per-run and per-retry roll-ups; drop most of `session_metrics` in favour of `SessionStats`; keep only what V2 doesn't measure (first-token latency, tool output bytes, re-reads, skills) |
| Background tasks | Only harness runs | `Job`, `subagent` with `background: true`, `/background` | **Adopt V2** instead of building our own |
| Subagents / children | `children`, `parentID` walk, `SubagentList` | `session.list?parentID=`, job state, `execution.*` | Swap the data source |
| Prompt queue | Client-side | Server inbox | **Delete** the client queue |
| Crash recovery | `docs/FLUPCODE-SESSION-RECOVERY.md` | Execution claim + restart resume | Re-check; much of it may be covered upstream |
| Context management / compaction | V1 plugins (anchors, trim, cache-selection) | `session.hook("context")`, `session.hook("compaction")` (can supply the summary and skip the model call), Instructions | **Better seam:** ADR-0016 §3's `ContextPlanner` gap is closed |
| Memory | Core patch (+8k lines incl. tests) | Plugin hooks + `rpc` + `storage` | Move to a plugin and **drop the core fork** |

---

## 9. AutoHarness + Jev

**How it works today (ADR-0016 to ADR-0025, `docs/ADAPTIVE.md`):**
- **Jev lives only inside harness-server** (`adaptive/providers/jev.ts`) behind `DecisionProvider`
  and `PredictiveModel`. The default provider is deterministic or null, and egress requires three
  opt-ins (ADR-0017).
- **The adaptive layer** (`harness-server/src/adaptive/**`) imports neither core nor Jev types.
- **Its only engine seam** is the V1 plugin bundle (relevance, guardrails, metrics, compaction
  anchors, tool trim, cache selection, runtime probe). The plugins call loopback harness-server with
  the adaptive token (ADR-0022).

**What V2 does to it:**
- **The plugin shell breaks completely,** as described in §4.
- **It fails safe.** The plugins aren't loaded, the probe reports `unknown`, and `relevance.ts:122`
  and `guardrails.ts:101` stay inert.
- **Jev itself and the decision layer are unaffected.** Jev never depends on OpenCode.

**Where it should plug in on V2:**
- **Not at the engine or protocol level.** Keep AutoHarness in **harness-server**, reached from
  **one thin V2 plugin**, for example `flupcode.adaptive`. The plugin would register:
  - `session.hook("context")` for relevance, cache selection and the system prompt;
  - `session.hook("compaction")` for the anchors, including supplying the summary;
  - `tool.hook("execute.before")` for guardrails;
  - `tool.hook("execute.after")` for trimming;
  - `event.subscribe` for metrics and episodes;
  - `rpc.register` for a typed ping and acknowledgement, which replaces heuristics based on event
    names in `runtime.ts`.
- **Don't build on System Context or Context Source.** They don't exist in v2.0.20; upstream's own
  `plan.ts` plugin injects reminders through the `context` hook.

**Keeping Jev swappable (the property to preserve):**

1. The plugin holds no state and never sees Jev. It sends opaque digests or ids and gets back a
   line or a verdict.
2. If the token is missing, harness-server is down or a request times out, the plugin changes
   nothing, so the turn is byte-identical. Keep the per-turn pin near the tail of the message list
   so the prompt cache survives (ADR-0024 §7).
3. Jev stays behind `DecisionProvider`/`PredictiveModel` in harness-server. Any other predictive
   model plugs in there. No OpenCode type crosses that interface.
4. During a transition, keep two plugin shells (V1 `Hooks` and V2 `define`) that share one
   protocol-neutral core module, for example `packages/remote/src/adaptive-plugin-core.ts`.

---

## 10. Supporting V1 and V2 during a transition

**It is viable, but only at the client/adapter level.** Running two engines against one database is
not viable.

### 10.1 Design

```
harness UI ──┐                              ┌─ V1Adapter (@opencode-ai/sdk legacy + /api dev-era)
             ├─▶ EngineAdapter (FlupCode) ──┤
harness-server┘   domain model = V2 shapes  └─ V2Adapter (@opencode/client 2.0.x)
                  detect: GET /api/info → V2 ; GET /global/health → V1
```

- **Where it lives:** in FlupCode, for example `packages/harness/src/engine/` with the adapter
  interface, plus a thin wrapper in harness-server. It must not depend on core or server.
- **The domain model is V2-shaped.** V2 is the target, and the UI is already close to it.
- **Plugins:** two shells over one shared core. Install only the shell that matches the detected
  engine. V2 would reject the V1 files anyway, but installing both creates noise.

### 10.2 What can be normalized

| Area | Can it be normalized? |
|---|---|
| Health and version, session list/get/create/delete/rename, message list, prompt (text and files), interrupt, compact, revert, fork, shell, command, children, agents, models, providers, skills, pty, vcs read, fs list/find | Yes |
| Streaming (V1 `message.part.*` vs V2 `session.text.*`) | Yes: two reducers producing one transcript store |
| Status (busy/idle vs execution lifecycle) | Yes, with some loss: V1 has no outcome or reason |
| Permissions (ask and reply) | Yes |
| Questions vs forms | Partly: V1 questions map to V2 `multiselect`/`string` fields; V2-only field types can't be represented on V1 |
| Steer and queue | Partly: V2 uses the server inbox, V1 keeps the client queue |

### 10.3 What cannot be normalized

- MCP OAuth: V1 routes vs V2 integrations are different flows.
- Config editing: V1 PATCH vs V2 files plus `location/reload`.
- Todos, share, LSP, console org, symbol search and vcs apply exist only on V1.
- Background jobs, crash recovery, `SessionStats` and forms with typed fields exist only on V2.
- Memory: our V1 core patch vs a V2 plugin; same API, different implementation.

### 10.4 Data

- V1 and V2 share `~/.local/share/opencode/opencode.db`, and V2 migrates it one way.
- **During the transition, run V2 against an isolated database** (`OPENCODE_DB`, or a separate data
  directory or channel).
- Treat "import V1 sessions into V2" as a separate, explicit, user-confirmed step that happens once,
  with a backup.

### 10.5 Cost

Two engine bundles, two event reducers, two plugin shells, and a test matrix that doubles every
contract test. It is reasonable for **one or two release cycles**, not indefinitely.

---

## 11. Test audit and matrix

**What exists today:**

| Package | Tests | Engine |
|---|---|---|
| harness | 68 unit + 60 Playwright | Mocked (`page.route` on `/api/session*`, `/api/event`) |
| harness-server | ~130 (mostly adaptive) | `fakeEngine` stubs |
| remote | 8 (`engine-plugins.test.ts`: 121 tests on generated plugin source with synthetic events) | None |
| flupcode-cli | 1 | Fake engine |
| harness-desktop | 2 | **Never run: no `test` script** |
| core / opencode (our patches) | memory, compat, backfill, projector, plan_exit, permission, config reload, auth | Real, but **CI never runs them** |

**CI gaps:**
- `.github/workflows/harness.yml` doesn't include `packages/opencode/` in its `changes` filter.
- It never runs `packages/core/test` or `packages/opencode/test`.
- `test.yml` is gated to `anomalyco/opencode`.

**Consequence:** every existing FlupCode test would stay green if events were renamed, part types
changed or status semantics changed. **No current test would catch a V1 → V2 regression**, except a
typecheck after the SDK is swapped.

**Matrix:**

| Area | V1 | V2 | Test needed |
|---|---|---|---|
| Session | `POST /session`, `/session/status` | `POST /api/session`, `execution.*`, `metadata` | Contract: create → prompt → wait → idle outcome, against a real engine with a stub provider |
| Messages | `message` + `part`, `fromLegacy` | `session_message`, `Idle`, compaction | Recorded-stream fixtures from both engines → the same transcript store snapshot |
| Tools | pending/running/completed/error | streaming/running/completed/error{Structured} | Tool lifecycle contract; the running-tool detection in harness-server |
| MCP | `/mcp*`, SSE fallback, OAuth routes | `/api/mcp*`, integrations, `pending` | Local stdio MCP fixture: list, connect, tools, resources; directory targeting; OAuth attempt lifecycle (mock AS) |
| Streaming | `/event?directory=` `message.part.delta` | `/api/event` `session.text.delta` (ordinal), `/log?after=` | Event-name set snapshot per engine; reconnect + catch-up |
| Agents | `/agent`, `agent.switched` | `/api/agent`, `agent.selected` | List and switch contract |
| Providers | `/provider`, `/auth`, provider OAuth | `/api/provider`, `/api/integration`, credentials | Keyless custom provider; key integration; variant `#` syntax |
| Plugins | V1 `Hooks` | `define({id,setup})` | **Plugin smoke:** load the bundle into a real engine and assert every hook fires (context, compaction, execute.before/after, event, rpc) |
| Permissions | `/permission`, rule groups, our floor | Session permission, `decision`, `evaluate` hook | Ask → reply once/always/reject; the agent-deny floor survives session rules |
| Runs | harness-server polling | `wait` / `execution.*` | harness-server runner against a real engine: a two-task workflow, stop, retry, worktree |
| Artifacts | V1 plugin tool | V2 plugin tool | Tool writes the artifact; harness-server lists it |
| Questions / forms | `/question` | `form.*` | Ask → answer → the tool continues |
| Memory | Core patch | Plugin + rpc | API parity suite that runs against both implementations |
| Config | PATCH `/config` | `/api/config` + file write + reload | Round-trip a setting; `flupcode` block survives |
| Data | n/a | v1-migration | Migrate a copy of a real `opencode.db`; count sessions and messages; time it |

**Performance: what to measure** (no data exists):
- cold start to first prompt;
- RSS and heap when idle and with N sessions/locations;
- time to first token (native vs AI SDK);
- SSE throughput and reconnect/catch-up;
- `GET /mcp` cold latency (the 499 case);
- tool round-trip;
- v1-migration duration on a large DB;
- binary and tarball size;
- harness bundle size before and after the SDK swap.

---

## 12. Technical decision

### A. Is 2.0.20 the V2 engine?

Yes. It is the current stable release (`@opencode/cli@latest`) of the V2 line, built from upstream
branch `v2`. It is a **separate product line**, with a new npm scope, a new branch, a new API and a
new plugin API. It is not a later release on `dev`, where 1.x continues and which our fork tracks.
V1 is still maintained and still the upstream default on GitHub Releases and the main docs.

### B. Can we switch directly from 1.18.33 to 2.0.20?

No, for these reasons:

1. **There is no version to bump.** The engine is a vendored fork of `dev`. V2 is about 3,950
   commits away on another branch and deletes `packages/opencode`, which is where our turns run.
2. **Every UI turn** uses `POST /session/:id/prompt_async` and `GET /event?directory=`
   (`message.part.*`). Both are gone.
3. **`@opencode-ai/sdk`**, the only client FlupCode uses, is deleted in V2.
4. **13 of the 14 FlupCode engine plugins** are refused by the V2 loader, and 1 fails in `setup`.
   Every adaptive feature goes silent.
5. **Our engine patches** (memory, plan_exit, permission floor, message compat, `/config/reload`)
   have no place to apply in V2.
6. **V2 migrates the shared `opencode.db` one way.** It deletes the event log, drops the dev-era
   core tables and NULLs session permissions.
7. **Features FlupCode shows are removed:** todos, share, LSP, console org, MCP OAuth over HTTP,
   config PATCH, SSE-only MCP servers.

### C. What must change in FlupCode

1. An engine adapter on `@opencode/client`, covering both `harness/src/client.ts` and
   `harness-server/src/engine.ts`.
2. A transcript reducer for V2 events, a status model based on the execution lifecycle, and
   renamed event handlers (`session.next.*` → `session.*`).
3. Prompt sending through the inbox; delete the client queue.
4. Permissions on V2 routes; questions become forms.
5. MCP on `/api/mcp*` plus integration OAuth; `location[directory]` targeting.
6. Config reads from `/api/config`; writes go to files through harness-server plus
   `/api/location/reload`; the `flupcode` block moves out of the engine schema.
7. The 14 plugins become a V2 plugin package (a shared core with a V2 shell).
8. Memory and `plan_exit` become V2 plugins; drop the patches for Copilot, reload, revertCommit and
   message-compat.
9. The permission floor via the `evaluate` hook or upstream.
10. harness-server runs use `metadata`, `wait` and `interrupt`; usage comes from `SessionStats`.
11. Desktop and CLI launch: an explicit V2 binary, `/api/info` health, an isolated DB, a
    `restart-engine.sh` rewrite.
12. Decide what to do about todos, share, LSP and console org.
13. Tests and CI (§11).

### D. What could break, in priority order

1. **Chat and Code turns don't send or stream at all** (the core path).
2. **All adaptive, AutoHarness and Jev behaviour goes silent** (plugins not loaded). It fails safe,
   but nothing surfaces it.
3. **The user's session history and permission modes** after V2 migrates the shared DB.
4. **Runs and routines** (harness-server polling and create payload).
5. **Memory feature** (no engine support).
6. **Permission and question docks.**
7. **MCP management and OAuth; SSE-only MCP servers.**
8. **Config panel and model/provider settings.**
9. **Tasks aside, share, LSP, console org** (feature loss).
10. **Cost panels** (field shapes, `Money.USD`).
11. **Web actions approval** (`ctx.ask` has no direct V2 equivalent).
12. **Tool accounting under Code Mode** (UNKNOWN).

### E. Checklist before updating

- [ ] Ship V2-00: FlupCode detects a V2 engine and fails with a clear message, instead of breaking
      silently when a user installs V2 over the `opencode` binary.
- [ ] Fix CI so it runs `packages/core` and `packages/opencode` tests and includes them in
      `changes`; add `test` to harness-desktop.
- [ ] Contract suite against the real **current** engine (baseline), with recorded fixtures.
- [ ] A V2 engine running locally with an **isolated DB**; the same contract suite fails in known
      places.
- [ ] Decide on the integration model: **consume V2 as an external engine plus a FlupCode plugin
      package** (recommended) or re-fork onto `v2`.
- [ ] Prototype the adaptive V2 plugin (relevance + guardrails) and confirm the hooks fire.
- [ ] Prototype memory as a V2 plugin; confirm `rpc` and storage are enough.
- [ ] Decide on the `ctx.ask` replacement for web actions.
- [ ] Decide on todos, share, LSP, console org and SSE-only MCP.
- [ ] Measure the §11 performance items on both engines.
- [ ] Back up and dry-run the migration on a copy of a real `opencode.db`.
- [ ] Pin a V2 version (`2.0.x`) and a policy for rebasing on V2 point releases.

### F. Recommended migration architecture

**Recommendation: migrate, but as a planned program, not a bump. Start the groundwork now and
cut over later.**

- **Why now:**
  - the V2 plugin API removes most of our engine fork, which ADR-0001 and ADR-0002 want anyway;
  - V2 gives us a server inbox, execution lifecycle, background jobs, crash recovery, `SessionStats`
    and a proper context and compaction hook;
  - every month on `dev` adds more V1-only code.
- **Why not cut over yet:**
  - V1 is still maintained with no EOL, so there is no forcing function;
  - V2 is moving fast (21 releases in 18 days);
  - V2 drops features we show (LSP, todos, share, MCP OAuth over HTTP, config PATCH);
  - there is no test that would tell us we're done.

**Architecture change:** stop vendoring the engine.
- FlupCode consumes a **stock, pinned V2 engine** (`@opencode/cli` binary) and ships:
  - its own clients on `@opencode/client`;
  - one **FlupCode plugin package** (adaptive, memory, plan_exit, artifacts, actions, deliver,
    reasoning variants, cowork agent, permission floor).
- Engine patches go to zero, or become upstream PRs.
- FlupCode stops syncing `dev` into `power`. The `upstream-inventory` and sync ADRs need revisiting.

**Phases:**

| Phase | Name | Goal | Exit criterion |
|---|---|---|---|
| 0 | Baseline and safety net | Guard against an unexpected V2 engine on the `PATH` (V2-00); CI covers the engine tests; contract suite and recorded fixtures against the current engine | V2 engine detected with a clear error; suite green on the current engine |
| 1 | V2 sandbox | A V2.0.x engine next to V1 with an isolated DB; contract suite runs against it (expected failures listed) | Failure list matches §5 |
| 2 | Engine adapter | `EngineAdapter` with a V2 domain model; V1 adapter wraps today's code (no behaviour change) | All UI and harness-server engine calls go through the adapter; tests green on V1 |
| 3 | V2 adapter | V2 implementation: sessions, prompt/inbox, events reducer, status, permissions, forms, MCP, config, providers | Contract suite green on V2 for supported areas |
| 4 | Plugin package | Shared plugin core; V2 shell for all 14 plugins; memory and plan_exit as V2 plugins | Plugin smoke green on V2; adaptive e2e on V2 |
| 5 | UI semantics | Execution-lifecycle status, inbox queue, forms, structured errors, MCP events, decisions on removed features | Playwright green against a live V2 engine |
| 6 | AutoHarness / Jev validation | Relevance, guardrails, compaction, trim, cache selection on V2 hooks; cache-pin check; fail-safe check | ADR-0021/0023/0024 acceptance checks pass on V2 |
| 7 | Launch and data | Desktop and CLI resolve the V2 binary, `/api/info`, explicit and confirmed V1 → V2 import with backup | Fresh install and upgrade paths verified |
| 8 | Default V2, V1 deprecated | V2 by default; V1 adapter kept for one release | One release with no V1-only bugs |
| 9 | V2-only cleanup | Remove the V1 adapter, V1 plugin shell, vendored `packages/opencode` and engine patches; update ADR-0001/0009, `ARCHITECTURE.md`, `V2-HOOKS.md`, `AGENTS.md` | No `@opencode-ai/*` imports left |

---

## 13. Executable roadmap

Tickets use the prefix `V2-`. P0 means it blocks the phase, P1 is needed, and P2 is nice to have.
Every ticket is its own PR against `power`.

### Progress

| Ticket | Status |
|---|---|
| V2-00 | Done: rldona/FlupCode#434 |
| V2-01 | Done: rldona/FlupCode#435 |
| V2-02 | Done: rldona/FlupCode#437 |
| V2-03 | Done: rldona/FlupCode#438 |
| V2-04 | Done: rldona/FlupCode#436 |
| V2-05, V2-06 | Done: rldona/FlupCode#439. Findings in [V2-CONTRACT-REPORT.md](V2-CONTRACT-REPORT.md) |
| V2-07 | Open. The report only has start-to-healthy times, and they are not comparable |
| V2-10, V2-12 | Done in the engine adapter PR |
| V2-20 | Done in the OpenCode 2 adapter PR: `engine/v2.ts` on `@opencode/client@2.0.18` (the newest version old enough for `minimumReleaseAge`, same as the sandbox) covers the session and message domains. Permission and question replies are stubbed until V2-22. `createClient` does not choose it yet: it will once every domain exists |
| V2-21 | Done in the event reducer PR: `engine/v2-events.ts` builds the transcript from `session.*` events on `/api/event`, mirroring `@opencode/client`'s own projection and converting through the same `toMessage` a refetch uses. A real 2.x engine proves the live transcript equals the recorded one for text, tool, second and interrupted turns. `app.tsx` applies it, marks runs from `session.execution.*`, and reads `permission.asked`, `form.*` and the 2.x catalog events. Left for the cutover: catch-up through `/api/log?after=` (a reconnect refetches instead, as on 1.x), filtering by `location.directory`, and not opening per-folder streams on 2.x (they answer HTML and back off) |
| V2-22 | Done in the permissions and forms PR: the 2.x adapter lists and answers permissions (once, always, reject with a message) and reads forms as the app's questions. The `question` tool makes one `q<i>` field per question, so the docks answer a form unchanged; other forms read field by field. `blocked.*` reads empty on 2.x, which sends the docks to the session, as they already fall back. Proven against a real 2.x engine, including saving and revoking an "always" rule. The Playwright half waits for the cutover, since `createClient` does not pick the 2.x adapter yet |
| V2-23 | Done in the MCP PR: the 2.x adapter lists servers (`pending` and `needs_auth` included), connects and disconnects them, reads resources from the catalog, and signs in through the server's integration OAuth attempt (open the URL, wait on the attempt, remove the credential). Every request names its folder in `location[directory]`. `app.tsx` refreshes MCP state on `mcp.*` events. Proven against a real 2.x engine with a stdio fixture (connect, resource, a tool call) and a remote server behind a stub authorization server (needs_auth → OAuth → connected → sign out). Adding and removing a saved server came with V2-24. Left for the cutover: a sign-in that needs a pasted code, and per-server tool use and latency (H-16), since 2.x calls MCP tools from Code Mode's `execute` instead of as `server_tool` |
| V2-24 | Done in the config PR, a simpler route than the plan above: 2.x writes only its `shell` and drops unknown keys (`flupcode`) from `GET /api/config`, but it still loads `opencode.json` in 1.x shape, migrating it as it reads. So harness-server's new `/harness/engine-config` reads and patches the engine's own files in that shape (JSONC edits that keep comments, `null` removes a key, `provider` entries replaced whole, behind the writer bearer), and the 2.x adapter reloads the location after each write. The `flupcode` block stays in `opencode.json`; moving it waits until 2.x stops tolerating unknown keys. MCP servers are saved and removed the same way. Proven against a real 2.x engine: the writer's global (comments and `flupcode` included) and folder writes load after a reload, and the adapter's save, read-back and MCP add/remove round-trip. Risks for the cutover: 2.x reads `opencode.json(c)` only, never `config.json` (1.x wrote a folder's settings there, and a global `config.json` alone is invisible to 2.x); without a harness server the 2.x config reads empty and saving is refused |
| V2-25 | Done in the providers PR: the 2.x adapter lists models and providers from `/api/model` and `/api/provider`, and rebuilds the 1.x provider directory the panel reads from 2.x's integrations (every provider it knows; one with no integration was declared in the config). Integrations, key connect, OAuth attempts (status and cancel name their integration, which the adapter remembers) and credential removal go through `/api/integration*` and `/api/credential*`. 2.x keeps a key only as an integration credential, and a config provider gets an integration of its own, so `auth.set`/`auth.remove` have nothing left to do and there are no configured keys to link. Model and provider `settings` are never copied: they can hold the API key. Proven against a real 2.x engine: a keyless config provider is listed, an OpenAI key brings its models and removing the credential takes them away, an OAuth attempt starts pending and is cancelled, and no answer carries a key. 2.x's catalog settles about a second after start, and the app refetches on `model.updated`/`provider.updated` (V2-21). Still missing from the 2.x adapter before `createClient` can pick it: `health`, `reload`, `event`, `paths`, `suggest`, `console`, `agent`, `command`, `tools`, `skill`, `memory`, `file`, `vcs` |
| V2-26 | Done in the harness-server runs PR: `Engine` detects the engine line once (asking again while the engine is not up yet) and hands every call to `engine-v2.ts` on 2.x, so the scheduler, the runner, replay and the adaptive layer move without changing. On 2.x a session is created with its location, permissions (`bash` renamed `shell`) and metadata; there is no `parentID` to create it under, so a task carries its run's session in `metadata.parentID`. Agent and model are selected on the session before the prompt; busy is `session.active`, stop is `interrupt`; the transcript is translated into the legacy shape replay and the drafter read; `lastAnswer` sums every step since the turn's prompt. `waitForIdle`, `commitMessage` and `handoff` are built on those and needed no 2.x version. A runner integration test (two tasks with a handoff, a stop mid-turn, a failed check retried until it passes, a worktree) passes on both lines in CI's engine job, plus 2.x confinement. The app adapter's permission rules now rename `bash`/`shell` both ways (a V2-20 bug). For the cutover: the app shows a run's tasks under it through `parentID`, which 2.x sessions only carry in metadata |
| V2-11 | Detection is covered by V2-00 (`detectEngine`, the banner, onboarding, desktop and CLI). Choosing an adapter by line lands with V2-20, since no 2.x adapter exists before it |

### Phase 0: Baseline

**V2-00 · Guard against an unexpected V2 engine (P0, risk that exists today)**

- **Why:** the packaged `harness-desktop` does not bundle the engine. It resolves
  `$FLUPCODE_OPENCODE` and otherwise falls back to `opencode` on the `PATH`
  (`harness-desktop/src/main/server.ts:145-164`); `flupcode remote` also spawns `opencode serve`.
  V1 and V2 both install the `opencode` command, and the V2 installer replaces the V1 binary. A user
  who installs V2 on their own (opencode.ai already advertises it) makes FlupCode start a V2 engine:
  - `/global/health` fails;
  - no plugin loads;
  - no turn works.

  FlupCode breaks without us migrating anything.
- **Files:**
  - `packages/harness-desktop/src/main/server.ts` (`resolveEngine`, `ensureServer`);
  - `packages/flupcode-cli/src/index.ts`;
  - `packages/harness/src/client.ts` (health/version probe);
  - `packages/remote/src/engine-plugins.ts` (`installEnginePlugins`).
- **Change:**
  1. On startup and when attaching to an already-running engine, probe `GET /api/info` before
     `/global/health`. A JSON reply with `version` ≥ 2 means V2.
  2. If the engine is V2:
     - don't install plugins;
     - don't start runs;
     - show a clear, actionable error in desktop, CLI and web: "FlupCode requires OpenCode 1.x.
       Found 2.x at `<path>`. Set `FLUPCODE_OPENCODE` to a 1.x binary." The text goes through i18n.
  3. Log the resolved engine path and version at startup.
  4. Follow-up (tracked in V2-60): bundle or pin an explicit engine binary instead of relying on the
     `PATH`.
- **Acceptance:**
  - Unit tests for the probe: V1 health, V2 info, unreachable, and an HTML reply from a stock web
    server.
  - The desktop shows the error dialog and doesn't crash-loop the engine restart when pointed at a
    V2 binary.
  - `flupcode remote` exits non-zero with the same message.
- **Tests:** a fake V2 engine on `Bun.serve` that answers `/api/info` with `{version:"2.0.20"}`,
  reusing the `flupcode-cli` fake-engine pattern.
- **Risk:** low. It adds a probe and changes nothing on the V1 path.
- **Rollback:** revert the PR.
- **Dependencies:** none. It should ship before V2-01 because it protects current users.

**V2-01 · Run engine tests in CI (P0)**
- **Files:** `.github/workflows/harness.yml`.
- **Change:** add `packages/opencode/**` to `changes`; add a job that runs `bun test` in
  `packages/core` and `packages/opencode` (FlupCode test files at least); add a `test` script to
  `packages/harness-desktop`.
- **Acceptance:** a PR that only touches `packages/opencode` triggers the tests; `gate` depends on
  them.
- **Risk:** the upstream suite is slow (about 250 s). Start by scoping to FlupCode test files.
- **Rollback:** revert the workflow.

**V2-02 · Engine contract harness (P0)**, depends on V2-01
- **Files:** new `packages/harness-server/test/contract/` (or a new `packages/engine-contract`).
- **Change:** spawn a real engine (path from an env var) with a stub OpenAI-compatible provider
  (`Bun.serve`) and an isolated `OPENCODE_DB` and `OPENCODE_CONFIG_DIR`. Cover these flows:
  create → prompt → stream → idle; tool call; permission ask and reply; question; interrupt;
  compact; MCP list with a stdio fixture; config read. Record the event-name set and the payloads
  as fixtures.
- **Acceptance:** green against the current engine; fixtures committed.
- **Risk:** flaky process lifecycle. Use a random port, wait on health, and put a timeout on every
  step.

**V2-03 · Plugin smoke test (P1)**, depends on V2-02
- **Change:** install the `engine-plugins` bundle into the contract engine; assert that each plugin
  loads and its hooks fire (via the harness-server adaptive endpoints hit, and the files written).
- **Acceptance:** 14/14 plugins observed on the current engine.

**V2-04 · Fix MCP write calls without a directory (P1, V1 bug)**
- **Files:** `packages/harness/src/client.ts` (~1085-1118).
- **Change:** pass the same `mcpDirectory()` to connect, disconnect, add and auth.
- **Acceptance:** a unit test asserts that the query carries the directory.

### Phase 1: V2 sandbox

**V2-05 · Run V2 locally, isolated (P0)**
- **Files:** a new `script/v2-engine.sh` (dev only); docs.
- **Change:** install a pinned `@opencode/cli@2.0.20` binary into a FlupCode-owned path; run
  `serve --port 4196` with an explicit password, `OPENCODE_DB` and a separate data and config
  directory. **Never touch `~/.local/share/opencode/opencode.db`.**
- **Acceptance:** `GET /api/info` answers 2.0.20; the user DB is unchanged (checksum).

**V2-06 · Run the contract suite against V2 (P0)**, depends on V2-02 and V2-05
- **Change:** parametrize the suite by engine; mark V2 expectations as expected failures; produce a
  failure report.
- **Acceptance:** the report matches §5 of this audit; any surprise is filed as a ticket.

**V2-07 · Performance baseline (P2)**, depends on V2-05
- **Change:** a script that measures the §11 items on both engines; results go in
  `perf/engine-v1-v2.md`.

### Phase 2: Adapter (no behaviour change)

**V2-10 · `EngineAdapter` interface + V1 adapter (P0)**
- **Files:** new `packages/harness/src/engine/{adapter.ts,v1.ts,types.ts}`; `client.ts` becomes a
  facade.
- **Change:** a V2-shaped domain model (Session, TranscriptItem, ToolState, ExecutionState,
  PermissionRequest, FormRequest, McpServerStatus, ConfigView); the V1 implementation moves today's
  code behind it.
- **Acceptance:** no UI file imports `@opencode-ai/sdk` directly; unit and e2e tests unchanged and
  green.
- **Risk:** a large refactor of `client.ts`. Split it per domain (sessions, transcript, permissions,
  MCP, config).

**V2-11 · Engine detection (P0)**, depends on V2-10
- **Change:** probe `GET /api/info` first (V2), then `/global/health` (V1); choose the adapter; show
  the engine kind and version in Settings.
- **Acceptance:** unit tests for both responses and for an unreachable engine.

**V2-12 · harness-server `Engine` behind the same adapter shape (P0)**
- **Files:** `packages/harness-server/src/engine.ts`, `runner.ts`, `adaptive/runtime.ts`.
- **Acceptance:** runner tests green; no direct SDK import outside the adapter.

### Phase 3: V2 adapter

**V2-20 · V2 sessions, prompt and inbox (P0)**
- **Change:** `@opencode/client` dependency; create, list, get, rename, delete; prompt with
  `delivery`; inbox list, cancel and change mode; interrupt; compact; revert stage, commit and
  clear; fork; shell; command; children via `parentID`.
- **Acceptance:** contract suite flows green on V2.

**V2-21 · V2 event reducer (P0)**
- **Files:** `harness/src/engine/v2-events.ts`, `transcript.ts`, `app.tsx`, `session-events.ts`,
  `replay.ts`.
- **Change:** reduce `session.{text,reasoning}.*` (keyed by ordinal), `session.tool.*`,
  `session.step.*`, `session.execution.*`, `session.inbox.*`, `permission.*`, `form.*`, `mcp.*`,
  `model.updated`/`provider.updated`; catch up via `/log?after=`; filter by `location.directory`.
- **Acceptance:** recorded V2 fixtures produce the same transcript store snapshot as the matching V1
  fixtures.
- **Risk:** `/api/event` disconnects slow consumers. Batch updates and re-sync from `/log` on
  reconnect.

**V2-22 · Permissions and forms (P0)**
- **Files:** `client.ts` `blocked.*`, `PermissionDock`, `QuestionDock` → `FormDock`,
  `pending-questions.ts`, `permission-preview.ts`.
- **Acceptance:** ask → reply (once/always/reject) and form → answer, on V2 through the contract
  suite and one Playwright test.

**V2-23 · MCP on V2 (P1)**
- **Files:** `client.ts` MCP, `mcp.ts`, `McpManager.tsx`, `app.tsx:1290`.
- **Change:** `/api/mcp*`; `location[directory]`; status from events; OAuth through the integration
  attempt flow; show `pending`; warn about SSE-only servers.
- **Acceptance:** a stdio fixture lists, connects and returns tools; an OAuth attempt lifecycle runs
  against a mock AS; no request depends on `?directory=`.

**V2-24 · Config on V2 (P1)**
- **Files:** `client.ts` config, `ConfigPanel.tsx`, `harness-server/src/config-files.ts`.
- **Change:** read `GET /api/config` entries; writes go through harness-server to config files
  (preserving V1 or V2 shape), then `POST /api/location/reload`; move the `flupcode` block to a
  FlupCode-owned file with a one-time copy from `opencode.json`.
- **Acceptance:** round-trip tests; the engine still loads the resulting file.

**V2-25 · Providers, models, integrations (P1)**
- **Change:** `/api/provider`, `/api/model`, `/api/integration/*`, `/api/credential*`; variant
  syntax.
- **Acceptance:** key and OAuth provider connect; a keyless custom provider is listed.

**V2-26 · harness-server runs on V2 (P0)**, depends on V2-12
- **Change:** `metadata{runID,taskID}` instead of `parentID`; `PATCH {permissions}`;
  `experimental.session.wait` or execution events instead of polling; `interrupt`; `lastAnswer`
  from `session.message.list`; usage from `step.ended` or `SessionStats`.
- **Acceptance:** runner integration test (two tasks, stop, retry, worktree) green on both engines.

### Phase 4: Plugin package

**V2-30 · Shared plugin core + V2 shell (P0)**
- **Files:** `packages/remote/src/engine-plugins.ts` split into
  `plugins/core/*.ts` (protocol-neutral), `plugins/v1/*.ts` and `plugins/v2/*.ts`, plus
  `installEnginePlugins(engineKind)`.
- **Change:** the V2 shell uses `export default { id, setup }` on `@opencode/plugin` and the hook
  mapping in §4.2; install only the shell that matches the engine kind.
- **Acceptance:** plugin smoke 14/14 on V2; the existing `engine-plugins.test.ts` still green for
  V1.

**V2-31 · Web actions approval on V2 (P1)**, depends on V2-30
- **Change:** a spike on `permission.hook("evaluate")` vs form-based approval for each call; pick
  one and implement it.
- **Acceptance:** a sensitive action asks the user and a denial blocks it, on V2.

**V2-32 · Memory as a V2 plugin (P1)**
- **Change:** a `flupcode.memory` plugin with a `context` hook (injects the memory block), the
  `memory` tool via `tool.transform`, and the CRUD API via `rpc.register`; storage in its own SQLite
  file under the FlupCode data directory; extraction on `session.execution.succeeded`; cleanup on
  `session.deleted`. Point the harness `memory.ts` at the RPC.
- **Acceptance:** port the memory tests (`memory-*.test.ts`) to the plugin; the API parity suite
  passes against the V1 patch and the V2 plugin.
- **Risk:** data continuity. Write a one-off export and import from the V1 `memory` table.

**V2-33 · plan_exit, cowork agent, reasoning variants, permission floor as plugins (P2)**
- **Acceptance:** Plan agent can't edit even with permissive session rules; plan exit asks and
  switches; cowork agent is listed; variants show.

### Phase 5: UI semantics

**V2-40 · Execution-lifecycle status (P0)**: `trackActivity`, run badges, idle outcome and interrupt
reason in the UI.

**V2-41 · Server-side queue (P1)**: remove `pending-prompts.ts` on V2; `DeliveryMenu` uses the inbox;
queued items survive a reload.

**V2-42 · Decisions on removed features (P1)**: Tasks aside (hide on V2, or rebuild on a plugin
tool), Share, LSP, Console org, vcs apply. Record each in an ADR.

**V2-43 · Live-engine Playwright project (P1)**: one Playwright project against the V2 engine from
V2-05 (send, stream, permission, form, MCP list).

### Phase 6: AutoHarness / Jev

**V2-50 · Adaptive plugin on V2 hooks (P0)**, depends on V2-30
- **Change:** relevance, cache selection and system prompt via `context`; anchors via `compaction`;
  guardrails and trim via tool hooks; metrics and episodes via `event`; an `rpc` acknowledgement.
- **Acceptance:**
  - ADR-0021 relevance gate;
  - ADR-0023 guardrails;
  - ADR-0024 cache pin, checked by comparing cache-read tokens across two turns;
  - fail-safe (harness-server down → byte-identical request).

  Jev stays behind `DecisionProvider`, and there is no Jev import outside `adaptive/providers`.

**V2-51 · Runtime probe v2 (P1)**: `runtime.ts` classifies by the plugin RPC acknowledgement, not by
event names.

### Phase 7: Launch and data

**V2-60 · Desktop and CLI launcher for V2 (P0)**
- **Files:** `harness-desktop/src/main/server.ts`, `flupcode-cli/src/index.ts`,
  `script/restart-engine.sh`.
- **Change:** resolve an explicit V2 binary (bundle it or use `$FLUPCODE_OPENCODE`; never an
  ambiguous `opencode`); `/api/info` health; always set a password; drop
  `OPENCODE_SERVER_USERNAME`.
- **Acceptance:** fresh install, upgrade from V1, and engine-already-running paths all verified.

**V2-61 · Explicit V1 → V2 data import (P0)**
- **Change:** the default V2 DB is FlupCode-isolated; the "Import V1 history" action backs up
  `opencode.db` and then triggers the V2 import and shows `/api/experimental/migration/v1`
  progress; the memory table import (V2-32).
- **Acceptance:** tested on a copy of a real DB, comparing session and message counts; rollback
  restores the backup.

### Phase 8 and 9: Default and cleanup

**V2-70 · Default engine V2, V1 deprecated (P1)**: a feature flag, release notes, one release cycle.

**V2-71 · Remove V1 (P1)**
- **Change:** the V1 adapter, V1 plugin shell, vendored `packages/opencode`, legacy `sdk/js` usage
  and engine patches.
- **Docs:** update ADR-0001, ADR-0009, `ARCHITECTURE.md`, `V2-HOOKS.md`, `PARITY.md` and the
  `AGENTS.md` "V2 Session Core" section.
- **Acceptance:** `rg "@opencode-ai/"` finds nothing in FlupCode packages; CI green.

### Rollback strategy

- **Phases 0-6** only add code behind engine detection. V1 stays the default, so rollback is not
  selecting the V2 adapter.
- **Phase 7** never mutates the user's V1 DB without a backup. The V2 DB is isolated, and rollback
  means switching the binary back to V1 and restoring the backup if an import ran.
- **Phase 8** is a flag. Only phase 9 is irreversible; do it after one clean release on V2.

---

## Appendix: facts to verify with a live engine (UNKNOWN)

1. **The 499 root cause.** Time a cold `GET /mcp` on V1 and check the logs for bootstrapping,
   dependency install and MCP connect timeouts.
2. **V1 legacy runner on a DB that V2 has already migrated** (rollback safety).
3. **Code Mode's effect** on tool accounting, guardrails and `tool-uses`.
4. **Whether `permission.hook("evaluate")` can express the web-actions approval** for each call.
5. **Whether keyless custom providers and the `markExplicit` patch** are still needed on V2.
6. **Whether V2 `session.hook("context")` message mutations keep provider prompt-cache hits** with
   the tail pin (ADR-0024).
7. **Whether `@opencode/cli` coexists with a V1 `opencode` on the `PATH`,** and what binary name and
   path to bundle.
