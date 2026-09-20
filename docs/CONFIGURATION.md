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

## What stays out of the repository

Agents, commands, tools, MCP servers and settings that name a product, a private service, a
credential or a machine belong in your configuration, never in FlupCode. The repository keeps a
check — `bun run repo-hygiene` — that fails if a private reference is committed by accident.
