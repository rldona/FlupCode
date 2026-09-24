# Web actions

A **web action** lets the agent act on a website through a real browser on your own machine:
navigate, fill a form, upload a file, submit, or read a value back. You describe the action once as a
**profile**; FlupCode registers a tool for it and the agent calls that tool. No code is written for
your site, and no site name enters FlupCode's repository.

This is the contract for `flupcode.actions`. For the rationale and boundaries, see
[ADR-0015](adr/0015-web-actions-and-browser-automation.md). To add an agent, a command, a tool or an
MCP server, see [CONFIGURATION.md](CONFIGURATION.md).

## The rule

> **One top-level configuration key per medium/backend; one profile per use case.**

- Web actions live under **`flupcode.actions`**. They cover any website: publishing, booking,
  sending, or reading a page.
- Native OS automation will be a different medium with its own key, **`flupcode.os`** (future). It is
  not a profile inside `actions`.
- **`flupcode.delivery`** is separate: it composes a piece and hands it to a person, with no side
  effects. It does not act on a site.

The first backend is the browser (`kind: "browser"`). `kind: "api"` and `kind: "mcp"` are reserved:
the envelope is the same, and only the executor changes.

## The profile envelope

Every profile, whatever its `kind`, carries these fields:

| Field          | Required      | Meaning                                                                        |
| -------------- | ------------- | ------------------------------------------------------------------------------ |
| `tool`         | yes           | The id the model calls, e.g. `do_<profile>`. Must be a valid tool name.        |
| `description`  | no            | What the model is told the tool is for. Falls back to a generic sentence.      |
| `kind`         | yes           | The backend. `"browser"` today; `"api"` and `"mcp"` reserved.                  |
| `origin`       | for `browser` | The site's origin, `scheme://host[:port]`. Normalized lowercase, no path.      |
| `credential`   | no            | The name of a stored credential to inject, resolved inside the runtime.        |
| `inputs`       | no            | The values the tool accepts from the agent (`text`, `alt`, `image`, …).        |
| `steps`        | yes           | The ordered recipe the runner executes.                                        |
| `extract`      | no            | Values to read back from the page (a read action).                             |
| `guards`       | no            | Product-owned modules that must allow the action (see below).                  |
| `sensitive`    | no            | Whether the action performs a side effect that needs approval. Default `true`. |
| `availability` | no            | Where it may run: `host` (default) or `desktop`.                               |
| `evidence`     | no            | What to keep: per-step screenshots, a trace, or the final page text.           |

An unsupported `kind` is refused when the profile is loaded, never silently ignored.

## Inputs

`inputs` names what the agent supplies. A `text` input is a string the agent writes; an `image` input
is taken from the composed image the agent already produced in the conversation (the same
`composeTools` mechanism `flupcode.composeTools` declares) or from an artifact. Every declared input
becomes an argument of the tool:

```jsonc
"inputs": { "text": "string", "alt": "string", "image": "image" }
```

The agent writes the text and the alt; the image is attached automatically. The recipe references
inputs with `{{name}}`.

## Steps

A step is one of the following (web kind). Steps run in order, each with a timeout and bounded
retries.

| Step         | Shape                                                                   | Effect                                                             |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `goto`       | `{ "goto": "{{origin}}/path" }`                                         | Navigate. Refused if it leaves `origin` or hits a blocked address. |
| `waitFor`    | `{ "waitFor": "<selector>", "timeoutMs": 15000 }`                       | Wait for an element.                                               |
| `fill`       | `{ "fill": { "selector": "…", "text": "{{text}}" } }`                   | Type into a field. `text` or `credential` (a name), not both.      |
| `click`      | `{ "click": "<selector>" }`                                             | Click an element.                                                  |
| `upload`     | `{ "upload": { "selector": "input[type=file]", "from": "{{image}}" } }` | Set a file input from an image input.                              |
| `submit`     | `{ "submit": { "selector": "…" } }`                                     | Perform the final, irreversible submit. Always sensitive.          |
| `assert`     | `{ "assert": { "selector": "…", "text": "…" } }`                        | Fail the action if the page does not match.                        |
| `screenshot` | `{ "screenshot": "label" }`                                             | Capture evidence at this point.                                    |

A `fill` with `credential` injects the stored value; the value is never returned. A step marked
`"sensitive": true` triggers an approval request before it runs. An action whose `sensitive` is
`false` (a pure read) needs no per-step approval beyond navigation.

## Extract

