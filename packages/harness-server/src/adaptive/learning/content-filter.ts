/**
 * The content filter a drafted skill must pass before a person ever sees it (AH-F04).
 *
 * A learned skill is text that every later session of the project reads as guidance, and it is
 * drafted from evidence that can carry untrusted tool output. The shape lint (`proposal.ts`) makes
 * sure it *looks* like a skill; this module makes sure it does not *tell the agent* to do the four
 * things an injected skill would want:
 *
 * - `unsafe-shell-pipe` — run code fetched or decoded on the spot (`curl … | sh`, `bash <(curl …)`,
 *   `base64 -d | bash`, `iex (iwr …)`, `| sudo`).
 * - `unverified-url` — send the agent to a link the episode never saw. A link that is in the
 *   evidence was seen by the session; one that is not was invented or smuggled in. Loopback hosts
 *   (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`) are allowed: they do not leave the machine.
 * - `overrides-judgement` — unconditional imperatives that switch off the agent's judgement or the
 *   person's say ("ignore previous instructions", "never ask for confirmation", "without asking",
 *   "you must always…").
 * - `permission-change` — widen what the agent may do (`--dangerously-*`, disable the sandbox or
 *   approvals, edit the permission config, `sudo`, `chmod 777`).
 *
 * Pure and synchronous: the same text and evidence always give the same answer, so the manager can
 * run it before staging and the approval can run it again (defence in depth, with the live evidence).
 *
 * False positives, the trade-off. The filter is deliberately strict — a rejected good draft costs
 * one skill that can be written by hand, an accepted bad one persists into every session — but two
 * shapes keep legitimate skills out of its way:
 *
 * - "Always run the tests" is fine: only imperatives that remove a check (`without asking`, `never
 *   ask for confirmation`, `you must always`) are refused, never a plain "always"/"never".
 * - A *warning* in prose is fine for the two negatable rules (`unsafe-shell-pipe`,
 *   `permission-change`): when the clause before the match ends in a direct negation ("Never run
 *   `curl … | sh`", "Do not use sudo", "instead of chmod 777"), the line is advice against, not an
 *   instruction. The negation must govern the match directly ("Never forget to run `curl … | sh`"
 *   does not count), and it never applies inside a fenced code block: a command in a block is
 *   something the agent may copy, whatever the sentence above it said. A warning still carrying a
 *   URL the evidence lacks is refused by `unverified-url`.
 */

export const CONTENT_RULES = [
  "unsafe-shell-pipe",
  "unverified-url",
  "overrides-judgement",
  "permission-change",
] as const
export type ContentRule = (typeof CONTENT_RULES)[number]

/** Plain-language reasons, for logs and the docs; the app translates the rule id itself. */
export const CONTENT_RULE_REASONS: Record<ContentRule, string> = {
  "unsafe-shell-pipe": "It runs code downloaded or decoded on the spot, such as piping a download into a shell.",
  "unverified-url": "It links to an address that did not appear in the session it was learned from.",
  "overrides-judgement": "It tells the assistant to skip checks or stop asking before acting.",
  "permission-change": "It tries to widen what the assistant is allowed to do.",
}

export type ContentFinding = { rule: ContentRule; reason: string; excerpt: string }

export type ContentInput = {
  /** The texts a future session will read: the description and the body. */
  texts: readonly string[]
  /**
   * The episode's evidence text. Absent means the caller has none to check against and the URL rule
   * is skipped; present (even empty) means every non-loopback URL must appear in it.
   */
  evidence?: readonly string[]
}

const DOWNLOADER = String.raw`(?:curl|wget|fetch|iwr|irm|invoke-webrequest|invoke-restmethod|aria2c|ncat|nc)`
const SHELL = String.raw`(?:sudo\s+(?:-\S+\s+)*)?(?:(?:ba|z|k|da|fi|c|tc)?sh|pwsh|powershell|iex|invoke-expression|source)\b`
/** An interpreter only counts when it reads its program from stdin (`| python`, `| node -`). */
const STDIN_INTERPRETER = String.raw`(?:python[0-9.]*|node|perl|ruby|php)(?:\s+-)?\s*(?:$|[\x60'"\);&|])`
const DECODER = String.raw`(?:base64|xxd|openssl|gunzip|zcat|uudecode|rev)`

