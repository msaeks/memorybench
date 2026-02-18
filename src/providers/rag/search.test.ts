import { describe, expect, it } from "bun:test"
import { HybridSearchEngine, type Chunk } from "./search"

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: "c1",
    content: "Alice likes hiking in Seattle parks.",
    sessionId: "s1",
    chunkIndex: 0,
    embedding: [1, 0, 0],
    ...overrides,
  }
}

describe("HybridSearchEngine", () => {
  it("returns empty results for missing/empty containers", () => {
    const engine = new HybridSearchEngine()
    expect(engine.search("missing", [1, 0], "anything", 5)).toEqual([])

    engine.addChunks("emptyish", [])
    expect(engine.search("emptyish", [1, 0], "anything", 5)).toEqual([])
  })

  it("combines vector and BM25 scores and sorts by hybrid score", () => {
    const engine = new HybridSearchEngine()
    engine.addChunks("ct", [
      makeChunk({
        id: "best",
        content: "Alice likes hiking and climbing in Seattle",
        embedding: [1, 0],
      }),
      makeChunk({
        id: "keyword-only",
        content: "Alice hiking hiking hiking",
        embedding: [0.2, 0],
      }),
      makeChunk({
        id: "vector-only",
        content: "Completely unrelated tokens",
        embedding: [0.9, 0],
      }),
    ])

    const results = engine.search("ct", [1, 0], "alice hiking", 3)
    expect(results).toHaveLength(3)
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score)
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score)
    expect(results[0].vectorScore).toBeGreaterThan(0)
    expect(results[0].bm25Score).toBeGreaterThanOrEqual(0)
  })

  it("handles cosine edge cases and stop-word-only query", () => {
    const engine = new HybridSearchEngine()
    engine.addChunks("ct2", [
      makeChunk({ id: "len-mismatch", embedding: [1, 2, 3], content: "alpha beta" }),
      makeChunk({ id: "zero-norm", embedding: [0, 0], content: "gamma delta" }),
    ])

    const mismatch = engine.search("ct2", [1, 0], "the and or", 2)
    expect(mismatch).toHaveLength(2)
    expect(mismatch.some((r) => r.vectorScore === 0)).toBe(true)
    expect(mismatch.every((r) => r.bm25Score === 0)).toBe(true)
  })

  it("clears containers and reports chunk counts", () => {
    const engine = new HybridSearchEngine()
    engine.addChunks("ct3", [makeChunk({ id: "x" }), makeChunk({ id: "y" })])
    expect(engine.getChunkCount("ct3")).toBe(2)
    engine.clear("ct3")
    expect(engine.getChunkCount("ct3")).toBe(0)
  })
})

