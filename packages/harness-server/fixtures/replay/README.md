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
- **Local.** This folder is git-ignored apart from this README, `example-synthetic.json` and
  `variants/` (config only, no session data). A fixture is only committed after somebody reviews it
  and adds it on purpose (`git add -f`).
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
(only the fields that surface allows). `engine` points a variant at another, already running engine.
`engineConfig` starts a throwaway engine for the variant instead: this checkout's opencode on a free
port (`--engine-command "… --port {port}"` overrides it), with the object layered over your config
through `OPENCODE_CONFIG_CONTENT`, checked against the engine's `/config`, and stopped after the
variant. Your engine on :4096 and your global config are never touched. `--model provider/model` is a
one-variant shortcut.

## Native levers experiment (AH-D01)

`variants/native-levers.json` compares the engine's own levers against a baseline, each on a fresh
engine: `compaction.prune`, `tool_output.max_bytes` at 16k and 32k, `compaction.tail_turns` and
`compaction.preserve_recent_tokens`.

```sh
# The plan: fixtures × 6 variants × 3 repetitions, and the config each engine gets.
bun run replay -- --variants fixtures/replay/variants/native-levers.json --repeat 3

# The paid run.
bun run replay -- --variants fixtures/replay/variants/native-levers.json --repeat 3 --yes
```

`report.md` then adds, per variant against `baseline`, Δ uncached input tokens, Δ completion (pp), Δ
wall time and Δ USD, and a recommendation by the preregistered rule (Δ uncached ≤ 0 and Δ completion ≥
−1 pp). Produce the report that sets defaults from real fixtures (30 or more exported sessions, with
some long enough to compact): the D02/D03 thresholds are fixed from it, not from the synthetic
example.

Reports land in `reports/<timestamp>/report.json` and `report.md`: tokens (uncached input, cached,
output), USD and wall time per repetition, the verify result, mean, p50 and spread per fixture ×
variant, and each variant's deltas against the baseline. The engine exposes no sampling seed, so the report says `seed: null` and pins the model on
every prompt; "reproducible" means every repetition is within ±5% of the mean in total tokens and USD.

The runner refuses to run under `CI`: it always calls a real model.
