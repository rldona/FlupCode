import { PairingCard } from "../../components/PairingCard"
import { t } from "../../i18n"
import { toast } from "../../toast"
import { hostsHarnessToken } from "../../transport"
import type { AppStores } from "../../app-context"

/** A browser tab the harness refused can pair with a code (HE-01); the desktop hands its own token. */
export function pairingCard(app: AppStores) {
  return app.runs.harnessRefusal() && !hostsHarnessToken() ? (
    <PairingCard
      serverUrl={app.connection.harnessServerUrl()}
      onPaired={() => toast(t("This tab is paired with your computer"), "success")}
    />
  ) : undefined
}
