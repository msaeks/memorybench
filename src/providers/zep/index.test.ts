import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { ZepClient } from "@getzep/zep-cloud"
import { ZepProvider } from "./index"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"

describe("ZepProvider", () => {
  const originalSetTimeout = globalThis.setTimeout

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  it("initialize creates Zep client and logs", async () => {
    const provider = new ZepProvider()
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {})

    await provider.initialize({ apiKey: "zep-key" })

    expect((provider as any).client).toBeInstanceOf(ZepClient)
    expect(infoSpy).toHaveBeenCalledWith("Initialized Zep provider")
    infoSpy.mockRestore()
  })

  it("ingest requires init and builds graph/task ids", async () => {
    const provider = new ZepProvider()
    await expect(provider.ingest([], { containerTag: "ct" })).rejects.toThrow("Provider not initialized")

    const createMock = mock(async () => {})
    const setOntologyMock = mock(async () => {})
    const addBatchMock = mock(async () => [{ taskId: "t1" }, { taskId: "t1" }, { taskId: "t2" }])

    ;(provider as any).client = {
      graph: {
        create: createMock,
        setOntology: setOntologyMock,
        addBatch: addBatchMock,
      },
    }

    const longText = `user: ${"a".repeat(10050)}`
    const sessions: UnifiedSession[] = [
      {
        sessionId: "s1",
        messages: [
          { role: "user", speaker: "User", content: "hello" },
          { role: "assistant", speaker: "Assistant", content: longText },
        ],
        metadata: { date: "2026-01-01T00:00:00Z" },
      },
    ]

    const result = await provider.ingest(sessions, { containerTag: "ct with spaces" })
    expect(result.taskIds).toEqual(["t1", "t2"])
    expect(createMock).toHaveBeenCalled()
    expect(setOntologyMock).toHaveBeenCalled()
    expect(addBatchMock).toHaveBeenCalled()
  })

  it("awaitIndexing handles polling transitions", async () => {
    const provider = new ZepProvider()
    await expect(provider.awaitIndexing({ documentIds: [], taskIds: ["x"] }, "ct")).rejects.toThrow(
      "Provider not initialized"
    )

    const taskStates: Record<string, string[]> = {
      t1: ["running", "succeeded"],
      t2: ["failed"],
    }
    ;(provider as any).client = {
      task: {
        get: async (id: string) => {
          const seq = taskStates[id]
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

    const states: unknown[] = []
    await provider.awaitIndexing({ documentIds: [], taskIds: ["t1", "t2"] }, "ct", (p) => states.push(p))
    expect(states[states.length - 1]).toEqual({
      completedIds: ["t1"],
      failedIds: ["t2"],
      total: 2,
    })
    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith("1 indexing tasks failed")

    setTimeoutSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it("search derives graph id when missing and merges edges/nodes", async () => {
    const provider = new ZepProvider()
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
    ;(provider as any).client = {
      graph: {
        search: mock(async ({ scope }: { scope: string }) => {
          if (scope === "edges") return { edges: [{ fact: "edge fact" }] }
          return { nodes: [{ name: "node name" }] }
        }),
      },
    }

    const results = await provider.search("query", { containerTag: "ct@bad", limit: 5 })
    expect(results).toEqual([
      { fact: "edge fact", _type: "edge" },
      { name: "node name", _type: "node" },
    ])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("clear deletes graph and tolerates delete failures", async () => {
    const provider = new ZepProvider()
    await expect(provider.clear("ct")).rejects.toThrow("Provider not initialized")

    const deleteMock = mock(async (_graphId: string) => {})
    ;(provider as any).client = { graph: { delete: deleteMock } }
    ;(provider as any).graphIds.set("ct", "memorybench_ct")
    ;(provider as any).ontologySet.add("memorybench_ct")

    await provider.clear("ct")
    expect(deleteMock).toHaveBeenCalledWith("memorybench_ct")
    expect((provider as any).graphIds.has("ct")).toBe(false)

    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
    ;(provider as any).graphIds.set("ct2", "memorybench_ct2")
    ;(provider as any).ontologySet.add("memorybench_ct2")
    ;(provider as any).client.graph.delete = async () => {
      throw new Error("nope")
    }
    await provider.clear("ct2")
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
