# @flupcode/cli

The `flupcode` command. For now it has one command, `flupcode remote`: host remote control from a
terminal so a phone can drive this computer's OpenCode sessions (ADR-0010, F8-11).

```bash
bun src/index.ts remote              # from the repository
flupcode remote --help               # compiled binary from a release
```

`bun run build` compiles a standalone binary to `dist/flupcode`. Releases publish binaries for
macOS, Linux and Windows. See `docs/USAGE.md` → Remote control.
