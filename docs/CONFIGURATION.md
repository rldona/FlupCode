# Bring your own configuration

FlupCode is a generic client. It ships no agents, commands, tools or MCP servers of its own beyond
the examples an OpenCode install already carries: everything that knows about a particular product,
team or machine lives in **your** configuration, outside this repository. This document is how you
add it.

FlupCode reads the engine's configuration through the standard OpenCode layering. You do not patch
the repository to make FlupCode yours; you point it at configuration you keep yourself.

## The layers

OpenCode merges configuration from several directories, later ones overriding earlier ones:

| Layer | Where | Shareable |
|---|---|---|
| Global | `~/.config/opencode/` (or `$XDG_CONFIG_HOME/opencode`, or `$OPENCODE_CONFIG_DIR`) | per machine |
| Project | `.opencode/` in the project folder, and each parent up to the project root | via git, with the project |
| Home | `~/.opencode/` | per machine |
| Extra | the directory named by `$OPENCODE_CONFIG_DIR` | your choice |

Set `OPENCODE_CONFIG_DIR` to load one more configuration directory in addition to the rest — the
usual way to keep a whole setup (agents, commands, tools, MCP) in one place you version yourself.
Note that when it is set it also becomes the engine's global config folder, so keep there whatever
you relied on from `~/.config/opencode/`.

From every one of those directories OpenCode loads, when present:

- `agent/*.md` — agents. The frontmatter is how one runs (model, permissions, mode); the body is
  what it is told. A primary agent is chosen in a session; a subagent is reached from another.
- `command/*.md` — slash commands. `description` and optional `agent`/`model` in the frontmatter,
  the prompt in the body; `$ARGUMENTS` is what the reader typed after the command.
- `tool/*.ts` (or `tool/*.js`) — tools, written against `@opencode-ai/plugin`. The engine installs
  that package in the config folder by itself.
- `plugin/` — engine plugins.
- `opencode.json` / `opencode.jsonc` — settings, including the `mcp` servers to connect. Merged
  across layers.

Skills (`SKILL.md` folders) are reachable with `skills.paths` and `skills.urls`, and extra
instruction files with `instructions`, both in the settings file.

## A configuration of your own

The simplest shape is a directory you open as a project, whose `.opencode/` is your configuration:

```
my-flupcode-config/
└── .opencode/
    ├── agent/
    │   └── example.md
    ├── command/
    │   └── example.md
    ├── tool/
    │   └── my-tool.ts
    └── opencode.jsonc
```

Open that folder in FlupCode (or start the engine with it as the directory) and the agents, commands
and tools appear. Keep it in its own private repository to version and share it without touching
FlupCode.

## A concrete setting: `flupcode.composeTools`

Some tools return an image that is an *input* to a piece a delivery tool later re-attaches, rather
than the piece itself. FlupCode must not paint that image on its own — it would show twice — but it
must not hard-code which tools those are either. You declare them:

```jsonc
{
  "flupcode": {
    "composeTools": ["<server>_compose_map", "<server>_compose_card"]
  }
}
```

FlupCode reads the list and never names a tool of any product. With no such setting, nothing is
special and the behaviour is the default.

## Delivery: one tool per product, declared

A piece is often two things that must travel together: the text and an image some tool composed. The
delivery step re-attaches that image so a person copies both at once, and it does not publish
anything. Instead of writing a delivery tool for every product, declare the profiles and FlupCode's
engine plugin registers one tool per profile — the same plugin mechanism the repository already uses,
so nothing here names a product:

```jsonc
{
  "flupcode": {
    "composeTools": ["<server>_compose_map", "<server>_compose_card"],
    "delivery": {
      "<profile>": {
        "tool": "deliver-<profile>",
        "description": "What the model is told this tool is for.",
        "composeTools": ["<server>_compose_map"],
        "imageRequired": true,
        "imageMissing": "Returned when no composed image is in the conversation.",
        "labels": { "title": "…", "text": "…", "alt": "…", "image": "…", "missingAlt": "…" },
        "guards": ["lib/<profile>-guards.ts"]
      }
    }
  }
}
```

