/**
 * A local site with a three-step form, for the agent's browser tool (BU-05): a name, then an email
 * and a checkbox, then a plan sent with Enter, and a page that says what arrived. Every request is
 * recorded, so a test can tell whether the browser reached the site at all. `/long` is a page taller
 * than any window, whose title says when it was scrolled.
 */
export function startFormSite() {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)
      const field = (name: string) => escape(url.searchParams.get(name) ?? "")
      const kept = (...names: string[]) =>
        names.map((name) => `<input type="hidden" name="${name}" value="${field(name)}">`).join("")
      if (url.pathname === "/")
        return page(
          "Sign up",
          `<h1>Sign up</h1>
           <form action="/contact"><label for="name">Name</label><input id="name" name="name">
           <button type="submit">Next</button></form>`,
        )
      if (url.pathname === "/contact")
        return page(
          "Contact",
          `<h1>Contact</h1><p>Hello ${field("name")}</p>
           <form action="/plan">${kept("name")}
           <label for="email">Email</label><input id="email" name="email" type="email">
           <label><input type="checkbox" name="terms"> I accept the terms</label>
           <button type="submit">Next</button></form>`,
        )
      if (url.pathname === "/plan")
        return page(
          "Plan",
          `<h1>Plan</h1>
           <form action="/done">${kept("name", "email", "terms")}
           <label for="plan">Plan</label><input id="plan" name="plan">
           <button type="submit">Finish</button></form>`,
        )
      if (url.pathname === "/done")
        return page(
          "Done",
          `<h1>Done</h1><p>name=${field("name")} email=${field("email")} terms=${field("terms")} plan=${field("plan")}</p>`,
        )
      if (url.pathname === "/long")
        return page(
          "Long",
          `<h1>Long</h1><div style="height: 5000px"></div><p>Bottom</p>
           <script>addEventListener("scroll", () => { document.title = "Long, scrolled to " + Math.round(scrollY) })</script>`,
        )
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    /** Every path asked for, with its query, oldest first. */
    requests,
    stop: () => server.stop(true),
  }
}

const page = (title: string, body: string) =>
  new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html" },
  })

const escape = (value: string) =>
  value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!)
