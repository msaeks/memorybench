import { describe, expect, it } from "bun:test"
import { OpenAIJudge } from "./openai"
import { AnthropicJudge } from "./anthropic"
import { GoogleJudge } from "./google"

describe("provider judges initialization", () => {
  it("OpenAIJudge initializes and exposes prompt/model helpers", async () => {
    const judge = new OpenAIJudge()
    expect(() => judge.getModel()).toThrow("Judge not initialized")

    await judge.initialize({ apiKey: "test-key", model: "gpt-4o" })
    expect(judge.getPromptForQuestionType("temporal")).toContain("off-by-one")
    expect(judge.getModel()).toBeDefined()
  })

  it("AnthropicJudge initializes and exposes prompt/model helpers", async () => {
    const judge = new AnthropicJudge()
    expect(() => judge.getModel()).toThrow("Judge not initialized")

    await judge.initialize({ apiKey: "test-key", model: "sonnet-4" })
    expect(judge.getPromptForQuestionType("abstention")).toContain("properly abstained")
    expect(judge.getModel()).toBeDefined()
  })

  it("GoogleJudge initializes and exposes prompt/model helpers", async () => {
    const judge = new GoogleJudge()
    expect(() => judge.getModel()).toThrow("Judge not initialized")

    await judge.initialize({ apiKey: "test-key", model: "gemini-2.5-flash" })
    expect(judge.getPromptForQuestionType("preference")).toContain("desired response")
    expect(judge.getModel()).toBeDefined()
  })
})

