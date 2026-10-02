# Security

## Threat model

FlupCode is a web, desktop and remote interface for the [OpenCode](https://github.com/anomalyco/opencode)
engine, which runs locally on your machine and gives an agent shell, file and web access.

- **No sandbox.** The engine does not sandbox the agent. Permission modes are a UX feature that asks
  before commands and edits; they are not isolation. For isolation, run the engine in a container or VM.
- **Local engine.** FlupCode runs the pinned OpenCode 2 engine on your computer. OpenCode 2 always
  asks for a password: the desktop app generates one and signs its own window in, and `flupcode serve`
  puts FlupCode's engine proxy at `http://127.0.0.1:4096`, which signs in for FlupCode's web app and
  serves a browser page only from that app's origin. Exposing the engine beyond your machine is your
  choice.
- **Harness server.** The desktop app also runs FlupCode's harness server on loopback
  (`http://127.0.0.1:4097`), which keeps runs, routines, artifacts and web-action profiles. Its
  routes ask for a bearer token the desktop app generates. The engine's plugins get a second token
  that only lists, approves and runs web actions, reads their evidence and asks the plan's hand-off:
  it cannot commit, push, write config or read anything else. Neither token is handed to the engine
  or to the commands the harness runs (external tasks, checks, git and its hooks). Both live in files
  in your FlupCode config folder, which anything running as you can read, an agent's shell included;
  moving the UI's token out of that folder is open work (AUDIT-2026-10).
- **Remote control.** Phones reach the engine through the relay over an end-to-end encrypted channel
  opened by pairing. The relay forwards encrypted traffic and cannot read it; anyone holding a paired
  device can control the paired computer, so revoke devices you no longer use.

### Out of scope

| Category | Rationale |
| --- | --- |
| Engine behavior | Report engine vulnerabilities to [OpenCode](https://github.com/anomalyco/opencode/security) |
| Access with a paired device | A paired device is meant to control the computer |
| Server access you enabled | An exposed engine server behaves as configured |
| LLM provider data handling | Data sent to your provider follows its policies |
| MCP servers and config files you add | They are outside FlupCode's trust boundary |

## Reporting a vulnerability

Please report security issues privately through GitHub's
[Report a vulnerability](https://github.com/rldona/FlupCode/security/advisories/new) form rather
than in a public issue, with steps to reproduce and the affected version. AI-generated reports
without a verified reproduction will not be reviewed.
