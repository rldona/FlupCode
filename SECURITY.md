# Security

## Threat model

FlupCode is a web, desktop and remote interface for the [OpenCode](https://github.com/anomalyco/opencode)
engine, which runs locally on your machine and gives an agent shell, file and web access.

- **No sandbox.** The engine does not sandbox the agent. Permission modes are a UX feature that asks
  before commands and edits; they are not isolation. For isolation, run the engine in a container or VM.
- **Local engine.** FlupCode talks to an engine on your computer (`http://localhost:4096` by default).
  Exposing that server beyond your machine is your choice; set `OPENCODE_SERVER_PASSWORD` if you do.
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
