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
    const palette = JSON.parse(localStorage.getItem("flupcode.colorTheme") || "null")
    // "default" was the neutral palette's id before it was renamed to "classic".
    const classic = palette === "classic" || palette === "default"
    document.documentElement.classList.toggle("fc-dark", dark)
    if (classic) document.documentElement.dataset.fcTheme = "classic"
    document.documentElement.style.backgroundColor = classic
      ? dark
        ? "#0f0f0f"
        : "#ffffff"
      : dark
        ? "#05060b"
        : "#ffffff"
  } catch {}
})()
