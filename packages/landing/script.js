;(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => [...r.querySelectorAll(s)]

  /* ---------- i18n ---------- */
  const ES = {
    "nav.cockpit": "Cabina",
    "nav.tour": "Tour",
    "nav.control": "Control",
    "nav.download": "Descargar",
    "nav.open": "Abrir la app",
    "hero.eyebrow": "<i></i> Código abierto · MIT · Sobre el motor OpenCode",
    "hero.h1":
      '\n        <span class="w" style="animation-delay:.05s">Tu</span>\n        <span class="w" style="animation-delay:.12s">agente,</span>\n        <span class="w" style="animation-delay:.19s">en</span>\n        <span class="w" style="animation-delay:.26s">una</span>\n        <span class="w grad" style="animation-delay:.33s">cabina</span>\n        <span class="w grad" style="animation-delay:.40s">de verdad.</span>\n      ',
    "hero.lead":
      "\n        FlupCode es un harness web y de escritorio para <strong>OpenCode</strong>: chat con diffs lado a lado,\n        terminal integrado, modos de permisos y paneles de uso. El motor no se toca. Todo lo que tocas tú, mejora.\n      ",
    "hero.try": "Pruébalo en el navegador",
    "hero.star":
      '\n          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.6.5.5 5.6.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.6 18.4.5 12 .5z"/></svg>\n          Estrella en GitHub\n        ',
    "quick.desktop": "App de escritorio",
    "quick.browser": "Navegador",
    "quick.source": "Desde el código",
    "quick.desktop.p":
      "Descarga FlupCode para tu plataforma. Arranca el motor OpenCode por ti si el CLI está instalado, y te guía si no lo está.",
    "quick.seeall": "Ver todos",
    "quick.browser.p":
      'Arranca el motor permitiendo el origen alojado y abre <a href="https://app.flupcode.com" target="_blank" rel="noreferrer" style="color:var(--sky)">app.flupcode.com</a>.',
    "quick.source.p": "Clona el monorepo y lanza el harness en modo desarrollo.",
    copy: "Copiar",
    "frame.title": "opencode-ui-power · Mover el panel de proveedores a un diálogo",
    "frame.conn": "<i></i> Conectado · localhost:4096",
    "side.new": "＋ Nueva sesión",
    "side.projects": "Proyectos",
    "side.s1": 'Mover el panel de proveedores… <span class="pin">★</span>',
    "side.s2": "Arreglar el badge del README",
    "side.s3": "Añadir heatmap de uso",
    "side.s4": "Post sobre beneficios",
    "side.today": "Hoy",
    "side.spent": "Gasto",
    "why.badge": "Agente = Motor + Cabina",
    "why.formula": "Cabina",
    "why.h2": "te mantiene al mando mientras el agente trabaja",
    "why.p":
      "El motor es el cerebro. La cabina es donde lees, decides y pilotas. FlupCode reconstruye solo la cabina, sobre el motor OpenCode que ya usas.",
    "why.c1.h": "El motor, intacto",
    "why.c1.p":
      "FlupCode habla con la misma API HTTP y SSE que usa cualquier cliente de OpenCode. Sin backend nuevo, sin fork del bucle del agente, upstream sigue siendo mergeable.",
    "why.c2.h": "Una cabina que se lee",
    "why.c2.p":
      "Diffs lado a lado, razonamiento plegable, salida de herramientas expandible, un pie de turno claro. Lo que el terminal imprime, FlupCode lo maqueta.",
    "why.c3.h": "Controles que significan algo",
    "why.c3.p":
      "Modos de permisos, plan frente a build, selectores de modelo y esfuerzo. Las reglas viven en el motor, así que la UI nunca miente sobre lo que el agente puede hacer.",
    "tour.h2": "Todo lo que hace el terminal. En una UI de verdad.",
    "tour.s1.h": "Chat con diffs de verdad",
    "tour.s1.p":
      "Cada edición se muestra como un diff lado a lado, cada comando con su salida. El razonamiento se pliega; nada queda escondido en un scrollback.",
    "tour.s2.h": "Un terminal integrado",
    "tour.s2.p":
      "Un PTY real en un panel del workspace, conectado al motor. Redimensiónalo, escribe en él, lanza tus tests junto a la conversación. Sin cambiar de contexto.",
    "tour.s3.h": "Un inicio que enseña tu semana",
    "tour.s3.p":
      "Sesiones, mensajes, tokens, rachas y un heatmap de actividad de todos tus proyectos. El coste queda a un vistazo, no a un panel de distancia.",
    "tour.s4.h": "Modos de permisos por sesión",
    "tour.s4.p":
      "Pasa de <code>Manual</code>, donde cada cambio se confirma, a <code>Bypass</code> para ejecuciones desatendidas. El chip del compositor siempre dice la verdad.",
    "scene.chat": "Sesión · chat",
    "scene.chat.u": "Añade un campo de búsqueda al diálogo de proveedores.",
    "scene.term": "Workspace · terminal",
    "scene.term.a": "Los tests pasan. ¿Abro una PR contra <code>dev</code>?",
    "scene.term.u": "Sí, una sola PR, rebase cuando CI esté en verde.",
    "scene.dash": "Inicio · uso",
    "home.h": "¿Qué sigue, Raúl?",
    "home.sub": "Resumen de tu actividad en FlupCode.",
    "home.sg1": '<i style="color:var(--sky)">⌕</i>Explora y comprende código',
    "home.sg2": '<i style="color:var(--violet)">✎</i>Crea una nueva función o herramienta',
    "home.sg3": '<i style="color:var(--mint)">↻</i>Revisa código y sugiere cambios',
    "home.sg4": '<i style="color:var(--amber)">⚑</i>Corrige problemas y fallos',
    "home.tabs": '<span class="on">Resumen</span><span>Modelos</span><span class="rng"><b>Todo</b> 30d 7d</span>',
    "home.t1": "Sesiones",
    "home.t2": "Mensajes",
    "home.t3": "Tokens totales",
    "home.t4": "Días activos",
    "home.t5": "Racha actual",
    "home.t6": "Racha más larga",
    "home.t7": "Hora pico",
    "home.t8": "Modelo favorito",
    "home.note": "Usaste ~19.454× más tokens que <em>1984</em>.",
    "scene.modes": "Sesión · modo de permisos",
    "scene.m1": "Auto <em>· el motor clasifica cada llamada</em>",
    "scene.m2": "Manual <em>· pregunta antes de cada cambio</em>",
    "scene.m3": "Accept edits <em>· acepta ediciones de archivos</em>",
    "scene.m4": "Bypass <em>· acepta todos los permisos</em>",
    "scene.needs": "requiere aprobación",
    "scene.allow":
      'Permitir una vez <span class="chip on" style="font-family:var(--ui)">Permitir</span> <span class="chip" style="font-family:var(--ui)">Siempre en esta sesión</span> <span class="chip" style="font-family:var(--ui)">Denegar</span>',
    "ctl.badge": "Pruébalo",
    "ctl.h2": "Decide cuánto puede hacer el agente",
    "ctl.p":
      "Elige un modo. Mira qué harían las mismas tres acciones en esa sesión. Son las reglas reales, no una capa por encima.",
    "ctl.lbl": "Modo de permisos",
    "ctl.auto.s": "El motor decide en cada llamada",
    "ctl.manual.s": "Pregunta antes de cada cambio",
    "ctl.edits.s": "Acepta ediciones de archivos",
    "ctl.bypass.s": "Acepta todos los permisos",
    "ctl.note":
      "Cambia de modo a mitad de sesión con el chip del compositor o con <kbd>⇧ Tab</kbd>. La elección se guarda por sesión, no globalmente.",
    "surf.badge": "Superficies",
    "surf.h2": "La misma cabina en todas partes",
    "surf.p": "Navegador, escritorio o junto al terminal que ya te gusta. Los tres hablan con el mismo motor.",
    "surf.web.p":
      'Abre <a href="https://app.flupcode.com" target="_blank" rel="noreferrer">app.flupcode.com</a> y apúntala a tu servidor. Empareja un móvil con un QR y dirige la misma sesión en remoto.',
    "surf.desk.h": "Escritorio",
    "surf.term.p":
      "Quédate con el TUI de OpenCode. FlupCode lo complementa con paridad función a función, seguida en una matriz viva.",
    "dl.h2": "Descarga la app de escritorio",
    "dl.p": "Builds preview gratuitas publicadas en GitHub Releases. Resaltamos la de la máquina en la que estás.",
    "dl.win": "Instalador · .exe",
    "dl.note":
      "\n        Las builds no están firmadas por ahora. En macOS, si dice “FlupCode está dañado”, ejecuta\n        <code>xattr -dr com.apple.quarantine /Applications/FlupCode.app</code> o clic derecho → Abrir. En Windows elige “Más información → Ejecutar de todas formas”.\n      ",
    "surf.desk.p":
      'Una app Electron que arranca el motor por ti. Notificaciones nativas y un badge en el dock mientras el agente trabaja. <a href="#download">Descargar</a>',
    "final.h2": "Tu motor. Una cabina mejor.",
    "final.p": "Clónalo, conéctalo a OpenCode y sigue publicando. Independiente, MIT, upstream primero.",
    "final.get": "Consigue FlupCode",
    "final.docs": "Lee la documentación",
    "final.parity": "Matriz de paridad con el TUI",
    "foot.note":
      '© <span id="year">2026</span> FlupCode. Un fork independiente de OpenCode. No está afiliado, respaldado ni desarrollado por OpenCode ni Anthropic. “OpenCode” es un proyecto de Anomaly; “Claude Code” es un producto de Anthropic.',
  }
  const EN = {}
  $$("[data-i18n]").forEach((el) => {
    if (!(el.dataset.i18n in EN)) EN[el.dataset.i18n] = el.innerHTML
  })
  const STR = {
    en: {
      placeholder: "Describe a task or ask a question",
      prompt: "Move the provider panel into a dialog and add a search field.",
      thinking: "Reading the panel and its tests",
      dl: "Download for ",
      dlAny: "Download the app",
      run: "runs",
      ask: "asks you",
    },
    es: {
      placeholder: "Describe una tarea o haz una pregunta",
      prompt: "Mueve el panel de proveedores a un diálogo y añade un campo de búsqueda.",
      thinking: "Leyendo el panel y sus tests",
      dl: "Descargar para ",
      dlAny: "Descargar la app",
      run: "se ejecuta",
      ask: "te pregunta",
    },
  }
  let lang = "en"
  try {
    lang =
      localStorage.getItem("flupcode.lang") || ((navigator.language || "").toLowerCase().startsWith("es") ? "es" : "en")
  } catch {
    lang = (navigator.language || "").toLowerCase().startsWith("es") ? "es" : "en"
  }
  const L = () => STR[lang]
  const hooks = [
    () => {
      const y = $("#year")
      if (y) y.textContent = new Date().getFullYear()
    },
  ]
  function setLang(next) {
    lang = next
    document.documentElement.lang = lang
    document.title =
      lang === "es" ? "FlupCode — Tu agente, en una cabina de verdad" : "FlupCode — Your agent, in a real cockpit"
    try {
      localStorage.setItem("flupcode.lang", lang)
    } catch {}
    $$("[data-i18n]").forEach((el) => {
      const k = el.dataset.i18n
      const v = lang === "es" ? ES[k] : EN[k]
      if (v != null && el.innerHTML !== v) el.innerHTML = v
    })
    $$("#lang span").forEach((x) => x.classList.toggle("on", x.dataset.l === lang))
    hooks.forEach((h) => h())
  }
  $("#lang").addEventListener("click", () => setLang(lang === "es" ? "en" : "es"))

  /* nav */
  const nav = $("#nav")
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 24)
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
    { c: "#5b8cff", a: 0.4, y: 0.42, amp: 0.1, f: 1.3, s: 0.00022, w: 0.36 },
    { c: "#8b5cf6", a: 0.36, y: 0.52, amp: 0.13, f: 0.9, s: 0.00017, w: 0.3 },
    { c: "#4cc9ff", a: 0.3, y: 0.34, amp: 0.08, f: 1.7, s: 0.00028, w: 0.22 },
    { c: "#c084fc", a: 0.2, y: 0.62, amp: 0.11, f: 1.1, s: 0.00013, w: 0.26 },
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
    octx.fillStyle = "#05060b"
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
    g.addColorStop(0, "rgba(5,6,11,.9)")
    g.addColorStop(0.35, "rgba(5,6,11,.15)")
    g.addColorStop(1, "rgba(5,6,11,0)")
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
          c.fillStyle = "#9fb8ff"
          c.beginPath()
          c.arc(x, y, p.r * 3, 0, 6.28)
          c.fill()
        }
        c.globalAlpha = tw
        c.fillStyle = p.big ? "#ffffff" : "#e3e9ff"
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
      const PROMPT = L().prompt
      thread.innerHTML = ""
      composer.innerHTML = `<span class="ph">${L().placeholder}</span>`
      await sleep(1400)
      await type(PROMPT)
      composer.innerHTML = `<span class="ph">${L().placeholder}</span>`
      await add(el(`<div class="u">${PROMPT}</div>`), 700)
      const think = el(`<div class="a">${L().thinking} <span class="think"><i></i><i></i><i></i></span></div>`)
      await add(think, 1500)
      think.textContent = L().thinking
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
      s: {
        en: "The engine classifies each call. Reads and safe commands run, writes outside the workspace and anything that leaves the machine ask first.",
        es: "El motor clasifica cada llamada. Lecturas y comandos seguros se ejecutan; escrituras fuera del workspace y todo lo que salga de la máquina preguntan antes.",
      },
      edit: "run",
      bash: "run",
      push: "ask",
    },
    manual: {
      t: "Manual",
      s: {
        en: "Every write and every command waits for you. Best for unfamiliar repos and first sessions.",
        es: "Cada escritura y cada comando esperan tu aprobación. Ideal para repos desconocidos y primeras sesiones.",
      },
      edit: "ask",
      bash: "ask",
      push: "ask",
    },
    edits: {
      t: "Accept edits",
      s: {
        en: "File edits inside the workspace go through. Commands still ask, so nothing runs that you didn't see.",
        es: "Las ediciones de archivos dentro del workspace pasan. Los comandos siguen preguntando, así que no se ejecuta nada que no hayas visto.",
      },
      edit: "run",
      bash: "ask",
      push: "ask",
    },
    bypass: {
      t: "Bypass",
      s: {
        en: "Everything runs without prompts. For unattended, scripted or sandboxed sessions only.",
        es: "Todo se ejecuta sin preguntar. Solo para sesiones desatendidas, automatizadas o en sandbox.",
      },
      edit: "run",
      bash: "run",
      push: "run",
    },
  }
  let mode = "manual"
  function setMode(m) {
    mode = m
    const d = MODES[m]
    $$(".mode-btn").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === m))
    $("#demo-title").textContent = d.t
    $("#demo-sub").textContent = d.s[lang]
    modeChip.textContent = d.t + " ▾"
    $$(".act").forEach((a) => {
      const v = d[a.dataset.act]
      const p = $(".pill", a)
      p.className = "pill " + v
      p.textContent = L()[v]
      a.classList.toggle("asks", v === "ask")
    })
  }
  hooks.push(() => setMode(mode))
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
  const dlLabel = () => {
    $("#hero-dl").lastChild.textContent = " " + (os ? L().dl + names[os] : L().dlAny)
  }
  hooks.push(dlLabel)
  setLang(lang)
})()
