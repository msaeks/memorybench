import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { UnifiedSession } from "../../types/unified"

const BASE_DIR = join(process.cwd(), "data", "providers", "filesystem")

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

describe("FilesystemProvider ingest", () => {
  beforeEach(async () => {
    await rm(BASE_DIR, { recursive: true, force: true })
  })

  afterEach(async () => {
    mock.restore()
    await rm(BASE_DIR, { recursive: true, force: true })
  })

  it("writes extracted memories with date header and sanitized session IDs", async () => {
    const extractMemoriesMock = mock(async () => "## Key Facts\n- User likes coffee")
    mock.module("../../prompts/extraction", () => ({
      extractMemories: extractMemoriesMock,
    }))

    const { FilesystemProvider } = await import("./index")
    const provider = new FilesystemProvider()
    ;(provider as any).openai = {} as unknown

    const sessions: UnifiedSession[] = [
      {
        sessionId: "session/1",
        messages: [{ role: "user", content: "I like coffee." }],
        metadata: { formattedDate: "2026-02-01" },
      },
    ]

    const result = await provider.ingest(sessions, { containerTag: "my container" })
    expect(result.documentIds).toEqual(["session_1"])
    expect(extractMemoriesMock).toHaveBeenCalledTimes(1)

    const filePath = join(BASE_DIR, sanitize("my container"), "memories", "session_1.md")
    const content = await readFile(filePath, "utf-8")
    expect(content).toContain("# Memory: session/1")
    expect(content).toContain("**Date:** 2026-02-01")
    expect(content).toContain("User likes coffee")
  })

  it("returns empty document list for empty session arrays", async () => {
    const { FilesystemProvider } = await import("./index")
    const provider = new FilesystemProvider()
    ;(provider as any).openai = {} as unknown

    const result = await provider.ingest([], { containerTag: "empty" })
    expect(result.documentIds).toEqual([])
  })
})
