import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import MemoryClient from "mem0ai"
import { Mem0Provider } from "./index"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"

describe("Mem0Provider", () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout

  beforeEach(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  })

  afterEach(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  })

  it("initialize sets apiKey, updates project instructions, and logs", async () => {
    const provider = new Mem0Provider()
    const initSpy = spyOn((MemoryClient as { prototype: { _initializeClient: () => Promise<void> } }).prototype, "_initializeClient").mockImplementation(async () => {})
    const updateSpy = spyOn((MemoryClient as { prototype: { updateProject: () => Promise<void> } }).prototype, "updateProject").mockImplementation(async () => {})
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {})

    await provider.initialize({ apiKey: "mem0-key" })

    expect((provider as any).apiKey).toBe("mem0-key")
    expect((provider as any).client).toBeInstanceOf(MemoryClient)
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        custom_instructions: expect.stringContaining("Generate personal memories"),
      })
    )
    expect(infoSpy).toHaveBeenCalledWith("Initialized Mem0 provider")

    initSpy.mockRestore()
    updateSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it("initialize tolerates updateProject failures", async () => {
    const provider = new Mem0Provider()
    const initSpy = spyOn((MemoryClient as { prototype: { _initializeClient: () => Promise<void> } }).prototype, "_initializeClient").mockImplementation(async () => {})
    const updateSpy = spyOn((MemoryClient as { prototype: { updateProject: () => Promise<void> } }).prototype, "updateProject").mockImplementation(async () => {
      throw new Error("boom")
    })
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {})

    await provider.initialize({ apiKey: "mem0-key" })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Could not set custom instructions:"))
    expect(infoSpy).toHaveBeenCalledWith("Initialized Mem0 provider")

    initSpy.mockRestore()
    updateSpy.mockRestore()
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it("ingests sessions and collects event IDs", async () => {
    const addMock = mock(async () => [{ event_id: "e1" }, { event_id: "e2" }, {}])
    const provider = new Mem0Provider()
    ;(provider as any).client = {
      add: addMock,
    }

    const sessions: UnifiedSession[] = [
      {
        sessionId: "s1",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "world" },
        ],
        metadata: { date: "2026-01-01", x: 1 },
      },
    ]

    const result = await provider.ingest(sessions, { containerTag: "user1", metadata: { y: 2 } })
    expect(result.documentIds).toEqual(["e1", "e2"])

    expect(addMock).toHaveBeenCalledTimes(1)
    const [messages, addOptions] = addMock.mock.calls[0] as [unknown[], Record<string, unknown>]
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ])
    expect(addOptions.user_id).toBe("user1")
    expect((addOptions.metadata as Record<string, unknown>).sessionId).toBe("s1")
    expect((addOptions.metadata as Record<string, unknown>).x).toBe(1)
    expect((addOptions.metadata as Record<string, unknown>).y).toBe(2)
  })

  it("awaitIndexing handles polling progression and failures", async () => {
    const provider = new Mem0Provider()
    ;(provider as any).apiKey = "abc"

    const statusById: Record<string, string[]> = {
      e1: ["RUNNING", "SUCCEEDED"],
      e2: ["FAILED"],
    }
    ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      const eventId = url.split("/event/")[1].replace("/", "")
      const sequence = statusById[eventId]
      const status = sequence.length > 1 ? sequence.shift()! : sequence[0]
      return new Response(JSON.stringify({ status }), { status: 200 })
    }) as typeof fetch

    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((cb: (...args: unknown[]) => void) => {
        cb()
        return 0 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout
    )
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})

    const progress: unknown[] = []
    await provider.awaitIndexing({ documentIds: ["e1", "e2"] }, "ignored", (p) => progress.push(p))

    expect(progress[0]).toEqual({ completedIds: [], failedIds: [], total: 2 })
    expect(progress[progress.length - 1]).toEqual({
      completedIds: ["e1"],
      failedIds: ["e2"],
      total: 2,
    })
    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith("1 events failed indexing")

    setTimeoutSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it("awaitIndexing short-circuits empty events", async () => {
    const provider = new Mem0Provider()
    const states: unknown[] = []
    await provider.awaitIndexing({ documentIds: [] }, "x", (p) => states.push(p))
    expect(states).toEqual([{ completedIds: [], failedIds: [], total: 0 }])
  })

  it("search and clear require initialization and handle results", async () => {
    const provider = new Mem0Provider()
    await expect(provider.search("q", { containerTag: "u" })).rejects.toThrow("Provider not initialized")
    await expect(provider.clear("u")).rejects.toThrow("Provider not initialized")

    const searchMock = mock(async () => ({ results: [{ id: 1 }] }))
    const deleteAllMock = mock(async () => {})
    ;(provider as any).client = { search: searchMock, deleteAll: deleteAllMock }

    expect(await provider.search("q", { containerTag: "u", limit: 4 })).toEqual([{ id: 1 }])
    expect(searchMock).toHaveBeenCalledWith("q", {
      user_id: "u",
      top_k: 4,
      enable_graph: false,
      output_format: "v1.1",
    })

    await provider.clear("u")
    expect(deleteAllMock).toHaveBeenCalledWith({ user_id: "u" })
  })

  it("getEventStatus returns UNKNOWN on errors", async () => {
    const provider = new Mem0Provider()
    ;(provider as any).apiKey = "abc"

    ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response("no", { status: 500 })) as typeof fetch
    expect(await (provider as any).getEventStatus("e1")).toBe("UNKNOWN")

    ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch
    expect(await (provider as any).getEventStatus("e2")).toBe("UNKNOWN")
  })
})
