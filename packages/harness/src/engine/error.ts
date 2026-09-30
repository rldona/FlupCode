/**
 * A failed engine call, keeping the error's `_tag`. The app needs the tag, not just the message, to
 * tell a session the engine no longer has (`SessionNotFoundError`) from the engine being unreachable:
 * one means drop the stale session, the other means say the truth and leave it in place.
 */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly tag?: string,
  ) {
    super(message)
    this.name = "EngineError"
  }
}

export function isSessionGone(cause: unknown) {
  return cause instanceof EngineError && cause.tag === "SessionNotFoundError"
}

/** A call the connected engine has no equivalent for, named so the app can say so instead of failing. */
export function unsupported(feature: string): never {
  throw new EngineError(`This engine does not support ${feature}`, "UnsupportedByEngine")
}
