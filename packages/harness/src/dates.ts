import { getLocale } from "./i18n"

/**
 * A date and time the way the app shows them everywhere: `Lun 28 sept 13:03`.
 *
 * Short weekday, day, short month and time, no year — the year is noise beside a session or an
 * artifact that is hours old, and the reader can ask the tooltip when they need it. The parts come
 * from `Intl` in the app's own locale, so English reads `Mon 28 Sep 13:03`.
 */
export function formatDateTime(value: number): string {
  const date = new Date(value)
  const locale = getLocale()
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date)
  const day = new Intl.DateTimeFormat(locale, { day: "numeric" }).format(date)
  const month = new Intl.DateTimeFormat(locale, { month: "short" }).format(date)
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${day} ${month} ${time}`
}
