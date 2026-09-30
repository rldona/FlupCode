# Engine contract

Tests that drive a real OpenCode engine the way FlupCode does (ticket V2-02 in
[docs/V2-MIGRATION-AUDIT.md](../../docs/V2-MIGRATION-AUDIT.md)).

Each run starts `opencode serve` from this checkout with its own temporary home, XDG folders,
database and config, and a stub OpenAI-compatible model (`src/model.ts`) that replies what the test
scripts. It never touches the user's engine or `opencode.db`.

The flows: a text turn, a tool call, a permission asked and answered, a question asked and answered,
an aborted turn, and the routes the harness reads outside a turn. Each one records a fixture in
`fixtures/<v1|v2>/`: the session's event types, the transcript's roles, part types and tool
statuses, and the keys of the responses FlupCode reads.

```bash
bun run --cwd packages/engine-contract test
```

- `FLUPCODE_CONTRACT_ENGINE`: another engine command, with `{port}` for the port it listens on,
  for example a released `opencode` binary or an OpenCode 2.x one.
- `UPDATE_FIXTURES=1`: rewrite the fixtures after an intended contract change. In CI (`CI` set) a
  missing fixture fails instead of being written.
