import { Show, type Component } from "solid-js"

/**
 * FlupCode's one icon set (UX-06, docs/DESIGN.md "Icons").
 *
 * Every icon is drawn on a 24-unit grid with a round stroke in `currentColor`, so it takes the
 * colour of the text around it and reads the same in every palette. An icon is never a Unicode
 * glyph: a glyph comes from whichever font the system picks, at that font's size and weight, and
 * the same character looks different on every machine (`tokens.test.ts` fails on one).
 *
 * A shape is either a stroked path, or `{ stroke, fill }` when part of it is solid.
 */
export const ICONS = {
  // Actions
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6 6 18",
  check: "M20 6 9 17l-5-5",
  pencil: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4",
  copy: "M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM5 15V6a2 2 0 0 1 2-2h9",
  retry: "M4 10a8 8 0 1 1 2.3 5.7M4 20v-5h5",
  fork: "M7 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5ZM7 16.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5ZM17 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5ZM7 7.5v9M9.4 12h5.1",
  "zoom-in": "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13ZM15.5 15.5l4 4M10.5 7.5v6M7.5 10.5h6",
  open: "M7 17 17 7M8 7h9v9",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  compact: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  split: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM12 4v16",
  archive: "M4 4h16a1 1 0 0 1 1 1v3H3V5a1 1 0 0 1 1-1ZM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4",
  tag: "M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9ZM7.5 7.5h.01",
  more: {
    fill: "M10.4 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M3.4 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M17.4 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0",
  },
  "more-vertical": {
    fill: "M10.4 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M10.4 5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M10.4 19a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0",
  },
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z",
  "star-filled": { fill: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z" },

  // Direction
  "chevron-down": "m6 9 6 6 6-6",
  "chevron-up": "m18 15-6-6-6 6",
  "chevron-right": "m9 6 6 6-6 6",
  "chevron-left": "m15 18-6-6 6-6",
  "arrow-left": "M19 12H5M11 6l-6 6 6 6",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
  "arrow-up": "M12 19V5M6 11l6-6 6 6",

  // State
  warning: "M12 4 2.8 19.5a.5.5 0 0 0 .4.5h17.6a.5.5 0 0 0 .4-.5ZM12 10v4M12 17h.01",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18ZM12 7v5l3 2",
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4ZM10 21h4",
  loader: "M12 3a9 9 0 1 0 9 9",
  circle: "M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14Z",
  question: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5v.7M12 17h.01",
  "circle-half": { stroke: "M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14Z", fill: "M12 5a7 7 0 0 1 0 14Z" },
  play: { fill: "M8 5.5v13l10-6.5Z" },
  sparkle: "M12 3c.6 4.6 2.4 6.4 8 9-5.6 2.6-7.4 4.4-8 9-.6-4.6-2.4-6.4-8-9 5.6-2.6 7.4-4.4 8-9Z",

  // Places and things
  runs: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18ZM10 8.5v7l5.5-3.5Z",
  workflow:
    "M5 3h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM15 15h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1ZM7 9v4a4 4 0 0 0 4 4h3",
  attachment: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5M9 13h6M9 17h4",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  command: "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3",
  settings: {
    stroke:
      "M18.5 9.6 21.2 10.1 21.2 13.9 18.5 14.4 18.3 14.8 19.8 17.2 17.2 19.8 14.8 18.3 14.4 18.5 13.9 21.2 10.1 21.2 9.6 18.5 9.2 18.3 6.8 19.8 4.2 17.2 5.7 14.8 5.5 14.4 2.8 13.9 2.8 10.1 5.5 9.6 5.7 9.2 4.2 6.8 6.8 4.2 9.2 5.7 9.6 5.5 10.1 2.8 13.9 2.8 14.4 5.5 14.8 5.7 17.2 4.2 19.8 6.8 18.3 9.2ZM12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z",
  },
  key: "M8 11a4 4 0 1 0 0 8 4 4 0 1 0 0-8ZM10.8 12.2 20 3M17 6l2.5 2.5M14.5 8.5l2 2",
  decision: "M12 3l9 9-9 9-9-9Z",
  memory: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18ZM12 11v5M12 8h.01",
  chart: "M4 20h16M7 16v-5M12 16V6M17 16V9",
  remote: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 18h2",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  search: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13ZM16 16l4.5 4.5",
  sidebar: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 4v16",
  // The left sidebar's icon, mirrored.
  "context-panel": "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM15 4v16",
  preview: "M3 5h18v14H3zM3 9h18M6 7h.01M9 7h.01",
  eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6ZM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5Z",
  terminal: "m5 7 5 5-5 5M12 18h7",
  chat: "M7 17.5 3.5 20V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2Z",
  code: "m9 8-4 4 4 4M15 8l4 4-4 4",
  clip: "M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6",
  slash: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM14 8l-4 8",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  image: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15.5 9.5h.01",
  upload: "M14 3H6v18h12V7zM14 3v4h4M12 17v-6M9 14l3-3 3 3",
  stop: "M8 8h8v8H8z",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7Z",
  shield: "M12 3l8 4v6c0 4-3.5 7-8 8-4.5-1-8-4-8-8V7Z",
  lines: "M4 6h16M4 12h16M4 18h10",
  history: "M12 7v5l3 2M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  hammer:
    "M15 12l-8.373 8.373a1 1 0 1 1-3-3L12 9M18 15l4-4M21.5 11.5l-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5",
  bulb: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  robot:
    "M12 8V4H8M9 13v2M15 13v2M2 14h2M20 14h2M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z",
  learn: "M3 9l9-5 9 5-9 5-9-5ZM7 11.5V16c0 1.5 2.2 3 5 3s5-1.5 5-3v-4.5",
  ideas: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z",
  globe:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z",
} satisfies Record<string, string | { stroke?: string; fill?: string }>

export type IconName = keyof typeof ICONS

/**
 * One icon. Without a size it is `1em` square, so it sits in a line of text at that text's size —
 * the size the glyph it replaced had — and a rule that sets the font size sets the icon's too.
 *
 * It is hidden from assistive technology unless it has a `label`: most sit next to words that say
 * the same thing, and the ones that stand alone are inside a button that has its own name.
 */
export const Icon: Component<{ name: IconName; size?: number; weight?: number; class?: string; label?: string }> = (
  props,
) => {
  const shape = () => {
    const value: string | { stroke?: string; fill?: string } = ICONS[props.name]
    return typeof value === "string" ? { stroke: value, fill: undefined } : value
  }
  return (
    <svg
      class={props.class ? `fc-icon ${props.class}` : "fc-icon"}
      viewBox="0 0 24 24"
      width={props.size ?? "1em"}
      height={props.size ?? "1em"}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <Show when={shape().fill}>{(fill) => <path d={fill()} fill="currentColor" />}</Show>
      <Show when={shape().stroke}>
        {(stroke) => (
          <path
            d={stroke()}
            fill="none"
            stroke="currentColor"
            stroke-width={props.weight ?? 2}
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        )}
      </Show>
    </svg>
  )
}
