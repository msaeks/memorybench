import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { HindsightProvider } from "./index"
import type { UnifiedSession } from "../../types/unified"

describe("HindsightProvider", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  })

  afterEach(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  })

  it("ingests sessions, falls back to sessionId, and reports indexing progress", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    ;(globalThis as { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls.push({ url: String(input), init })
      const body = JSON.parse(String(init?.body || "{}"))
      if (String(input).includes("/memories")) {
        if (body.payload?.sessionId === "s1") {
          return new Response(JSON.stringify({ memory: { id: "mem-1" } }), { status: 200 })
        }
        return new Response(JSON.stringify({ memory: {} }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const provider = new HindsightProvider()
    await provider.initialize({ apiKey: "k", baseUrl: "http://localhost:8888/" })

    const sessions: UnifiedSession[] = [
      {
        sessionId: "s1",
        messages: [{ role: "user", content: "I like tea" }],
        metadata: { formattedDate: "2026-02-01" },
      },
      {
        sessionId: "s2",
        messages: [{ role: "assistant", content: "noted" }],
      },
    ]

    const result = await provider.ingest(sessions, {
      containerTag: "tag/with space",
      metadata: { a: 1 },
    })
    expect(result.documentIds).toEqual(["mem-1", "s2"])
    expect(calls[0].url).toContain("/banks/tag%2Fwith%20space/memories")
    expect(calls[0].init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer k",
    })

    let progressPayload: unknown
    await provider.awaitIndexing(result, "ignored", (p) => {
      progressPayload = p
    })
    expect(progressPayload).toEqual({
      completedIds: ["mem-1", "s2"],
      failedIds: [],
      total: 2,
    })
  })

  it("search returns memories array or empty array", async () => {
    let call = 0
    ;(globalThis as { fetch: typeof fetch }).fetch = (async () => {
      call++
      if (call === 1) {
        return new Response(JSON.stringify({ memories: [{ id: "m1" }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ memories: "not-array" }), { status: 200 })
    }) as unknown as typeof fetch

    const provider = new HindsightProvider()
    await provider.initialize({ apiKey: "none" })
    expect(await provider.search("q", { containerTag: "tag", limit: 5 })).toEqual([{ id: "m1" }])
    expect(await provider.search("q", { containerTag: "tag" })).toEqual([])
  })

  it("clear tolerates 404 and throws on non-404 errors", async () => {
    let call = 0
    ;(globalThis as { fetch: typeof fetch }).fetch = (async () => {
      call++
      if (call === 1) return new Response("missing", { status: 404 })
      return new Response("boom", { status: 500 })
    }) as unknown as typeof fetch

    const provider = new HindsightProvider()
    await provider.initialize({ apiKey: "" })

    await provider.clear("tag")
    await expect(provider.clear("tag")).rejects.toThrow("Hindsight clear failed (500): boom")
  })
})
