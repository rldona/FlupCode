;(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => [...r.querySelectorAll(s)]

  const STR = {
    placeholder: "Describe a task or ask a question",
    prompt: "Move the provider panel into a dialog and add a search field.",
    thinking: "Reading the panel and its tests",
    run: "runs",
    ask: "asks you",
  }

  /* nav */
  const nav = $("#nav")
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 24)
  $("#year").textContent = new Date().getFullYear()
  onScroll()
  addEventListener("scroll", onScroll, { passive: true })

  /* quick start tabs */
  const quick = $("#quick")
  $$("[role=tab]", quick).forEach((t) =>
    t.addEventListener("click", () => {
      $$("[role=tab]", quick).forEach((x) => x.setAttribute("aria-selected", x === t))
      $$(".quick-body", quick).forEach((p) => p.classList.toggle("on", p.dataset.panel === t.dataset.tab))
    }),
  )
  $$("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($(b.dataset.copy).textContent.trim())
        const p = b.textContent
        b.textContent = "Copied"
        setTimeout(() => (b.textContent = p), 1400)
      } catch {}
    }),
  )

  /* reveal */
  const io = new IntersectionObserver(
    (es) =>
      es.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("play")
          io.unobserve(e.target)
        }
      }),
    { rootMargin: "0px 0px -8% 0px", threshold: 0.1 },
  )
  $$(".reveal").forEach((el) => io.observe(el))

  /* ---------- aurora ---------- */
  const aurora = $("#aurora")
  const ctx = aurora.getContext("2d")
  const off = document.createElement("canvas")
  const octx = off.getContext("2d")
  let W = 0,
    H = 0,
    mx = 0.5,
    my = 0.4,
    tmx = 0.5,
    tmy = 0.4
  const ribbons = [
    { c: "#f0603a", a: 0.3, y: 0.42, amp: 0.1, f: 1.3, s: 0.00022, w: 0.34 },
    { c: "#c6472a", a: 0.24, y: 0.52, amp: 0.13, f: 0.9, s: 0.00017, w: 0.28 },
    { c: "#e0a24a", a: 0.18, y: 0.34, amp: 0.08, f: 1.7, s: 0.00028, w: 0.22 },
    { c: "#7c2d12", a: 0.12, y: 0.62, amp: 0.11, f: 1.1, s: 0.00013, w: 0.24 },
  ]
  function size() {
    const r = aurora.getBoundingClientRect()
    W = Math.max(1, r.width | 0)
    H = Math.max(1, r.height | 0)
    aurora.width = W
    aurora.height = H
    off.width = Math.max(160, (W / 6) | 0)
    off.height = Math.max(100, (H / 6) | 0)
  }
  function drawAurora(t) {
    const w = off.width,
      h = off.height
    mx += (tmx - mx) * 0.03
    my += (tmy - my) * 0.03
    octx.globalCompositeOperation = "source-over"
    octx.fillStyle = "#050505"
    octx.fillRect(0, 0, w, h)
    octx.globalCompositeOperation = "lighter"
    ribbons.forEach((r, i) => {
      octx.beginPath()
      const dx = (mx - 0.5) * 40 * (i % 2 ? -1 : 1),
        dy = (my - 0.5) * 26
      for (let x = -10; x <= w + 10; x += 6) {
        const u = x / w
        const y =
          h * r.y +
          dy +
          Math.sin(u * Math.PI * r.f + t * r.s) * h * r.amp +
          Math.sin(u * Math.PI * 3.1 + t * r.s * 1.7 + i) * h * 0.03
        x === -10 ? octx.moveTo(x + dx, y) : octx.lineTo(x + dx, y)
      }
      octx.lineCap = "round"
      octx.lineWidth = h * r.w
      octx.strokeStyle = r.c
      octx.globalAlpha = r.a
      octx.stroke()
    })
    octx.globalAlpha = 1
    // dark vignette at the top so the nav stays legible
    const g = octx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, "rgba(5,5,5,.9)")
    g.addColorStop(0.35, "rgba(5,5,5,.15)")
    g.addColorStop(1, "rgba(5,5,5,0)")
    octx.globalCompositeOperation = "source-over"
    octx.fillStyle = g
    octx.fillRect(0, 0, w, h)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(off, 0, 0, W, H)
  }
  /* ---------- stars ---------- */
  function starfield(canvas, count, drift, parallax) {
    const c = canvas.getContext("2d")
    let pts = [],
      w = 0,
      h = 0
    const sz = () => {
      const r = canvas.getBoundingClientRect()
      w = canvas.width = r.width | 0
      h = canvas.height = r.height | 0
      pts = Array.from({ length: count }, () => {
        const big = Math.random() < 0.18
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          r: big ? Math.random() * 1.4 + 1.4 : Math.random() * 1 + 0.5,
          p: Math.random() * 6.28,
          v: Math.random() * 0.7 + 0.25,
          d: Math.random() * 0.7 + 0.3,
          big,
        }
      })
    }
    sz()
    addEventListener("resize", sz)
    return (t) => {
      c.clearRect(0, 0, w, h)
      const ox = parallax ? (mx - 0.5) * -parallax : 0,
        oy = parallax ? (my - 0.5) * -parallax * 0.6 : 0
      for (const p of pts) {
        const tw = 0.45 + 0.55 * Math.abs(Math.sin(t * 0.0014 * p.v + p.p))
        const x = p.x + ox * p.d,
          y = ((((p.y - t * drift * p.v) % h) + h) % h) + oy * p.d
        if (p.big) {
          c.globalAlpha = tw * 0.35
          c.fillStyle = "#e5e5e5"
          c.beginPath()
          c.arc(x, y, p.r * 3, 0, 6.28)
          c.fill()
        }
        c.globalAlpha = tw
        c.fillStyle = p.big ? "#ffffff" : "#ffffff"
        c.beginPath()
        c.arc(x, y, p.r, 0, 6.28)
        c.fill()
      }
      c.globalAlpha = 1
    }
  }
  const s1 = starfield($("#stars"), 170, 0.004, 28),
    s2 = starfield($("#stars2"), 180, 0.006, 0)
  size()
  addEventListener("resize", size)
  addEventListener(
    "pointermove",
    (e) => {
      tmx = e.clientX / innerWidth
      tmy = e.clientY / innerHeight
    },
    { passive: true },
  )
  let last = 0
  function loop(t) {
    if (!reduce || t - last === 0) {
      drawAurora(t)
      s1(t)
      s2(t)
    }
    last = t
    if (!reduce) requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)

  /* ---------- frame tilt on scroll ---------- */
  const frame = $("#frame")
  function tilt() {
    if (reduce) return
    const r = frame.getBoundingClientRect()
    const p = Math.min(1, Math.max(0, 1 - (r.top - innerHeight * 0.15) / (innerHeight * 0.55)))
    const e = 1 - Math.pow(1 - p, 3)
    frame.style.transform = `rotateX(${(1 - e) * 12}deg) translateY(${(1 - e) * 10}px) scale(${0.96 + e * 0.04})`
  }
  tilt()
  addEventListener("scroll", tilt, { passive: true })
  addEventListener("resize", tilt)

  /* ---------- living session demo ---------- */
  const thread = $("#thread"),
    composer = $("#composer"),
    modeChip = $("#mode-chip")
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const el = (html) => {
    const d = document.createElement("div")
    d.innerHTML = html.trim()
    return d.firstElementChild
  }
  async function type(text) {
    composer.innerHTML = '<span class="caret"></span>'
    for (let i = 1; i <= text.length; i++) {
      composer.innerHTML = text.slice(0, i) + '<span class="caret"></span>'
      await sleep(text[i - 1] === " " ? 55 : 28 + Math.random() * 30)
    }
    await sleep(500)
  }
  async function add(node, ms = 0) {
    thread.appendChild(node)
    await sleep(ms)
  }
  async function run() {
    while (true) {
      const PROMPT = STR.prompt
      thread.innerHTML = ""
      composer.innerHTML = `<span class="ph">${STR.placeholder}</span>`
      await sleep(1400)
      await type(PROMPT)
      composer.innerHTML = `<span class="ph">${STR.placeholder}</span>`
      await add(el(`<div class="u">${PROMPT}</div>`), 700)
      const think = el(`<div class="a">${STR.thinking} <span class="think"><i></i><i></i><i></i></span></div>`)
      await add(think, 1500)
      think.textContent = STR.thinking
      await add(
        el(
          `<div class="tool"><div class="tool-h"><span class="badge read">read</span> src/components/ProvidersPanel.tsx <span class="st run">running</span></div></div>`,
        ),
        900,
      )
      $(".st", thread.lastElementChild).className = "st ok"
      $(".st", thread.lastElementChild).textContent = "completed"
      const edit = el(
        `<div class="tool"><div class="tool-h"><span class="badge edit">edit</span> src/components/ProvidersPanel.tsx <span class="st run">writing</span></div><div class="diff"></div></div>`,
      )
      await add(edit, 500)
      const lines = [
        `<div class="l"><span class="ln">12</span><span class="same">const [query, setQuery] = createSignal("")</span><span class="ln">12</span><span class="same">const [query, setQuery] = createSignal("")</span></div>`,
        `<div class="l"><span class="ln"></span><span></span><span class="ln">13</span><span class="add">const filtered = createMemo(() =&gt; match(providers, query()))</span></div>`,
        `<div class="l"><span class="ln">13</span><span class="del">return &lt;ul&gt;{providers.map(render)}&lt;/ul&gt;</span><span class="ln">14</span><span class="add">return &lt;ul&gt;{filtered().map(render)}&lt;/ul&gt;</span></div>`,
        `<div class="l"><span class="ln">14</span><span class="del">&lt;Panel title="Providers"&gt;</span><span class="ln">15</span><span class="add">&lt;Dialog title="Providers" search={setQuery}&gt;</span></div>`,
      ]
      for (const l of lines) {
        $(".diff", edit).appendChild(el(l))
        await sleep(420)
      }
      $(".st", edit).className = "st ok"
      $(".st", edit).textContent = "completed"
      await sleep(600)
      const bash = el(
        `<div class="tool"><div class="tool-h"><span class="badge bash">bash</span> bun run check <span class="st run">running</span></div></div>`,
      )
      await add(bash, 1500)
      bash.appendChild(el(`<div class="out">6 pass · 0 fail · 15 expect() calls</div>`))
      $(".st", bash).className = "st ok"
      $(".st", bash).textContent = "completed"
      await add(el(`<div class="foot">▣ <b>Build</b> · Muse Spark 1.3 · 42s · 12.4k tokens · $0.04</div>`), 5200)
    }
  }
  if (reduce) {
    thread.innerHTML = $(".scene[data-scene=chat] .thread").innerHTML
  } else run()

  /* home heatmap */
  const heat = $("#heat")
  if (heat) {
    let seed = 7
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280
    heat.innerHTML = Array.from({ length: 52 * 7 }, (_, i) => {
      const col = i % 52
      const r = rnd()
      const lvl = col > 44 && r > 0.45 ? (r > 0.85 ? 3 : r > 0.65 ? 2 : 1) : col > 30 && r > 0.9 ? 1 : 0
      return `<i class="${lvl ? "l" + lvl : ""}"></i>`
    }).join("")
  }

  /* ---------- scroll tour ---------- */
  const steps = $$("#steps .step"),
    scenes = $$("#scenes .scene")
  const show = (id) => {
    steps.forEach((s) => s.classList.toggle("on", s.dataset.scene === id))
    scenes.forEach((s) => s.classList.toggle("on", s.dataset.scene === id))
  }
  const so = new IntersectionObserver(
    (es) => {
      es.forEach((e) => {
        if (e.isIntersecting) show(e.target.dataset.scene)
      })
    },
    { rootMargin: "-45% 0px -45% 0px", threshold: 0 },
  )
  steps.forEach((s) => so.observe(s))
  steps.forEach((s) => s.addEventListener("click", () => show(s.dataset.scene)))

  /* ---------- permission demo ---------- */
  const MODES = {
    auto: {
      t: "Auto",
      s: "The engine classifies each call. Reads and safe commands run, writes outside the workspace and anything that leaves the machine ask first.",
      edit: "run",
      bash: "run",
      push: "ask",
    },
    manual: {
      t: "Manual",
      s: "Every write and every command waits for you. Best for unfamiliar repos and first sessions.",
      edit: "ask",
      bash: "ask",
      push: "ask",
    },
    edits: {
      t: "Accept edits",
      s: "File edits inside the workspace go through. Commands still ask, so nothing runs that you didn't see.",
      edit: "run",
      bash: "ask",
      push: "ask",
    },
    bypass: {
      t: "Bypass",
      s: "Everything runs without prompts. For unattended, scripted or sandboxed sessions only.",
      edit: "run",
      bash: "run",
      push: "run",
    },
  }
  function setMode(m) {
    const d = MODES[m]
    $$(".mode-btn").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === m))
    $("#demo-title").textContent = d.t
    $("#demo-sub").textContent = d.s
    modeChip.textContent = d.t + " ▾"
    $$(".act").forEach((a) => {
      const v = d[a.dataset.act]
      const p = $(".pill", a)
      p.className = "pill " + v
      p.textContent = STR[v]
      a.classList.toggle("asks", v === "ask")
    })
  }
  $$(".mode-btn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)))
  setMode("manual")

  /* ---------- os detection ---------- */
  const ua = navigator.userAgent,
    plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ""
  let os =
    /Win/i.test(plat) || /Windows/i.test(ua)
      ? "win"
      : /Linux/i.test(plat) && !/Android/i.test(ua)
        ? "linux"
        : /Mac/i.test(plat)
          ? "mac-arm"
          : null
  const names = { win: "Windows", linux: "Linux", "mac-arm": "macOS" }
  if (os) $(`#dl a[data-os="${os}"]`).classList.add("yours")
  if (os) $("#hero-dl").lastChild.textContent = " Download for " + names[os]
})()
