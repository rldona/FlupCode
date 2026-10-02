import { ExportDialog } from "../../components/ExportDialog"
import { sessionTitle } from "../../session-title"
import { t } from "../../i18n"
import { useApp } from "../../app-context"

/** Exporting or sharing the open conversation (H-35). */
export default function ExportRoute() {
  const app = useApp()
  return (
    <ExportDialog
      open={app.router.exportOpen()}
      title={sessionTitle(app.sessions.selectedSession()) || t("This conversation")}
      canShare={app.connection.supports("shares")}
      onExport={app.sessions.runExport}
      onShare={app.sessions.runShare}
      onClose={() => app.router.setExportOpen(false)}
    />
  )
}
