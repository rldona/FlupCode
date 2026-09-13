import { t } from "./i18n"

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
}

/** A readable name for an effort variant id (`xhigh` → "Extra"). */
export const effortLabel = (id: string) =>
  EFFORT_LABELS[id] ? t(EFFORT_LABELS[id]!) : id.charAt(0).toUpperCase() + id.slice(1)
