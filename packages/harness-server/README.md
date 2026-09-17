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
| `GET /harness/findings` | filtered by `directory`, `runID`, `open=1` |
| `PATCH /harness/findings/:id/resolved` | set one aside, or bring it back |
| `GET /harness/runs/:id/activity` | which tool each running task is inside, and since when |
| `GET /harness/runs/:id/files` | what each task changed on disk, from the checkpoints around it |
| `GET /harness/usage` | what the runs cost, filtered by `directory` and `days` |
| `GET`/`POST /harness/checkpoints` | the ones for `?directory=`, or take one now |
| `GET /harness/checkpoints/:id/plan` | which files restoring would write, and which it would delete |
| `POST /harness/checkpoints/:id/restore` | do it, after recording the present as a checkpoint of its own |
| `DELETE /harness/checkpoints/:id` | forget one |
| `GET /harness/artifacts` | filtered by `directory`, `runID`, `kind` |
| `POST /harness/artifacts` | keep one by hand |
| `GET /harness/artifacts/:id`, `DELETE /harness/artifacts/:id` | read or forget one |
| `GET`/`POST /harness/routines`, `…/:id` (`GET`/`PATCH`/`DELETE`) | the routines |
| `PATCH /harness/routines/:id/enabled` | pause or resume one |
| `POST /harness/routines/:id/runs` | run one now; **409** if it is already running |
| `POST /harness/routines/:id/runs/:runID/stop` | stop that run |

## Development

```bash
FLUPCODE_ENGINE_URL=http://127.0.0.1:4096 bun run dev
```

The server listens on `127.0.0.1:4097` by default (`FLUPCODE_HARNESS_PORT`, `FLUPCODE_HARNESS_HOST`).
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
