import { Effect } from "effect"
import { effectCmd, CliError } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    // A port already taken is the ordinary way this fails, and the listener's own error says only
    // `ServeError`, which the CLI then reports as an unexpected one. Name the address instead.
    const server = yield* Effect.tryPromise({
      try: () => Server.listen(opts),
      catch: () =>
        new CliError({
          message: [
            `Could not listen on ${opts.hostname}${opts.port === 0 ? "" : `:${opts.port}`}.`,
            "Another process may already be using that port: stop it, or serve on another one with --port.",
          ].join(" "),
          exitCode: 1,
        }),
    })
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
