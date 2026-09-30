# Replay corpus (AH-B04)

Past sessions, reduced to what they asked, so a change to the adaptive layer (or a model switch) can
be measured against the same work instead of against a feeling. `docs/ADAPTIVE.md` ("Replay corpus
and runner") has the design; this file is the privacy stance and the commands.

## Privacy

- **Opt-in.** A session is exported only when a person names it: `replay:export --session <id>`.
  Nothing exports sessions in the background.
- **Inputs only.** A fixture keeps the user's prompts in order, the agent and model, the project
  folder, its git commit and an optional verify command. No assistant answer and no tool output is
  written.
- **Redacted.** Every prompt, the folder and the verify command go through the harness's secret
  redaction (`src/adaptive/redaction.ts`: known env secrets plus credential shapes), and absolute
  home paths (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) become `~`. The redaction is
  conservative, not a guarantee: read a fixture before you share it.
- **Local.** This folder is git-ignored apart from this README and `example-synthetic.json`. A
  fixture is only committed after somebody reviews it and adds it on purpose (`git add -f`).
- **A fixture is code.** Its `verify` command runs in a shell on replay. Only replay fixtures you
  exported or reviewed.

## Commands

From `packages/harness-server`, with the engine (and ideally the harness) running:

```sh
# Export one session; repeat for each session of the corpus (aim for 30 or more).
bun run replay:export -- --session ses_… --name fix-login-bug --verify "bun test"

# Print the plan (nothing is spent without --yes).
bun run replay -- --variants variants.json --repeat 3

# Run it: one throwaway session, in a fresh engine worktree, per fixture × variant × repetition.
bun run replay -- --variants variants.json --repeat 3 --yes
```

A variants file is a JSON array:

```json
[
  { "name": "adaptive-off", "adaptive": { "enabled": false } },
  { "name": "adaptive-on", "adaptive": { "enabled": true, "context": { "enabled": true } } },
  { "name": "haiku", "model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" } }
]
```

`adaptive` is patched through the harness settings surface before the variant and restored after it
(only the fields that surface allows). `engine` points a variant at another engine, for settings the
engine only reads at startup. `--model provider/model` is a one-variant shortcut.

Reports land in `reports/<timestamp>/report.json` and `report.md`: tokens (uncached input, cached,
output), USD and wall time per repetition, the verify result, and mean, p50 and spread per fixture ×
variant. The engine exposes no sampling seed, so the report says `seed: null` and pins the model on
every prompt; "reproducible" means every repetition is within ±5% of the mean in total tokens and USD.

The runner refuses to run under `CI`: it always calls a real model.
