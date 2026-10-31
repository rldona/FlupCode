# Changelog

What a reader of FlupCode gets, version by version. The published notes of each release — the page
the website links to — are on
[GitHub Releases](https://github.com/rldona/FlupCode/releases); this file keeps the same history in
the repository, one section per version, oldest last.

## 4.1.3

- Settings → Agents shows how each agent is set up without opening it: a line under its name with the
  mode, the model with its effort level, and the provider, e.g.
  `Subagent / Claude Opus 5.5 · High / GitHub Copilot` (#566).
- Model and provider names stay current: coming back to the window rereads both catalogs, at most once
  every five minutes, so a renamed model shows without restarting FlupCode (#566).
- The onboarding screen loads on demand, keeping the startup bundle under its limit (#566).

## 4.1.2

Two fixes reported from the app, and the test change that stops them from blocking a release again.

- Cowork sends with no project folder: a turn is usually reading, searching or running a command, so
  the folder is offered rather than required, and the reason a send cannot go appears on the screen
  where it was tried (#561).
- The context ring no longer fills red when switching sessions: an unmeasured session shows an empty
  ring instead of the session's cumulative spend (#562).
- The streaming e2e spec reports its turn as active, so the store's own poll cannot end it and make
  the test forbid its own refetch (#564).

## 4.1.1

- Agents say what they are about to do: one instruction file, loaded as engine instructions, asks
  every agent and subagent for a line before the first tool of a turn, and again when the work
  changes direction (#559).

## 4.1.0

- Tasks are back in the details panel, first above the agents, written by FlupCode's own `todo` tool
  and kept per session by the harness (#554, #555, #556).
- The details panel only shows while it has something in it — this session's agents, tasks or
  memories — and its toggle appears with them (#552).
- The reader's prompt sits on the right, in a bubble (#552).
- `+ New` keeps a resting shade, one step lighter on hover (#552).
- One run from start to end: the stop button no longer blinks at every step boundary, and the
  transcript stops skipping layout while a turn streams, which is what made long chats flash (#553).
- The picked option in a menu keeps a shaded row, not only the tick (#557).

## 4.0.2

- Patch on 4.0.1; see the release notes on GitHub.
