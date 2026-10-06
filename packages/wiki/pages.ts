/**
 * The pages of the wiki, in sidebar order. Each one is a file of the repository's `docs/` folder,
 * rendered as it is: the guides are written once, next to the code. A doc that is not listed here
 * (audits, ADRs, tickets, migration reports) is not published; a link to one goes to GitHub.
 */
export const groups = [
  {
    text: "Start",
    pages: [
      { slug: "getting-started", text: "Getting started", doc: "GETTING-STARTED.md" },
      { slug: "usage", text: "Usage", doc: "USAGE.md" },
    ],
  },
  {
    text: "Configure",
    pages: [
      { slug: "configuration", text: "Your own configuration", doc: "CONFIGURATION.md" },
      { slug: "memory", text: "Memory", doc: "MEMORY.md" },
    ],
  },
  {
    text: "Browser",
    pages: [
      { slug: "browser", text: "Your browser, through MCP", doc: "BROWSER-MCP.md" },
      { slug: "web-actions", text: "Web actions", doc: "WEB-ACTIONS.md" },
    ],
  },
  {
    text: "Adaptive",
    pages: [{ slug: "adaptive", text: "Set up Adaptive", doc: "ADAPTIVE-GUIDE.md" }],
  },
]

export const pages = groups.flatMap((group) => group.pages)

export const DOCS_ON_GITHUB = "https://github.com/rldona/FlupCode/blob/main/docs"
