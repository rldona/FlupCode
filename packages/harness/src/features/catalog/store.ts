import { createEffect, createMemo, createSignal } from "solid-js"
import { createResource } from "../../resource"
import { setAdaptiveModels } from "../../adaptive-copy"
import {
  addSource,
  removeSource,
  normalizeSources,
  EMPTY_SOURCES,
  type SkillSourceKind,
  type SkillSources,
} from "../../skill-sources"
import { AdaptiveConfigError, adaptiveSurfaces, createClient, createHarnessClient } from "../../client"
import { customProviderPayload, type CustomProviderResult } from "../../custom-provider"
import type { ModelInfo, ConsoleOrg } from "../../engine-types"
import type { McpConfig, McpScope } from "../../types"
import { t } from "../../i18n"
import { toast } from "../../toast"
import { setCompositionTools } from "../../components/SessionView"
import type { CommandDraft } from "../../components/CommandsPanel"
import type { ModelKeyChange } from "../../components/AdaptiveSettingsPanel"
import { needsOAuth } from "../../mcp"
import type { AppStores } from "../../app-context"

export function createCatalog(app: AppStores) {
  // The adaptive settings (FH-070). Read while the settings panel is open and re-read after every
  // write, so the panel draws the server's own resulting view rather than guessing it. An older
  // server that does not announce the surface is not asked, so there is no 404 in the console.
  const [adaptiveRevision, setAdaptiveRevision] = createSignal(0)
  const [adaptiveSettings] = createResource(
    () =>
      app.router.settingsOpen() && adaptiveSurfaces(app.connection.harnessCapabilities()).config
        ? adaptiveRevision()
        : undefined,
    () => createHarnessClient(app.connection.harnessServerUrl()).adaptive.config.get(),
  )
  // The model registry (AH-C01) names models and providers outside Settings too — the Decisions
  // screen, the session chip, the context plan — so it is read once per server that announces the
  // surface, and every settings read refreshes it. Without it ids are shown as they are.
  const [adaptiveRegistry] = createResource(
    () =>
      adaptiveSurfaces(app.connection.harnessCapabilities()).config ? app.connection.harnessServerUrl() : undefined,
    (url) =>
      createHarnessClient(url)
        .adaptive.config.get()
        .then((view) => view.models ?? []),
  )
  createEffect(() => setAdaptiveModels(adaptiveSettings()?.models ?? adaptiveRegistry() ?? []))
  // The value gate (AH-C05) says whether the predictive model is paused for low value; an older server
  // that does not announce it is not asked.
  const [adaptiveVoi] = createResource(
    () =>
      app.router.settingsOpen() && adaptiveSurfaces(app.connection.harnessCapabilities()).voi
        ? adaptiveRevision()
        : undefined,
    () => createHarnessClient(app.connection.harnessServerUrl()).adaptive.voi.get(),
  )
  const [adaptiveSaving, setAdaptiveSaving] = createSignal(false)
  const [adaptiveWarnings, setAdaptiveWarnings] = createSignal<string[]>([])
  const [adaptiveError, setAdaptiveError] = createSignal<AdaptiveConfigError>()
  const adaptiveFailed = (cause: unknown) => {
    setAdaptiveWarnings([])
    setAdaptiveError(
      cause instanceof AdaptiveConfigError
        ? cause
        : new AdaptiveConfigError(cause instanceof Error ? cause.message : String(cause), "internal_error"),
    )
  }
  const patchAdaptive = (patch: Record<string, unknown>, confirm: boolean) => {
    setAdaptiveSaving(true)
    setAdaptiveError(undefined)
    void createHarnessClient(app.connection.harnessServerUrl())
      .adaptive.config.patch({ patch, confirm })
      .then((answer) => {
        setAdaptiveWarnings(answer.warnings)
        setAdaptiveError(undefined)
        setAdaptiveRevision((value) => value + 1)
      })
      .catch(adaptiveFailed)
      .finally(() => setAdaptiveSaving(false))
  }
  // The predictive model's key: saved or removed, then the view is re-read so the panel says where
  // the key now comes from. The key is passed straight through and kept nowhere here.
  const changeModelKey = (change: ModelKeyChange) => {
    setAdaptiveSaving(true)
    setAdaptiveError(undefined)
    const modelKey = createHarnessClient(app.connection.harnessServerUrl()).adaptive.modelKey
    void ("key" in change ? modelKey.set(change.key) : modelKey.remove())
      .then(() => {
        setAdaptiveWarnings([])
        setAdaptiveRevision((value) => value + 1)
      })
      .catch(adaptiveFailed)
      .finally(() => setAdaptiveSaving(false))
  }
  // Dismissing the runtime alerts (AH-D05) re-reads the view, so the panel draws what the server kept.
  const acknowledgeRuntime = () => {
    setAdaptiveSaving(true)
    void createHarnessClient(app.connection.harnessServerUrl())
      .adaptive.runtime.acknowledge()
      .then(() => setAdaptiveRevision((value) => value + 1))
      .catch((cause: unknown) =>
        setAdaptiveError(
          new AdaptiveConfigError(cause instanceof Error ? cause.message : String(cause), "internal_error"),
        ),
      )
      .finally(() => setAdaptiveSaving(false))
  }

  // Extra skill sources (H-27). The engine reads its own folders; `skills.paths`/`skills.urls` add
  // more, and writing them is a `PATCH /config`, so this is the engine's to own.
  const [skillSources, setSkillSources] = createSignal<SkillSources>(EMPTY_SOURCES)
  createEffect(() => {
    if (!app.router.skillsScreenOpen() || !app.connection.ready()) return
    void createClient(app.connection.serverUrl())
      .config()
      .then((config) => setSkillSources(normalizeSources((config as { skills?: unknown }).skills)))
      .catch(() => undefined)
  })
  const writeSkillSources = (next: SkillSources) =>
    createClient(app.connection.serverUrl())
      .updateConfig({ skills: { paths: next.paths, urls: next.urls } })
      .then(() => toast(t("Skill sources saved"), "success"))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  const addSkillSource = (kind: SkillSourceKind, value: string) => {
    const next = addSource(skillSources(), kind, value)
    setSkillSources(next)
    void writeSkillSources(next)
  }
  const removeSkillSource = (kind: SkillSourceKind, value: string) => {
    const next = removeSource(skillSources(), kind, value)
    setSkillSources(next)
    void writeSkillSources(next)
  }
  const [models, { refetch: refetchModels }] = createResource(
    () => (app.connection.ready() ? `${app.connection.serverUrl()}::${app.sessions.modelLocation() ?? ""}` : undefined),
    (key) => {
      const separator = key.lastIndexOf("::")
      const url = key.slice(0, separator)
      const directory = key.slice(separator + 2)
      return createClient(url).model.list(directory ? { location: { directory } } : undefined)
    },
  )
  const [modelDirectory, { refetch: refetchModelDirectory }] = createResource(
    () => (app.connection.ready() ? app.connection.serverUrl() : undefined),
    async (url) => createClient(url).model.directory(),
  )
  // The engine's own settings. The context meter needs the compaction ones: they are what decides
  // when the engine folds a session, and how much room the reader really has.
  const [engineConfig, { refetch: refetchEngineConfig }] = createResource(
    () => (app.connection.ready() ? `${app.connection.serverUrl()}\n${app.connection.serverReload()}` : undefined),
    async (key) => createClient(key.split("\n")[0]!).config(),
  )
  /** Writes the repository the config-files export copies into, kept in the global config. */
  const saveConfigRepo = (repo: string) => {
    void createClient(app.connection.serverUrl())
      .updateGlobalConfig({ flupcode: { configRepo: repo } })
      .then(() => refetchEngineConfig())
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  // Which tools draw an image a delivery re-attaches is configuration, not knowledge: FlupCode reads
  // `flupcode.composeTools`, plus each delivery profile's own `composeTools`, and never names a tool
  // of any product itself.
  createEffect(() => {
    const flupcode = engineConfig()?.flupcode
    setCompositionTools([
      ...(flupcode?.composeTools ?? []),
      ...Object.values(flupcode?.delivery ?? {}).flatMap((profile) => profile.composeTools ?? []),
    ])
  })
  const [lastModels, setLastModels] = createSignal<ModelInfo[]>([])
  createEffect(() => {
    const data = models()?.data
    if (data && data.length > 0) setLastModels(data)
  })
  const modelList = createMemo(() => {
    const data = models()?.data
    return data && data.length > 0 ? data : lastModels()
  })
  const [agents] = createResource(
    () =>
      app.connection.ready()
        ? `${app.connection.serverUrl()}\n${app.connection.serverReload()}\n${app.sessions.vcsDirectory() ?? ""}`
        : undefined,
    async (key) => {
      const [url = "", , directory = ""] = key.split("\n")
      return createClient(url).agent.list(directory ? { location: { directory } } : undefined)
    },
  )
  const [skills] = createResource(
    () =>
      app.connection.ready()
        ? `${app.connection.serverUrl()}\n${app.connection.serverReload()}\n${app.sessions.vcsDirectory() ?? ""}`
        : undefined,
    async (key) => {
      const [url = "", , directory = ""] = key.split("\n")
      return createClient(url).skill.list(directory ? { location: { directory } } : undefined)
    },
  )
  // The engine answers `/mcp` with a directory and refuses without one when it serves a repository,
  // while a stock CLI instance answers either way. Prefer the selected session's folder, then the
  // engine's own working directory, then its state folder, so the list is the reader's, not a 499.
  const mcpDirectory = () =>
    app.sessions.vcsDirectory() ?? app.connection.enginePaths()?.directory ?? app.connection.enginePaths()?.state
  const [mcp, { refetch: refetchMcp }] = createResource(
    () => (app.connection.ready() ? `${app.connection.serverUrl()}\n${mcpDirectory() ?? ""}` : undefined),
    async (key) => {
      const [url = "", directory = ""] = key.split("\n")
      return createClient(url).mcp.list(directory ? { directory } : undefined)
    },
  )
  // What the connected MCP servers expose (H-34). The engine reports resources, not tools.
  const [mcpResources, { refetch: refetchMcpResources }] = createResource(
    () => (app.connection.ready() ? `${app.connection.serverUrl()}\n${mcpDirectory() ?? ""}` : undefined),
    async (key) => {
      const [url = "", directory = ""] = key.split("\n")
      return createClient(url)
        .mcp.resources(directory ? { directory } : undefined)
        .catch(() => [])
    },
  )
  // An MCP server waiting on OAuth cannot be used until the reader signs in; the home screen offers
  // to do it there instead of burying it in Settings. A failed status read means "not known yet".
  const mcpNeedingAuth = () => {
    try {
      return (mcp()?.data ?? []).filter(needsOAuth)
    } catch {
      return []
    }
  }
  const [providerDirectory, { refetch: refetchProviderDirectory }] = createResource(
    () => (app.connection.ready() ? app.connection.serverUrl() : undefined),
    async (url) => createClient(url).provider.directory(),
  )
  const [globalConfig, { refetch: refetchGlobalConfig }] = createResource(
    () => (app.connection.ready() && app.router.providersSectionVisible() ? app.connection.serverUrl() : undefined),
    async (url) => createClient(url).globalConfig(),
  )
  // The reload counter is part of the key so the list is asked for again when the engine reloads:
  // a command (or a whole skill set) added on disk only shows up after the engine re-reads it.
  const [commands] = createResource(
    () =>
      app.connection.ready()
        ? `${app.connection.serverUrl()}\n${app.connection.serverReload()}\n${app.sessions.vcsDirectory() ?? ""}`
        : undefined,
    async (key) => {
      const [url = "", , directory = ""] = key.split("\n")
      return createClient(url).command.list(directory ? { location: { directory } } : undefined)
    },
  )
  const [integrations, { refetch: refetchIntegrations }] = createResource(
    () => (app.connection.ready() ? app.connection.serverUrl() : undefined),
    async (url) => createClient(url).integration.list(),
  )
  createEffect(() => {
    if (!app.router.providersSectionVisible()) return
    void refetchProviderDirectory()
    void refetchIntegrations()
  })
  /** The Console org behind providers, when the engine has one (CO-1). */
  const [consoleActive, { refetch: refetchConsoleActive }] = createResource(
    () => (app.connection.ready() && app.router.providersSectionVisible() ? app.connection.serverUrl() : undefined),
    async (url) =>
      createClient(url)
        .console.active()
        .catch(() => undefined),
  )
  const [consoleOrgs, { refetch: refetchConsoleOrgs }] = createResource(
    () => (app.connection.ready() && app.router.providersSectionVisible() ? app.connection.serverUrl() : undefined),
    async (url) =>
      createClient(url)
        .console.orgs()
        .catch(() => [] as ConsoleOrg[]),
  )
  /**
   * Switch the Console org, then reread everything it manages (CO-1). Providers, models and
   * integrations all hang off the active org, so all of them refresh.
   */
  const switchConsoleOrg = (org: ConsoleOrg) => {
    void createClient(app.connection.serverUrl())
      .console.switchOrg({ accountID: org.accountID, orgID: org.orgID })
      .then(() => {
        void refetchConsoleActive()
        void refetchConsoleOrgs()
        void refetchProviderDirectory()
        void refetchIntegrations()
        void refetchModels()
        void refetchModelDirectory()
        toast(t("Console organization switched"), "success")
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  // Skills (H-27). The files come from the harness server, including the ones the engine did not
  // load — which the engine, by definition, cannot report.
  const [skillsRefresh, setSkillsRefresh] = createSignal(0)
  const skillFilesKey = () => {
    if (!app.router.skillsScreenOpen() || !app.runs.routinesServerAvailable()) return undefined
    return `${app.connection.harnessServerUrl()}\n${app.sessions.vcsDirectory() ?? ""}\n${skillsRefresh()}`
  }
  const [skillFiles] = createResource(skillFilesKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).skills.list(directory ? { directory } : {})
  })
  const readSkillFile = (path: string) =>
    createHarnessClient(app.connection.harnessServerUrl())
      .skills.file({ path, ...(app.sessions.vcsDirectory() ? { directory: app.sessions.vcsDirectory()! } : {}) })
      .then((answer) => {
        if (!answer) throw new Error(t("Could not read that file"))
        return answer.content
      })
  /**
   * Re-reads the engine's agent, skill and command definitions after a panel wrote a file. Best
   * effort: a failed reload must not lose the file already written or surface as a failed save, so
   * the failure is dropped and the engine's lists are asked to refresh next.
   */
  const reloadEngineDefinitions = async () => {
    const directory = app.sessions.vcsDirectory()
    await createClient(app.connection.serverUrl())
      .reloadConfig(directory ? { directory } : undefined)
      .catch(() => undefined)
    app.connection.setServerReload((count) => count + 1)
  }
  const saveSkill = async (draft: { name: string; scope: "global" | "project"; description: string; body: string }) => {
    const directory = app.sessions.vcsDirectory()
    await createHarnessClient(app.connection.harnessServerUrl()).skills.save({
      ...draft,
      ...(directory ? { directory } : {}),
    })
    await reloadEngineDefinitions()
    setSkillsRefresh((count) => count + 1)
  }
  const deleteSkillFile = async (path: string) => {
    const directory = app.sessions.vcsDirectory()
    await createHarnessClient(app.connection.harnessServerUrl()).skills.remove({
      path,
      ...(directory ? { directory } : {}),
    })
    await reloadEngineDefinitions()
    setSkillsRefresh((count) => count + 1)
  }
  /**
   * The agents this folder has, for the screen that is about this folder's agent files. It is the
   * legacy `/agent?directory=` list, which is the one the engine reads those files with.
   */
  const folderAgentsKey = () =>
    (app.router.agentsSectionVisible() || app.router.agentsOpen()) && app.connection.ready()
      ? `${app.connection.serverUrl()}\n${app.sessions.vcsDirectory() ?? ""}`
      : undefined
  const [folderAgents] = createResource(folderAgentsKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createClient(url).agent.listFor(directory || undefined)
  })
  // Agents you can edit (H-13). The files come from the harness server, which can read the disk;
  // what exists comes from the engine, which reports more than there are files.
  const agentFilesKey = () => {
    // Also when Settings is open: who may reach a server is read from the agent files (H-34).
    if ((!app.router.settingsOpen() && !app.router.agentsOpen()) || !app.runs.routinesServerAvailable())
      return undefined
    return `${app.connection.harnessServerUrl()}\n${app.sessions.vcsDirectory() ?? ""}\n${agentsRefresh()}`
  }
  const [agentsRefresh, setAgentsRefresh] = createSignal(0)
  const [agentFiles] = createResource(agentFilesKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).agents.list(directory ? { directory } : {})
  })
  const saveAgent = async (draft: {
    name: string
    scope: "global" | "project"
    fields: Record<string, unknown>
    prompt: string
    path?: string
  }) => {
    const directory = app.sessions.vcsDirectory()
    await createHarnessClient(app.connection.harnessServerUrl()).agents.save({
      ...draft,
      ...(directory ? { directory } : {}),
    })
    await reloadEngineDefinitions()
    setAgentsRefresh((count) => count + 1)
  }
  const deleteAgent = async (path: string) => {
    const directory = app.sessions.vcsDirectory()
    await createHarnessClient(app.connection.harnessServerUrl()).agents.remove({
      path,
      ...(directory ? { directory } : {}),
    })
    await reloadEngineDefinitions()
    setAgentsRefresh((count) => count + 1)
  }
  // Commands you can edit (H-25). The files behind the engine's slash commands; the palette already
  // reads what the engine lists, so a save here shows up without touching the palette.
  const [commandsRefresh, setCommandsRefresh] = createSignal(0)
  const commandFilesKey = () => {
    if (!app.router.settingsOpen() || !app.runs.routinesServerAvailable()) return undefined
    return `${app.connection.harnessServerUrl()}\n${app.sessions.vcsDirectory() ?? ""}\n${commandsRefresh()}`
  }
  const [commandFiles] = createResource(commandFilesKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).commands.list(directory ? { directory } : {})
  })
  const saveCommand = (draft: CommandDraft) => {
    const directory = app.sessions.vcsDirectory()
    void createHarnessClient(app.connection.harnessServerUrl())
      .commands.save({ ...draft, ...(directory ? { directory } : {}) })
      .then(async () => {
        await reloadEngineDefinitions()
        setCommandsRefresh((count) => count + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  const deleteCommand = (path: string) => {
    const directory = app.sessions.vcsDirectory()
    void createHarnessClient(app.connection.harnessServerUrl())
      .commands.remove({ path, ...(directory ? { directory } : {}) })
      .then(async () => {
        await reloadEngineDefinitions()
        setCommandsRefresh((count) => count + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  // The configured MCP servers (H-25): so the form can open one for editing, not just add a new one.
  const [mcpConfigs, { refetch: refetchMcpConfigs }] = createResource(
    () =>
      app.router.settingsOpen() && app.connection.ready()
        ? `${app.connection.serverUrl()}\n${mcpDirectory() ?? ""}`
        : undefined,
    async (key) => {
      const [url = "", directory = ""] = key.split("\n")
      return createClient(url).mcp.config(directory ? { directory } : undefined)
    },
  )
  // The engine's permission policy (H-25), edited in Settings. Runtime grants ("Allow always") are
  // a different thing and are read from the engine on their own.
  const [permissionPolicy, { refetch: refetchPermissionPolicy }] = createResource(
    () => (app.router.settingsOpen() && app.connection.ready() ? app.connection.serverUrl() : undefined),
    async (url) => ((await createClient(url).config()) as { permission?: unknown }).permission,
  )
  const savePermissionPolicy = (policy: Record<string, unknown>) =>
    void createClient(app.connection.serverUrl())
      .updateConfig({ permission: policy })
      .then(() => {
        void refetchPermissionPolicy()
        toast(t("Permissions saved"))
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  const toolsKey = () =>
    (app.router.contextOpen() || app.router.agentsOpen() || app.router.agentsSectionVisible()) && app.connection.ready()
      ? app.connection.serverUrl()
      : undefined
  const [engineTools] = createResource(toolsKey, (url) => createClient(url).tools())

  // What "Allow always" wrote. The engine applies these to every session in the project, so they
  // only become reviewable once something lists them.
  const [savedPermissions, { refetch: refetchSavedPermissions }] = createResource(
    () => (app.connection.ready() && app.router.settingsOpen() ? app.connection.serverUrl() : undefined),
    async (url) => createClient(url).permission.saved.list(),
  )
  // The sites the agent may act on without asking (BU-01), kept by the harness server.
  const [browserGrants, { refetch: refetchBrowserGrants }] = createResource(
    () =>
      app.router.settingsOpen() && app.connection.supports("browser-policy")
        ? app.connection.harnessServerUrl()
        : undefined,
    (url) => createHarnessClient(url).browserPolicy.grants(),
  )
  const revokeBrowserGrant = (id: string) =>
    void createHarnessClient(app.connection.harnessServerUrl())
      .browserPolicy.revoke(id)
      .then(() => {
        void refetchBrowserGrants()
        toast(t("Permission revoked"), "success")
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  const revokePermission = (id: string) =>
    void app.sessions.run(async (current) => {
      await current.permission.saved.remove({ id })
      void refetchSavedPermissions()
      return undefined
    }, t("Permission revoked"))

  const addMcp = (server: string, config: McpConfig, scope: McpScope) =>
    app.sessions.run(async (current) => {
      await current.mcp.add({ server, config, scope, directory: mcpDirectory() })
      void refetchMcp()
      void refetchMcpConfigs()
      void refetchMcpResources()
      return undefined
    }, t("MCP server added"))

  const removeMcp = (server: string) =>
    app.sessions.run(async (current) => {
      await current.mcp.remove({ server, directory: mcpDirectory() })
      void refetchMcp()
      void refetchMcpConfigs()
      void refetchMcpResources()
      return undefined
    }, t("MCP server removed"))

  const connectMcp = (server: string) =>
    app.sessions.run(async (current) => {
      await current.mcp.connect({ server, directory: mcpDirectory() })
      void refetchMcp()
      void refetchMcpResources()
      return undefined
    }, t("MCP server connected"))

  const disconnectMcp = (server: string) =>
    app.sessions.run(async (current) => {
      await current.mcp.disconnect({ server, directory: mcpDirectory() })
      void refetchMcp()
      void refetchMcpResources()
      return undefined
    }, t("MCP server disconnected"))

  /**
   * OAuth for a server that needs it (SE-2): the engine opens the authorization URL in the
   * reader's own browser — the only place carrying their session — and `authenticate` waits
   * for the engine's callback before the list is read again. No in-app window on top: it
   * would load the provider with no user context and only duplicate the browser tab.
   */
  const oauthMcp = (server: string) =>
    app.sessions.run(async (current) => {
      const started = (await current.mcp.authStart({ server, directory: mcpDirectory() })) as {
        authorizationUrl?: string
        code?: boolean
        instructions?: string
      }
      if (!started?.authorizationUrl) throw new Error(t("This server did not offer OAuth"))
      // On 2.x some providers show a code to paste back instead of calling the engine; the page is
      // already open, so what is left is asking for the code.
      if (started.code) return void setMcpCode({ server, instructions: started.instructions ?? "" })
      await current.mcp.authenticate({ server, directory: mcpDirectory() })
      void refetchMcp()
      void refetchMcpResources()
      toast(t("MCP server connected"), "success")
      return undefined
    })

  const [mcpCode, setMcpCode] = createSignal<{ server: string; instructions: string }>()
  const completeMcpCode = (code: string) => {
    const pending = mcpCode()
    if (!pending) return
    setMcpCode(undefined)
    void app.sessions.run(async (current) => {
      await current.mcp.authComplete({ server: pending.server, code, directory: mcpDirectory() })
      void refetchMcp()
      void refetchMcpResources()
      return undefined
    }, t("MCP server connected"))
  }

  const saveProvider = (providerID: string, key: string) =>
    app.sessions.run(async (current) => {
      await current.integration.connectKey({ integrationID: providerID, key, label: providerID }).catch(() => undefined)
      await current.auth.reload().catch(() => undefined)
      void refetchProviderDirectory()
      void refetchModelDirectory()
      void refetchModels()
      void refetchIntegrations()
      return undefined
    }, t("Provider saved"))

  const removeProvider = (providerID: string) =>
    app.sessions.run(async (current) => {
      const integrations = await current.integration.list()
      const integration = integrations.data.find((item) => item.id === providerID)
      for (const connection of integration?.connections ?? []) {
        if (connection.type !== "credential") continue
        await current.integration.disconnect(connection.id)
      }
      await current.auth.reload().catch(() => undefined)
      void refetchProviderDirectory()
      void refetchModelDirectory()
      void refetchModels()
      void refetchIntegrations()
      return undefined
    }, t("Provider removed"))

  const saveCustomProvider = (result: CustomProviderResult) =>
    app.sessions.run(async (current) => {
      const disabled = (await current.globalConfig()).disabled_providers ?? []
      await current.updateGlobalConfig(customProviderPayload(result, disabled))
      await current.reloadConfig(app.sessions.vcsDirectory() ? { directory: app.sessions.vcsDirectory()! } : undefined)
      if (result.key) {
        await current.integration
          .connectKey({ integrationID: result.providerID, key: result.key, label: result.providerID })
          .catch(() => undefined)
      }
      await current.auth.reload().catch(() => undefined)
      void refetchProviderDirectory()
      void refetchModelDirectory()
      void refetchModels()
      void refetchIntegrations()
      void refetchGlobalConfig()
      return undefined
    }, t("Provider saved"))

  const removeCustomProvider = (providerID: string) =>
    app.sessions.run(async (current) => {
      const integrations = await current.integration.list()
      const integration = integrations.data.find((item) => item.id === providerID)
      for (const connection of integration?.connections ?? []) {
        if (connection.type !== "credential") continue
        await current.integration.disconnect(connection.id)
      }
      const disabled = (await current.globalConfig()).disabled_providers ?? []
      await current.updateGlobalConfig({ disabled_providers: Array.from(new Set([...disabled, providerID])) })
      await current.reloadConfig(app.sessions.vcsDirectory() ? { directory: app.sessions.vcsDirectory()! } : undefined)
      await current.auth.reload().catch(() => undefined)
      void refetchProviderDirectory()
      void refetchModelDirectory()
      void refetchModels()
      void refetchIntegrations()
      void refetchGlobalConfig()
      return undefined
    }, t("Provider removed"))

  const startOAuth = (providerID: string, methodID?: string) =>
    app.connection
      .client()
      .integration.oauth({ integrationID: providerID, methodID, label: providerID })
      .then((result) => result.data)

  const oAuthStatus = (attemptID: string) =>
    app.connection
      .client()
      .integration.attempt.status(attemptID)
      .then((result) => result.data)

  const cancelOAuth = (attemptID: string) =>
    app.connection
      .client()
      .integration.attempt.cancel(attemptID)
      .then(() => undefined)

  const finishOAuth = () => {
    const refresh = () => {
      void app.connection
        .client()
        .auth.reload()
        .catch(() => undefined)
        .then(() => {
          void refetchProviderDirectory()
          void refetchModelDirectory()
          void refetchModels()
          void refetchIntegrations()
        })
    }
    refresh()
    // The engine marks the attempt complete just before persisting the
    // credential, so refresh again once it has landed.
    setTimeout(refresh, 800)
  }
  return {
    acknowledgeRuntime,
    adaptiveError,
    adaptiveSaving,
    adaptiveSettings,
    adaptiveVoi,
    adaptiveWarnings,
    addMcp,
    addSkillSource,
    agentFiles,
    agents,
    browserGrants,
    cancelOAuth,
    changeModelKey,
    commandFiles,
    commands,
    completeMcpCode,
    connectMcp,
    consoleActive,
    consoleOrgs,
    deleteAgent,
    deleteCommand,
    deleteSkillFile,
    disconnectMcp,
    engineConfig,
    engineTools,
    finishOAuth,
    folderAgents,
    globalConfig,
    integrations,
    mcp,
    mcpCode,
    mcpConfigs,
    mcpNeedingAuth,
    mcpResources,
    modelDirectory,
    modelList,
    models,
    oAuthStatus,
    oauthMcp,
    patchAdaptive,
    permissionPolicy,
    providerDirectory,
    readSkillFile,
    refetchEngineConfig,
    refetchGlobalConfig,
    refetchMcp,
    refetchMcpResources,
    refetchModelDirectory,
    refetchModels,
    refetchProviderDirectory,
    reloadEngineDefinitions,
    removeCustomProvider,
    removeMcp,
    removeProvider,
    removeSkillSource,
    revokeBrowserGrant,
    revokePermission,
    saveAgent,
    saveCommand,
    saveConfigRepo,
    saveCustomProvider,
    savePermissionPolicy,
    saveProvider,
    saveSkill,
    savedPermissions,
    setAgentsRefresh,
    setMcpCode,
    skillFiles,
    skillSources,
    skills,
    startOAuth,
    switchConsoleOrg,
  }
}

export type CatalogStore = ReturnType<typeof createCatalog>
