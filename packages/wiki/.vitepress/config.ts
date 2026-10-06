import { defineConfig } from "vitepress"
import { DOCS_ON_GITHUB, groups, pages } from "../pages"

// Served at flupcode.com/wiki: the landing rewrites that path to this site, so the build lands in
// `dist/wiki` and every URL carries the base.
export default defineConfig({
  title: "FlupCode Wiki",
  description: "Guides for FlupCode, the web and desktop app on the OpenCode 2 engine.",
  lang: "en",
  base: "/wiki/",
  outDir: "dist/wiki",
  cleanUrls: true,
  appearance: "dark",
  head: [
    ["link", { rel: "icon", href: "https://flupcode.com/assets/icon-192.png", type: "image/png" }],
    ["meta", { name: "theme-color", content: "#05060b" }],
  ],
  themeConfig: {
    siteTitle: "FlupCode Wiki",
    nav: [
      { text: "flupcode.com", link: "https://flupcode.com" },
      { text: "Open the app", link: "https://app.flupcode.com" },
    ],
    sidebar: groups.map((group) => ({
      text: group.text,
      items: group.pages.map((page) => ({ text: page.text, link: `/${page.slug}` })),
    })),
    socialLinks: [{ icon: "github", link: "https://github.com/rldona/FlupCode" }],
    search: { provider: "local" },
    outline: { level: [2, 3] },
    editLink: {
      text: "Edit this page on GitHub",
      // Runs in the browser, so it can only read the page: a doc's file name travels in its params.
      pattern: (page) =>
        `https://github.com/rldona/FlupCode/edit/main/${page.params?.doc ? `docs/${page.params.doc}` : "packages/wiki/index.md"}`,
    },
    footer: { message: "Released under the MIT License." },
  },
  markdown: {
    // The docs are plain Markdown and write placeholders as `<name>` in running text, which a Vue
    // page would read as an unclosed tag.
    html: false,
    config: (md) => {
      // The docs link to each other by file name, as GitHub reads them. Here a listed doc is a page
      // of the wiki, and any other file of `docs/` stays on GitHub.
      md.core.ruler.push("flupcode-doc-links", (state) => {
        state.tokens
          .flatMap((token) => token.children ?? [])
          .filter((token) => token.type === "link_open")
          .forEach((token) => {
            const href = token.attrGet("href") ?? ""
            if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return
            const [path = "", hash = ""] = href.split(/(?=#)/)
            const page = pages.find((entry) => entry.doc === path)
            token.attrSet("href", page ? `/${page.slug}${hash}` : `${DOCS_ON_GITHUB}/${path}${hash}`)
          })
      })
    },
  },
})
