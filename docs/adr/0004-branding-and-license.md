# ADR-0004: Branding and license

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

OpenHarness is a public fork of OpenCode (MIT). It is inspired by Anthropic's Claude Code desktop
app but is not built by or affiliated with OpenCode or Anthropic. We need a clear product identity
without violating the upstream license or implying endorsement.

## Decision

- Product name: **OpenHarness**; repository `rldona/OpenHarness`.
- Preserve the upstream MIT `LICENSE` and copyright notices.
- State prominently in the README that OpenHarness is an independent fork, **not affiliated with
  OpenCode (Anomaly) or Anthropic**.
- Rebrand only our own surfaces (harness app name, icon, about, installers). Do not strip upstream
  notices from reused code.
- Do not use upstream trademarks as our product identity.

## Consequences

- Clear legal footing and honest attribution.
- Some upstream branding remains in untouched packages, which is expected and acceptable.
- Marketing/README copy must repeat the non-affiliation notice.
