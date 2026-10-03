import { For, Show, lazy } from "solid-js"
import { searchForDecision } from "../../screen"
import { adaptiveSurfaces, createHarnessClient } from "../../client"
import { runAttention } from "../../attention"
import { promptHistory } from "../../prompt-history"
import { t } from "../../i18n"
import { HomeCanvas } from "../../components/HomeCanvas"
import { Composer } from "../../components/Composer"
import { BrowserApprovalDock, PermissionDock } from "../../components/PermissionDock"
import { QuestionDock } from "../../components/QuestionDock"
import { SessionView } from "../../components/SessionView"
import { ModelUnavailableDock } from "../../components/ModelUnavailableDock"
import { permissionMode } from "../../permission-modes"
import { GuardrailBanner } from "../../components/GuardrailBanner"
import { AdaptiveChip } from "../../components/AdaptiveChip"
import { RemoteHome } from "../../components/RemoteHome"
import { ChatHero, ChatStarters } from "../../components/ChatHome"
import { SessionTabs } from "../../components/SessionTabs"
import { PanelBoundary } from "../../components/PanelBoundary"
import { useApp } from "../../app-context"

const SplitPanes = lazy(() => import("./SplitPanes"))

/** The session column: the open session (or split panes) with its docks and composer, or the home. */
export function SessionColumn() {
  const app = useApp()
  return (
    <Show
      when={!app.sessions.splitActive() && !app.router.toolScreen()}
      fallback={
        // A tool screen replaces both branches: the split panes keep their state and return
        // when the screen is left.
        app.router.toolScreen() ? <></> : <SplitPanes />
      }
    >
      {/* The sessions open in this window (H-36). Hidden while split: the panes are the tabs then. */}
      <Show
        when={
          app.settings.sessionTabsEnabled() &&
          !app.settings.mobileRemote() &&
          app.sessions.selected() &&
          app.sessions.sessionTabs().length > 1
        }
      >
        <SessionTabs
          tabs={app.sessions.sessionTabList()}
          active={app.sessions.selected()}
          onSelect={app.sessions.selectSession}
          onClose={app.sessions.closeSessionTab}
        />
      </Show>
      <Show
        when={app.sessions.selected()}
        fallback={
          app.settings.mobileRemote() ? (
            app.sessions.mobileComposing() ? (
              <div class="fc-mobile-new">
                <p class="fc-onboarding-text">
                  {app.sessions.plainChatView()
                    ? t("Write a message to start a chat.")
                    : t("Describe a task to start a new session.")}
                </p>
              </div>
            ) : (
              <RemoteHome
                view={app.sessions.view()}
                onViewChange={app.sessions.changeView}
                viewActivity={app.sessions.viewActivity()}
                sessions={app.sessions.remoteSessions()}
                loading={app.sessions.sessions.loading}
                projects={app.sessions.projects()}
                runs={app.runs.remoteRuns()}
                runAttention={app.runs.runsAttention()}
                runsAvailable={app.runs.routinesServerAvailable()}
                onOpen={app.sessions.openMobileSession}
                onShowRuns={(runID) => {
                  app.runs.setRunFocus(runID ? { runID } : undefined)
                  app.router.showScreen("runs")
                }}
                onNew={app.sessions.startMobileSession}
                onAddDevice={() => app.router.setRemoteOpen(true)}
              />
            )
          ) : app.sessions.chatView() ? (
            <ChatHero displayName={app.settings.displayName()} />
          ) : (
            <HomeCanvas
              displayName={app.settings.displayName()}
              range={app.sessions.range()}
              usage={app.sessions.homeUsage()}
              stats={app.sessions.homeStats()}
              activity={app.sessions.activity()}
              activeSessions={app.sessions.activeSessions()}
              onOpenSession={app.sessions.selectSession}
              error={app.sessions.error()}
              onRangeChange={app.sessions.setRange}
            />
          )
        }
      >
        <PanelBoundary name={t("The conversation")}>
          <GuardrailBanner
            status={app.sessions.liveGuardrail()}
            onViewDecision={(decisionID) => app.router.showScreen("decisions", searchForDecision(decisionID))}
            onStopTurn={app.sessions.stopSession}
            onDismiss={() => app.sessions.setGuardrailDismissed(app.sessions.liveGuardrail()?.decisionID)}
          />
          <SessionView
            messages={app.sessions.activeMessages()}
            sessionKey={app.sessions.selected()}
            reveal={app.sessions.revealMessage()}
            onRevealed={() => app.sessions.setRevealMessage(undefined)}
            loading={app.sessions.messagesLoading()}
            busy={app.sessions.generating()}
            compacting={app.sessions.compacting()}
            retry={(() => {
              const sessionID = app.sessions.selected()
              return sessionID ? app.sessions.retryState()[sessionID] : undefined
            })()}
            outcome={(() => {
              const sessionID = app.sessions.selected()
              return sessionID ? app.sessions.runOutcomes()[sessionID] : undefined
            })()}
            usage={app.sessions.liveUsage()}
            startedAt={app.sessions.generationStartedAt()}
            modelName={app.composer.modelName}
            showTools={app.settings.showTools()}
            showReasoning={app.settings.showReasoning()}
            chat={app.sessions.plainChatView()}
            pending={app.sessions.pendingForSession()}
            onEditUser={app.sessions.editMessage}
            onForkUser={app.sessions.forkSession}
            onRetry={app.composer.retryTurn}
            onOpenSession={app.sessions.selectSession}
          />
        </PanelBoundary>
      </Show>
      <Show when={!app.settings.mobileRemote() || app.sessions.mobileScreen() === "session"}>
        <div class="fc-docks">
          <Show when={app.composer.missingModel()}>
            {(ref) => (
              <ModelUnavailableDock
                model={ref()}
                replacement={app.composer.missingModelReplacement()}
                disabled={app.sessions.generating()}
                onUse={(model) => app.composer.pickModel(model.providerID, model.id)}
                onChoose={() => app.router.setModelPickerOpen(true)}
              />
            )}
          </Show>
          <For each={app.sessions.permissionData}>
            {(request) => (
              <PermissionDock
                request={request}
                messages={app.sessions.activeMessages()}
                busy={app.sessions.busy()}
                onReply={(reply, message) => app.sessions.replyPermission(request, reply, message)}
              />
            )}
          </For>
          <For each={app.sessions.questionData}>
            {(request) => (
              <Show
                when={request.browser}
                fallback={
                  <QuestionDock
                    request={request}
                    busy={app.sessions.busy()}
                    onReply={(answers) => app.sessions.replyQuestion(request, answers)}
                    onReject={() => app.sessions.rejectQuestion(request)}
                  />
                }
              >
                {(approval) => (
                  <BrowserApprovalDock
                    request={request}
                    approval={approval()}
                    busy={app.sessions.busy()}
                    onAnswer={(label) => app.sessions.replyQuestion(request, [[label]])}
                  />
                )}
              </Show>
            )}
          </For>
        </div>
        <Composer
          variant={app.settings.mobileRemote() ? "mobile" : "desktop"}
          mode={app.sessions.view()}
          chatClass={app.sessions.composerChatClass()}
          onChatClassChange={app.sessions.changeChatClass}
          sessionOpen={!!app.sessions.selected()}
          value={app.composer.prompt()}
          sending={app.sessions.busy()}
          generating={!!app.sessions.selected() && app.sessions.generating()}
          compacting={app.sessions.compacting()}
          onStop={app.sessions.stopSession}
          models={app.catalog.modelList()}
          modelKey={app.composer.modelKey()}
          favorites={app.settings.favorites()}
          onModelChange={app.composer.pickModel}
          modelLabel={app.composer.modelLabel()}
          variants={app.composer.variants()}
          variantKey={app.composer.variantKey()}
          usage={app.composer.contextUsage()}
          spend={
            app.runs.routinesServerAvailable()
              ? {
                  report: app.composer.sessionSpend.report(),
                  failure: app.composer.sessionSpend.failure(),
                  refresh: app.composer.sessionSpend.refresh,
                }
              : undefined
          }
          repo={
            app.sessions.vcsDirectory() && app.sessions.codeChrome()
              ? {
                  directory: app.sessions.vcsDirectory()!,
                  branch: app.workspace.vcsInfo()?.branch,
                  additions: app.workspace.vcsTotals().additions,
                  deletions: app.workspace.vcsTotals().deletions,
                  onCommit: app.workspace.commitChanges,
                  onOpenChanges: app.workspace.openChanges,
                  onClose: app.sessions.selected() ? () => app.sessions.newSession() : undefined,
                  onClear:
                    !app.sessions.selected() && app.sessions.targetDirectory()
                      ? () => app.sessions.changeTargetDirectory(undefined)
                      : undefined,
                }
              : undefined
          }
          pullRequest={
            app.sessions.vcsDirectory() && app.sessions.codeChrome()
              ? {
                  state: app.workspace.branchState(),
                  creating: app.workspace.openingPullRequest(),
                  suggestedTitle: app.workspace.branchState()?.subject ?? app.workspace.branchState()?.branch ?? "",
                  onOpenPullRequest: app.workspace.openPullRequest,
                  onOpen: (url) => window.open(url, "_blank", "noopener,noreferrer"),
                  onCheckLog: (job) =>
                    createHarnessClient(app.connection.harnessServerUrl())
                      .git.checkLog(app.sessions.vcsDirectory() ?? "", job)
                      .then((log) => {
                        if (!log) throw new Error(t("Could not read that log"))
                        return log
                      }),
                  onAddChip: app.composer.addChip,
                }
              : undefined
          }
          attachments={app.composer.attachments()}
          chips={app.composer.chips()}
          onRemoveChip={app.composer.removeChip}
          onAddChips={app.composer.addChips}
          commands={app.composer.commandOptions()}
          projects={app.sessions.projects()}
          targetDirectory={app.sessions.targetDirectory() ?? app.sessions.selectedSession()?.location?.directory}
          agents={app.catalog.agents()?.data ?? []}
          artifacts={(app.workspace.artifactList() ?? []).flatMap((artifact) =>
            artifact.path || artifact.content
              ? [{ id: artifact.id, path: artifact.path, title: artifact.title, kind: artifact.kind }]
              : [],
          )}
          packs={app.composer.packs()}
          onSavePack={(refs) => app.composer.setPackRefs(refs)}
          agent={app.composer.agent()}
          permissionMode={app.composer.permissionModeId()}
          delivery={app.composer.delivery()}
          onDeliveryChange={app.composer.changeDelivery}
          suggestion={app.composer.currentSuggestion()}
          history={promptHistory()}
          onInput={(value) => {
            app.composer.setPrompt(value)
            if (value) app.composer.setSuggestion(undefined)
          }}
          onSend={app.composer.send}
          onCommandPick={(name) => app.composer.setPrompt(`/${name} `)}
          onCommandRun={(name) => {
            app.composer.setPrompt(`/${name} `)
            app.composer.send()
          }}
          onOpenModelPicker={() => app.router.setModelPickerOpen(true)}
          onVariantChange={app.composer.changeVariant}
          onAttach={app.composer.addAttachments}
          onRemoveAttachment={app.composer.removeAttachment}
          searchFiles={app.composer.searchFiles}
          onPasteText={app.composer.collapsePaste}
          onStash={() => app.composer.stashPrompt(app.composer.prompt(), true)}
          onTargetChange={app.sessions.changeComposerTarget}
          onOpenFolder={() => app.router.setFolderOpen(true)}
          onAgentChange={app.composer.changeAgent}
          onPermissionModeChange={app.composer.changePermissionMode}
          adaptiveChip={
            <Show
              when={
                app.sessions.selected() && adaptiveSurfaces(app.connection.harnessCapabilities()).session
                  ? app.sessions.selected()
                  : undefined
              }
            >
              {(sessionID) => (
                <AdaptiveChip
                  serverUrl={app.connection.harnessServerUrl()}
                  sessionID={sessionID()}
                  busy={app.sessions.generating()}
                  onWhy={app.router.showDecision}
                />
              )}
            </Show>
          }
        />
        <Show when={app.sessions.chatView() && !app.sessions.selected() && !app.settings.mobileRemote()}>
          <ChatStarters onPick={(text) => app.composer.setPrompt(text)} />
        </Show>
      </Show>
    </Show>
  )
}
