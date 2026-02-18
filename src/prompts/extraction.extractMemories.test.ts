import { afterEach, describe, expect, it, mock } from "bun:test"
import type { UnifiedSession } from "../types/unified"

afterEach(() => {
  mock.restore()
})

describe("extractMemories", () => {
  it("calls generateText and returns trimmed text", async () => {
    const generateTextMock = mock(async () => ({ text: "  extracted memory  \n" }))
    mock.module("ai", () => ({
      generateText: generateTextMock,
    }))

    const { extractMemories } = await import(`./extraction?mock=${Date.now()}`)

    const fakeOpenAI = (() => ({})) as unknown as ReturnType<
      (typeof import("@ai-sdk/openai"))["createOpenAI"]
    >
    const session: UnifiedSession = {
      sessionId: "s1",
      messages: [{ role: "user", content: "hello" }],
    }

    const text = await extractMemories(fakeOpenAI, session)
    expect(text).toBe("extracted memory")
    expect(generateTextMock).toHaveBeenCalled()
  })
})

