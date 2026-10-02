# Engine contract

Tests that drive a real OpenCode engine the way FlupCode does (ticket V2-02 in
[docs/V2-MIGRATION-AUDIT.md](../../docs/V2-MIGRATION-AUDIT.md)).

Each run starts the pinned OpenCode 2 binary with its own temporary home, XDG folders, database and
config, and a stub OpenAI-compatible model (`src/model.ts`) that replies what the test scripts. It
never touches the user's engine or `opencode.db`.

- `test/contract-v2.test.ts` (V2-06): a text turn, a tool call, a permission asked and answered, a
  question asked and answered, an aborted turn, and the routes the app reads outside a turn. Each
  records a fixture in `fixtures/v2/`, so a pin bump that changes the contract shows up as a diff.
- `test/plugins-v2.test.ts` (V2-30): FlupCode's 2.x plugins installed from
  `packages/remote/src/engine-plugins-v2.ts`, each one checked by what it leaves behind.
- `test/mcp-stats-v2.test.ts`: an MCP tool called from Code Mode is counted and timed.
- `test/browser-attach-v2.test.ts` (BU-07, ADR-0028): the engine's built-in `opencode.browser`
  attach protocol (`experimental.browser` version 4), driven by a minimal client.
- `test/v1-import-v2.test.ts` (V2-61): a recorded 1.x database (`fixtures/v1/history.db`, written by
  FlupCode's last 1.x engine) imported into 2.x, memories included, and rolled back.

```bash
bun run --cwd packages/engine-contract test
```

- `FLUPCODE_CONTRACT_ENGINE`: another OpenCode 2 command, with `{port}` for the port it listens on.
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
`src/opencode-v2.ts`) from the npm registry. It refuses a version younger than the repo's
`minimumReleaseAge` (`bunfig.toml`), the rule bun applies to every other package. It checks the
package against the published sha512 integrity and unpacks it to `~/.cache/flupcode/engines/opencode-<version>/`. `serve` runs it with a home under
`~/.cache/flupcode/engines/sandbox-<version>/` and prints a fresh password; delete that folder to
start over.

The findings are in [docs/V2-CONTRACT-REPORT.md](../../docs/V2-CONTRACT-REPORT.md).
