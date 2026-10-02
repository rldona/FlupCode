/**
 * Reading the routines the harness server sends, for the routines screen.
 *
 * Pure helpers, kept out of `app.tsx` so they can be tested without mounting the app (that file
 * pulls the markdown worker, which a unit test cannot import).
 */

import { t } from "./i18n"
import { normalizeRoutineSchedule } from "./routine-schedule"
import type { ActionTaskInput, BrowserAllowRule, Routine, RoutineRun } from "./types"

const normalizeAction = (value: unknown): ActionTaskInput | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || !record.id.trim()) return undefined
  const inputs =
    record.inputs && typeof record.inputs === "object" && !Array.isArray(record.inputs)
      ? (record.inputs as Record<string, unknown>)
      : undefined
  return { id: record.id.trim(), ...(inputs ? { inputs } : {}) }
}

const normalizeAllow = (value: unknown): BrowserAllowRule[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const rules = value.flatMap((entry): BrowserAllowRule[] => {
    if (!entry || typeof entry !== "object") return []
    const rule = entry as { permission?: unknown; pattern?: unknown; action?: unknown }
    if (rule.action !== "allow") return []
    if (rule.permission !== "browser" && rule.permission !== "browser_sensitive") return []
    if (typeof rule.pattern !== "string" || !rule.pattern) return []
    return [{ permission: rule.permission, pattern: rule.pattern, action: "allow" }]
  })
  return rules.length > 0 ? rules : undefined
}

export const normalizeRoutine = (value: unknown): Routine | undefined => {
  if (!value || typeof value !== "object") return undefined
  const item = value as Record<string, unknown>
  if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.prompt !== "string") return undefined
  const legacyInterval =
    typeof item.intervalMinutes === "number" && Number.isFinite(item.intervalMinutes) && item.intervalMinutes > 0
      ? Math.max(1, Math.round(item.intervalMinutes))
      : 60
  const schedule = normalizeRoutineSchedule(item.schedule, legacyInterval)
  const rawModel = item.model
  const model =
    rawModel && typeof rawModel === "object" && "providerID" in rawModel && "id" in rawModel &&
    typeof rawModel.providerID === "string" && typeof rawModel.id === "string"
      ? {
          providerID: rawModel.providerID,
          id: rawModel.id,
          variant: "variant" in rawModel && typeof rawModel.variant === "string" ? rawModel.variant : undefined,
        }
      : undefined
  const runs = Array.isArray(item.runs)
    ? item.runs.flatMap((run) => {
        if (!run || typeof run !== "object") return []
        const entry = run as Record<string, unknown>
        if (typeof entry.id !== "string" || typeof entry.startedAt !== "number") return []
        const status =
          entry.status === "running" || entry.status === "awaiting" || entry.status === "success" ||
          entry.status === "failed" || entry.status === "stopped"
            ? entry.status
            : "failed"
        return [
          {
            id: entry.id,
            sessionID: typeof entry.sessionID === "string" ? entry.sessionID : undefined,
            status,
            startedAt: entry.startedAt,
            finishedAt: typeof entry.finishedAt === "number" ? entry.finishedAt : undefined,
            error:
              typeof entry.error === "string"
                ? entry.error
                : status === "failed"
                  ? t("Run interrupted")
                  : undefined,
            // How it was judged (RP-06), which decides what a finished run needs (UX-02).
            verdict: runVerdictOf(entry.verdict),
          } satisfies RoutineRun,
        ]
      })
    : []
  return {
    id: item.id,
    name: item.name,
    description: typeof item.description === "string" ? item.description : "",
    prompt: item.prompt,
    schedule,
    projectDirectory: typeof item.projectDirectory === "string" ? item.projectDirectory : undefined,
    agent: typeof item.agent === "string" ? item.agent : undefined,
    model,
    workflow:
      item.workflow && typeof item.workflow === "object" && "name" in item.workflow &&
      typeof (item.workflow as { name: unknown }).name === "string" &&
      (item.workflow as { name: string }).name.trim()
        ? {
            name: (item.workflow as { name: string }).name.trim(),
            inputs: (item.workflow as { inputs?: unknown }).inputs as Record<string, string> | undefined,
          }
        : undefined,
    policy: (item.policy ?? undefined) as Routine["policy"],
    action: normalizeAction(item.action),
    allow: normalizeAllow(item.allow),
    enabled: item.enabled !== false,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
    lastRunAt: typeof item.lastRunAt === "number" ? item.lastRunAt : undefined,
    runs,
  }
}

export const normalizeRoutines = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const routine = normalizeRoutine(item)
        return routine ? [routine] : []
      })
    : []

const VERDICTS = ["verified", "unverified", "needs-user", "failed"] as const

/** A run's verdict as the server sent it, or nothing when it is not one this build knows. */
function runVerdictOf(value: unknown): RoutineRun["verdict"] {
  if (!value || typeof value !== "object") return undefined
  const verdict = value as Record<string, unknown>
  const known = VERDICTS.find((entry) => entry === verdict.value)
  if (!known || typeof verdict.taskID !== "string") return undefined
  return {
    value: known,
    reason: typeof verdict.reason === "string" ? verdict.reason : "",
    source: verdict.source === "check" || verdict.source === "model" ? verdict.source : "rule",
    taskID: verdict.taskID,
  }
}
