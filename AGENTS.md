# FlupCode

FlupCode is a web and desktop app on the official OpenCode 2 engine (ADR-0027). The engine is the
pinned `@opencode/cli` binary and `@opencode/client` from npm: it is never built or patched here.
What FlupCode adds to the engine ships as plugins (`packages/remote/src/engine-plugins-v2.ts`).

- Packages: `harness` (web app), `harness-desktop` (Electron), `harness-server` (loopback server),
  `remote` (engine install, plugins, proxy, remote control), `relay`, `flupcode-cli`,
  `engine-contract` (tests against the real binary), `landing`.
- The engine version is one pin: `OPENCODE_V2_VERSION` in `packages/remote/src/opencode-v2.ts` and
  `@opencode/client` in the `package.json` files. Move it with `bun script/opencode-pin.ts bump`
  (see `docs/UPSTREAM.md`); CI checks they agree.
- Talk to the engine only through the adapter in `packages/harness/src/engine/` (web) and
  `packages/harness-server/src/engine-v2.ts` (server).

## Git Workflow

- `power` is our master. It only receives changes through a pull request: never commit or push directly to it.
- Work on a short feature branch based on `power`, push it, open a PR, and merge it. Do not leave local commits sitting on `power`.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `harness`, `desktop`, `server`, `remote`, `cli`, `relay` or `opencode` (a pin bump).

Examples: `fix(harness): keep the scroll position`, `docs: update contributing guide`, `chore(opencode): pin OpenCode 2.0.19`.

## Deployments

- Never trigger Vercel preview deployments: they consume paid quota. Work through GitHub only.
- Production reaches Vercel later, from `power`, through the normal merge flow. Do not run the `vercel` CLI to deploy a preview.
- Both `packages/harness/vercel.json` and `packages/landing/vercel.json` disable deployments for every branch except `power` (`git.deploymentEnabled`).

## Branding

- Never hand-edit raster brand assets. Regenerate them with `swift script/branding.swift` (macOS only).
- Source of truth is `assets/flupcode-tentative-logo.png` on a `#FFEDD5` plate.
- Brand geometry lives in `script/branding.swift` (`targets`): desktop `icon.png` full-bleed plate at artwork `fraction: 0.60`; mac `icon-mac.png` plate `scale: 0.805` (macOS 824/1024 grid) with artwork `fraction: 0.60`; web/PWA plate icons (`apple-touch-icon.png`, `icon-192.png`, `icon-512.png` in harness and landing) at `fraction: 0.52`; `icon-maskable-512.png` at `0.50` (maskable safe zone); `og.png` (1200x630) at `fraction: 0.68` on height basis; transparent `flupcode-logo.png` artwork fit at `0.90`. See "Icon geometry" in `docs/RELEASE.md` and keep these values so every build mounts the same icon.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Session } from "./session"`, then reference `Session.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/harness`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/harness`), never `tsc` directly.
