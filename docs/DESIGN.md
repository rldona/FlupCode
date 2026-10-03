# Design

FlupCode is where agent work is **supervised, verified and costed**. A person hands work to agents,
watches it while it runs, steps in where it waits on them, and gets back an answer that says what was
checked and what it cost. The look follows from that model and from nothing else: this document is
the brief for it (audit UX-06, principle P1), the tokens that carry it, and the rules that keep it.

## 1. The brief

### What the product is about

- **Supervised.** Work runs without the person and stops for them. Runs, workflows and routines go on
  in the background; a gate, an approval or a question brings the person back. The interface has to
  answer one question from any screen: *does anything need me?*
- **Verified.** An answer is not the same as checked work. A run ends with a verdict, and the
  interface never draws an answer nothing checked as if it were (P4): "Not verified" is a state of
  its own, with its own mark, not a quieter "Verified".
- **Costed.** Every figure has a name and a source (P11): estimated, measured, notional or unpriced,
  never added across, and a dash where nothing is known.
- **Resumable and scheduled.** Work stops, fails and picks up again; routines come back on their own.
  The unit the interface is organised around is the **Run**, not the chat and not a rail of tools.

### What that means for the look

1. **The canvas is quiet so that state can speak.** Surfaces are near-monochrome with hairline
   borders. Colour is spent on state — success, warning, danger, and the accent for what needs the
   person — and on the person's own content. A colour that only decorates competes with a gate.
2. **Attention has one scale.** Waiting for approval, waiting for input, failed, not verified,
   running: one order, one set of words (`attention.ts`, `AttentionMark`), the same on a session row,
   a run card and the Runs entry in the sidebar. The loudest thing on screen is whatever waits on
   the person.
3. **Marks say what was proven.** A verdict is a badge (`StateBadge`); an unverified one is an
   outline. A cost is a `CostFigure` with its lens; an unknown one is a dash with a reason. No
   control claims a state the system has not confirmed: "Stopped" means the engine stopped.
4. **Numbers are evidence.** Figures are set in tabular numerals, with their unit and their basis
   one click away. A number without a name is not shown.
5. **One concept, one word, one mark** (P5). A concept has one icon everywhere: Runs is the same mark
   in the sidebar and in the search; a fork is the same mark in the session menu and on a message.
6. **Motion shows a change of state, nothing else.** Two durations and one easing (§3); loops only
   for work in progress; still under reduced motion.
7. **Dense where the work is, open where it is read.** Lists, cards and controls use the small steps
   of the type scale; the transcript reads in a serif at its own size, and a screen's title grows
   with the window.

### What it is not

Not a chat app with extras: a transcript is one surface of the work, not the product. Not an editor, a git client or an
extension platform (P13). Not a dashboard of every number the engine has: usage is shown where it
answers a question about the work. FlupCode's identity does not come from resembling or contrasting
with any other product; where this brief and an existing screen disagree, the screen changes.

## 2. Layout

