import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EVIDENCE_SLICE_LIMIT,
  EVIDENCE_TOTAL_LIMIT,
  evidenceHash,
} from "./adaptive/evidence"
import { SqliteRoutineRepository } from "./repository"

const NOW = 1_000_000

const open = () => new SqliteRoutineRepository(":memory:")

const rows = (repository: SqliteRoutineRepository) =>
  (repository.db.query("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n

const newEpisode = (repository: SqliteRoutineRepository, id = "episode:session:ses_1") =>
  repository.createEpisode(
    {
      id,
      sessionID: "ses_1",
      projectID: "local",
      objective: "test",
      toolCalls: 0,
      files: [],
      commands: [],
      failures: [],
      verifications: [],
      evidenceRefs: [],
      startedAt: NOW,
    },
    NOW,
  )

describe("evidence store (FH-006)", () => {
  test("a slice is put and read back by its address", () => {
    const repository = open()
    const slice = repository.putEvidence({ content: "boom" }, NOW)

    expect(slice).toMatchObject({ hash: evidenceHash("boom"), content: "boom", createdAt: NOW })
    expect(slice?.truncated).toBeUndefined()

    const read = repository.getEvidence(evidenceHash("boom"), NOW + 1)
    expect(read).toMatchObject({ hash: evidenceHash("boom"), content: "boom", createdAt: NOW })
    repository.close()
  })

  test("empty content is nothing, and neither is a hash that is absent or malformed", () => {
    const repository = open()
    expect(repository.putEvidence({ content: "" }, NOW)).toBeUndefined()
    expect(repository.getEvidence("f".repeat(64), NOW)).toBeUndefined()
    expect(repository.getEvidence("not-a-hash", NOW)).toBeUndefined()
    expect(repository.getEvidence("", NOW)).toBeUndefined()
    repository.close()
  })

  test("the same content is one row, and truncated is monotonic", () => {
    const repository = open()
    repository.putEvidence({ content: "boom" }, NOW)
    repository.putEvidence({ content: "boom" }, NOW + 1)
    expect(rows(repository)).toBe(1)

    // A long slice is cut and marked; the same first 8192 characters are the same address, and a
    // later put that is not cut must not unmark what was already cut.
    const long = "a".repeat(EVIDENCE_SLICE_LIMIT + 5)
    const cut = repository.putEvidence({ content: long }, NOW)
    expect(cut).toMatchObject({ truncated: true, bytes: long.length })
    const short = repository.putEvidence({ content: "a".repeat(EVIDENCE_SLICE_LIMIT) }, NOW + 1)
    expect(short?.truncated).toBe(true)
    expect(rows(repository)).toBe(2)
    repository.close()
  })

  test("a row edited by hand no longer matches its address and reads as nothing", () => {
    const repository = open()
    const hash = repository.putEvidence({ content: "boom" }, NOW)!.hash
    repository.db.query("UPDATE evidence SET content = ?1 WHERE hash = ?2").run("tampered", hash)

    expect(repository.getEvidence(hash, NOW)).toBeUndefined()
    repository.close()
  })

  test("a cut multibyte slice reports its original size in UTF-8 bytes", () => {
    const repository = open()
    const content = "é".repeat(EVIDENCE_SLICE_LIMIT + 1)
    const slice = repository.putEvidence({ content }, NOW)!

    expect(slice.truncated).toBe(true)
    expect(slice.bytes).toBe(Buffer.byteLength(content, "utf8"))
    repository.close()
  })

  test("duplicate content is one slice, so two equal candidates collapse to one association", () => {
    const repository = open()
    const episode = newEpisode(repository)
    const first = repository.putEvidence({ content: "same" }, NOW)!
    const second = repository.putEvidence({ content: "same" }, NOW + 1)!

    expect(first.hash).toBe(second.hash)
    expect(rows(repository)).toBe(1)

    repository.setEpisodeEvidence(
      episode.id,
      [
        { hash: first.hash, kind: "signal", position: 0 },
        { hash: second.hash, kind: "event", position: 1 },
      ],
      NOW,
    )

    expect(repository.evidenceFor(episode, NOW)).toHaveLength(1)
    repository.close()
  })

  test("episode evidence is replaced, not accumulated, and keeps its order", () => {
    const repository = open()
    const episode = newEpisode(repository)
    const first = repository.putEvidence({ content: "first" }, NOW)!
    const second = repository.putEvidence({ content: "second" }, NOW)!
    const third = repository.putEvidence({ content: "third" }, NOW)!

    repository.setEpisodeEvidence(
      episode.id,
      [
        { hash: third.hash, kind: "event", source: "tool:edit", position: 0 },
        { hash: first.hash, kind: "signal", source: "bun test", position: 1 },
      ],
      NOW,
    )
    expect(repository.evidenceFor(episode, NOW).map((slice) => slice.content)).toEqual(["third", "first"])
    expect(repository.evidenceFor(episode, NOW)[0]).toMatchObject({ kind: "event", source: "tool:edit" })

    // A second write replaces: the association that is gone cannot come back, and the order is the
    // one the new links state.
    repository.setEpisodeEvidence(episode.id, [{ hash: second.hash, kind: "signal", position: 0 }], NOW)
    expect(repository.evidenceFor(episode, NOW).map((slice) => slice.content)).toEqual(["second"])
    repository.close()
  })

  test("reading evicts the least recently used slice and its association", () => {
    const repository = open()
    const episode = newEpisode(repository)
    const old = repository.putEvidence({ content: "a".repeat(10) }, 100)!
    const recent = repository.putEvidence({ content: "b".repeat(10) }, 200)!
    repository.setEpisodeEvidence(
      episode.id,
      [
        { hash: old.hash, kind: "signal", position: 0 },
        { hash: recent.hash, kind: "signal", position: 1 },
      ],
      300,
    )

    const removed = repository.evictEvidence({ maxBytes: 15 })

    expect(removed).toBe(1)
    expect(repository.getEvidence(old.hash, NOW)).toBeUndefined()
    expect(repository.getEvidence(recent.hash, NOW)).toBeDefined()
    const associations = (
      repository.db.query("SELECT COUNT(*) AS n FROM episode_evidence WHERE hash = ?1").get(old.hash) as { n: number }
    ).n
    expect(associations).toBe(0)
    expect(repository.evidenceFor(episode, NOW).map((slice) => slice.content)).toEqual(["b".repeat(10)])
    repository.close()
  })

  test("the newest slice survives a sweep that would otherwise empty the store", () => {
    const repository = open()
    repository.putEvidence({ content: "old" }, 100)
    repository.putEvidence({ content: "new" }, 200)

    // Only room for one of the two: the oldest goes first.
    expect(repository.evictEvidence({ maxBytes: 3 })).toBe(1)
    expect(repository.getEvidence(evidenceHash("old"), NOW)).toBeUndefined()
    expect(repository.getEvidence(evidenceHash("new"), NOW)).toBeDefined()
    repository.close()
  })

  test("reading a slice keeps it out of the next eviction", () => {
    const repository = open()
    // Both slices existed when nothing had been read, so created_at alone would drop `old` first.
    const old = repository.putEvidence({ content: "a".repeat(10) }, 100)!
    const recent = repository.putEvidence({ content: "b".repeat(10) }, 200)!
    repository.getEvidence(old.hash, 500)

    // Room for one of two: the one that was read is the least recently evicted, not the least old.
    expect(repository.evictEvidence({ maxBytes: 15 })).toBe(1)
    expect(repository.getEvidence(old.hash, NOW)).toBeDefined()
    expect(repository.getEvidence(recent.hash, NOW)).toBeUndefined()
    repository.close()
  })

  test("a write brings the store back under the total limit", () => {
    const repository = open()
    // The production total is not injectable, so the only honest way to exercise the default wiring
    // is to put the store over it. One oversized row suffices; its content is never read back, so it
    // does not need to be a real content address.
    const giant = "x".repeat(EVIDENCE_TOTAL_LIMIT + 1)
    repository.db
      .query(
        "INSERT INTO evidence (hash, content, bytes, truncated, created_at, last_read_at) VALUES (?1, ?2, NULL, NULL, ?3, NULL)",
      )
      .run("0".repeat(64), giant, 100)

    const kept = repository.putEvidence({ content: "kept" }, NOW)

    const total = (
      repository.db.query("SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS n FROM evidence").get() as {
        n: number
      }
    ).n
    expect(total).toBeLessThanOrEqual(EVIDENCE_TOTAL_LIMIT)
    expect(kept).toBeDefined()
    expect(repository.getEvidence(evidenceHash("kept"), NOW)).toBeDefined()
    expect(rows(repository)).toBe(1)
    repository.close()
  })

  test("evidenceFor follows position, not the order the links were written", () => {
    const repository = open()
    const episode = newEpisode(repository, "episode:ordered")
    const a = repository.putEvidence({ content: "a" }, NOW)!
    const b = repository.putEvidence({ content: "b" }, NOW)!
    const c = repository.putEvidence({ content: "c" }, NOW)!

    repository.setEpisodeEvidence(
      episode.id,
      [
        { hash: c.hash, kind: "signal", position: 2 },
        { hash: a.hash, kind: "signal", position: 0 },
        { hash: b.hash, kind: "signal", position: 1 },
      ],
      NOW,
    )
    expect(repository.evidenceFor(episode, NOW).map((slice) => slice.content)).toEqual(["a", "b", "c"])
    repository.close()
  })

  test("evidenceFor skips a slice whose content no longer matches its address", () => {
    const repository = open()
    const episode = newEpisode(repository, "episode:tampered")
    const good = repository.putEvidence({ content: "good" }, NOW)!
    const bad = repository.putEvidence({ content: "bad" }, NOW)!
    repository.setEpisodeEvidence(
      episode.id,
      [
        { hash: good.hash, kind: "signal", position: 0 },
        { hash: bad.hash, kind: "signal", position: 1 },
      ],
      NOW,
    )
    repository.db.query("UPDATE evidence SET content = ?1 WHERE hash = ?2").run("tampered", bad.hash)

    // The bad link is skipped rather than handed back as something it is not; the rest survives.
    expect(repository.evidenceFor(episode, NOW).map((slice) => slice.content)).toEqual(["good"])
    repository.close()
  })

  test("an empty store has nothing to evict", () => {
    const repository = open()
    expect(repository.evictEvidence()).toBe(0)
    repository.close()
  })

  test("a store that cannot be reached answers with nothing and never throws", () => {
    const repository = open()
    const episode = newEpisode(repository, "episode:closed")
    repository.close()

    // Every method is defensive by contract: a broken store degrades to undefined/[]/0 rather than
    // taking a capture down with it.
    expect(repository.putEvidence({ content: "boom" }, NOW)).toBeUndefined()
    expect(repository.getEvidence(evidenceHash("boom"), NOW)).toBeUndefined()
    expect(repository.evidenceFor(episode, NOW)).toEqual([])
    expect(repository.evictEvidence()).toBe(0)
    expect(() => repository.setEpisodeEvidence("episode:closed", [], NOW)).not.toThrow()
  })
})

describe("incremental eviction (AH-A08)", () => {
  const total = (repository: SqliteRoutineRepository) =>
    (repository.db.query("SELECT bytes FROM evidence_total").get() as { bytes: number }).bytes
  const measured = (repository: SqliteRoutineRepository) =>
    (
      repository.db.query("SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS n FROM evidence").get() as {
        n: number
      }
    ).n

  test("rows written before the size column are measured once and counted", () => {
    const directory = mkdtempSync(join(tmpdir(), "flupcode-evidence-"))
    const path = join(directory, "harness.db")
    // The table exactly as a build before the column wrote it, with rows in it.
    const legacy = new Database(path, { create: true })
    legacy.exec(`CREATE TABLE evidence (
      hash TEXT PRIMARY KEY, content TEXT NOT NULL, bytes INTEGER, truncated INTEGER,
      created_at INTEGER NOT NULL, last_read_at INTEGER)`)
    legacy
      .query("INSERT INTO evidence (hash, content, created_at) VALUES (?1, ?2, ?3)")
      .run(evidenceHash("old"), "old", 100)
    legacy
      .query("INSERT INTO evidence (hash, content, created_at) VALUES (?1, ?2, ?3)")
      .run(evidenceHash("é"), "é", 200)
    legacy.close()

    const repository = new SqliteRoutineRepository(path)
    const sizes = repository.db.query("SELECT hash, size FROM evidence ORDER BY created_at").all()
    expect(sizes).toEqual([
      { hash: evidenceHash("old"), size: 3 },
      { hash: evidenceHash("é"), size: 2 },
    ])
    expect(total(repository)).toBe(5)

    // The backfilled sizes drive eviction like any other row: room for one, the oldest goes.
    expect(repository.evictEvidence({ maxBytes: 2 })).toBe(1)
    expect(repository.getEvidence(evidenceHash("é"), NOW)).toBeDefined()
    expect(total(repository)).toBe(2)
    repository.close()

    // The total survives a restart, recomputed rather than carried over.
    const reopened = new SqliteRoutineRepository(path)
    expect(total(reopened)).toBe(2)
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  })

  test("the same content put again is not counted twice", () => {
    const repository = open()
    repository.putEvidence({ content: "same" }, NOW)
    repository.putEvidence({ content: "same" }, NOW + 1)
    repository.putEvidence({ content: "a".repeat(EVIDENCE_SLICE_LIMIT + 5) }, NOW)
    repository.putEvidence({ content: "a".repeat(EVIDENCE_SLICE_LIMIT) }, NOW + 1)

    expect(total(repository)).toBe(4 + EVIDENCE_SLICE_LIMIT)
    expect(total(repository)).toBe(measured(repository))
    repository.close()
  })

  test("the total follows every delete, including rows removed with their episode's links", () => {
    const repository = open()
    const episode = newEpisode(repository)
    const kept = repository.putEvidence({ content: "kept" }, 100)!
    const gone = repository.putEvidence({ content: "gone" }, 200)!
    repository.setEpisodeEvidence(
      episode.id,
      [
        { hash: gone.hash, kind: "signal", position: 0 },
        { hash: kept.hash, kind: "signal", position: 1 },
      ],
      300,
    )
    repository.getEvidence(kept.hash, 400)

    expect(repository.evictEvidence({ maxBytes: 4 })).toBe(1)
    expect(total(repository)).toBe(4)
    expect(total(repository)).toBe(measured(repository))
    expect(repository.evidenceFor(episode, NOW).map((slice) => slice.content)).toEqual(["kept"])
    repository.close()
  })

  test("eviction removes least recently used rows, in order, only until the store fits", () => {
    const repository = open()
    const slices = ["a", "b", "c", "d", "e"].map(
      (letter, index) => repository.putEvidence({ content: letter.repeat(10) }, 100 + index)!,
    )
    // `a` was read after everything else was written, so it is the most recently used.
    repository.getEvidence(slices[0]!.hash, 1_000)

    expect(repository.evictEvidence({ maxBytes: 25 })).toBe(3)
    const left = (
      repository.db.query("SELECT content FROM evidence ORDER BY content").all() as Array<{ content: string }>
    ).map((row) => row.content[0])
    expect(left).toEqual(["a", "e"])
    expect(total(repository)).toBe(20)
    repository.close()
  })

  test("a put into a large store under its total does not scan it", () => {
    const repository = open()
    // Around 40 MB in 10 000 rows: well under the total, and big enough that a scan per put shows.
    const insert = repository.db.query("INSERT INTO evidence (hash, content, created_at) VALUES (?1, ?2, ?3)")
    repository.db.transaction(() => {
      Array.from({ length: 10_000 }, (_, index) => {
        const content = "x".repeat(4_000) + index
        insert.run(evidenceHash(content), content, index)
      })
    })()
    expect(total(repository)).toBe(measured(repository))

    const puts = 50
    const started = performance.now()
    Array.from({ length: puts }, (_, index) => repository.putEvidence({ content: `fresh ${index}` }, NOW + index))
    const perPut = (performance.now() - started) / puts

    // A generous bound: the full scan this replaced took tens of milliseconds per put at this size.
    expect(perPut).toBeLessThan(5)
    expect(rows(repository)).toBe(10_000 + puts)
    repository.close()
  })
})
