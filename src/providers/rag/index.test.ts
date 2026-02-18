import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import type { UnifiedSession } from "../../types/unified"

const embedManyMock = mock(async ({ values }: { values: string[] }) => ({
  embeddings: values.map((_value, i) => [i, i + 1]),
}))
const embedMock = mock(async () => ({ embedding: [0.9, 0.1] }))
const createOpenAIMock = mock(() => {
  const factory = ((modelId: string) => ({ modelId })) as any
  factory.embedding = (modelId: string) => ({ modelId })
  return factory
})
const extractMemoriesMock = mock(async () => "Short memory.")

mock.module("ai", () => ({ embedMany: embedManyMock, embed: embedMock }))
mock.module("@ai-sdk/openai", () => ({ createOpenAI: createOpenAIMock }))
mock.module("../../prompts/extraction", () => ({ extractMemories: extractMemoriesMock }))

const { RAGProvider, chunkText } = await import("./index")

describe("RAGProvider", () => {
  beforeEach(() => {
    embedManyMock.mockClear()
    embedMock.mockClear()
    createOpenAIMock.mockClear()
    extractMemoriesMock.mockClear()
    extractMemoriesMock.mockImplementation(async () => "Short memory.")
  })

  afterAll(() => {
    mock.restore()
  })

  it("chunkText handles multiple breakpoint strategies and avoids non-advancing loops", () => {
    const sentenceChunks = chunkText("Sentence. ".repeat(260))
    expect(sentenceChunks.length).toBeGreaterThan(1)

    const newlineChunks = chunkText(`${"a".repeat(900)}\n${"b".repeat(900)}\n${"c".repeat(900)}`)
    expect(newlineChunks.length).toBeGreaterThan(1)

    const spaceChunks = chunkText("word ".repeat(700))
    expect(spaceChunks.length).toBeGreaterThan(1)

    const hardBreakChunks = chunkText("# Memories from 2026-01-01\n\n" + "x".repeat(2500))
    expect(hardBreakChunks.length).toBeGreaterThan(1)
    expect(hardBreakChunks.every((chunk) => chunk.length > 0)).toBe(true)
  })

  it("validate initialization requirements", async () => {
    const provider = new RAGProvider()
    await expect(provider.initialize({ apiKey: "" })).rejects.toThrow(
      "RAG provider requires OPENAI_API_KEY"
    )
  })

  it("initializes, ingests sessions into embedded chunks, and supports search/clear", async () => {
    extractMemoriesMock.mockImplementation(async (_client: unknown, session: UnifiedSession) => {
      if (session.sessionId === "nobreaks") return "x".repeat(2400)
      if (session.sessionId === "unknown-date") return "Memory without explicit date."
      return "Sentence. ".repeat(240)
    })

    const addChunksMock = mock(() => {})
    const searchMock = mock((_tag: string, _vec: number[], _query: string, _limit: number) => [
      { id: "chunk-1", score: 0.88 },
    ])
    const clearMock = mock(() => {})
    const getChunkCountMock = mock(() => 7)

    const provider = new RAGProvider()
    ;(provider as any).searchEngine = {
      addChunks: addChunksMock,
      search: searchMock,
      clear: clearMock,
      getChunkCount: getChunkCountMock,
    }

    await provider.initialize({ apiKey: "test-key" })

    const sessions: UnifiedSession[] = [
      {
        sessionId: "sentences",
        messages: [{ role: "user", content: "a" }],
        metadata: { date: "2026-02-01T00:00:00Z", k: "v" },
      },
      {
        sessionId: "unknown-date",
        messages: [{ role: "assistant", content: "b" }],
      },
      {
        sessionId: "nobreaks",
        messages: [{ role: "user", content: "c" }],
        metadata: { date: "2026-02-03T00:00:00Z" },
      },
    ]

    const ingestResult = await provider.ingest(sessions, {
      containerTag: "ct",
      metadata: { source: "unit" },
    })
    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "test-key" })
    expect(extractMemoriesMock).toHaveBeenCalledTimes(3)
    expect(embedManyMock).toHaveBeenCalled()
    expect(addChunksMock).toHaveBeenCalled()
    const [containerTag, chunks] = addChunksMock.mock.calls[0] as [string, Array<Record<string, unknown>>]
    expect(containerTag).toBe("ct")
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]?.id).toEqual(expect.stringContaining("ct_"))
    expect(chunks[0]?.sessionId).toEqual(expect.any(String))
    expect(ingestResult.documentIds.length).toBeGreaterThan(3)

    const searchResults = await provider.search("where does the user live?", {
      containerTag: "ct",
      limit: 3,
    })
    expect(embedMock).toHaveBeenCalled()
    expect(searchMock).toHaveBeenCalledWith("ct", [0.9, 0.1], "where does the user live?", 3)
    expect(searchResults).toEqual([{ id: "chunk-1", score: 0.88 }])
    expect(getChunkCountMock).toHaveBeenCalledWith("ct")

    await provider.clear("ct")
    expect(clearMock).toHaveBeenCalledWith("ct")
  })

  it("handles empty ingest and sync awaitIndexing", async () => {
    const provider = new RAGProvider()
    ;(provider as any).openai = createOpenAIMock()

    const empty = await provider.ingest([], { containerTag: "ct" })
    expect(empty.documentIds).toEqual([])

    const states: unknown[] = []
    await provider.awaitIndexing({ documentIds: ["a", "b"] }, "ct", (progress) => states.push(progress))
    expect(states).toEqual([{ completedIds: ["a", "b"], failedIds: [], total: 2 }])
  })

  it("search fails before initialize", async () => {
    const provider = new RAGProvider()
    await expect(provider.search("q", { containerTag: "ct" })).rejects.toThrow("Provider not initialized")
  })
})
