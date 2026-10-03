import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { createResource } from "../resource"
import { formatDateTime } from "../dates"
import { adaptiveSurfaces, createHarnessClient } from "../client"
import type { AgentFile, LearnedSkill, LearnedSkillState, SkillFile, SkillProposal } from "../types"
import type { SkillInfo } from "../engine-types"
import type { SkillSourceKind, SkillSources } from "../skill-sources"
import { skillAccess } from "../skill-access"
import { PanelFailure } from "./PanelBoundary"
import { ConfirmDialog } from "./ConfirmDialog"
import { Modal, ModalClose } from "./Modal"
import { Icon } from "./Icon"

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
  /** The harness server and the project folder, for the read-only learning audit (FH-073). */
  serverUrl: string
  projectID?: string
  capabilities: string[]
  /** Only the desktop app can open a local file; a browser reads a learned skill in place instead. */
  canOpenFiles: boolean
  onOpenInEditor: (path: string) => void
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

/** What the lifecycle calls a learned skill's state, as the catalogue shows it (FH-073). */
export const learnedStateLabel = (state: LearnedSkillState | undefined): string =>
  state ? state.charAt(0).toUpperCase() + state.slice(1) : "Probation"

/** What became of a proposal, as the catalogue shows it (FH-073). */
export const proposalStatusLabel = (status: SkillProposal["status"]): string =>
  status.charAt(0).toUpperCase() + status.slice(1)

/**
 * Why the harness refused a proposal on its own (AH-F04), in plain words; `undefined` for any other
 * reason, which the catalogue shows as it is. The keys are the content-filter rule ids the server
 * records on the proposal.
 */
const AUTOMATIC_REJECTIONS: Record<string, string> = {
  "unsafe-shell-pipe": "it runs code downloaded from the internet",
  "unverified-url": "it links to a page the session never visited",
  "overrides-judgement": "it tells the assistant to act without asking",
  "permission-change": "it tries to give the assistant more permissions",
}

export const automaticRejection = (proposal: Pick<SkillProposal, "status" | "reason">): string | undefined =>
  proposal.status === "rejected" && proposal.reason ? AUTOMATIC_REJECTIONS[proposal.reason] : undefined

/** A learned skill's badge: "Disabled" when a person turned it off, otherwise its lifecycle state. */
export const learnedSkillLabel = (skill: Pick<LearnedSkill, "state" | "disabled">): string =>
  skill.disabled ? "Disabled" : learnedStateLabel(skill.state)

export type LearnedAction = "disable" | "enable" | "archive"

/**
 * What a person can do to an installed learned skill (AH-E04): disable or enable it, and archive it
 * from either place — only when the server announced the actions, which it does only with its bearer.
 */
export const learnedSkillActions = (
  skill: Pick<LearnedSkill, "disabled">,
  surfaces: { manageSkills: boolean },
): LearnedAction[] => (surfaces.manageSkills ? [skill.disabled ? "enable" : "disable", "archive"] : [])

/**
 * The confirmation of each action, in terms of what changes for the person — whether new sessions are
 * offered the skill, and where its file goes — never the route or the field it writes.
 */
export const learnedActionCopy = (action: LearnedAction | "reject") =>
  ({
    disable: {
      title: "Disable learned skill",
      message:
        "The skill will no longer be offered in new sessions of this project. Its file is kept, and you can enable it again.",
      confirmLabel: "Disable",
    },
    enable: {
      title: "Enable learned skill",
      message: "The skill will be offered again in new sessions of this project.",
      confirmLabel: "Enable",
    },
    archive: {
      title: "Archive learned skill",
      message:
        "The skill will no longer be offered in new sessions and leaves this list. Its file moves to the project's archive; nothing is deleted.",
      confirmLabel: "Archive",
    },
    reject: {
      title: "Reject proposal",
      message: "The skill will not be installed and the agent will never see it. The proposal is closed as rejected.",
      confirmLabel: "Reject",
    },
  })[action]

/**
 * Whether a proposal gets Approve / Reject (AH-A04): only a staged one, and only when the server
 * announced the review, which it does only when its writer's bearer exists.
 */