- `tool` is the id the model calls; `composeTools` says which composed image to re-attach; `labels`
  is the copy around it; `guards` is optional (see below).
- Profiles are read from the merged **global** config — `config.json`, then `opencode.json`, then
  `opencode.jsonc`, later files winning, jsonc highest — so they are machine-wide and a profile
  written by the advanced editor's Global scope is still seen. Changing them takes a restart of the
  engine.

A guard is product-owned code, kept out of FlupCode. It is a module under the config directory that
exports `guards`, an array of `{ id, assess }`; `assess(input)` receives `{ text, template, alt,
location, messages }` and returns `{ allow, code?, reason? }`. The first `allow: false` stops the
delivery with its reason. Guards fail closed: a listed module that cannot be loaded, or one whose
`assess` throws, refuses the delivery instead of being skipped. Without `guards`, the profile
delivers unconditionally.

## Adaptive Harness settings

The Adaptive Harness is FlupCode's own bounded service, and its settings live in the global
`flupcode.adaptive` block — read through the same OpenCode layering as the rest of the global config,
not a product profile. The block is read with the precedence **`env > block > default`**: an
environment variable always wins, a well-typed value in the block comes next, and a missing or
malformed value falls back to the conservative default rather than being guessed.

```jsonc
{
  "flupcode": {
    "adaptive": {
      "enabled": true,            // kill switch; false (or FLUPCODE_ADAPTIVE_DISABLED=1) stops decisions, shadow, every predictive model, relevance, learning and the context plan
      "shadow": true,             // record decisions without acting on them
      "context": { "enabled": true, "apply": false },   // apply is off until the offline evaluation promotes it
      "learning": { "enabled": false },
      "relevance": { "enabled": false },
      "models": { "completion": "<provider id>" },   // which predictive provider answers each decision; absent ⇒ built-in rules
      "providers": {              // per-provider settings (PI-01); every field optional, the provider has its own defaults
        "<provider id>": {
          "endpoint": "…", "model": "…", "timeoutMs": 400,
          "maxInputChars": 32000,  // the most characters of serialized input it is sent
          "keyRef": "…",           // the vault name of its key; also read from FLUPCODE_<KEYREF> (upper case, - as _)
          "budget": { "monthlyTokens": 50000 }   // lowers the layer's monthly budget for this provider
        }
      },
      "egress": {
        "providers": {            // consent per provider; nothing leaves the machine without it
          "<provider id>": { "enabled": false, "projects": [], "kinds": {} }
        }
      },
      "budget": { "monthlyTokens": 100000, "hotReserveFraction": 0.2 },
      "retention": {              // ADR-0022; off by default
        "enabled": false,
        "decisionsDays": 30,
        "actingDays": 90,
        "plansDays": 30,
        "appliedPlansDays": 90,
        "reflectionDays": 30,
        "rejectedProposalsDays": 30
      }
    }
  }
}
```

From the app's **Adaptive** settings section you may move the **switches** only:

`enabled`, `shadow`, `context.enabled`, `context.apply`, `learning.enabled`, `relevance.enabled`,
`models.<kind>`, `egress.providers.<id>.{enabled,projects,kinds}`, `retention.enabled` and
`budget.monthlyTokens`. Everything else above is read-only there — the thresholds, timeouts, provider
settings and retention windows are edited in the file, not from the panel. A provider's key is never
read from the config block: `FLUPCODE_<KEYREF>` in the environment wins, and otherwise the panel can
save one, write-only, in the encrypted vault under the provider's `keyRef`, bound to its endpoint's
origin (ADR-0017, amended 2026-09-30).

Names written before PI-01 are still read, never written, for one release: the `jev` block
(`enabled` as the old single switch, `endpoint`, `model`, `timeoutMs`, `maxInputTokens` as
`providers.jev.maxInputChars`), `decisions.<kind>.allowJev` (as `allowModel`), the top-level
`egress.projects`/`egress.kinds` (as Jev's consent) and `TYPESAFE_API_KEY` (as
`FLUPCODE_TYPESAFE_API_KEY`). A field the new shape sets wins. `jev.enabled` is no longer writable:
choosing a model for one decision turns it off and pins the other decisions to what it resolved to.

