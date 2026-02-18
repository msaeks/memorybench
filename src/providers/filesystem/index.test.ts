import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FilesystemProvider } from "./index"
import { logger } from "../../utils/logger"

const BASE_DIR = join(process.cwd(), "data", "providers", "filesystem")

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

describe("FilesystemProvider", () => {
  beforeEach(async () => {
    await rm(BASE_DIR, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(BASE_DIR, { recursive: true, force: true })
  })

  it("initialize validates api key and creates base directory", async () => {
    const provider = new FilesystemProvider()
    await expect(provider.initialize({ apiKey: "" })).rejects.toThrow(
      "Filesystem provider requires OPENAI_API_KEY for memory extraction"
    )
    await expect(provider.initialize({ apiKey: "none" })).rejects.toThrow(
      "Filesystem provider requires OPENAI_API_KEY for memory extraction"
    )

    await provider.initialize({ apiKey: "test-key" })
    const containerDir = join(BASE_DIR, sanitize("container"))
    await mkdir(join(containerDir, "memories"), { recursive: true })
  })

  it("awaitIndexing reports all IDs as completed immediately", async () => {
    const provider = new FilesystemProvider()
    let progress: unknown
    await provider.awaitIndexing({ documentIds: ["a", "b"] }, "x", (p) => {
      progress = p
    })
    expect(progress).toEqual({ completedIds: ["a", "b"], failedIds: [], total: 2 })
  })

  it("search returns empty array when memories directory is missing", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
    const provider = new FilesystemProvider()
    const result = await provider.search("hello", { containerTag: "missing/tag", limit: 5 })
    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("search scores and sorts markdown files, then applies limit and fallback", async () => {
    const provider = new FilesystemProvider()
    const containerTag = "tag with spaces"
    const memoriesDir = join(BASE_DIR, sanitize(containerTag), "memories")
    await mkdir(memoriesDir, { recursive: true })

    await writeFile(
      join(memoriesDir, "s1.md"),
      "Alice likes hiking. Alice likes Seattle parks. Hiking is frequent.",
      "utf-8"
    )
    await writeFile(join(memoriesDir, "s2.md"), "Bob prefers chess indoors.", "utf-8")
    await writeFile(join(memoriesDir, "ignore.txt"), "not markdown", "utf-8")

    const topOnly = (await provider.search("alice hiking", {
      containerTag,
      limit: 1,
    })) as Array<{ sessionId: string; score: number }>
    expect(topOnly).toHaveLength(1)
    expect(topOnly[0].sessionId).toBe("s1")
    expect(topOnly[0].score).toBeGreaterThan(0)

    const withFallback = (await provider.search("alice", {
      containerTag,
      limit: 2,
    })) as Array<{ sessionId: string; score: number }>
    expect(withFallback).toHaveLength(2)
    expect(withFallback.some((r) => r.sessionId === "s1")).toBe(true)
    expect(withFallback.some((r) => r.score === 0)).toBe(true)
  })

  it("clear removes container data safely", async () => {
    const provider = new FilesystemProvider()
    const containerTag = "clear-me"
    const containerDir = join(BASE_DIR, sanitize(containerTag), "memories")
    await mkdir(containerDir, { recursive: true })
    await writeFile(join(containerDir, "x.md"), "data", "utf-8")

    await provider.clear(containerTag)
    const results = await provider.search("data", { containerTag, limit: 5 })
    expect(results).toEqual([])
  })
})

