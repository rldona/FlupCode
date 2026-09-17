// Apply the saved mode and palette before the first paint. They are otherwise applied when the
// app mounts, so the white fallback background flashes on reload, clearly visible in Electron.
// Keep these colours in sync with the `--fc-bg` values in styles/tokens.css.
//
// A file rather than an inline block: the hosted app is served under `script-src 'self'`,
// which blocks inline script. Inline, this never ran there — the flash it exists to prevent
// was back, and every load logged a CSP violation.
;(() => {
  try {
    const stored = JSON.parse(localStorage.getItem("flupcode.theme") || "null")
    const mode = stored === "dark" || stored === "light" ? stored : "system"
    const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
    const saved = JSON.parse(localStorage.getItem("flupcode.colorTheme") || "null")
    // "default" was the neutral palette's id before it was renamed to "classic". Anything unknown
    // falls back to the FlupCode palette, which is the default and needs no attribute.
    const palette =
      {
        classic: "classic",
        default: "classic",
        sublime: "sublime",
        "sublime-dark": "sublime-dark",
        github: "github",
        copilot: "copilot",
      }[saved] ?? "flupcode"
    document.documentElement.classList.toggle("fc-dark", dark)
    if (palette !== "flupcode") document.documentElement.dataset.fcTheme = palette
    const backgrounds = {
      flupcode: { light: "#ffffff", dark: "#05060b" },
      classic: { light: "#ffffff", dark: "#0f0f0f" },
      sublime: { light: "#f4f4f4", dark: "#21252b" },
      // Dark-only: the same colour in both modes.
      "sublime-dark": { light: "#17191e", dark: "#17191e" },
      github: { light: "#ffffff", dark: "#0d1117" },
      copilot: { light: "#ffffff", dark: "#111114" },
    }
    document.documentElement.style.backgroundColor = backgrounds[palette][dark ? "dark" : "light"]
  } catch {}
})()
