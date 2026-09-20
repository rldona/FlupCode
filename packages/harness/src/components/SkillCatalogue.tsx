import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { AgentFile, SkillFile } from "../types"
import type { SkillInfo } from "../engine-types"
import type { SkillSourceKind, SkillSources } from "../skill-sources"
import { skillAccess } from "../skill-access"

type SkillCatalogueProps = {
  open: boolean
  /** What is on disk, loaded or not. */
  files: SkillFile[]
  /** What the engine says it has, which includes ones with no file — the built-in one. */
  skills: SkillInfo[]
  loading: boolean
  /**
   * The engine's list is still on its way. Until it arrives an empty `skills` means "not asked yet",
   * not "the engine has nothing": a loaded file would otherwise flash as "written, and not picked up
   * yet" and be counted as a second `effect` row.
   */
  skillsLoading: boolean
  serverAvailable: boolean
  hasProject: boolean
  /** Extra places the engine reads skills from: folders and URLs (H-27). */
  sources: SkillSources
  /** Agent files, so each skill can say who loads it (SK-1, like H-34 does for MCP). */
  agents: AgentFile[]
  onAddSource: (kind: SkillSourceKind, value: string) => void
  onRemoveSource: (kind: SkillSourceKind, value: string) => void
  onRead: (path: string) => Promise<string>
  onSave: (draft: { name: string; scope: "global" | "project"; description: string; body: string }) => Promise<unknown>
  onDelete: (path: string) => Promise<unknown>
}

const WHERE: Record<SkillFile["scope"], string> = {
  global: "global",
  project: "project",
  claude: ".claude",
  agents: ".agents",
}

/** What the engine has that no file here explains: the built-in skill, and anything pulled from a URL. */
export function withoutFiles(skills: SkillInfo[], files: SkillFile[]) {
  const named = new Set(files.filter((file) => file.loaded).map((file) => file.name))
  return skills.filter((skill) => !named.has(skill.name))
}

/** The ones on disk that the engine would not load. The reason this screen exists. */
export const ignored = (files: SkillFile[]) => files.filter((file) => !file.loaded)

/**
 * Written correctly, and the engine still does not have it.
 *
 * Measured: the engine reads a folder's skills when it opens that folder, and a skill written after
 * that does not appear at all — not after a second, not after a minute. From the outside this is
 * identical to a skill with a mistake in it, so it is worth telling the two apart.
 */
export function notPickedUp(skills: SkillInfo[], files: SkillFile[]) {
  const has = new Set(skills.map((skill) => skill.name))
  return files.filter((file) => file.loaded && file.name && !has.has(file.name))
}

/**
 * Skills, and why yours is not showing up (H-27).
 *
 * The old screen was a list with an Insert button, which the audit called a placebo, and it was: it
 * could not answer the only question worth asking a skill screen — *"I wrote one and the model does
 * not have it"*. The engine drops a skill with no `name`, and one in a file not called `SKILL.md`,
 * and says nothing about either. Both are named here, with the file they are about.
 */