const SHELL_PIPE: readonly RegExp[] = [
  new RegExp(String.raw`\b${DOWNLOADER}\b[^\n]*?\|\s*(?:\w+=\S+\s+)*(?:${SHELL}|${STDIN_INTERPRETER})`, "i"),
  /\|\s*sudo\b/i,
  new RegExp(String.raw`<\(\s*${DOWNLOADER}\b`, "i"),
  new RegExp(
    String.raw`\b(?:eval|exec|(?:ba|z|k)?sh\s+-c|python[0-9.]*\s+-c|node\s+-e|perl\s+-e|ruby\s+-e)\s+["']?(?:\$\(|\x60)\s*${DOWNLOADER}\b`,
    "i",
  ),
  new RegExp(String.raw`\b${DECODER}\b[^\n]*\|\s*(?:${SHELL}|${STDIN_INTERPRETER})`, "i"),
  /\$\(\s*echo\b[^\n)]*\|\s*base64\s+(?:-d|--decode|-D)\b/i,
  /\b(?:eval|exec)\s*\(\s*(?:atob|base64\.|b64decode|Buffer\.from|__import__|compile)/i,
  /\b(?:iex|invoke-expression)\b[^\n]*\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)\b/i,
  /\bdownloadstring\s*\(/i,
  new RegExp(String.raw`\b(?:curl|wget)\b[^\n]*(?:&&|;)\s*(?:sudo\s+)?(?:ba|z|k)?sh\s+\S`, "i"),
]

const OVERRIDES_JUDGEMENT: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:(?:the|your|of\s+the)\s+)?(?:previous|prior|above|earlier|other|system|user'?s?|safety)\s+(?:instructions?|rules?|prompts?|guidelines?|messages?|directions?)/i,
  /\bsystem\s+prompt\b/i,
  /\bnew\s+instructions\s*:/i,
  /\bwithout\s+(?:first\s+|ever\s+)?(?:asking|confirm(?:ing|ation)|approval|permission(?!\s+(?:errors?|issues?|problems?|denied))|prompting|consent|checking\s+with|consulting|(?:the\s+)?(?:user|human)(?:'s)?\s+(?:approval|confirmation|consent|review|ok))\b/i,
  /\b(?:never|don'?t|do\s+not|no\s+need\s+to|stop)\s+(?:ever\s+)?(?:ask|prompt|check\s+with|wait\s+for|request)\b[^.\n]{0,40}\b(?:confirm(?:ation)?|permission|approval|consent|go-ahead)\b/i,
  /\byou\s+must\s+(?:always|never)\b/i,
  /\bregardless\s+of\s+(?:what\s+)?(?:the\s+)?(?:user|human|instructions?|warnings?|polic(?:y|ies)|consequences)\b/i,
  /\b(?:skip|bypass|override|suppress|ignore)\s+(?:the\s+|any\s+|all\s+)?(?:(?:user'?s?|human)\s+(?:confirmation|approval|review)s?|confirmations?|approvals?)\b/i,
  /\b(?:don'?t|do\s+not|never)\s+(?:tell|inform|notify|alert)\s+the\s+(?:user|human|person)\b/i,
  /\b(?:approve|accept|confirm|say\s+yes|answer\s+yes)\s+(?:to\s+)?(?:every|all|any)\s+(?:prompts?|requests?|permissions?|dialogs?|confirmations?)\b|\b(?:always|automatically|unconditionally)\s+(?:approve|say\s+yes|answer\s+yes)\b/i,
]

const PERMISSION_CHANGE: readonly RegExp[] = [
  /--dangerously(?:-[\w-]+)?/i,
  /\b(?:grant|give|bypass|skip|disable|turn\s+off|switch\s+off|override|escalate|elevate|circumvent|relax|widen|loosen)\s+(?:(?:all|the|every|any|its|your|tool|full|extra|additional)\s+)*(?:permissions?|approvals?|sandbox(?:ing)?|confirmations?|privileges?|guardrails?|safety\s+checks?)\b/i,
  /\bsudo\b/i,
  /\bsu\s+(?:-|root)(?:\s|$)/i,
  /\b(?:doas|visudo)\b|\/etc\/sudoers|\bNOPASSWD\b/i,
  /\bchmod\s+(?:-R\s+)?(?:0?777|a\+rwx|ugo\+rwx|o\+w)(?![\w+])/i,
  /(?:^|\n)\s*"?permissions?"?\s*:/i,
  /\b(?:allow|deny)\s+(?:all\s+)?tools?\b/i,
  /\b(?:edit|modify|change|update|write|patch|add)\b[^.\n]{0,40}\b(?:permission\s+(?:config(?:uration)?|settings|rules?|file)|\.claude\/settings|settings\.local\.json|approval[_ -]?policy)\b/i,
  /\b(?:opencode|flupcode)\.jsonc?\b[^.\n]{0,40}\bpermission|\bpermission[^.\n]{0,40}\b(?:opencode|flupcode)\.jsonc?\b/i,
  /\bauto[- ]?approv(?:e|al)\b|\byolo\s+mode\b|--yolo\b|--yes-to-all\b|--trust-all\b/i,
  /\bapproval[_-]?policy\s*[=:]\s*["']?never\b|--ask-for-approval[= ]never\b/i,
  /\bsandbox(?:ing)?\s*["']?\s*[=:]\s*["']?(?:false|off|none|disabled?|danger\w*)\b|--sandbox[= ](?:none|off|danger\w*)/i,
]

const RULES: ReadonlyArray<{
  rule: Exclude<ContentRule, "unverified-url">
  patterns: readonly RegExp[]
  negatable: boolean
}> = [
  { rule: "unsafe-shell-pipe", patterns: SHELL_PIPE, negatable: true },
  { rule: "overrides-judgement", patterns: OVERRIDES_JUDGEMENT, negatable: false },
  { rule: "permission-change", patterns: PERMISSION_CHANGE, negatable: true },
]

/**
 * The clause before a match ends in a negation that governs it: "Never run", "Do not use", "instead
 * of", "rather than piping", "without". At most two verb-ish words may sit between the negation and
 * the match, so "Never forget to run" is not a warning.
 */
const NEGATION_TAIL =
  /(?:^|[\s(])(?:never|don'?t|do\s+not|avoid|must\s+not|mustn'?t|should\s+not|shouldn'?t|instead\s+of|rather\s+than|without)(?:\s+(?:ever|run|running|use|using|pipe|piping|execute|executing|call|calling|type|typing|paste|pasting|invoke|invoking|add|adding|do|recommend|suggest|need|to|be|with|a|an|the)){0,3}\s*$/i
/** Where a clause starts: a sentence end or a shell separator, so "cd x; curl … | sh" is not negated. */
const CLAUSE_BREAK = /[.!?;]\s|[;:]|&&|\|\|/g

const URL_PATTERN = /\b(?:https?|ftp|wss?):\/\/[^\s<>"'\x60)\]}]+|\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s<>"'\x60)\]}]*/gi
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|[a-z0-9.-]+\.localhost)(?::\d+)?(?:[/?#]|$)/i
/** Zero-width and bidi controls an adversary uses to split a keyword; removed before any match. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g

/**
 * The first finding in the texts, or `undefined` when the draft is clean. Rules run in a fixed order
 * (shell pipe, judgement, permissions, then URLs), so a draft that breaks several reports the same
 * reason every time.
 */
export function filterSkillContent(input: ContentInput): ContentFinding | undefined {
  const lines = input.texts.flatMap((text) => proseLines(normalize(text)))
  for (const entry of RULES) {
    for (const line of lines) {
      const excerpt = firstMatch(line, entry.patterns, entry.negatable)
      if (excerpt !== undefined) return finding(entry.rule, excerpt)
    }
  }
  if (!input.evidence) return undefined
  const evidence = normalize(input.evidence.join("\n"))
  const url = input.texts
    .flatMap((text) => normalize(text).match(URL_PATTERN) ?? [])
    .map((match) => match.replace(/[.,;:!?]+$/, ""))
    .find((match) => !LOOPBACK.test(withoutScheme(match)) && !seenIn(evidence, match))
  return url === undefined ? undefined : finding("unverified-url", url)
}

function finding(rule: ContentRule, excerpt: string): ContentFinding {
  return { rule, reason: CONTENT_RULE_REASONS[rule], excerpt: excerpt.slice(0, 120) }
}

/** NFKC folds full-width lookalikes (`｜`, `ｓｕｄｏ`); backslash continuations join a split command. */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/\\\r?\n\s*/g, " ")
}

/** Every line, tagged with whether it sits inside a fenced code block (``` or ~~~). */
function proseLines(text: string): Array<{ text: string; fenced: boolean }> {
  const state = { fenced: false }
  return text.split("\n").map((line) => {
    const fence = /^\s*(?:```|~~~)/.test(line)
    if (fence) state.fenced = !state.fenced
    return { text: line, fenced: fence || state.fenced }
  })
}

/** The first match on the line that is not a governed warning; `undefined` when there is none. */
function firstMatch(line: { text: string; fenced: boolean }, patterns: readonly RegExp[], negatable: boolean) {
  for (const pattern of patterns) {
    const every = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)
    for (const match of line.text.matchAll(every)) {
      if (negatable && !line.fenced && isNegated(line.text.slice(0, match.index))) continue
      return match[0]
    }
  }
  return undefined
}

function isNegated(prefix: string): boolean {
  // A match inside inline code is governed by what precedes the code span, not by its own first half.
  const head = (prefix.split("\x60").length - 1) % 2 === 1 ? prefix.slice(0, prefix.lastIndexOf("\x60")) : prefix
  const clause = head.split(CLAUSE_BREAK).at(-1) ?? ""
  return NEGATION_TAIL.test(clause.replace(/[\x60'"*_\s]+$/, ""))
}

function withoutScheme(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "")
}

/**
 * A URL was seen when the evidence carries it, compared without the scheme, a leading `www.` or a
 * trailing slash, and on host boundaries so `x.co` is not "seen" inside `x.com`.
 */
function seenIn(evidence: string, url: string): boolean {
  const key = withoutScheme(url)
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
  if (!key) return false
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`, "i").test(evidence)
}
