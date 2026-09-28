# Episode replay fixtures (FH-007)

Deterministic, synthetic and anonymised episodes for the adaptive layer. Nothing here is copied
from a real session: the directories (`/work/proj`), the session ids (`ses_*`), the file names and
the shell output are invented to look like what the plugin and the harness actually write, with no
real path or secret in them.

`episode-fixtures.test.ts` loads each file, seeds `SqliteRoutineRepository(":memory:")`, points
`FLUPCODE_EPISODE_SIGNALS_DIR` and `FLUPCODE_TOOL_USES_DIR` at temporary directories built from the
fixture, and drives the operation `capture` names with a fixed `now` — offline, with no engine and
no network. On load it checks the required keys, that `name` matches the file's own name and that
`capture` carries the blocks it needs; a fixture that fails any of these is not used at all.

## Shape

Every fixture is JSON in this shape. All fields are read literally; the test does not guess.
`capture` is what the test drives: `"run"` calls `captureRun`, `"session"` calls `captureSession`,
and `"sweep"` marks the run terminal like restart recovery would and calls `sweep`.

```jsonc
{
  "name": "run-red-then-green",       // must match the file's own name
  "capture": "run" | "session" | "sweep",
  "directory": "/work/proj",          // the run's directory; becomes the episode's projectID
  "now": 1700000000000,               // fixed clock the coordinator is given

  // capture "run" and "sweep": the run to seed (startRun) and, in "run", to settle (finishRun).
  "run": {
    "source": { "type": "manual" },   // or { "type": "routine", "routineID": "..." }
    "startedAt": 1699999000000,
    "sessionID": "ses_red_green",     // optional attachSession(run.id, sessionID)
    "finish": { "status": "success", "at": 1700000000000, "error": "..." } // omitted while live
  },

  // capture "run" and "sweep": tasks, in position order. A task with no `status` stays queued.
  "tasks": [
    { "name": "build", "prompt": "go", "kind": "agent", "status": "success", "output": "done" },
    { "name": "check", "prompt": "", "kind": "verify", "attempt": 1, "status": "failed", "error": "red" },
    { "name": "check", "prompt": "", "kind": "verify", "attempt": 2, "status": "success" }
  ],

  // capture "session": the session to capture, with no run.
  "session": { "sessionID": "ses_fail_fix", "directory": "/work/proj" },

  // Files the real readers find on disk; keys are session ids.
  "toolUses": { "ses_red_green": { "tools": { "bash": { "count": 4, "last": 1 } }, "calls": [] } },
  "signals": {
    "ses_fail_fix": {
      "calls": [
        { "tool": "bash", "ok": true, "exit": 1, "command": "bun test", "out": "...", "paths": [] },
        { "tool": "edit", "ok": true, "paths": ["/work/proj/src/math.ts"] }
      ]
    }
  },

  // What the episode must read as. `evidenceRefs` is exact; `evidenceRefsContains` requires each
  // ref exactly once; `evidenceRefsPrefixes` requires at least one ref with each prefix.
  "expect": {
    "outcome": "success",
    "toolCalls": 6,
    "files": ["src/math.ts"],
    "commands": ["bun test"],
    "failures": [],
    "verifications": [{ "step": "check", "ok": false }],
    "evidenceRefs": ["session:ses_fail_fix", "failure:src/math.test.ts:3"],
    "evidenceRefsContains": ["verify:check"],
    "evidenceRefsPrefixes": ["run:", "task:"],
    "rows": 1
  },

  // capture "sweep": the state of the live checkpoint captured before restart recovery.
  "expectCheckpoint": { "outcome": "unknown", "toolCalls": 4 }
}
```

## Files

- `run-red-then-green.json` — a run whose `check` fails and passes on retry. Settles `success` and
  still carries the recovered failure; cites exactly one `verify:check`.
- `run-last-check-red.json` — a run the harness settled `success` whose last check is red. Reads
  `partial` and cites `verify:check`.
- `session-fail-and-fix.json` — a session with no run whose signals carry a red `bash` (`exit: 1`)
  and an `edit`. Reads `partial`, anchors `failure:src/math.test.ts:3` and lists the edited file.
- `run-crashed-then-recovered.json` — a live checkpoint, then restart recovery marks the run failed.
  The sweep settles the same row (`failed`) instead of leaving the checkpoint `unknown`.
