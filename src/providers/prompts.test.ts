import { describe, expect, it } from "bun:test"
import { buildMem0AnswerPrompt } from "./mem0/prompts"
import { buildRAGAnswerPrompt } from "./rag/prompts"
import { buildSupermemoryAnswerPrompt } from "./supermemory/prompts"
import { buildFilesystemAnswerPrompt } from "./filesystem/prompts"
import { buildZepAnswerPrompt, buildZepJudgePrompt } from "./zep/prompts"

describe("provider prompt builders", () => {
  it("buildMem0AnswerPrompt renders timestamp when present", () => {
    const prompt = buildMem0AnswerPrompt("Where do I live?", [
      { memory: "Lives in Seattle", metadata: { date: "2026-01-01" } },
      { note: "fallback object" },
    ])
    expect(prompt).toContain("[Timestamp: 2026-01-01]")
    expect(prompt).toContain("Lives in Seattle")
    expect(prompt).toContain("Where do I live?")
  })

  it("buildRAGAnswerPrompt renders chunk scores and no-result fallback", () => {
    const noResults = buildRAGAnswerPrompt("Q", [], "2026-01-10")
    expect(noResults).toContain("No relevant memory chunks were retrieved.")

    const withResults = buildRAGAnswerPrompt(
      "Q2",
      [
        {
          content: "Chunk content",
          score: 0.9,
          vectorScore: 0.8,
          bm25Score: 0.4,
          sessionId: "s1",
          chunkIndex: 0,
          date: "2026-01-01",
        },
      ],
      "2026-01-10"
    )
    expect(withResults).toContain("scores: hybrid: 0.900, semantic: 0.800, keyword: 0.400")
    expect(withResults).toContain("Date: 2026-01-01")
    expect(withResults).toContain("Chunk content")
  })

  it("buildSupermemoryAnswerPrompt deduplicates chunks and includes temporal context", () => {
    const prompt = buildSupermemoryAnswerPrompt("What happened?", [
      {
        memory: "Memory 1",
        chunk: "shared chunk",
        chunks: [
          { content: "shared chunk", position: 2 },
          { content: "later chunk", position: 5 },
        ],
        metadata: { temporalContext: { documentDate: "2026-01-01", eventDate: ["2026-01-02"] } },
      },
      { memory: "Memory 2", chunks: [{ content: "shared chunk", position: 1 }] },
    ])

    expect(prompt).toContain("Temporal Context: documentDate: 2026-01-01 | eventDate: 2026-01-02")
    expect(prompt).toContain("=== DEDUPLICATED CHUNKS ===")
    const sharedCount = (prompt.match(/shared chunk/g) || []).length
    expect(sharedCount).toBeGreaterThan(0)
  })

  it("buildFilesystemAnswerPrompt handles empty and populated contexts", () => {
    const emptyPrompt = buildFilesystemAnswerPrompt("Q", [])
    expect(emptyPrompt).toContain("No relevant memory files were found.")

    const prompt = buildFilesystemAnswerPrompt("Q2", [
      { sessionId: "s1", content: "hello", score: 0.83, matchCount: 3 },
    ])
    expect(prompt).toContain("=== Memory File 1: s1 (relevance: 83%) ===")
    expect(prompt).toContain("hello")
  })

  it("buildZepAnswerPrompt and buildZepJudgePrompt format context and rubric prompt", () => {
    const answerPrompt = buildZepAnswerPrompt("Where did I go?", [
      { _type: "edge", fact: "Went to Kyoto", valid_at: "2026-02-01T00:00:00Z" },
      { _type: "node", name: "Kyoto", summary: "City in Japan" },
    ])
    expect(answerPrompt).toContain("<FACTS>")
    expect(answerPrompt).toContain("Went to Kyoto")
    expect(answerPrompt).toContain("<ENTITIES>")
    expect(answerPrompt).toContain("Kyoto: City in Japan")

    const judgePrompt = buildZepJudgePrompt("Q", "GT", "H")
    expect(judgePrompt.default).toContain("Question: Q")
    expect(judgePrompt.default).toContain("Gold answer: GT")
    expect(judgePrompt.default).toContain("Generated answer: H")
  })
})

