/**
 * Features that stay visible but switched off until they work end to end. Their menu entries
 * render disabled and the command handlers ignore them, so re-enabling one is a one-line change.
 */
export const UNAVAILABLE_FEATURES = new Set(["routines", "artifacts"])
