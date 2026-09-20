// The engine brands message ids and orders them time-first (`msg_` + ascending); see
// packages/schema/src/session-message.ts. Sending our own id lets the transcript show a prompt
// immediately and reconcile it with the engine's message once it is projected.
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

export function messageID() {
  const timestamp = Date.now()
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((current >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return `msg_${time}${Array.from(bytes, (byte) => CHARS[byte % 62]).join("")}`
}
