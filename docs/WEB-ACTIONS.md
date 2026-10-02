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
`"sensitive": true` makes the action sensitive and is shown in its single approval request. An action
whose `sensitive` is `false` (a pure read) needs no approval beyond navigation.

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

Every web action is a decision of the harness server's browser policy (`browser-policy.ts`), made
from the profile the server loaded, never from the plugin's request. The policy looks at two
things: the profile's **origin** and the **tier** of what its steps do.

| Tier        | What it covers                                                                  |
| ----------- | ------------------------------------------------------------------------------- |
| `read`      | `waitFor`, `assert`, `screenshot`, `extract`: looking at the page               |
| `navigate`  | `goto`: opening an address on the site, and reading it                          |
| `interact`  | `fill`, `click`: changing the page                                              |
| `sensitive` | `submit`, `upload`, a saved credential, a step marked `sensitive`, or a profile marked `sensitive` that does not otherwise change the page |

An action's tier is its highest step. The policy answers **allow**, **ask** or **deny**:

- **Deny** on a small, fixed list of payment, banking and sign-in sites (`BLOCKED_SITES`: identity
  providers, password vaults, payment and exchange sites, and the `.bank` domain, with their
  subdomains). Nothing, not even a routine's rule, lets an action run there.
- **Allow** when a standing grant for that origin covers the tier, or a routine's rule covers the
  action (see below).
- **Ask** otherwise. On OpenCode 2 a plugin's tool cannot ask, so the harness server asks in the
  session itself, as a form the app shows as a browser approval: the site, what the agent would do
  in plain words, and the answers on offer.

The answers are **Allow once**, **Allow for this session**, **Always allow on the site** (at the tier
asked for, which covers the tiers below it) and **Deny**. For a page the agent only opens and reads,
"always" is the first button, so trusting a site for reading is one click. A `sensitive` action is
offered only once or deny, and asks every time. Session and always grants are kept in
`harness.sqlite` and listed under Settings → Permissions → Browser access, where each can be
revoked.

The harness server owns that decision. A yes is a single-use approval id, bound to the action, the
session, the project and the inputs it was asked for, and the run route refuses a run without one
(`403 approval_required`): a used, unknown or mismatched id runs nothing. The id carries the policy's
permit, which the runner spends before the browser opens. The editor's dry run plans without a
browser; its preview is the person's own request from the editor, so the policy is asked and a
blocked site refuses it, but it does not ask again. There is no route to navigate, click, type,
submit, wait on or capture a page outside an action.

Every decision, every answer and every action is written to the browser audit (`browser_audit`) and
appended to the event log as `browser.audit`, with its session, run and task, and the evidence
artifact the action left. What the page said — its title, URL, extracts, text and screenshots — is
returned to the agent labelled as untrusted page data, not instructions.

A **scheduled** action is never asked: there is nobody to answer it. Its approval is written
down on the routine as an `allow` list and checked when the routine is saved and again before the
browser opens (see [Scheduling](#scheduling)).

## Scheduling

A scheduled action is a **Routine**, not a separate mechanism. Create a routine whose `action`
names the profile and whose `inputs` fill its declared values; the routine's `allow` list carries the
consent it needs. Each execution is a normal **Run** with one deterministic task of kind `action`,
and the harness server drives the action runner in process: no model turn, no engine session, and no
question. Because an unattended run cannot answer an approval, a browser routine without an `allow`
rule covering the profile — `origin` for `browser`, `origin:action` for `browser_sensitive` — is
refused at creation with an actionable warning, and the task asks the browser policy before the
browser opens: `browser` on an origin covers opening and reading it, `browser_sensitive` on
`origin:action` covers that one action. A blocked site fails the task whatever the rule says. Scheduled runs are headless; the window is only shown when a person starts the action
from the app. The screenshots and text log the run produces are filed under its run and task, so the
evidence travels with the run.

## Authoring one

From the app: open **Actions**, add a profile, set its origin and credential, add steps and (for a
read action) an extract. The editor validates the draft against the same schema the runner uses
before it is saved, and can preview it: the browser runs the recipe's read steps — `goto`, `waitFor`,
`assert` — and stops before the first side effect, reporting that step and everything after it as
skipped. No credential is resolved and no evidence is filed by a preview. Clicking the live page
turns the element under the point into ranked selectors, which the editor drops into the field that
has focus.

A profile is written to `flupcode.actions[id]` of a config file, and only that key is touched: the
rest of the file, comments included, is left as it was. A **global** profile goes to the first of
`opencode.jsonc`, `opencode.json`, `config.json` that exists, or to the file that already holds the
id, and a fresh install creates `opencode.jsonc`. A **project** profile goes to
`<project>/.opencode/opencode.jsonc` (or `.json` when that is what exists) and overrides a global one
of the same id while the editor or a scheduled run is looking at that project. Profiles can be
exported to your own configuration repository from **Config files**.

By hand: add the profile to the `flupcode.actions` block of an `opencode.json` / `opencode.jsonc`.
The engine carries the settings; FlupCode's plugin reads them and registers the tools on the next
engine start.

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
- The live view is a streamed screenshot sized to its panel, so the headless page fills the frame;
  takeover reveals the real window and opens it at once when the run is idle. A headed window keeps
  its own size, and Wave 1 does not forward your mouse and keyboard into the page.
- Redaction masks password and card fields and the fields the action filled. It cannot be complete;
  an unredacted capture requires explicit approval.
- A **project-scoped** profile lives in the project's `.opencode` and is available to the editor and
  to scheduled runs in that project, but not to the agent's plugin: the plugin registers tools from
  the global config alone. The editor marks a project profile as not available to the agent and can
  move it to the global config, where the plugin does read it.

## What this is not

- Not native OS control. Acting on the whole desktop is `flupcode.os`, a later, separate medium.
- Not a cloud browser and not remote control of the browser.
- Not a password manager. The vault exists only to inject a named credential into a recipe.
