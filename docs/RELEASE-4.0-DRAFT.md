# FlupCode 4.0 — draft release notes

Draft for the release after `flupcode-v3.0.1`. It covers pull requests #476 to #540: the roadmap of
`docs/AUDIT-2026-10.md` (waves 1 to 7). Nothing here is released yet, and no version has been
bumped. Each line comes from the "Release note" of its pull request.

The engine pin does not change: OpenCode 2.0.18.

## Why a major version

These changes can break something a user or a script relied on:

- **FlupCode's plugins no longer load in an OpenCode you start yourself** (#519). They live in
  FlupCode's own config folder and load only in engines FlupCode starts. The copies earlier
  versions left in `~/.config/opencode/plugins/` are removed on the next start.
- **Routes and options removed:**
  - `/harness/browser/navigate|click|type|submit|text|snapshot` (#488), and `waitFor` and
    `screenshot` (#503).
  - `GET /harness/adaptive/metrics/sessions` (#518). Use `/harness/usage/summary?groupBy=session`.
  - `fromCheckpoint` on `POST /harness/workflows/:name/runs` (#509). Use resume.
  - `/replay` (#500) now opens the home screen.
- **Adaptive settings changed shape** (#526). `adaptive.jev.*`, `allowJev` and `TYPESAFE_API_KEY`
  are read-only aliases for one release; use `adaptive.providers.<id>.*`, `allowModel` and
  `FLUPCODE_TYPESAFE_API_KEY`. An older web app does not draw the Adaptive section against this
  server.
- **Stricter defaults:**
  - A run task whose model call failed now ends **failed** (#478). Routines that showed success
    this way start failing visibly.
  - A run task that needs approval mid-turn now holds its run at "Needs approval" until somebody
    answers (#513). `unattended: deny` fails it within seconds instead.
  - A web action that submits a form, uploads a file or signs in asks every time; an earlier
    "Always allow" for those is no longer honoured (#503).
  - Memories FlupCode extracts are not used in prompts until approved in the Memory panel (#485).
  - harness-server answers 403 for folders that are not a known project or worktree (#486).
  - In an external task's `command`, `{{item}}` and inputs are passed as one quoted shell word
    each (#480). A workflow that relied on an input expanding into several words must be rewritten.
  - A run with a budget starts its remaining tasks one at a time once 80% is spent (#540). Turn
    it off with `nearBudget: { serial: false }`.
  - A run whose policy names a `fallback` moves its next task to it at 80% of a budget or of the
    provider's shortest quota window, even when the task names its own model (#534).
- **The engine is installed only at the pinned version**, and only when its tarball matches the
  sha512 committed in the repository (#508).
- **Deleting now removes more:** a run's checkpoints, findings and evidence go with it (#491,
  #495), and deleting a document forgets all its versions (#511).
- **Restoring a checkpoint also takes back the conversation** it was taken in; the prompts made
  since are removed for good, after the plan says so (#535).
- **Navigation moved** (#528): "Customize" is "Settings", Agents live only in Settings › Agents,
  the Cost screen is at `/cost`. Old links redirect.

## Highlights

- **Runs you can trust.** Stop really stops (#477). A failed model call fails the task (#478).
  Every task and run carries a verdict from something other than the working agent: Verified,
  Not verified, Needs your input or Failed (#502). A failed run resumes from the task where it
  broke (#509). Checkpoints carry the conversation, a summary and the cost, and a run can be
  forked from any of them (#535).
- **Cost you can read.** One usage ledger behind every figure (#496–#499, #501, #505), the home
  card and the Cost screen agree (#522), budgets stop a run at the step that crosses them (#520),
  runs slow down, wait or switch model near a budget (#534, #540), and the Cost screen shows the
  quota OpenRouter and DeepSeek report (#524).
- **A browser under policy.** One browser policy decides every browser action (#503). The agent
  can use FlupCode's own browser (#525), your Chrome or Edge through the FlupCode Bridge extension
  limited to its tab group (#530, loaded unpacked for now), MCP presets (#507), and an embedded
  Preview of the project's dev server in the desktop app (#531). A `verify` task can compare the
  page with its last capture (#538).
- **FlupCode without the desktop window.** `flupcode serve` hosts the harness and a web tab pairs
  with a code (#515). A paired phone has a Runs view where it can approve a gate and stop a run
  (#523). The desktop app restarts its engine and harness server, keeps logs and offers Copy
  Diagnostics (#510).
- **Routines that keep time.** Time zones, cron, missed-run policy, retries, a notice after three
  failures, and workflow inputs in the form (#512). Unattended tasks no longer wait silently
  (#513).
- **One interface.** One navigation model (#528), one attention scale (#504), one run card
  (#506), one accessible dialog (#527), one icon set and type scale (#533), context chips in the
  composer (#536), artifacts with versions and lineage (#511).

## Notes by area

### Runs, workflows and routines

- Stopping a run stops the agent working on it; a stopped run no longer spends on a closing
  note (#477).
- A run task whose model call failed ends failed with the provider's message (#478).
- External task commands quote `{{item}}` and inputs (#480).
- A routine whose workflow file was deleted records a failed run, and a long-running routine no
  longer stops the others from firing on time (#481).
- A resumed run hands on its notes and trees (#490). A run names the workflow, version and inputs
  it executed (#494).
- Deleting a run also deletes its checkpoints; each run keeps its newest 50 (#491). It also
  removes the run's findings and evidence, and keeps pinned artifacts and anything an agent or you
  made. The harness database uses WAL mode (#495).
- Verdicts on every task and run; `require: verified` on workflow tasks (#502).
- Resume from the task where a run broke (#509).
- Routines: time zones, cron, missed beats, retries, failure notice, workflow inputs; the empty
  "Templates" tab is gone (#512).
- Unattended mode (`gate` by default, or `deny`); agent permission checks refuse a call when the
  agent's rules cannot be read (#513).
- Semantic checkpoints, the run's checkpoint timeline, "Fork from here" (#535).
- Visual `verify` tasks with before / after on the Run card; the Preview can be captured with its
  panel closed (#538).

### Cost and usage

- Session cost no longer counts steps twice; small costs show as `$0.0043` (#479).
- Usage ledger: every step, failed step, compaction and tool is recorded, attributed to its run,
  task, routine, workflow and purpose, and reconciled from the engine's transcripts (#496–#499).
- The Cost screen's run figures include every step of a run's tasks, subagents and retries (#501).
- Every cost in the app comes from the ledger and carries its basis. The composer meter shows this
  turn and the session; it can read lower than before because the engine's title generation is
  not in the ledger. Steps on models without a price show as unpriced (#505).
- The home card matches the Cost screen. "Current streak", "Peak hour", the weekly per-model chart
  and "Reset counters" are gone (#522).
- Budgets per run, routine, workflow and day, with a warning share (#520).
- Model routing near a budget or a quota window (#534); one task at a time, an optional gate and
  closing notes on the fallback near a budget (#540).
- Provider quota for OpenRouter and DeepSeek, read inside the engine every 5 minutes; the key
  never leaves the engine (#524).

### Browser

- Web actions need a server-issued, single-use approval (#488).
- One browser policy: once / this session / always per site and tier; payment, banking and
  sign-in sites are refused; grants are listed under Settings → Permissions → Browser access
  (#503).
- MCP presets for your own browser (#507).
- FlupCode's own browser for a session, through the engine's `browser.*` tools; sessions sent from
  the app no longer see those tools unless a browser is attached (#525).
- FlupCode Bridge extension for Chrome and Edge, limited to its tab group (#530).
- Desktop Preview panel with running-server discovery and annotate-to-composer (#531).
- A session's browser tools are withdrawn before it reports it has no browser (#539).

### Security and trust boundaries

- Memory injects only approved memories and refuses credentials (#485).
- File, git, checkpoint and artifact reads are confined to known project roots (#486).
- The desktop app runs one copy per user, under a Content-Security-Policy limited to the local
  engine, the harness server and the relay; "Open in VS Code" opens only VS Code (#487).
- Plugins use their own narrower token; commands the harness runs no longer inherit FlupCode's
  tokens, engine credentials or vault key (#489).
- A remote predictive model receives a digest of the project instead of its absolute path (#518).
- A release builds only from a commit whose `gate` passed; the engine tarball is checked against a
  committed sha512; the Intel Mac app ships x86_64 sidecars (#508).

### Hosts: desktop, CLI, remote

- The integrated terminal works again on OpenCode 2 (#482).
- Supervised engine and harness server, logs, Copy Diagnostics, `flupcode diagnostics` (#510).
- `flupcode serve` hosts the harness; `flupcode pair` and `flupcode pair revoke` (#515).
- `/harness/*` over remote control with a `remote`-scoped token; bodies capped at 32 MiB;
  `flupcode remote --harness-port` (#523).
- A phone shows the runs that need it as soon as it connects (#539).
- Engine plugins in FlupCode's own folder (#519).

### App

- One slash-command registry for the palette and the composer (#492).
- Changes and Cost say when a read failed and offer Try again (#493).
- The unused session replay page is gone; Config (advanced) shows and saves the engine's real
  config files (#500).
- One attention mark per state across sessions, runs, routines and the phone home (#504).
- One run card; run reports are titled by how the run ended (#506).
- Artifacts with versions, lineage, compare and paging (#511).
- Dialog links such as `/?dialog=settings&section=providers` (#521).
- Every dialog keeps the keyboard focus and closes with Escape in any language; shared motion
  timings; reduced motion stops all animation (#527, #532).
- One navigation model; every screen and Settings section is in search (#528). The palette no
  longer redraws its results on every refresh (#537).
- One SVG icon set, one type scale, one highlighter (#533).
- Context chips for files, artifacts, packs, diff hunks, terminal selections, failing checks and
  preview annotations; the engine receives the file itself and the artifact's content (#536).

### Adaptive layer

- Pruned to what has a consumer; three decision kinds are no longer offered; eval scripts moved to
  `packages/adaptive-eval` (#518).
- Provider-neutral settings and keys (#526). A decision kind is one module (#529).

## Upgrade notes

- **Database.** `harness.sqlite` goes from schema version 2 to 20 in one start (migrations 3 to
  17 and 20; 18 and 19 were not needed). A copy is taken first with `VACUUM INTO`. Existing
  duplicate documents become versions of one document; nothing is removed (#511). Rows left by
  earlier deletes are settled after the backup (#495).
- **First start.** The usage ledger is backfilled once from every existing session (#498).
  FlupCode's plugin files are removed from `~/.config/opencode/plugins/`, only those whose name is
  FlupCode's and whose first line is `// Installed by FlupCode` (#519).
- **An engine started by hand** needs the `plugin-token` file: start the harness or the desktop
  app first (#489).
- **`flupcode serve`** needs `flupcode-harness-<platform>` from the release beside `flupcode`
  (#515).
- **Aliases that last one release:** `adaptive.jev.*`, `allowJev`, `TYPESAFE_API_KEY` (#526).

## Known gaps

- Signing and auto-update signature verification are still blocked on certificates (F5-4).
- The FlupCode Bridge extension is not in any store. Store builds get their own extension ids,
  which must be added to `BRIDGE_EXTENSION_IDS` before they can connect.
- The engine proxy still signs in for any page at the hosted origin without a pairing code; only
  the harness is behind pairing (HE-01 finding).
- Tokens kept on disk can be read from an agent's shell (TI-10 and HE-02 findings).
- The Preview's guard covers main-frame navigations only (BU-06 finding).
- The engine's title-generation cost is not in the ledger (UL-02 finding).
- One BU-04 bridge test fails now and then in CI and did not reproduce locally (#539).
- The main JavaScript chunk is at 497.1 kB of its 500 kB limit.

The full list is under "Hallazgos durante la implementación" in `docs/AUDIT-2026-10.md`.

## Before tagging

- [ ] `gate` green on the commit to tag (the release job now requires it).
- [ ] Upgrade test on a **copy** of a real 3.0.1 `harness.sqlite`: all rows kept, integrity check
      ok, the backup file present.
- [ ] Decide between `4.0.0-rc.1` and `4.0.0`.
- [ ] Follow "Cutting a release" in `docs/RELEASE.md`; `script/opencode-pin.ts` must report the
      pin and its hashes in agreement.

## Smoke checklist for the packaged desktop app

Desktop main has little CI coverage, so check these by hand on the packaged build, on a test
profile:

- [ ] First start after 3.0.1: the app opens, sessions and runs are there, the Cost screen fills.
- [ ] A session answers; the terminal opens; Settings opens from the profile menu and from ⌘K.
- [ ] A workflow run: the card shows tasks, verdict and cost; Stop stops it; Resume from a failed
      task runs only what is left.
- [ ] A routine with a time zone shows its next run; "Run now" works.
- [ ] Kill the engine process: the banner shows and the app reconnects within 10 seconds.
- [ ] Help → Copy Diagnostics contains no token or key.
- [ ] Preview panel lists a running dev server, opens it, and asks before a site off this machine.
- [ ] "Give the agent a browser": an action asks for approval, and Stop detaches.
- [ ] Remote control: a phone pairs, sees Runs, approves a gate and stops a run.
- [ ] `flupcode serve` alone: a web tab pairs with the code and shows Runs.
- [ ] Intel Mac build: `file` on the harness server, the dictation helper and Chromium reports
      x86_64.
- [ ] A standalone `opencode` lists no FlupCode plugin.
