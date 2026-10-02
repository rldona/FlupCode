# @flupcode/harness-server

The part of FlupCode that keeps going when the window is closed.

It owns:

- **Runs and tasks.** A run is one execution, made of tasks; a task is a turn of an agent or a check
  the harness runs itself. Both survive a restart, and what they cost is recorded.
- **Verification** (H-22). The project's own commands, declared in `.flupcode/project.yaml` or
  detected from its `package.json` scripts. No model is involved. When one fails and the work was
  given a budget, it is attempted again with the evidence in its prompt — a bounded number of times,
  and each retry is a new task rather than the same one repeated.
- **Workflows** (H-21). Processes written down as YAML: inputs, an ordered list of tasks, and gates.
  Templates are seeded to `~/.local/share/flupcode/workflows` once and never overwritten; a
  project's own, in `.flupcode/workflows/`, take precedence.
- **Artifacts** (H-14). What runs leave behind — the verdict of each check, a report of each run —
  kept inline up to a ceiling, hashed, and published as they are written.
- **Git and pull requests** (H-20). Commit and branch, run as `git` with an argument vector rather
  than through a shell; the branch's pull request and its checks, read with `gh`. The client is a browser and the engine's `/vcs` routes only read, so this is the only part
  of FlupCode that can write to a repository. What may be committed is what `git status` has just
  listed as changed.
- **Context** (H-17). Which `AGENTS.md` files a turn in a folder would load, by the engine's own
  rules — the global one, then every one walking up to the project root, nearest last. Read from
  disk because the engine does not report them. It will only read back a file it has just listed.
- **Findings** (H-32). A review's points, anchored to a file and usually to a line, parsed out of
  what the agent answered and carried onto the diff. Forgiving about the shape a model writes, strict
  about anchoring: a point with no file cannot become a comment on a line, so it is counted rather
  than pretended into one.
- **What it cost** (H-16). Every task the runs recorded, added up by model, agent, project and day —
  with work attempted a second time split out, because a bounded retry is a new task and so a second
  bill. Runs only: the harness never sees an ordinary chat turn.
- **Checkpoints** (H-15). A way back from what a run did: a git commit object on no branch, built
  through a temporary index, so taking one touches neither the working tree nor the index nor the
  stash. A ref under `refs/flupcode/checkpoints/` keeps git from collecting it. Restoring says which
  files it would write and which it would delete first, and records the present before it starts.
- **Routines.** Prompts on a schedule, with a per-routine lock and lease renewal so one cannot run
  twice at once, plus recovery for runs a stopped server left behind.
- **An event log.** Everything above is appended with a sequence number and served as SSE, so a
  client follows along instead of polling.

## HTTP API

Everything lives under `/harness`. A response is `{ "data": … }` or `{ "error": "…" }`.

| | |
| --- | --- |
| `GET /harness/health` | is it up |
| `GET /harness/events` | the stream. With `?after=<seq>` or `Last-Event-ID`, what was missed; with neither, only what happens next |
| `GET /harness/runs` | the runs, newest first |
| `POST /harness/runs` | start one from a list of tasks |
| `GET /harness/runs/:id` | one run, with its tasks |
| `GET /harness/runs/:id/tasks` | just its tasks |
| `POST /harness/runs/:id/stop` | interrupt it; also how a gate is refused |
| `POST /harness/runs/:id/approve` | let it through the gate it stopped at |
| `DELETE /harness/runs/:id` | forget it; **409** while it is running or waiting |
| `POST /harness/runs/stop` | interrupt everything going |
| `DELETE /harness/runs` | forget every run that has finished |
| `GET /harness/workflows` | what is available; `?directory=` includes the project's own |
| `POST /harness/workflows/:name/runs` | start one; **400** names a missing input, **404** an unknown workflow |
| `POST /harness/git/commit` | stage the named paths and commit them; **409** if one is no longer changed |
| `POST /harness/git/branch` | start a branch here and move onto it; **409** if the name is taken |
| `GET /harness/git/branch` | which branch `?directory=` is on |
| `GET /harness/git/pr` | where `?directory=`'s branch stands: pushed or not, its pull request and every check |
| `POST /harness/git/pr` | push the branch if needed, then open a pull request |
| `GET /harness/git/pr/log` | what the failing Actions `?job=` printed, tail-limited and stripped of the runner's columns |
| `GET /harness/context` | the instruction files `?directory=` would load, in order |
| `GET /harness/context/file` | one of them, and only one this folder would load |
| `GET /harness/context/system-prompt` | the system prompts `?sessionID=`'s last requests went out with, recorded by FlupCode's engine plugin |
| `GET /harness/context/tool-uses` | the tools `?sessionID=` ran, and how often, recorded the same way |
| `GET /harness/findings` | filtered by `directory`, `runID`, `open=1` |
| `PATCH /harness/findings/:id/resolved` | set one aside, or bring it back |
| `GET /harness/runs/:id/activity` | which tool each running task is inside, and since when |
| `GET /harness/runs/:id/files` | what each task changed on disk, from the checkpoints around it |
| `GET /harness/usage/summary` | the usage ledger added up: `groupBy` one dimension, `from`, `to`, `directory`, `limit` |
| `GET /harness/usage/sessions/:id` | a session with its subagents and its cost by agent; `from` adds what the tree spent since then |
| `GET /harness/usage/runs/:id` | a run's cost by task, purpose, agent and model |
| `POST /harness/usage/events` | the usage ledger's ingest: `{ events, tools }`, at most 500 of each, stored once by `id`; plugin token only |
| `GET`/`POST /harness/checkpoints` | the ones for `?directory=`, or take one now |
| `GET /harness/checkpoints/:id/plan` | which files restoring would write, and which it would delete |
| `POST /harness/checkpoints/:id/restore` | do it, after recording the present as a checkpoint of its own |
| `DELETE /harness/checkpoints/:id` | forget one |
| `GET /harness/artifacts` | one row per document (its newest version matching the filter, with `versions`), filtered by `directory`, `runID`, `kind`, `q`; a page at a time (`limit`, `offset`), `next` says where the following page starts |
| `POST /harness/artifacts` | keep one by hand |
| `POST /harness/artifacts/index` | a document `artifact_write` just kept: `{ sessionID, messageID, directory, path, title }`; the server reads the file from `.flupcode/artifacts` and takes the run and task from the session's attribution; plugin token only |
| `GET /harness/artifacts/:id` | read one version |
| `GET /harness/artifacts/:id/versions` | every version of its document, newest first, without their text |
| `DELETE /harness/artifacts/:id` | forget one version; `?document=1` forgets every version of the document |
| `GET`/`POST /harness/routines`, `…/:id` (`GET`/`PATCH`/`DELETE`) | the routines |
| `PATCH /harness/routines/:id/enabled` | pause or resume one |
| `POST /harness/routines/:id/runs` | run one now; **409** if it is already running |
| `POST /harness/routines/:id/runs/:runID/stop` | stop that run |

