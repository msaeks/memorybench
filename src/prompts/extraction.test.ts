import { describe, expect, it } from "bun:test"
import { buildExtractionPrompt } from "./extraction"
import type { UnifiedSession } from "../types/unified"

describe("extraction prompt", () => {
  it("uses speaker/date metadata and includes timestamped conversation lines", () => {
    const session: UnifiedSession = {
      sessionId: "s-1",
      messages: [
        {
          role: "user",
          content: "I moved to Seattle.",
          timestamp: "10:00",
          speaker: "Alex",
        },
        {
          role: "assistant",
          content: "Noted!",
          speaker: "Sam",
        },
      ],
      metadata: {
        speakerA: "Alex",
        speakerB: "Sam",
        formattedDate: "2026-01-02",
      },
    }

    const prompt = buildExtractionPrompt(session)
    expect(prompt).toContain("Conversation Date: 2026-01-02")
    expect(prompt).toContain("Participants: Alex, Sam")
    expect(prompt).toContain("Alex [10:00]: I moved to Seattle.")
    expect(prompt).toContain("Sam: Noted!")
  })

  it("falls back to default labels/date when metadata is missing", () => {
    const session: UnifiedSession = {
      sessionId: "s-2",
      messages: [{ role: "user", content: "Hello" }],
      metadata: {},
    }

    const prompt = buildExtractionPrompt(session)
    expect(prompt).toContain("Conversation Date: Unknown date")
    expect(prompt).toContain("Participants: Speaker A, Speaker B")
    expect(prompt).toContain("user: Hello")
  })
})

