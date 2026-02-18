import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { Supermemory } from "supermemory"
import { SupermemoryProvider } from "./index"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"

describe("SupermemoryProvider", () => {
  const originalSetTimeout = globalThis.setTimeout

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  it("initialize creates Supermemory client and logs", async () => {
    const provider = new SupermemoryProvider()
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {})

    await provider.initialize({ apiKey: "supermemory-key" })

    expect((provider as any).client).toBeInstanceOf(Supermemory)
    expect(infoSpy).toHaveBeenCalledWith("Initialized Supermemory provider")
    infoSpy.mockRestore()
  })

  it("ingest requires initialization and escapes angle brackets", async () => {
    const provider = new SupermemoryProvider()
    await expect(provider.ingest([], { containerTag: "ct" })).rejects.toThrow("Provider not initialized")

    const addMock = mock(async () => ({ id: "doc1" }))
    ;(provider as any).client = { add: addMock }

    const sessions: UnifiedSession[] = [
      {
        sessionId: "s1",
        messages: [{ role: "user", content: "<tag>" }],
        metadata: { formattedDate: "2026-01-01", date: "2026-01-01T00:00:00Z" },
      },
    ]
    const result = await provider.ingest(sessions, { containerTag: "ct" })
    expect(result.documentIds).toEqual(["doc1"])
    expect(addMock).toHaveBeenCalled()
    const payload = addMock.mock.calls[0][0] as Record<string, unknown>
    expect(String(payload.content)).toContain("&lt;tag&gt;")
    expect(payload.containerTag).toBe("ct")
    expect((payload.metadata as Record<string, unknown>).sessionId).toBe("s1")
  })

  it("awaitIndexing handles empty, pending, success, and failed docs", async () => {
    const provider = new SupermemoryProvider()
    await expect(provider.awaitIndexing({ documentIds: ["x"] }, "ct")).rejects.toThrow(
      "Provider not initialized"
    )

    const docStates: Record<string, string[]> = {
      d1: ["processing", "done"],
      d2: ["done"],
    }
    const memStates: Record<string, string[]> = {
      d1: ["pending", "done"],
      d2: ["failed"],
    }

    ;(provider as any).client = {
      documents: {
        get: async (id: string) => {
          const seq = docStates[id]
          const status = seq.length > 1 ? seq.shift()! : seq[0]
          return { status }
        },
      },
      memories: {
        get: async (id: string) => {
          const seq = memStates[id]
          const status = seq.length > 1 ? seq.shift()! : seq[0]
          return { status }
        },
      },
    }

    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((cb: (...args: unknown[]) => void) => {
        cb()
        return 0 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout
    )
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})

    const emptyProgress: unknown[] = []
    await provider.awaitIndexing({ documentIds: [] }, "ct", (p) => emptyProgress.push(p))
    expect(emptyProgress).toEqual([{ completedIds: [], failedIds: [], total: 0 }])

    const states: unknown[] = []
    await provider.awaitIndexing({ documentIds: ["d1", "d2"] }, "ct", (p) => states.push(p))
    expect(states[states.length - 1]).toEqual({
      completedIds: ["d1"],
      failedIds: ["d2"],
      total: 2,
    })
    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith("1 documents failed indexing")

    setTimeoutSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it("search and clear behavior", async () => {
    const provider = new SupermemoryProvider()
    await expect(provider.search("q", { containerTag: "ct" })).rejects.toThrow("Provider not initialized")
    await expect(provider.clear("ct")).rejects.toThrow("Provider not initialized")

    const searchMemories = mock(async () => ({ results: [{ id: 1 }] }))
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})

    ;(provider as any).client = {
      search: {
        memories: searchMemories,
      },
    }

    expect(await provider.search("q", { containerTag: "ct", threshold: 0.5 })).toEqual([{ id: 1 }])
    expect(searchMemories).toHaveBeenCalledWith({
      q: "q",
      containerTag: "ct",
      limit: 30,
      threshold: 0.5,
      searchMode: "hybrid",
      include: {
        summaries: true,
        chunks: true,
      },
    })

    await provider.clear("ct")
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
