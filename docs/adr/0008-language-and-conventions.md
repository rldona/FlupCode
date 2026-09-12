# ADR-0008: Language and code conventions

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

OpenHarness is a public project intended to align with the OpenCode community and accept outside
contributions. Upstream OpenCode writes all code and documentation in English and follows a
documented style guide (`AGENTS.md`). Mixed-language code would hurt readability, tooling and the
upstream merge workflow.

## Decision

- **All code is written in English**: variable, function and type names, file names, comments,
  doc comments, commit messages, branch names, PR titles and ticket text.
- **User-facing strings are never hardcoded.** They go through the existing i18n system
  (`@solid-primitives/i18n`), with English as the default locale. Spanish and other locales are
  added as translations, not as source text.
- Follow the upstream style guide (`AGENTS.md`) for formatting and idioms, and conventional commits
  `type(scope): summary`.
- Branch names are short, hyphen-separated, at most three words.

## Consequences

- The codebase is consistent with upstream and friendly to external contributors.
- Localized UX is still possible without violating the English-in-code rule.
- Reviewers can reject non-English identifiers or hardcoded user-facing strings.
