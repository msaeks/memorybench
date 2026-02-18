import { describe, expect, it, spyOn } from "bun:test"
import * as ai from "ai"
import { OpenAIJudge } from "./openai"
import { AnthropicJudge } from "./anthropic"
import { GoogleJudge } from "./google"

const INPUT = {
  question: "Where do I live?",
  questionType: "single-hop",
  groundTruth: "Seattle",
  hypothesis: "Seattle",
}

describe("judge evaluate() providers", () => {
  it("OpenAIJudge evaluate parses response and sets temperature when supported", async () => {
    const generateTextSpy = spyOn(ai, "generateText").mockResolvedValue({
      text: '{"score":1,"label":"correct","explanation":"ok"}',
    } as never)

    const judge = new OpenAIJudge()
    await judge.initialize({ apiKey: "k", model: "gpt-4o" })
    const result = await judge.evaluate(INPUT)
    expect(result).toEqual({ score: 1, label: "correct", explanation: "ok" })

    const params = generateTextSpy.mock.calls[0][0] as Record<string, unknown>
    expect(params.maxTokens).toBeNumber()
    expect(params.temperature).toBeNumber()
    generateTextSpy.mockRestore()
  })

  it("OpenAIJudge omits temperature for reasoning models", async () => {
    const generateTextSpy = spyOn(ai, "generateText").mockResolvedValue({
      text: '{"score":0,"label":"incorrect","explanation":"no"}',
    } as never)

    const judge = new OpenAIJudge()
    await judge.initialize({ apiKey: "k", model: "gpt-5" })
    await judge.evaluate(INPUT)

    const params = generateTextSpy.mock.calls[0][0] as Record<string, unknown>
    expect("temperature" in params).toBe(false)
    generateTextSpy.mockRestore()
  })

  it("AnthropicJudge evaluate uses configured maxTokens and parsing", async () => {
    const generateTextSpy = spyOn(ai, "generateText").mockResolvedValue({
      text: '{"score":1,"label":"correct","explanation":"anthropic"}',
    } as never)

    const judge = new AnthropicJudge()
    await judge.initialize({ apiKey: "k", model: "sonnet-4" })
    const result = await judge.evaluate(INPUT)
    expect(result.label).toBe("correct")

    const params = generateTextSpy.mock.calls[0][0] as Record<string, unknown>
    expect(params.maxTokens).toBeNumber()
    generateTextSpy.mockRestore()
  })

  it("GoogleJudge evaluate uses configured maxTokens and parsing", async () => {
    const generateTextSpy = spyOn(ai, "generateText").mockResolvedValue({
      text: '{"score":1,"label":"correct","explanation":"google"}',
    } as never)

    const judge = new GoogleJudge()
    await judge.initialize({ apiKey: "k", model: "gemini-2.5-flash" })
    const result = await judge.evaluate(INPUT)
    expect(result.explanation).toBe("google")

    const params = generateTextSpy.mock.calls[0][0] as Record<string, unknown>
    expect(params.maxTokens).toBeNumber()
    generateTextSpy.mockRestore()
  })
})