Four regions: the **sidebar** (navigation, projects and their sessions), the **canvas** (a screen —
home, Runs, Workflows, Artifacts, Routines — or a session's transcript), the **composer dock**
anchored under the transcript, and the **context panel** on the right for what the open work is
touching (changes, files, terminal, agent browser). On a phone the sidebar is a sheet and the dock is
the phone composer; a phone controlling a computer has its own home (the phone remote, §3 Type).

## 3. Design tokens

Tokens are CSS custom properties under `--fc-*` in `packages/harness/src/styles/tokens.css`. The app
renders no upstream UI components, so a palette change re-skins all of it.

### Colour (the default FlupCode palette)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--fc-bg` | `#ffffff` | `#05060b` | App background |
| `--fc-bg-elevated` | `#ffffff` | `#0f121b` | Cards, popovers, dialogs |
| `--fc-sidebar` | `#f5f6fb` | `#0a0c14` | Sidebar surface |
| `--fc-border` | `#e2e6f0` | `#1f2436` | Hairline borders |
| `--fc-text` | `#12142a` | `#eef0f7` | Primary text |
| `--fc-text-muted` | `#5b6075` | `#8e94ab` | Secondary text, focus ring |
| `--fc-accent` | `#3563d6` | `#5b8cff` | What needs the person; links; the picked option's edge |
| `--fc-accent-soft` | `#e8edfb` | `#16223f` | The picked option's background |
| `--fc-success` | `#0f7a4a` | `#7ee2a8` | Verified, passed |
| `--fc-warning` | `#8a5a00` | `#f5b80c` | Waiting, not verified, estimated |
| `--fc-danger` | `#b42318` | `#f19a90` | Failed, destructive |
| `--fc-merged` | `#8250df` | `#a371f7` | A merged pull request |
| `--fc-syn-*` | | | Code: comment, string, number, keyword, constant |

### Shape & space

| Token | Value |
| --- | --- |
| `--fc-radius-sm` | `8px` |
| `--fc-radius-md` | `12px` |
| `--fc-radius-lg` | `16px` |
| `--fc-radius-pill` | `9999px` |
| `--fc-space-1..6` | `4 / 8 / 12 / 16 / 24 / 32px` |
| `--fc-control-sm` | `28px` (compact) |
| `--fc-control-md` | `36px` (default) |
| `--fc-control-lg` | `44px` (composer) |

### Type

| Token | Value |
| --- | --- |
| `--fc-font-ui` | Roboto (bundled), every text but the ones below |
| `--fc-font-chat` | Source Serif 4 (bundled), message bodies in the transcript |
| `--fc-font-brand` | Nunito Sans (bundled), the FlupCode name and the home greeting |
| `--fc-font-mono` | the system's monospace |
| `--fc-text-2xs, xs, sm, base, md, lg, xl, 2xl, 3xl, 4xl, display` | `10 / 11 / 12 / 13 / 14 / 16 / 18 / 20 / 26 / 32 / 40` px |
| `--fc-text-chat` | `17px`, the transcript's body, an optical match for the serif |
| `--fc-text-title` | `clamp(24px, 3vw, 34px)`, a screen's own title |
| `--fc-text-smaller` | `0.9em`, a run one step smaller than its line, such as inline code |
| `--fc-text-h1..h3` | a rendered message's headings: `2xl`, `xl`, `lg` |
| Weight | `400` body, `500` labels, `600` headings |

The dense interface reads at `sm` and `base`; `md` is a body line; `lg` and up are titles. Every font
size in the stylesheets is one of these tokens — none is written in pixels — and the canvas-drawn
terminal reads them too. The **phone remote** (`.fc-mobile-remote`, in `tokens.css`) sets the same
names to larger values, so every component that uses a token follows it.

### Icons

One set, in `packages/harness/src/components/Icon.tsx`: SVG on a 24-unit grid, a round 2-unit stroke
(1.8 in the composer dock) in `currentColor`, so an icon takes the colour of its text and reads the
same in every palette. Without a size an icon is `1em`, the size of the line it sits in. An icon is
hidden from assistive technology unless it stands alone and says something, in which case it gets a
`label`.

An icon is never a Unicode glyph (`× ▾ ✓ ⚙ ↻`…): a glyph comes from whichever font the system picks,
at that font's size and weight, so the same character draws differently on every machine. Arrows
inside running text ("plan → build") and the names of keys (`⌘K`, a `<kbd>`) are text, not icons.

### Code

One highlighter: the transcript's Shiki worker (`src/markdown`). A code block in a message, a file,
a diff and a tool's output are coloured by the same grammar and the same `--syntax-*` colours, mapped
onto `--fc-syn-*` (`styles/markdown.css`); everything outside the worker asks it through
`markdown/code-lines.ts`.

### Elevation & motion

- Elevation: none, or a single soft shadow on what floats (menus, dialogs); prefer borders.
- Motion: `--fc-duration-short` (`120ms`) for a change in place — a hover, a press, a chevron;
  `--fc-duration-long` (`200ms`) for something arriving or leaving — a dialog, a menu, a panel;
  `--fc-ease` (`cubic-bezier(0.2, 0, 0, 1)`) for both; `--fc-duration-loop` for the marks that say
  "working". Under `prefers-reduced-motion` all of them are zero, set in one place.

### Keeping it

`src/tokens.test.ts` checks that nothing drifts:

- a `var(--fc-…)` used without a fallback has to be a token that exists — an invented one silently
  leaves the property at its initial value, which is how `--fc-radius-2`, `--fc-radius-3`,
  `--fc-surface` and `--fc-control-h` gave thirty-two rules square corners and controls with no
  height;
- a radius the system has a name for is not written in pixels;
- every palette sets every colour, or the light one wins in dark mode;
- no stylesheet or component writes a duration or a curve (UX-03);
- no stylesheet or component writes a font size, and the scale is the one above (UX-06);
- no glyph stands in for an icon, in a component or in a stylesheet's `content` (UX-06).

`src/markdown/code-lines.test.ts` checks that only the markdown worker loads a highlighter.

## 4. Component inventory

The shared pieces a screen is built from, in `packages/harness/src/components`:

- **Structure**: `Modal` (every dialog), `ContextMenu` (every menu at a point), `PanelBoundary` (a
  panel that fails alone), `Segmented`, `Toggle`.
- **State**: `AttentionMark` (the attention scale), `StateBadge` (a run's verdict or status),
  `CostFigure` and `BudgetMeter` (cost, by lens), `Loader` and skeletons, toasts.
- **Marks**: `Icon` (the one icon set).
- **Code**: `Markdown` (messages), `FileDiff`, the files panel, through the one highlighter.

## 5. Accessibility

- Minimum contrast 4.5:1 for body text, 3:1 for large text and UI borders.
- Full keyboard operability; visible focus rings using `--fc-focus-border` (the secondary text grey,
  which every palette keeps at 4.5:1 on its canvas, so the ring clears 3:1).
- Hit targets ≥ `32px`.
- State is conveyed by a word and a shape as well as a colour: an attention level has its label, a
  verdict its badge, an unverified run an outline.

`src/tokens.test.ts` checks the colour half in every palette, light and dark: `--fc-text`,
`--fc-text-muted`, `--fc-success`, `--fc-warning` and `--fc-danger` at 4.5:1 on `--fc-bg` and
`--fc-bg-elevated`, text at 4.5:1 on `--fc-accent-soft`, and the accent at 3:1. A palette that fails
is fixed at the token, not worked around in one component.

### Patterns

- **A single choice among a few** (a level, a capability's state) is `Segmented`: a `radiogroup`
  with one Tab stop, arrows and Home/End over the options that can be picked, and Space/Enter to
  pick. Focus alone never picks, because a pick writes config. An option that cannot be picked is
  `aria-disabled`, still read out and focusable. The picked one is text on `--fc-accent-soft` with an
  accent edge, never white on the accent (2.7–3.2:1 in four dark palettes).
- **A dialog** takes the focus on open (`holdModalFocus`, the dialog itself with `tabIndex={-1}`),
  hands it back to its opener (or the row it is about) on close, and is described by its message.
  Escape and the Tab loop are the app's, for every dialog. Enter confirms only on the dialog itself;
  on a button it presses that button.
- **An answer that arrives later** (a save, a pause, a loop warning) is announced by a live region
  that is always mounted and only changes its text.
- **Copy** says the consequence in the reader's words. The adaptive surfaces never show the internal
  names from the audit's table (§7.4): "Predictive model", not Jev; "Observe only", not shadow;
  "Data shared with the predictive model", not egress; "Which skills fit", not `skillRelevance`;
  "Built-in rules were used (reason)", not degraded. `src/i18n.test.ts` fails on them, and on a string
  of those screens with no Spanish translation.

## 6. Theming

Theming has two independent axes, both applied to `<html>`:

- **Mode** (light/dark/system) is the `.fc-dark` class, stored under `flupcode.theme`.
- **Palette** is the `data-fc-theme` attribute, stored under `flupcode.colorTheme`. The FlupCode
  palette (navy and blue, shared with `packages/landing/styles.css`) is the default and has no
  attribute. The others are alternatives a person can pick, not the product's look: `classic`
  (neutral grey and blue), `sublime` (dark grey) and its deeper, dark-only `sublime-dark`, `github`
  (a light/dark pair), `copilot` (neutral graphite), `code` (a neutral editor pair) and `vercel`
  (black, dark-only).

Each palette normally defines a light and a dark variant (`.fc-dark`), so the two axes multiply.
Palette blocks in `tokens.css` come after `.fc-dark` and must be overridden by a
`[data-fc-theme="…"].fc-dark` block for every token they set. `sublime-dark` and `vercel` are
dark-only: their one block overrides `.fc-dark` in both modes, so they need no
`[data-fc-theme="…"].fc-dark` counterpart.

Settings exposes both axes: **Mode** and **Theme**. `index.html` applies the saved pair before the
first paint to avoid a flash, so its background colours are duplicated there by design and must stay
in sync with `--fc-bg`.