A read action declares `extract` and returns the values instead of changing anything:

```jsonc
"extract": { "price": { "selector": "[data-price]", "as": "text" } }
```

The tool result carries the extracted values as structured text. Extract actions default to
`sensitive: false`.

## Credentials

A credential is stored once, encrypted, under a **name**. The agent references the name; it never sees
the value. The value is resolved and typed inside the runtime, bound to the credential's declared
origin: a credential for one origin cannot be injected on another. See
[ADR-0015](adr/0015-web-actions-and-browser-automation.md) for where the vault and its key live. The
first login is manual, in the isolated browser profile for the project; the session persists across
runs without the agent ever handling the password.

## Guards

A guard is product-owned code kept out of FlupCode, exactly as in delivery profiles. It is a module
under your configuration directory that exports `guards`, an array of `{ id, assess }`.
`assess(input)` receives the action's inputs and returns `{ allow, code?, reason? }`. The first
`allow: false` stops the action with its reason. Guards fail closed: a listed module that cannot be
loaded, or one whose `assess` throws, refuses the action instead of being skipped. Without `guards`,
the profile runs unconditionally.

## Approval

Side-effecting actions are governed by two permissions:

- **`browser`** — navigate and read. Resource: `origin`.
- **`browser_sensitive`** — click, type, submit, credential. Resource: `origin:action`.

The agent tool asks for approval before every side-effecting step, showing the origin, the action and
a screenshot. "Allow always" remembers at most `origin` or `origin:action`, never everything. Modes
that grant broad access (including bypass) are documented as including the browser; a whole-engine
kill switch disables every browser tool regardless of mode.

## Scheduling

A scheduled action is a **Routine**, not a separate mechanism. Create a routine whose prompt drives
the agent and whose agent carries explicit allow rules for the origins it needs. Because an
unattended run cannot answer an approval, a browser routine without allow rules is refused at
creation with an actionable warning.

## Authoring one

From the app: open **Actions**, add a profile, set its origin and credential, add steps and (for a
read action) an extract, then run a dry-run against the browser. Profiles are saved to the global
config or the project's `.opencode`, and can be exported to your own configuration repository.

By hand: add the profile to the `flupcode.actions` block of your global `opencode.json` /
`opencode.jsonc`. The engine carries the settings; FlupCode's plugin reads them and registers the
tools on the next engine start.

## Example (generic)

Two profiles: one that publishes a composed piece to a site, and one that reads a value back. Neither
names a product.

```jsonc
{
  "flupcode": {
    "composeTools": ["<composer>"],
    "actions": {
      "publish": {
        "tool": "do_publish",
        "description": "Publish the piece you wrote and composed to <site>.",
        "kind": "browser",
        "origin": "https://<site>",
        "credential": "<site>_account",
        "sensitive": true,
        "inputs": { "text": "string", "alt": "string", "image": "image" },
        "steps": [
          { "goto": "{{origin}}/compose" },
          { "waitFor": "[data-editor]" },
          { "fill": { "selector": "[data-editor]", "text": "{{text}}" } },
          { "upload": { "selector": "input[type=file]", "from": "{{image}}" } },
          { "screenshot": "before-submit" },
          { "submit": { "selector": "[data-publish]" } },
          { "assert": { "selector": "[data-posted]" } },
        ],
        "guards": ["lib/publish-guards.ts"],
      },
      "status": {
        "tool": "read_status",
        "description": "Read the current status shown on <site>.",
        "kind": "browser",
        "origin": "https://<site>",
        "sensitive": false,
        "steps": [{ "goto": "{{origin}}/status" }, { "waitFor": "[data-status]" }],
        "extract": { "status": { "selector": "[data-status]", "as": "text" } },
      },
    },
  },
}
```

## Limits

- Only `http(s)`. Loopback, link-local, private addresses and cloud-metadata endpoints are refused.
- Page content is **untrusted input**: text on a page never authorises an action. The agent acts on
  the recipe and your instructions, not on what a page tells it to do.
- The live view is a streamed screenshot; takeover reveals the real window. Wave 1 does not forward
  your mouse and keyboard into the page.
- Redaction masks password and card fields and the fields the action filled. It cannot be complete;
  an unredacted capture requires explicit approval.

## What this is not

- Not native OS control. Acting on the whole desktop is `flupcode.os`, a later, separate medium.
- Not a cloud browser and not remote control of the browser.
- Not a password manager. The vault exists only to inject a named credential into a recipe.
