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
