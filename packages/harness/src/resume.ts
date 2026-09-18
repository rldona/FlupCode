/**
 * A checkpoint of the session, on demand.
 *
 * In Chat and Cowork, `/compact` never reached the engine: the text went to the model, and what the
 * model wrote back was a status summary. That summary is worth having as its own thing — and worth
 * having in Code too — so it is a prompt here, while folding the session stays the engine's job.
 *
 * It is only a prompt, so it works the same in every view: the session that did the work is the one
 * that can account for it. The ask is what a reader picking the work up needs, not a transcript
 * recap, and it must not turn the report into more work.
 */

export function resumePrompt() {
  return [
    "Give me a checkpoint of this session so far: what we have done, where the work stands, and what is still pending.",
    "Write it for someone picking the work up from here — the files, commands and decisions that matter, and the next step.",
    "This is a report, not a task: do not change anything, and only use tools if you need them to be accurate.",
  ].join("\n")
}
