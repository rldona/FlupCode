# @flupcode/harness-server

Persistent server-side runtime for FlupCode Routines.

It owns:

- SQLite persistence for routines and runs.
- Per-routine SQLite locks with lease renewal.
- The local scheduler and restart recovery.
- OpenCode session creation, prompt admission, waiting, and interruption.
- The HTTP API consumed by `packages/harness`.

## Development

```bash
FLUPCODE_ENGINE_URL=http://127.0.0.1:4096 bun run dev
```

The server listens on `127.0.0.1:4097` by default. The database is stored at
`~/.local/share/flupcode/harness.sqlite`; override it with `FLUPCODE_HARNESS_DB`.

The desktop app starts this process automatically and packages a compiled sidecar binary.
