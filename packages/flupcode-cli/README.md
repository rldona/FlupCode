# @flupcode/cli

The `flupcode` command: `flupcode remote` hosts remote control from a terminal so a phone can drive
this computer's OpenCode sessions (ADR-0010, F8-11); `flupcode serve` runs OpenCode 2 and FlupCode's
harness for the web app, and `flupcode pair` prints the code that pairs a web app tab with it (HE-01).

```bash
bun src/index.ts remote              # from the repository
flupcode remote --help               # compiled binary from a release
```

`bun run build` compiles a standalone binary to `dist/flupcode`. Releases publish binaries for
macOS, Linux and Windows. See `docs/USAGE.md` → Remote control.
