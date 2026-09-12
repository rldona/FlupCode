const nav = document.getElementById("nav")
const onScroll = () => nav?.classList.toggle("scrolled", window.scrollY > 8)
onScroll()
window.addEventListener("scroll", onScroll, { passive: true })

const toggle = document.querySelector("[data-menu-toggle]")
const links = document.querySelector(".nav-links")
toggle?.addEventListener("click", () => {
  const open = links?.classList.toggle("open") ?? false
  toggle.setAttribute("aria-expanded", String(open))
})
links?.addEventListener("click", (event) => {
  if (event.target instanceof HTMLAnchorElement) {
    links.classList.remove("open")
    toggle?.setAttribute("aria-expanded", "false")
  }
})

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const selector = button.getAttribute("data-copy")
    const source = selector ? document.querySelector(selector) : undefined
    const value = source?.textContent ?? ""
    try {
      await navigator.clipboard.writeText(value.trim())
      const previous = button.textContent
      button.textContent = "Copied"
      setTimeout(() => (button.textContent = previous), 1400)
    } catch {
      return
    }
  })
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible")
        observer.unobserve(entry.target)
      }
    }
  },
  { rootMargin: "0px 0px -10% 0px", threshold: 0.08 },
)
for (const element of document.querySelectorAll(".reveal")) observer.observe(element)

const year = document.getElementById("year")
if (year) year.textContent = String(new Date().getFullYear())
