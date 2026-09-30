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

`test/plugins.test.ts` (ticket V2-03) starts a second engine with FlupCode's 14 engine plugins
installed from `packages/remote/src/engine-plugins.ts`, a stand-in harness-server, and the tokens
and config the desktop writes. The engine refuses a plugin silently, so each test checks what one
plugin leaves behind once its hooks fire: a file it writes, a tool it registers, or a call it makes
to harness-server. A new plugin without an entry there fails the suite.

```bash
bun run --cwd packages/engine-contract test
```

- `FLUPCODE_CONTRACT_ENGINE`: another engine command, with `{port}` for the port it listens on,
  for example a released `opencode` binary or an OpenCode 2.x one.
- `UPDATE_FIXTURES=1`: rewrite the fixtures after an intended contract change. In CI (`CI` set) a
  missing fixture fails instead of being written.

## OpenCode 2.x sandbox

Ticket V2-05. OpenCode 2 installs the same `opencode` command as 1.x (its installer replaces the
1.x one) and migrates `~/.local/share/opencode/opencode.db` one way on first start, so it is never
installed globally or pointed at the user's data:

```bash
bun run --cwd packages/engine-contract opencode-v2 install   # prints the binary's path
bun run --cwd packages/engine-contract opencode-v2 serve     # http://127.0.0.1:4196, sandbox home
```

`install` fetches the platform package of the pinned version (`OPENCODE_V2_VERSION` in
`src/opencode-v2.ts`) from the npm registry, checks it against the published sha512 integrity, and
unpacks it to `~/.cache/flupcode/engines/opencode-<version>/`. `serve` runs it with a home under
`~/.cache/flupcode/engines/sandbox-<version>/` and prints a fresh password; delete that folder to
start over.

## Running the flows on OpenCode 2

Ticket V2-06. `test/contract-v2.test.ts` drives the same flows through OpenCode 2's API and records
`fixtures/v2/`. It also pins down what FlupCode meets there today: its 1.x routes answer the web UI's
HTML, and its 1.x plugins are all refused. Each suite runs only on its own line:

```bash
bun run --cwd packages/engine-contract test      # 1.x flows (default line, runs in CI)
bun run --cwd packages/engine-contract test:v2   # 2.x flows against the pinned sandbox binary
```

The findings are in [docs/V2-CONTRACT-REPORT.md](../../docs/V2-CONTRACT-REPORT.md).
