# ADR-0009: Engine API layer uses the SDK v2 client

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

The harness originally talked to the engine through OpenCode's vendored client
(`@opencode-ai/client`, `1.17.13`). The engine is `1.18.30`, and the surface drifted:

- `POST /api/session/:id/prompt` now requires `{ prompt: { text } }`; the vendored client sent
  `{ text }`, so every prompt failed with `InvalidRequestError`.
- The `project` and `mcp` groups were removed from the HTTP API.
- Model records switched from `modelID` to `id`, and the default-model endpoint disappeared.

The result: the UI rendered but could not complete a model turn.

Upstream's own app avoids this by using `@opencode-ai/sdk/v2/client` (generated from the server
OpenAPI) for request/response calls, reserving the vendored client for the event stream.

## Decision

- Use `@opencode-ai/sdk/v2/client` for all request/response engine calls.
- Keep a thin adapter (`packages/harness/src/client.ts`) that maps the SDK's generated groups,
  unwraps its result envelopes, and exposes the small surface the harness needs.
- Reach the live event stream over `fetch` + SSE directly (`GET /api/event`), independent of the
  generated client, and refetch session/message state on relevant events.
- Re-export SDK types under harness-facing names in `src/engine-types.ts`.
- Remove the vendored `@opencode-ai/client` dependency from the harness.

## Consequences

- Prompts complete end to end; models, agents, commands, skills, permissions, questions, files,
  revert and session lifecycle all use the current API.
- Historical sessions created before the v2 message projection existed have no rows in
  `session_message`, so their messages are read from the legacy route and normalized for rendering.
- Projects are derived from session locations instead of the removed `project` group.
- MCP configuration is unavailable until the engine exposes it again (tracked as blocked).
- Session rename/delete/fork/shell use the still-served v1 routes; session move and skill execution
  are not supported by the current API.
