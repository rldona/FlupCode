import { createSignal } from "solid-js"
import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"

export type Locale = "en" | "es"

const EN = {} as const

const ES: Record<string, string> = {
  // Navigation
  New: "Nuevo",
  Artifacts: "Artefactos",
  Routines: "Rutinas",
  Customize: "Personalizar",
  Projects: "Proyectos",
  Sessions: "Sesiones",
  Pinned: "Fijado",
  "No open projects": "Sin proyectos abiertos",
  "Open a folder to get started": "Abre una carpeta para empezar",
  "Filter projects": "Filtrar proyectos",
  "No sessions": "No hay sesiones",
  "Create one with New": "Crea una con Nuevo",
  Pin: "Fijar",
  Unpin: "Quitar de fijados",
  Open: "Abrir",
  "Copy path": "Copiar ruta",
  "Delete this project and its sessions?": "¿Eliminar este proyecto y sus sesiones?",
  "Project deleted": "Proyecto eliminado",
  "New session": "Nueva sesión",
  Refresh: "Actualizar",
  "Your name": "Tu nombre",
  About: "Acerca de",
  "About FlupCode": "Acerca de FlupCode",
  "Toggle sidebar": "Alternar barra lateral",
  Back: "Atrás",
  Forward: "Adelante",
  Connecting: "Conectando",
  Connected: "Conectado",
  Offline: "Sin conexión",

  // Home
  "What's next?": "¿Qué sigue?",
  "What's next, {name}?": "¿Qué sigue, {name}?",
  "Your FlupCode activity at a glance.": "Resumen de tu actividad en FlupCode.",
  Summary: "Resumen",
  Models: "Modelos",
  All: "Todo",
  "Total tokens": "Tokens totales",
  "Active days": "Días activos",
  "Current streak": "Racha actual",
  "Longest streak": "Racha más larga",
  "Peak hour": "Hora pico",
  "Favorite model": "Modelo favorito",
  "No model data": "Sin datos de modelos",
  "Explore and understand code": "Explora y comprende código",
  "Create a new function, app or tool": "Crea una nueva función, aplicación o herramienta",
  "Review code and suggest changes": "Revisa código y sugiere cambios",
  "Fix problems and bugs": "Corrige problemas y fallos",
  "Explore this repository and explain its architecture and main modules.":
    "Explora este repositorio y explícame su arquitectura y módulos principales.",
  "Create a new feature from scratch. Ask me for details first.":
    "Crea una nueva funcionalidad desde cero. Pregúntame los detalles primero.",
  "Review the recent changes and suggest improvements.":
    "Revisa los cambios recientes y sugiere mejoras.",
  "Find and fix problems and bugs in this project.":
    "Encuentra y corrige problemas y fallos en este proyecto.",
  "{count} sessions": "{count} sesiones",
  "You used ~{ratio}× more tokens than {name}.": "Usaste ~{ratio}× más tokens que {name}.",

  // Composer
  Local: "Local",
  "No folder": "Sin carpeta",
  Shell: "Shell",
  "Describe a task or ask a question": "Describe una tarea o haz una pregunta",
  Attach: "Adjuntar",
  Voice: "Voz",
  "Voice dictation": "Dictado por voz",
  Send: "Enviar",
  Save: "Guardar",
  Auto: "Auto",
  "Default model": "Modelo por defecto",
  Model: "Modelo",
  Variant: "Variante",
  Default: "Default",

  // Settings
  Appearance: "Apariencia",
  Theme: "Tema",
  System: "Sistema",
  Light: "Claro",
  Dark: "Oscuro",
  Language: "Idioma",
  English: "Inglés",
  Spanish: "Español",
  Profile: "Perfil",
  Name: "Nombre",
  On: "Activado",
  Off: "Desactivado",
  Conversation: "Conversación",
  "Show tool steps": "Mostrar pasos de herramientas",
  Yes: "Sí",
  No: "No",
  Server: "Servidor",
  Integrations: "Integraciones",
  "MCP servers": "Servidores MCP",
  "Remote access (QR)": "Acceso remoto (QR)",
  "Open FlupCode on your phone by scanning the code.": "Abre FlupCode desde el móvil escaneando el código.",
  URL: "URL",
  "Copy URL": "Copiar URL",
  "To expose on the network:": "Para exponerlo en la red:",
  "Session without title": "Sesión sin título",
  "No routines": "Sin rutinas",
  "Create one below": "Crea una abajo",
  Connect: "Conectar",
  Disconnect: "Desconectar",
  Remote: "Remoto",
  "No MCP servers": "Sin servidores MCP",
  "command and arguments": "comando y argumentos",
  "No artifacts yet": "Aún no hay artefactos",
  "Files changed by the session appear here": "Los archivos modificados por la sesión aparecen aquí",
  Copy: "Copiar",
  "Path copied": "Ruta copiada",
  Skills: "Skills",
  "No skills": "Sin skills",
  Insert: "Insertar",
  Tags: "Etiquetas",
  "Add tag": "Añadir etiqueta",
  Notifications: "Notificaciones",
  "Enable notifications": "Activar notificaciones",
  Shortcuts: "Atajos",
  "Command palette": "Paleta de comandos",
  "Press keys…": "Pulsa teclas…",
  "Config (advanced)": "Config (avanzado)",
  Reload: "Recargar",
  "Invalid JSON": "JSON inválido",
  "Config saved": "Configuración guardada",
  "Session finished": "Sesión finalizada",
  "Permission needed": "Permiso necesario",
  "Question asked": "Pregunta recibida",
  Folder: "Carpeta",
  Tunnel: "Túnel",
  "Copy command": "Copiar comando",

  // Onboarding
  "Welcome to FlupCode": "Bienvenido a FlupCode",
  "A harness for OpenCode with a dashboard, routines and projects, on web and desktop.":
    "Un harness para OpenCode con dashboard, rutinas y proyectos, en web y escritorio.",
  "Checking the server…": "Comprobando el servidor…",
  "Server connected": "Servidor conectado",
  "Server offline": "Sin conexión al servidor",
  "What's your name?": "¿Cómo te llamas?",
  "Get started": "Empezar",

  // About
  "Version {version}": "Versión {version}",
  "FlupCode is an independent fork of OpenCode. It is not affiliated with or endorsed by Anomaly (OpenCode) or Anthropic (Claude Code).":
    "FlupCode es un fork independiente de OpenCode. No está afiliado ni respaldado por Anomaly (OpenCode) ni por Anthropic (Claude Code).",
  Repository: "Repositorio",
  "Upstream OpenCode": "Upstream OpenCode",
  "MIT license. OpenCode copyright preserved.": "Licencia MIT. Copyright de OpenCode preservado.",
  Close: "Cerrar",

  // Commands / palette
  "New session…": "Nueva sesión",
  "Compact the current session": "Compactar la sesión actual",
  "Show or hide tool steps": "Mostrar u ocultar los pasos de herramientas",
  "MCP servers…": "Servidores MCP",
  "Save the current prompt": "Guardar el prompt actual",
  "View saved prompts": "Ver prompts guardados",
  "Customize FlupCode": "Personalizar FlupCode",
  "Scheduled tasks": "Tareas programadas",
  "Remote access / mobile": "Acceso remoto / móvil",
  "Search commands, sessions and files": "Buscar comandos, sesiones y archivos",
  "No results": "Sin resultados",

  // Dialogs and actions
  "Servers MCP": "Servidores MCP",
  "Saved prompts": "Prompts guardados",
  "No saved prompts": "Sin prompts guardados",
  "Use /stash to save the current prompt": "Usa /stash para guardar el prompt actual",
  Restore: "Restaurar",
  Remove: "Quitar",
  "Run": "Ejecutar",
  "Add": "Añadir",
  "prompt to run": "prompt a ejecutar",
  "every {minutes} min · last: {last}": "cada {minutes} min · última: {last}",
  Never: "nunca",
  Active: "Activa",
  Paused: "Pausada",
  "Permission required": "Permiso requerido",
  "Allow once": "Permitir una vez",
  "Allow always": "Permitir siempre",
  Reject: "Rechazar",
  Question: "Pregunta",
  Respond: "Responder",
  "Custom answer": "Respuesta personalizada",
  Tasks: "Tareas",
  "No tasks": "Sin tareas",
  Context: "Contexto",
  "% used": "% usado",
  Spent: "Gastado",
  Subagents: "Subagentes",
  Edit: "Editar",
  "Message ready to edit": "Mensaje listo para editar",
  "Thinking": "Pensamiento",
  Pending: "Pendiente",
  "In progress": "En ejecución",
  "No messages yet": "Aún no hay mensajes",
  "Write below to start": "Escribe abajo para empezar",
  Generating: "Generando…",
  "Error generating the response": "Error al generar la respuesta",
  You: "Tú",
  Fork: "Fork",
  Compact: "Compactar",
  Undo: "Deshacer",
  Redo: "Rehacer",
  "Confirm revert": "Confirmar reversión",
  Rename: "Renombrar",
  "Export MD": "Exportar MD",
  "Move to…": "Mover a…",
  Delete: "Eliminar",
  Agent: "Agente",
  "New title": "Nuevo título",

  // Toasts
  "Session created": "Sesión creada",
  "Message sent": "Mensaje enviado",
  "Session forked": "Sesión bifurcada",
  "Session compacted": "Sesión compactada",
  "Session renamed": "Sesión renombrada",
  "Session moved": "Sesión movida",
  "Session deleted": "Sesión eliminada",
  "Changes reverted": "Cambios revertidos",
  "Changes restored": "Cambios restaurados",
  "Revert confirmed": "Reversión confirmada",
  "Transcript exported": "Transcripción exportada",
  "Prompt saved": "Prompt guardado",
  "No prompt to save": "No hay prompt que guardar",
  "Nothing to undo": "Nada que deshacer",
  "Command executed": "Comando ejecutado",
  "Command launched": "Comando lanzado",
  "Skill executed": "Skill ejecutada",
  "MCP server added": "Servidor MCP añadido",
  "MCP server removed": "Servidor MCP eliminado",
  "MCP server connected": "Servidor MCP conectado",
  "MCP server disconnected": "Servidor MCP desconectado",
  "Routine created": "Rutina creada",
  'Routine "{name}" executed': 'Rutina "{name}" ejecutada',
  "Delete this session?": "¿Eliminar esta sesión?",
}

const STORAGE_DEFAULT: Locale = "en"

function detectLocale(): Locale {
  const saved = readStorage<Locale>(STORAGE_KEYS.locale, STORAGE_DEFAULT)
  if (saved === "en" || saved === "es") return saved
  return STORAGE_DEFAULT
}

const [locale, setLocaleSignal] = createSignal<Locale>(detectLocale())

export function getLocale() {
  return locale()
}

export function setLocale(value: Locale) {
  setLocaleSignal(value)
  writeStorage(STORAGE_KEYS.locale, value)
}

export function t(key: string, params?: Record<string, string | number>) {
  const template = locale() === "es" ? (ES[key] ?? key) : key
  if (!params) return template
  return Object.entries(params).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    template,
  )
}

export { EN }
