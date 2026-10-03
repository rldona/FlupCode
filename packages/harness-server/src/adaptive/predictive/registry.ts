/**
 * The predictive providers the server registers (AH-C01, PI-02).
 *
 * One builder per provider. Each reads its own `adaptive.providers.<id>` settings live, declares its
 * capabilities and latency class, and returns nothing when it cannot run here, so the registry is the
 * providers this install can actually ask. `adaptive.models.<kind>` then picks one of their ids per kind.
 *
 * - The HTTP model is always built: its key comes from `keys`, never from the config block
 *   (ADR-0017), and the service only reaches it when a kind is assigned to it and its own consent lists
 *   the project and the kind, so an off install makes no call. It carries the strict per-attempt timeout,
 *   bounded retries and `Retry-After` on the live path (FH-013).
 * - `small-llm` is built only when a `small_model` resolves at startup (AH-C04). It is never assigned by
 *   default and is not wrapped in retries: every attempt is a paid throwaway session.
 */

import type { Model } from "../../policy"
import type { ProviderSettings } from "../config"
import type { EgressGuard } from "../egress"
import type { KeySlot } from "../model-key"
import { createHttpModel } from "../providers/jev"
import { createSmallLlmModel } from "../providers/small-llm"
import type { SmallLlmEngine } from "../providers/small-llm"
import type { PredictiveModel } from "./model"

export type ProviderDeps = {
  egress: EgressGuard
  /** `adaptive.providers`, read live. */
  providers: () => Record<string, ProviderSettings>
  keys: { resolve(slot: KeySlot): Promise<string | undefined> }
  /** The global `small_model`, read per call. */
  smallModel: () => Model | undefined
  /** The engine client `small-llm` asks through; only built when it is registered. */
  engine: () => SmallLlmEngine
}

const BUILDERS: ReadonlyArray<(deps: ProviderDeps) => PredictiveModel | undefined> = [
  (deps) => createHttpModel({ egress: deps.egress, providers: deps.providers, keys: deps.keys }),
  (deps) =>
    deps.smallModel()
      ? createSmallLlmModel({ engine: deps.engine(), egress: deps.egress, model: deps.smallModel })
      : undefined,
]

/** Every provider this install can ask, in registration order. */
export function createPredictiveProviders(deps: ProviderDeps): PredictiveModel[] {
  return BUILDERS.flatMap((build) => build(deps) ?? [])
}