export const SkillCatalogue: Component<SkillCatalogueProps> = (props) => {
  const [openPath, setOpenPath] = createSignal<string>()
  const [content, setContent] = createSignal<string>()
  const [creating, setCreating] = createSignal(false)
  const [name, setName] = createSignal("")
  const [scope, setScope] = createSignal<"global" | "project">("project")
  const [description, setDescription] = createSignal("")
  const [body, setBody] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const [saved, setSaved] = createSignal<string>()
  const [confirming, setConfirming] = createSignal<string>()
  const [newPath, setNewPath] = createSignal("")
  const [newUrl, setNewUrl] = createSignal("")

  const read = (file: SkillFile) => {
    if (openPath() === file.path) {
      setOpenPath(undefined)
      return
    }
    setOpenPath(file.path)
    setContent(undefined)
    props
      .onRead(file.path)
      .then(setContent)
      .catch((cause) => setContent(cause instanceof Error ? cause.message : String(cause)))
  }

  const startNew = () => {
    setCreating(true)
    setOpenPath(undefined)
    setName("")
    setDescription("")
    setBody("")
    setProblem(undefined)
    setSaved(undefined)
    setScope(props.hasProject ? "project" : "global")
  }

  const save = async () => {
    setProblem(undefined)
    setSaved(undefined)
    if (!name().trim()) {
      setProblem(t("A skill needs a name"))
      return
    }
    setSaving(true)
    try {
      await props.onSave({ name: name().trim(), scope: scope(), description: description(), body: body() })
      // The form stays open on purpose: closing it here would unmount the line that says it worked,
      // and a save that looks like nothing happening is the bug this whole screen is about.
      setSaved(t("Written. The engine picks it up when this folder is opened again."))
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const loaded = createMemo(() => props.files.filter((file) => file.loaded))
  const notLoaded = createMemo(() => ignored(props.files))
  const access = createMemo(
    () =>
      new Map(
        skillAccess(
          props.files.filter((file) => file.loaded && file.name).map((file) => file.name!),
          props.agents,
        ).map((entry) => [entry.skill, entry.agents]),
      ),
  )
  const waiting = createMemo(() => (props.skillsLoading ? [] : notPickedUp(props.skills, props.files)))
  const orphans = createMemo(() => (props.skillsLoading ? [] : withoutFiles(props.skills, props.files)))

  createEffect(() => {
    if (!props.open) {
      setCreating(false)
      setOpenPath(undefined)
    }
  })

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Skills")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Automation")}</div>
            <h1>{t("Skills")}</h1>
            <p>{t("What the model can reach for, and what it cannot.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button fc-button-primary" type="button" onClick={startNew}>
              {t("New skill")}
            </button>
          </div>
        </div>

        <Show when={!props.serverAvailable}>
          <div class="fc-routines-notice">{t("The harness server is not reachable, so this is the last it said.")}</div>
        </Show>

        <div class="fc-context-screen">
          {/*
            First, because it is the answer to the only question this screen exists for. A skill the
            engine drops looks exactly like one nobody wrote.
          */}
          <Show when={notLoaded().length > 0}>
            <section class="fc-usage-block fc-skill-ignored">
              <h2>
                {t("On disk and not loaded")}
                <span class="fc-context-aside">{notLoaded().length}</span>
              </h2>
              <p class="fc-usage-note">{t("The engine skips these without saying anything. Here is what it wants.")}</p>
              <div class="fc-routine-cards">
                <For each={notLoaded()}>
                  {(file) => (
                    <div class="fc-routine-card fc-routine-card-static fc-skill-row">
                      <span class="fc-routine-card-content">
                        <strong title={file.path}>{file.path.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "")}</strong>
                        <small>{file.reason}</small>
                      </span>
                      <Show when={file.shadows}>
                        {(other) => (
                          <span class="fc-artifact-kind" title={other()}>
                            {t("already taken")}
                          </span>
                        )}
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>

          <Show when={waiting().length > 0}>
            <section class="fc-usage-block fc-skill-waiting">
              <h2>
                {t("Written, and not picked up yet")}
                <span class="fc-context-aside">{waiting().length}</span>
              </h2>
              <p class="fc-usage-note">
                {t("Nothing is wrong with these. The engine reads a folder's skills when it opens the folder.")}
              </p>
              <div class="fc-routine-cards">
                <For each={waiting()}>
                  {(file) => (
                    <div class="fc-routine-card fc-routine-card-static fc-skill-row">
                      <span class="fc-routine-card-content">
                        <strong>{file.name}</strong>
                        <small>{file.description}</small>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>

          {/*
            Configuration, not a diagnostic: it goes below the two lists that answer "why is mine
            not here", and above the loaded ones it explains (H-27).
          */}
          <section class="fc-usage-block fc-skill-sources">
            <h2>{t("Where else skills come from")}</h2>
            <p class="fc-usage-note">
              {t("A folder the engine also reads, or a URL it fetches from. This is configuration, so it applies everywhere.")}
            </p>
            <Show
              when={props.sources.paths.length + props.sources.urls.length > 0}
              fallback={<p class="fc-settings-hint">{t("Nothing added.")}</p>}
            >
              <For
                each={[
                  ...props.sources.paths.map((value) => ({ kind: "path" as const, value })),
                  ...props.sources.urls.map((value) => ({ kind: "url" as const, value })),
                ]}
              >
                {(source) => (
                  <div class="fc-usage-row fc-skill-row">
                    <span class="fc-diff-status">{source.kind === "url" ? "url" : "path"}</span>
                    <span class="fc-usage-key" title={source.value}>
                      {source.value}
                    </span>
                    <button
                      class="fc-button"
                      type="button"
                      onClick={() => props.onRemoveSource(source.kind, source.value)}
                    >
                      {t("Remove")}
                    </button>
                  </div>
                )}
              </For>
            </Show>
            <div class="fc-field-row">
              <label class="fc-field">
                <span>{t("Folder")}</span>
                <input
                  class="fc-question-custom"
                  placeholder="/home/me/my-skills"
                  value={newPath()}
                  onInput={(event) => setNewPath(event.currentTarget.value)}
                />
              </label>
              <button
                class="fc-button"
                type="button"
                disabled={!newPath().trim()}
                onClick={() => {
                  props.onAddSource("path", newPath())
                  setNewPath("")
                }}
              >
                {t("Add folder")}
              </button>
            </div>
            <div class="fc-field-row">
              <label class="fc-field">
                <span>{t("URL")}</span>
                <input
                  class="fc-question-custom"
                  placeholder="https://example.com/.well-known/skills/"
                  value={newUrl()}
                  onInput={(event) => setNewUrl(event.currentTarget.value)}
                />
              </label>
              <button
                class="fc-button"
                type="button"
                disabled={!newUrl().trim()}
                onClick={() => {
                  props.onAddSource("url", newUrl())
                  setNewUrl("")
                }}
              >
                {t("Add URL")}
              </button>
            </div>
          </section>

          <section class="fc-usage-block">
            <h2>
              {t("Loaded")}
              <span class="fc-context-aside">{loaded().length}</span>
            </h2>
            <Show
              when={loaded().length > 0}
              fallback={<p class="fc-usage-note">{props.loading ? t("Reading…") : t("None on disk.")}</p>}
            >
              <div class="fc-routine-cards">
                <For each={loaded()}>
                {(file) => (
                  <div class="fc-skill-file">
                    <button class="fc-routine-card fc-skill-row" type="button" onClick={() => read(file)}>
                      <span class="fc-routine-card-icon" aria-hidden="true">
                        ✦
                      </span>
                      <span class="fc-routine-card-content">
                        <strong>{file.name}</strong>
                        <small>{file.description ?? t("No description, so the model has nothing to choose it by")}</small>
                      </span>
                      <span class="fc-artifact-kind">{WHERE[file.scope]}</span>
                      <span class="fc-artifact-kind">{Math.max(1, Math.round(file.bytes / 102.4) / 10)} kB</span>
                    </button>
                    <Show when={file.name && (access().get(file.name) ?? []).length > 0}>
                      <p class="fc-mcp-access">
                        {t("Agents that load it: {agents}", { agents: (access().get(file.name!) ?? []).join(", ") })}
                      </p>
                    </Show>
                    <Show when={openPath() === file.path}>
                      <pre class="fc-pr-log">{content() ?? t("Reading…")}</pre>
                      <div class="fc-routines-header-actions">
                        <Show
                          when={confirming() === file.path}
                          fallback={
                            <button class="fc-button" type="button" onClick={() => setConfirming(file.path)}>
                              {t("Delete")}
                            </button>
                          }
                        >
                          <span class="fc-confirm-inline">
                            <span>{t("Delete {name}?", { name: file.name ?? file.path })}</span>
                            <button class="fc-button" type="button" onClick={() => setConfirming(undefined)}>
                              {t("Cancel")}
                            </button>
                            <button
                              class="fc-button fc-button-danger"
                              type="button"
                              onClick={async () => {
                                await props.onDelete(file.path)
                                setConfirming(undefined)
                                setOpenPath(undefined)
                              }}
                            >
                              {t("Delete")}
                            </button>
                          </span>
                        </Show>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
              </div>
            </Show>
          </section>

          <Show when={creating()}>
            <div class="fc-modal-backdrop" onClick={() => setCreating(false)}>
              <div
                class="fc-modal fc-form-modal fc-agent-form"
                role="dialog"
                aria-modal="true"
                aria-label={t("New skill")}
                onClick={(event) => event.stopPropagation()}
              >
                <div class="fc-modal-header">
                  <span>{t("New skill")}</span>
                  <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={() => setCreating(false)}>
                    ×
                  </button>
                </div>
                <p class="fc-modal-note">
                  {t("Written as the engine reads it: a folder of its own, a SKILL.md, and a name in its frontmatter.")}
                </p>
              <label class="fc-field">
                <span>{t("Name")}</span>
                <input
                  class="fc-question-custom"
                  value={name()}
                  onInput={(event) => setName(event.currentTarget.value)}
                  placeholder="reviewing"
                />
              </label>
              <label class="fc-field">
                <span>{t("Where")}</span>
                <select
                  class="fc-question-custom"
                  value={scope()}
                  onChange={(event) => setScope(event.currentTarget.value as "global" | "project")}
                >
                  <option value="project" disabled={!props.hasProject}>
                    {t("This project")}
                  </option>
                  <option value="global">{t("Everywhere")}</option>
                </select>
              </label>
              <label class="fc-field">
                <span>{t("Description")}</span>
                <input
                  class="fc-question-custom"
                  value={description()}
                  onInput={(event) => setDescription(event.currentTarget.value)}
                  placeholder={t("When the model should reach for it")}
                />
              </label>
              <label class="fc-field">
                <span>{t("Body")}</span>
                <textarea
                  class="fc-question-custom fc-agent-prompt"
                  rows={10}
                  value={body()}
                  onInput={(event) => setBody(event.currentTarget.value)}
                />
              </label>
              <Show when={problem()}>{(why) => <p class="fc-run-error">{why()}</p>}</Show>
              <Show when={saved()}>{(message) => <p class="fc-usage-note fc-agent-saved">{message()}</p>}</Show>
              <div class="fc-dialog-actions">
                <button class="fc-button" type="button" onClick={() => setCreating(false)}>
                  {t("Cancel")}
                </button>
                <button class="fc-button fc-button-primary" type="button" disabled={saving()} onClick={save}>
                  {saving() ? t("Saving…") : t("Save")}
                </button>
              </div>
              </div>
            </div>
          </Show>

          <Show when={orphans().length > 0}>
            <section class="fc-usage-block">
              <h2>
                {t("Not from a file here")}
                <span class="fc-context-aside">{orphans().length}</span>
              </h2>
              <p class="fc-usage-note">{t("The engine has these and no file on this machine explains them.")}</p>
              <div class="fc-routine-cards">
                <For each={orphans()}>
                  {(skill) => (
                    <div class="fc-routine-card fc-routine-card-static">
                      <span class="fc-routine-card-content">
                        <strong>{skill.name}</strong>
                        <small>{skill.description}</small>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </section>
    </Show>
  )
}