export const reviewable = (proposal: SkillProposal, surfaces: { review: boolean }): boolean =>
  surfaces.review && proposal.status === "proposed"

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

  /**
   * Adding a folder: the desktop app can open the OS picker, so the button does that and there is no
   * box to type in. In a browser there is no picker, so the box stays and the button reads it.
   */
  const nativeFolderPicker = () =>
    typeof window !== "undefined" && typeof window.flupcode?.chooseFolder === "function"
  const chooseFolder = async () => {
    if (nativeFolderPicker()) {
      const picked = await window.flupcode?.chooseFolder?.()
      if (picked) props.onAddSource("path", picked)
      return
    }
    if (!newPath().trim()) return
    props.onAddSource("path", newPath())
    setNewPath("")
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

  // The learning audit (FH-073): what a reflection drafted and what the curator installed. A staged
  // proposal is only installed when a person approves it here (AH-A04), and an installed skill is
  // disabled, enabled or archived here too (AH-E04). Merging is a later phase, so nothing promises it.
  const learning = () => adaptiveSurfaces(props.capabilities)
  const [proposals, proposalActions] = createResource(
    () => (props.open && learning().proposals && props.projectID ? props.projectID : undefined),
    (projectID) => createHarnessClient(props.serverUrl).adaptive.proposals.list({ projectID }),
  )
  const [learned, learnedActions] = createResource(
    () => (props.open && learning().learnedSkills && props.projectID ? props.projectID : undefined),
    (projectID) => createHarnessClient(props.serverUrl).adaptive.learnedSkills.list({ projectID }),
  )
  const [reviewing, setReviewing] = createSignal<SkillProposal>()
  const [reviewBusy, setReviewBusy] = createSignal<string>()
  const [reviewProblem, setReviewProblem] = createSignal<string>()
  const review = (proposal: SkillProposal, action: "approve" | "reject") => {
    setReviewing(undefined)
    setReviewBusy(proposal.id)
    setReviewProblem(undefined)
    const client = createHarnessClient(props.serverUrl).adaptive.proposals
    void (action === "approve" ? client.approve(proposal.id) : client.reject(proposal.id))
      .catch((error: unknown) => setReviewProblem(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        setReviewBusy(undefined)
        // A refused approval can still have changed the row (a stale proposal is closed), so both reread.
        void proposalActions.refetch()
        void learnedActions.refetch()
      })
  }

  const [rejecting, setRejecting] = createSignal<SkillProposal>()
  const [acting, setActing] = createSignal<{ skill: LearnedSkill; action: LearnedAction }>()
  const [actionBusy, setActionBusy] = createSignal<string>()
  const [actionProblem, setActionProblem] = createSignal<string>()
  const act = (skill: LearnedSkill, action: LearnedAction) => {
    const projectID = props.projectID
    setActing(undefined)
    if (!projectID) return
    setActionBusy(skill.name)
    setActionProblem(undefined)
    void createHarnessClient(props.serverUrl)
      .adaptive.learnedSkills.act(skill.name, action, projectID)
      .catch((error: unknown) => setActionProblem(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        setActionBusy(undefined)
        void learnedActions.refetch()
      })
  }
  // "Open file" hands the path to the editor where the desktop bridge exists; a browser cannot open a
  // local file, so there the skill's text is read from the harness and shown in place.
  const [shown, setShown] = createSignal<{ name: string; body?: string }>()
  const openSkill = (skill: LearnedSkill) => {
    if (props.canOpenFiles && skill.path) {
      props.onOpenInEditor(skill.path)
      return
    }
    if (shown()?.name === skill.name || !props.projectID) {
      setShown(undefined)
      return
    }
    setShown({ name: skill.name })
    const settle = (body: string) => setShown((current) => (current?.name === skill.name ? { name: skill.name, body } : current))
    createHarnessClient(props.serverUrl)
      .adaptive.learnedSkills.get(skill.name, { projectID: props.projectID })
      .then((detail) => settle(detail.body ?? ""))
      .catch((error: unknown) => settle(error instanceof Error ? error.message : String(error)))
  }
  const pendingConfirm = () => {
    const pending = acting()
    if (pending) return { name: pending.skill.name, ...learnedActionCopy(pending.action) }
    const proposal = rejecting()
    if (proposal) return { name: proposal.name ?? proposal.targetSkill ?? proposal.id, ...learnedActionCopy("reject") }
    return undefined
  }

  createEffect(() => {
    if (!props.open) {
      setCreating(false)
      setOpenPath(undefined)
      setShown(undefined)
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
              <Show when={!nativeFolderPicker()}>
                <label class="fc-field">
                  <span>{t("Folder")}</span>
                  <input
                    class="fc-question-custom"
                    placeholder="/home/me/my-skills"
                    value={newPath()}
                    onInput={(event) => setNewPath(event.currentTarget.value)}
                  />
                </label>
              </Show>
              <button
                class="fc-button"
                type="button"
                disabled={!nativeFolderPicker() && !newPath().trim()}
                onClick={() => void chooseFolder()}
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
                        <Icon name="sparkle" />
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
                  </div>
                )}
              </For>
              </div>
              {/* Read in a dialog: a SKILL.md is prose, and under its row it was cramped. */}
              <Show when={props.files.find((file) => file.path === openPath())}>
                {(file) => (
                  <Modal
                    onClose={() => setOpenPath(undefined)}
                    class="fc-modal fc-form-modal"
                    label={file().name ?? file().path}
                  >
                    <div class="fc-modal-header">
                      <span class="fc-modal-heading">{file().name ?? file().path}</span>
                      <ModalClose />
                    </div>
                    <div class="fc-modal-body">
                      <pre class="fc-pr-log">{content() ?? t("Reading…")}</pre>
                    </div>
                    <div class="fc-dialog-actions">
                      <Show
                        when={confirming() === file().path}
                        fallback={
                          <button class="fc-button" type="button" onClick={() => setConfirming(file().path)}>
                            {t("Delete")}
                          </button>
                        }
                      >
                        <span class="fc-confirm-inline">
                          <span>{t("Delete {name}?", { name: file().name ?? file().path })}</span>
                          <button class="fc-button" type="button" onClick={() => setConfirming(undefined)}>
                            {t("Cancel")}
                          </button>
                          <button
                            class="fc-button fc-button-danger"
                            type="button"
                            onClick={async () => {
                              await props.onDelete(file().path)
                              setConfirming(undefined)
                              setOpenPath(undefined)
                            }}
                          >
                            {t("Delete")}
                          </button>
                        </span>
                      </Show>
                    </div>
                  </Modal>
                )}
              </Show>
            </Show>
          </section>

          <Modal
            open={creating()}
            onClose={() => setCreating(false)}
            class="fc-modal fc-form-modal fc-agent-form"
            label={t("New skill")}
          >
              <div class="fc-modal-header">
                <span>{t("New skill")}</span>
                <ModalClose />
              </div>
              <div class="fc-modal-body">
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
            </div>
            <div class="fc-dialog-actions">
              <button class="fc-button" type="button" onClick={() => setCreating(false)}>
                {t("Cancel")}
              </button>
              <button class="fc-button fc-button-primary" type="button" disabled={saving()} onClick={save}>
                {saving() ? t("Saving…") : t("Save")}
              </button>
            </div>
          </Modal>

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

          <Show when={learning().proposals || learning().learnedSkills}>
            <section class="fc-usage-block fc-skill-learned">
              <h2>{t("Learned")}</h2>
              <p class="fc-usage-note">
                {t(
                  "Skills the harness proposed from past sessions, and what became of each. Nothing is installed until a person approves it.",
                )}
              </p>
              <Show when={!props.projectID}>
                <div class="fc-settings-hint">{t("Open a project to see what it learned.")}</div>
              </Show>

              <Show when={learning().learnedSkills}>
                <h3 class="fc-settings-subtitle">
                  {t("Learned skills")}
                  <Show when={(learned()?.length ?? 0) > 0}>
                    <span class="fc-context-aside">{learned()!.length}</span>
                  </Show>
                </h3>
                <Show when={!learned.loading && learned.failure()}>
                  {(error) => (
                    <PanelFailure
                      inline
                      title={t("{name} could not be read", { name: t("The learned skills") })}
                      error={error()}
                      onRetry={() => void learnedActions.refetch()}
                    />
                  )}
                </Show>
                <Show
                  when={(learned()?.length ?? 0) > 0}
                  fallback={
                    <Show when={!learned.failure() || learned.loading}>
                      <p class="fc-usage-note">{learned.loading ? t("Reading…") : t("None yet.")}</p>
                    </Show>
                  }
                >
                  <div class="fc-routine-cards">
                    <For each={learned()}>
                      {(skill) => (
                        <div class="fc-routine-card fc-routine-card-static fc-skill-row">
                          <span class="fc-routine-card-content">
                            <strong dir="auto">{skill.name}</strong>
                            <small dir="auto">{skill.description}</small>
                          </span>
                          <span class="fc-artifact-kind" dir="ltr">
                            {t(learnedSkillLabel(skill))}
                          </span>
                          <Show when={skill.usage}>
                            {(usage) => (
                              <span class="fc-context-aside">
                                {t("Used in {used} of {sessions} sessions", {
                                  used: usage().load,
                                  sessions: usage().opportunities,
                                })}
                              </span>
                            )}
                          </Show>
                          <Show when={skill.suggestArchive && !skill.disabled}>
                            <span class="fc-context-aside fc-skill-archive-hint">
                              {t("Unused in {count} sessions · Archive?", { count: skill.sessionsSinceUse ?? 0 })}
                            </span>
                          </Show>
                          <span class="fc-skill-review-actions">
                            <Show when={skill.path}>
                              <button
                                class="fc-button"
                                type="button"
                                aria-expanded={props.canOpenFiles ? undefined : shown()?.name === skill.name}
                                onClick={() => openSkill(skill)}
                              >
                                {t("Open file")}
                              </button>
                            </Show>
                            <For each={learnedSkillActions(skill, learning())}>
                              {(action) => (
                                <button
                                  class="fc-button"
                                  type="button"
                                  disabled={actionBusy() === skill.name}
                                  onClick={() => setActing({ skill, action })}
                                >
                                  {t(learnedActionCopy(action).confirmLabel)}
                                </button>
                              )}
                            </For>
                          </span>
                          <Show when={shown()?.name === skill.name}>
                            <pre class="fc-pr-log fc-skill-learned-body" dir="auto">
                              {shown()?.body ?? t("Reading…")}
                            </pre>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={actionProblem()}>
                  {(problem) => (
                    <p class="fc-run-error" role="alert">
                      {t("The learned skill could not be changed: {reason}", { reason: problem() })}
                    </p>
                  )}
                </Show>
              </Show>

              <Show when={learning().proposals}>
                <h3 class="fc-settings-subtitle">
                  {t("Proposals")}
                  <Show when={(proposals()?.length ?? 0) > 0}>
                    <span class="fc-context-aside">{proposals()!.length}</span>
                  </Show>
                </h3>
                <Show when={!proposals.loading && proposals.failure()}>
                  {(error) => (
                    <PanelFailure
                      inline
                      title={t("{name} could not be read", { name: t("The proposals") })}
                      error={error()}
                      onRetry={() => void proposalActions.refetch()}
                    />
                  )}
                </Show>
                <Show
                  when={(proposals()?.length ?? 0) > 0}
                  fallback={
                    <Show when={!proposals.failure() || proposals.loading}>
                      <p class="fc-usage-note">{proposals.loading ? t("Reading…") : t("No proposals yet.")}</p>
                    </Show>
                  }
                >
                  <div class="fc-routine-cards">
                    <For each={proposals()}>
                      {(proposal: SkillProposal) => (
                        <div class="fc-routine-card fc-routine-card-static fc-skill-row">
                          <span class="fc-routine-card-content">
                            <strong dir="auto">{proposal.name ?? proposal.targetSkill ?? proposal.id}</strong>
                            <small dir="auto">
                              {proposal.intent} · {formatDateTime(proposal.updatedAt)}
                            </small>
                            <Show when={proposal.reason}>
                              {(reason) => (
                                <small dir="auto">
                                  <Show when={automaticRejection(proposal)} fallback={reason()}>
                                    {(why) => t("Rejected automatically: {reason}", { reason: t(why()) })}
                                  </Show>
                                </small>
                              )}
                            </Show>
                          </span>
                          <span class="fc-artifact-kind" dir="ltr">
                            {t(proposalStatusLabel(proposal.status))}
                          </span>
                          <Show when={reviewable(proposal, learning())}>
                            <span class="fc-skill-review-actions">
                              <button
                                class="fc-button"
                                type="button"
                                disabled={reviewBusy() === proposal.id}
                                onClick={() => setReviewing(proposal)}
                              >
                                {t("Approve")}
                              </button>
                              <button
                                class="fc-button"
                                type="button"
                                disabled={reviewBusy() === proposal.id}
                                onClick={() => setRejecting(proposal)}
                              >
                                {t("Reject")}
                              </button>
                            </span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={reviewProblem()}>
                  {(problem) => (
                    <p class="fc-run-error" role="alert">
                      {t("The proposal could not be reviewed: {reason}", { reason: problem() })}
                    </p>
                  )}
                </Show>
                <ConfirmDialog
                  open={reviewing() !== undefined}
                  title={t("Review a learned skill")}
                  message={t("Install this learned skill? The agent will see it in every session of this project.")}
                  confirmLabel={t("Install")}
                  onClose={() => setReviewing(undefined)}
                  onConfirm={() => {
                    const proposal = reviewing()
                    if (proposal) review(proposal, "approve")
                  }}
                >
                  <div class="fc-skill-review" dir="auto">
                    <strong>{reviewing()?.name ?? reviewing()?.targetSkill}</strong>
                    <p class="fc-confirm-message">{reviewing()?.description}</p>
                    <pre class="fc-pr-log">{reviewing()?.body}</pre>
                  </div>
                </ConfirmDialog>
              </Show>
              <ConfirmDialog
                open={pendingConfirm() !== undefined}
                title={t(pendingConfirm()?.title ?? "")}
                message={t(pendingConfirm()?.message ?? "")}
                confirmLabel={t(pendingConfirm()?.confirmLabel ?? "")}
                onClose={() => {
                  setActing(undefined)
                  setRejecting(undefined)
                }}
                onConfirm={() => {
                  const pending = acting()
                  const proposal = rejecting()
                  setRejecting(undefined)
                  if (pending) act(pending.skill, pending.action)
                  if (proposal) review(proposal, "reject")
                }}
              >
                <strong class="fc-skill-review" dir="auto">
                  {pendingConfirm()?.name}
                </strong>
              </ConfirmDialog>
            </section>
          </Show>
        </div>
      </section>
    </Show>
  )
}
