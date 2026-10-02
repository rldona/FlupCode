import { Show, createMemo, lazy, type JSX } from "solid-js"
import { rememberModelSwitch } from "../../model-switch"
import { externalLinkOrigin, openExternalUrl, rememberExternalLinkOrigin } from "../../external-links"
import { t } from "../../i18n"
import { ImagePreview } from "../../image-preview"
import { Toaster } from "../../toast"
import { ModelPicker } from "../../components/ModelPicker"
import { ModelSwitchDialog } from "../../components/ModelSwitchDialog"
import { RenameDialog } from "../../components/RenameDialog"
import { TagsDialog } from "../../components/TagsDialog"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import { ExternalLinkDialog } from "../../components/ExternalLinkDialog"
import { McpAuthNotice } from "../../components/McpAuthNotice"
import { Onboarding } from "../../components/Onboarding"
import { desktopRemote, remote } from "../../remote"
import { useApp } from "../../app-context"
import PaletteRoute from "./PaletteRoute"

const AboutRoute = lazy(() => import("../settings/AboutRoute"))
const StashRoute = lazy(() => import("../composer/StashRoute"))
const ExportRoute = lazy(() => import("../sessions/ExportRoute"))
const WorkflowLaunchRoute = lazy(() => import("../runs/WorkflowLaunchRoute"))
const BestOfNRoute = lazy(() => import("../runs/BestOfNRoute"))
const SettingsRoute = lazy(() => import("../settings/SettingsRoute"))
const FilesRoute = lazy(() => import("../workspace/FilesRoute"))
const FolderRoute = lazy(() => import("../composer/FolderRoute"))
const RemoteRoute = lazy(() => import("../settings/RemoteRoute"))
const SkillPickerRoute = lazy(() => import("../catalog/SkillPickerRoute"))
const MemoryRoute = lazy(() => import("../workspace/MemoryRoute"))
const ConfigRoute = lazy(() => import("../catalog/ConfigRoute"))
const ConfigFilesRoute = lazy(() => import("../catalog/ConfigFilesRoute"))

/**
 * The dialogs, drawn over every screen, in the order they stack: a later one opens over an earlier one.
 *
 * The ones a reader opens now and then load the first time they open, and stay mounted from then on,
 * as they were when they were part of the main bundle.
 */
