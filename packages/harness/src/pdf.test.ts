import { describe, expect, test } from "bun:test"
import { isEncryptedPdf, unlockPdf } from "./pdf"

const pdf = (body: string) => `data:application/pdf;base64,${btoa(body)}`
const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"))
const latin1 = (data: Uint8Array) => new TextDecoder("latin1").decode(data)

/** One page with a `Hola banco` stream, RC4-128, empty user password. */
const EMPTY_PASSWORD =
  "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGVmNGExNjU0OWI+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgovQ29udGVudHMgNSAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0xlbmd0aCA0MQo+PgpzdHJlYW0KjbSi/xunlbRvKWUvbZ5sIWFXJ5X6P6tGqXXXNFeIasSg6FwlKOOLIhAKZW5kc3RyZWFtCmVuZG9iago2IDAgb2JqCjw8Ci9WIDIKL1IgMwovTGVuZ3RoIDEyOAovUCA0Mjk0OTY3MjkyCi9GaWx0ZXIgL1N0YW5kYXJkCi9PIDw0ODcxODUyZTI3ZjIwODYyY2IxZmViYjg2YjMzNWUxM2UwYTg3OWE5NDk0YzJjYTQ4OThkN2M5ZGUyMmQwZTc4PgovVSA8MWI5MzcwZTZkOTNjMDI5MWFhNmEyOGNjZjhhZTAxYjIyOGJmNGU1ZTRlNzU4YTQxNjQwMDRlNTZmZmZhMDEwOD4KPj4KZW5kb2JqCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbiAKMDAwMDAwMDE2NyAwMDAwMCBuIAowMDAwMDAwMjc3IDAwMDAwIG4gCjAwMDAwMDAzNjggMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA3Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDwzNDY1NjM2MzYzMzczNTY2MzIzMjY1NjYzNjM1NjQzMjY0MzQ2MzM1MzMzODM0NjY2MzY0NjU2MjM1MzEzNjMzPiA8MzQ2NTYzNjM2MzM3MzU2NjMyMzI2NTY2MzYzNTY0MzI2NDM0NjMzNTMzMzgzNDY2NjM2NDY1NjIzNTMxMzYzMz4gXQovRW5jcnlwdCA2IDAgUgo+PgpzdGFydHhyZWYKNTgzCiUlRU9GCg=="

/** The same page, but the user password is "secreto". */
const NEEDS_PASSWORD =
  "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGNmN2I2ZGM1OGY+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgovQ29udGVudHMgNSAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0xlbmd0aCA0MQo+PgpzdHJlYW0KwsVT2SCKPNpsqHPFfPeiOTMbJctyOaxjDtWAGHF+tKfedjtbaUwdQhEKZW5kc3RyZWFtCmVuZG9iago2IDAgb2JqCjw8Ci9WIDIKL1IgMwovTGVuZ3RoIDEyOAovUCA0Mjk0OTY3MjkyCi9GaWx0ZXIgL1N0YW5kYXJkCi9PIDwxM2FiYTgwMjBjZjNlZDBiMTA1MWZiYTBlMTQzMWU3ZmNlYzgyZmUwNjMyNTFhMGE4ODgxNjNiM2VlNDBlNzJkPgovVSA8YTU2ZjZjOTUxYWYxZmU5MWZlMDk5ODgzYWM1MzY5NTUyOGJmNGU1ZTRlNzU4YTQxNjQwMDRlNTZmZmZhMDEwOD4KPj4KZW5kb2JqCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU5IDAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbiAKMDAwMDAwMDE2NyAwMDAwMCBuIAowMDAwMDAwMjc3IDAwMDAwIG4gCjAwMDAwMDAzNjggMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA3Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDwzNDY1NjM2MzYzMzczNTY2MzIzMjY1NjYzNjM1NjQzMjY0MzQ2MzM1MzMzODM0NjY2MzY0NjU2MjM1MzEzNjMzPiA8MzQ2NTYzNjM2MzM3MzU2NjMyMzI2NTY2MzYzNTY0MzI2NDM0NjMzNTMzMzgzNDY2NjM2NDY1NjIzNTMxMzYzMz4gXQovRW5jcnlwdCA2IDAgUgo+PgpzdGFydHhyZWYKNTgzCiUlRU9GCg=="

describe("the PDFs the engine refuses", () => {
  test("a trailer with /Encrypt is refused", () => {
    expect(isEncryptedPdf({ uri: pdf("%PDF-1.4\ntrailer << /Encrypt 5 0 R >>"), name: "extracto.pdf" })).toBe(true)
  })

  test("a plain PDF is not", () => {
    expect(isEncryptedPdf({ uri: pdf("%PDF-1.4\ntrailer << /Root 1 0 R >>"), name: "extracto.pdf" })).toBe(false)
  })

  test("the trailer is found at the end of a long file", () => {
    const body = `%PDF-1.4\n${"A".repeat(40000)}\ntrailer << /Encrypt 9 0 R >>`
    expect(isEncryptedPdf({ uri: pdf(body), name: "extracto.pdf" })).toBe(true)
  })

  test("another kind of file is never a PDF", () => {
    expect(isEncryptedPdf({ uri: `data:text/plain;base64,${btoa("/Encrypt")}`, name: "notas.txt" })).toBe(false)
  })
})

describe("unlocking a PDF with an empty user password", () => {
  test("removes /Encrypt and decrypts its streams", () => {
    const result = unlockPdf(bytes(EMPTY_PASSWORD))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(latin1(result.bytes)).not.toContain("/Encrypt")
    expect(latin1(result.bytes)).toContain("Hola banco")
  })

  test("a real password is not guessed", () => {
    expect(unlockPdf(bytes(NEEDS_PASSWORD))).toEqual({ ok: false, reason: "password" })
  })
})
