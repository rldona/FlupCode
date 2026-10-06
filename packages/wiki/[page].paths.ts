import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { pages } from "./pages"

// One route per listed doc, its Markdown read from `docs/` as it is.
export default {
  watch: ["../../docs/*.md"],
  paths: () =>
    pages.map((page) => ({
      params: { page: page.slug, doc: page.doc },
      content: readFileSync(fileURLToPath(new URL(`../../docs/${page.doc}`, import.meta.url)), "utf8"),
    })),
}
