export * as ConfigMemory from "./memory"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.Memory")({
  /** Master switch for reading and writing memory. */
  enabled: Schema.Boolean.pipe(Schema.optional),
  /** Allow background extraction of implicit memory candidates. */
  auto: Schema.Boolean.pipe(Schema.optional),
  /** `provider/model` used for background extraction. Defaults to `small_model`. */
  model: Schema.String.pipe(Schema.optional),
  /** Maximum memories injected into one provider turn. */
  max_injected: PositiveInt.pipe(Schema.optional),
  /** Soft token budget for the injected memory block. */
  max_tokens: PositiveInt.pipe(Schema.optional),
  /** Days before an anchored memory is re-verified opportunistically. */
  stale_after_days: PositiveInt.pipe(Schema.optional),
  /** Minutes between background extraction passes for one session. */
  extract_interval: NonNegativeInt.pipe(Schema.optional),
  /** Maximum candidates one session may propose before extraction pauses. */
  max_candidates_per_session: NonNegativeInt.pipe(Schema.optional),
}) {}