The switches keep their guards, so the panel cannot promise more than the engine does:

- A provider's `egress.providers.<id>.enabled` needs an **egress allowlist** first: a project and
  a kind for that provider. With neither, the toggle is drawn disabled with the reason.
- `relevance.enabled` needs the harness's resolved `adaptive-token`; without it the toggle is
  disabled.
- `retention.enabled`, `learning.enabled`, a provider's consent and **widening** its projects or
  kinds ask for a confirmation before the write.
- With `FLUPCODE_ADAPTIVE_DISABLED=1`, the master switch is off and disabled and `enabled=true` is
  refused with `env-disabled`.
- The egress kind list shows only the **four kinds the server ships** — `completion`,
  `skillRelevance`, `contextItem`, `skillReflection`; a kind that does not exist yet is not offered,
  so the panel never promises an entry that would do nothing.

The panel writes through **`PATCH /harness/adaptive/config`** with a partial body:

```jsonc
{ "patch": { "egress": { "projects": ["/home/me/project"] }, "confirm": true } }
```

`patch` mirrors the block and may carry only allowlisted leaves; `null` on a leaf deletes it (back to
default). The route answers with the resulting read view plus any `warnings`, or `422` with a closed
code. It requires the loopback bearer, and the settings section is read-only when the server has no
writer token. See [`docs/ADAPTIVE.md`](ADAPTIVE.md#the-cockpit-e8) for the full posture.

### Retention

- `enabled` is **off by default**: nothing expires until you opt in. The numbers above are the
  conservative defaults — ADR-0022 fixes the policy, not the numbers; a malformed
  value or a non-positive window falls back to its default, never guessed.
- When on, a single transactional purge limits only the four adaptive audit tables —
  `adaptive_decision`, `adaptive_plan`, `reflection_job`, `skill_proposals` — with a window per state
  (shadow vs acting decisions, shadow vs applied plans, terminal reflection jobs, rejected proposals),
  judged by `updated_at`.
- **Never purged**: proposals in `proposed` or `promoted`, `pending` reflection jobs, any row another
  row references, and — outside retention entirely — episodes, evidence, artifacts and every on-disk
  artifact (`.ledger.jsonl`, `.versions/`, `.sidecar.json`, the archive). Execution is at startup and
  on the hourly sweep, and fails safe.

The relevance loopback auth is **not** configuration: the harness creates
`<configDir>/adaptive-token` (0600) itself and the relevance plugin reads the same file, so there is
nothing to put in your config. `WEB_ACTIONS_PLUGIN` and the browser token are unchanged. See
[`docs/ADAPTIVE.md`](ADAPTIVE.md#acting-promotion-in-progress) for the full posture.

## Onboarding a product

1. An agent (`agent/<product>.md`, or the Agents panel).
2. A command (`command/<product>.md`, or the Commands panel).
3. An MCP server, if the product needs one of its own — reuse the one that already serves every
   product when it does. Add servers in the MCP manager, whose scope is **Global** by default.
4. A `flupcode.delivery` profile in the global config (the advanced config editor, **Global** scope,
   or the file).
5. A `lib/<product>-guards.ts` module only if the product must refuse a piece.
6. Nothing else — no code belongs in this repository for it.

## Global or project, and versioning

The app's agent and command editors write either to the config directory (Global) or to the project's
`.opencode` (Project). MCP servers and `flupcode.*` settings default to **Global**, because they are
about the machine, not one project.

Files created from the app are live configuration. If you want them versioned, keep them in your own
configuration repository and install them (symbolic links for agent/command/tool/lib, a merge for the
settings); otherwise they live only on the machine. Editing an already-linked file through the app
writes through the link into your repository; creating a new one does not.

## What stays out of the repository

Agents, commands, tools, MCP servers and settings that name a product, a private service, a
credential or a machine belong in your configuration, never in FlupCode. The repository keeps a
check — `bun run repo-hygiene` — that fails if a private reference is committed by accident.
