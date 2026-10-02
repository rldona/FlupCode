import { Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { pairTab, type PairResult } from "../pairing"

/**
 * What a browser tab the harness refused shows (HE-01): what is missing, where the code comes from,
 * the one field to type it in, and the browser permission the request may ask for first.
 */
export const PairingCard: Component<{ serverUrl: string; onPaired: () => void }> = (props) => {
  const [code, setCode] = createSignal("")
  const [pairing, setPairing] = createSignal(false)
  const [failure, setFailure] = createSignal<Exclude<PairResult, "paired">>()

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!code().trim() || pairing()) return
    setPairing(true)
    setFailure(undefined)
    const result = await pairTab(props.serverUrl, code())
    setPairing(false)
    if (result === "paired") return props.onPaired()
    setFailure(result)
  }

  return (
    <section class="fc-pairing" aria-labelledby="fc-pairing-title">
      <h2 id="fc-pairing-title" class="fc-pairing-title">
        {t("Pair this tab with your computer")}
      </h2>
      <p class="fc-pairing-text">
        {t(
          "The harness on this computer answered, but this tab is not paired with it, so runs, routines and artifacts stay hidden here.",
        )}
      </p>
      <p class="fc-pairing-text">
        {t("Run flupcode serve in a terminal, or flupcode pair while it runs, and type the code it prints.")}
      </p>
      <form class="fc-pairing-form" onSubmit={(event) => void submit(event)}>
        <label class="fc-pairing-label" for="fc-pairing-code">
          {t("Pairing code")}
        </label>
        <div class="fc-pairing-row">
          <input
            id="fc-pairing-code"
            class="fc-question-custom fc-pairing-input"
            value={code()}
            placeholder="ABCD-2345"
            autocomplete="one-time-code"
            autocapitalize="characters"
            spellcheck={false}
            onInput={(event) => setCode(event.currentTarget.value)}
          />
          <button class="fc-button fc-button-primary" type="submit" disabled={pairing() || !code().trim()}>
            {pairing() ? t("Pairing…") : t("Pair")}
          </button>
        </div>
      </form>
      <Show when={failure()}>
        {(reason) => (
          <p class="fc-pairing-error" role="alert">
            {reason() === "invalid_code"
              ? t("That code is wrong, used or expired. flupcode pair prints a new one.")
              : reason() === "rate_limited"
                ? t("Too many wrong codes. Wait a minute and try again.")
                : t("The harness on this computer did not answer. Is flupcode serve running?")}
          </p>
        )}
      </Show>
      <p class="fc-pairing-note">
        {t(
          "Chrome may ask to let this site access apps and devices on your local network. Allow it: that is how this tab reaches the harness on this computer.",
        )}
      </p>
    </section>
  )
}