export function Dialogs() {
  const app = useApp()
  return (
    <>
      {/* Opened from the keyboard at any moment, so it is ready before it is asked for. */}
      <PaletteRoute />
      <ModelPicker
        open={app.router.modelPickerOpen()}
        models={app.catalog.modelList()}
        loading={app.catalog.models.loading}
        selectedKey={app.composer.modelKey()}
        favorites={app.settings.favorites()}
        onSelect={app.composer.pickModel}
        onToggleFavorite={app.settings.toggleFavoriteModel}
        onRetry={() => void app.catalog.refetchModels()}
        onClose={() => app.router.setModelPickerOpen(false)}
      />
      <Lazily when={app.router.aboutOpen()}>
        <AboutRoute />
      </Lazily>
      <Lazily when={app.router.stashOpen()}>
        <StashRoute />
      </Lazily>
      <Lazily when={app.router.exportOpen()}>
        <ExportRoute />
      </Lazily>
      <RenameDialog
        open={!!app.catalog.mcpCode()}
        title={t("Sign in to {server}", { server: app.catalog.mcpCode()?.server ?? "" })}
        description={app.catalog.mcpCode()?.instructions || t("Paste the code the sign-in page showed you.")}
        placeholder={t("Code")}
        initial=""
        onSave={app.catalog.completeMcpCode}
        onClose={() => app.catalog.setMcpCode(undefined)}
      />
      <RenameDialog
        open={!!app.router.renameTarget()}
        title={t("Rename")}
        initial={app.router.renameTarget()?.title ?? ""}
        onSave={app.sessions.commitRename}
        onClose={() => app.router.setRenameTarget(undefined)}
      />
      <RenameDialog
        open={!!app.composer.packRefs()}
        title={t("Name this pack")}
        initial=""
        onSave={app.composer.savePack}
        onClose={() => app.composer.setPackRefs(undefined)}
      />
      <Lazily when={!!app.runs.launching()}>
        <WorkflowLaunchRoute />
      </Lazily>
      <Lazily when={app.router.bestOfNOpen()}>
        <BestOfNRoute />
      </Lazily>
      <TagsDialog
        open={!!app.router.tagsTarget()}
        title={
          app.router.tagsTarget()?.title ? t("Tags · {name}", { name: app.router.tagsTarget()!.title }) : t("Tags")
        }
        initial={app.router.tagsTarget()?.tags ?? []}
        onSave={(tags) => {
          const target = app.router.tagsTarget()
          if (target) app.sessions.setTags(target.id, tags)
          app.router.setTagsTarget(undefined)
        }}
        onClose={() => app.router.setTagsTarget(undefined)}
      />
      <ExternalLinkDialog
        url={app.router.externalLink()}
        onCancel={() => app.router.setExternalLink(undefined)}
        onOpen={(remember) => {
          const url = app.router.externalLink()
          if (!url) return
          if (remember) {
            const origin = externalLinkOrigin(url)
            if (origin) rememberExternalLinkOrigin(origin)
          }
          app.router.setExternalLink(undefined)
          openExternalUrl(url)
        }}
      />
      <ConfirmDialog
        open={!!app.router.confirmTarget()}
        title={app.router.confirmTarget()?.title ?? ""}
        message={app.router.confirmTarget()?.message ?? ""}
        confirmLabel={app.router.confirmTarget()?.confirmLabel}
        onConfirm={() => app.router.confirmTarget()?.onConfirm()}
        onClose={() => app.router.setConfirmTarget(undefined)}
      />
      <Lazily when={app.router.settingsOpen()}>
        <SettingsRoute />
      </Lazily>
      <Lazily when={app.router.filesOpen()}>
        <FilesRoute />
      </Lazily>
      <Lazily when={app.router.folderOpen()}>
        <FolderRoute />
      </Lazily>
      <Onboarding
        open={
          !app.settings.onboarded() && !remote.activeHost() && !remote.pairing() && remote.status() !== "connecting"
        }
        remoteClient={!desktopRemote()}
        onRemote={(name) => {
          app.settings.completeOnboarding(name)
          app.router.setRemoteOpen(true)
        }}
        serverHealthy={app.connection.health()?.healthy}
        serverBlocked={app.connection.health()?.blocked === true}
        serverAuthRequired={app.connection.serverAuthRequired()}
        localNetwork={app.connection.localNetwork()}
        allowingLocalNetwork={app.connection.allowingLocalNetwork()}
        onAllowLocalNetwork={() => void app.connection.allowLocalNetwork()}
        serverInput={app.connection.serverInput()}
        onServerInput={app.connection.setServerInput}
        onConnect={() => {
          app.connection.commitServer()
          void app.connection.refetchHealth()
        }}
        onDone={app.settings.completeOnboarding}
      />
      <Lazily when={app.router.remoteOpen()}>
        <RemoteRoute />
      </Lazily>
      <Lazily when={app.router.skillsOpen()}>
        <SkillPickerRoute />
      </Lazily>
      <Lazily when={app.router.memoryOpen()}>
        <MemoryRoute />
      </Lazily>
      <Lazily when={app.router.configOpen()}>
        <ConfigRoute />
      </Lazily>
      <Lazily when={app.router.configFilesOpen()}>
        <ConfigFilesRoute />
      </Lazily>
      <ImagePreview />
      {/* Drawn last: the warning opens over the modal that asked for the change (Customize, the picker). */}
      <ModelSwitchDialog
        open={!!app.composer.pendingModelSwitch()}
        from={app.composer.pendingModelSwitch()?.from ?? ""}
        to={app.composer.pendingModelSwitch()?.to ?? ""}
        onCancel={() => app.composer.setPendingModelSwitch(undefined)}
        onConfirm={(skipNextTime) => {
          const pending = app.composer.pendingModelSwitch()
          if (!pending) return
          rememberModelSwitch(skipNextTime)
          app.composer.setPendingModelSwitch(undefined)
          app.composer.applyModel(pending.next.providerID, pending.next.id)
        }}
      />
      {/* A nudge on the home screen only, and only for servers the engine says need OAuth. */}
      <Show
        when={
          app.settings.onboarded() &&
          !app.settings.mobileRemote() &&
          !app.sessions.selected() &&
          !app.settings.mcpAuthNoticeDismissed() &&
          app.catalog.mcpNeedingAuth().length > 0
        }
      >
        <McpAuthNotice
          servers={app.catalog.mcpNeedingAuth()}
          busy={app.sessions.busy()}
          onAuthenticate={app.catalog.oauthMcp}
          onOpenSettings={() => app.router.openSettings("mcp")}
          onDismiss={() => app.settings.setMcpAuthNoticeDismissed(true)}
        />
      </Show>
      <Toaster />
    </>
  )
}

/** Mounts its children the first time `when` holds, and keeps them mounted from then on. */
function Lazily(props: { when: boolean; children: JSX.Element }) {
  const opened = createMemo((was: boolean) => was || props.when, false)
  return <Show when={opened()}>{props.children}</Show>
}