## Development

```bash
FLUPCODE_ENGINE_URL=http://127.0.0.1:4096 bun run dev
```

The server listens on `127.0.0.1:4097` by default (`FLUPCODE_HARNESS_PORT`, `FLUPCODE_HARNESS_HOST`).

Access (WA-9, AH-A05):

- **Bearer.** `/harness/browser/*`, `/harness/actions/*`, `/harness/credentials` and
  `/harness/action-profiles` always answer **403** `invalid_token` without
  `Authorization: Bearer <token>`, where the token is `<configDir>/browser-token` (or
  `FLUPCODE_BROWSER_TOKEN`). The engine's plugins hold a second, narrower token,
  `<configDir>/plugin-token` (or `FLUPCODE_PLUGIN_TOKEN`): it opens the action catalogue, approval
  and run (not the editor's validate, dry run or preview), a run's evidence screenshots and
  `/harness/plan-exit`, the usage ledger's ingest and the artifacts index, which only it may write,
  and nothing else (TI-10, UL-01, RP-03). The remote host (the desktop app, `flupcode remote`)
  carries a paired phone's `/harness/*` calls through the tunnel with a third, `<configDir>/remote-token`
  (file only): it reads runs and artifacts, approves a run's gate and stops a run, and every other route
  answers **403** `out_of_scope` (HE-02, `src/remote-scope.ts`). Processes the server starts get neither token, nor
  the engine's credentials or the vault key. When a token exists — the entrypoint always creates one unless the write
  fails — **every other `/harness` route asks for it too**: runs, best-of-n, task retry/cancel,
  workflows, routines, git, checkpoints, artifacts, the event stream, and the reads that carry
  prompts, files or config (context, files, config files, skills, agents, commands, memory, stash…).
  The `Origin` check accepts any loopback port, so without this another page on `localhost` could
  start agent runs. Only three things stay open: `GET /harness/health`, a share link
  (`GET /harness/shares/:id`, read as a plain link whose id is the secret), and `/harness/adaptive/*`,
  where each surface keeps its own guard (the acting line's dedicated token, or this bearer) and its
  ordinary-404 rule. Without a token nothing is compared and every route answers as before. The
  desktop app hands the token to the renderer and to the remote host's routine notifier; a plain
  browser tab has none, so it is refused. `vite` dev in `packages/harness` (never `build`/`preview`)
  serves the same token to a same-origin loopback tab through `/@flupcode/dev-token.js`, so local
  development keeps working. A hosted or built web tab without the desktop has no harness until a
  pairing flow exists.
- **Host.** Every request whose `Host` is not a loopback name (`127.0.0.1`, `::1`, `localhost`,
  `*.localhost`) or the address the server listens on answers **403** `invalid_host`, which stops a
  DNS-rebinding page. On a wildcard listener (`0.0.0.0`, `::`) any IP literal is also accepted. A
  reverse proxy or LAN name goes in `FLUPCODE_HARNESS_ALLOWED_HOSTS` (comma-separated, exact
  hostnames or `host:port`).
- **Origin.** A mutating request that sends an `Origin` must send `oc://renderer`, a loopback origin
  on any port, or one named exactly in `FLUPCODE_HARNESS_CORS`.
The database is stored at `~/.local/share/flupcode/harness.sqlite`; override it with
`FLUPCODE_HARNESS_DB`. Columns added by later versions are migrated into an existing database on
start, so a database written by an older server keeps working.

The pull-request routes need `gh` installed and logged in. Without it they answer
`{ available: false, problem: … }` rather than an error, so a client shows nothing instead of a
control that cannot work. The repository is taken from the branch's own remote, never from `gh`'s
default: in a fork with an `upstream` remote, `gh` picks the upstream and answers an empty list for
a branch that has a pull request — no error, just the wrong repository.

The desktop app starts this process automatically and packages a compiled sidecar binary.

> Tests always construct the repository with `:memory:`. One built with no path opens the database
> this machine actually uses, and a test run then writes its fixtures into somebody's real routines
> — which has happened.
