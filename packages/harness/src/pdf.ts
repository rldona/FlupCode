/**
 * The PDFs the engine refuses, and the ones it can be handed after unlocking.
 *
 * OpenCode answers "encrypted PDFs are not supported" when a turn carries one, and the failure
 * sticks: the file stays in the conversation, so every later turn fails the same way. Attachments
 * arrive as data URLs, so the trailer is checked here, before the file reaches the composer or the
 * engine.
 *
 * Most bank statements are only permission-encrypted: the user password is empty, and any reader
 * opens them without asking. For those, `unlockPdf` removes the encryption in place — RC4 keeps
 * every byte where it was, so the cross-reference table stays valid and no rewrite is needed — and
 * the composer attaches the readable copy. A file that needs a real password is still refused.
 */
export function isEncryptedPdf(file: { uri: string; name: string }) {
  if (!/\.pdf$/i.test(file.name) && !file.uri.startsWith("data:application/pdf")) return false
  const comma = file.uri.indexOf(",")
  if (comma < 0) return false
  const header = file.uri.slice(0, comma)
  const payload = file.uri.slice(comma + 1)
  try {
    const bytes = header.includes(";base64") ? decodeBase64Tail(payload) : decodeURIComponent(payload)
    return bytes.includes("/Encrypt")
  } catch {
    // Not something this check can read: let the engine say what it is instead of failing here.
    return false
  }
}

export function pdfBytes(uri: string) {
  const comma = uri.indexOf(",")
  if (comma < 0) return undefined
  const payload = uri.slice(comma + 1)
  try {
    if (uri.slice(0, comma).includes(";base64")) return base64Bytes(payload)
    return new TextEncoder().encode(decodeURIComponent(payload))
  } catch {
    return undefined
  }
}

export function pdfDataUrl(bytes: Uint8Array) {
  return `data:application/pdf;base64,${base64Text(bytes)}`
}

function base64Bytes(text: string) {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function base64Text(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function decodeBase64Tail(payload: string) {
  const start = Math.max(0, payload.length - 16384)
  const aligned = start + ((4 - (start % 4)) % 4)
  return atob(payload.slice(aligned))
}
