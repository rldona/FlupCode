/**
 * The decision kinds the server asks (PI-02), one module each. Each has a production caller (PI-03):
 * `completion` (the episode shadow and the run auditor, RP-06), `skillRelevance` (the relevance line),
 * `contextItem` (the context manager), `failure` (the loop guardrails) and `skillReflection`
 * (learning). A new kind is a new module listed here; nothing else names it.
 */

import { completion } from "./completion"
import { contextItem } from "./context-item"
import { createDecisionRegistry } from "./define"
import { failure } from "./failure"
import { skillReflection } from "./skill-reflection"
import { skillRelevance } from "./skill-relevance"

export const BUILT_IN_DECISIONS = [completion, skillRelevance, contextItem, failure, skillReflection] as const

export const DECISIONS = createDecisionRegistry(BUILT_IN_DECISIONS)
