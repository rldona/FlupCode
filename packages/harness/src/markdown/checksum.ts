// FNV-1a over UTF-16 code units, in base 36: a cheap content key for the block cache, not a
// security hash. It runs over every streamed message on each update, so it stays a plain loop.
export function checksum(content: string) {
  if (!content) return undefined
  let hash = 0x811c9dc5
  for (let index = 0; index < content.length; index++) hash = Math.imul(hash ^ content.charCodeAt(index), 0x01000193)
  return (hash >>> 0).toString(36)
}
