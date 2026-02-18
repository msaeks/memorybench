import { describe, expect, it } from "bun:test"
import {
  getModelConfig,
  getModelId,
  getModelProvider,
  listAvailableModels,
  listModelsByProvider,
  resolveModel,
} from "./models"

describe("model utils", () => {
  it("returns exact config for known aliases case-insensitively", () => {
    const lower = getModelConfig("gpt-4o")
    const upper = getModelConfig("GPT-4O")
    expect(lower.id).toBe("gpt-4o")
    expect(upper.id).toBe("gpt-4o")
    expect(lower.provider).toBe("openai")
  })

  it("infers openai reasoning defaults for gpt-5/o* families", () => {
    const gpt5 = getModelConfig("gpt-5-custom")
    const o3 = getModelConfig("o3-custom")

    expect(gpt5.provider).toBe("openai")
    expect(gpt5.supportsTemperature).toBe(false)
    expect(gpt5.maxTokensParam).toBe("max_completion_tokens")

    expect(o3.provider).toBe("openai")
    expect(o3.defaultTemperature).toBe(1)
  })

  it("infers gpt/claude/gemini fallback branches", () => {
    const gpt = getModelConfig("gpt-x")
    const claude = getModelConfig("claude-x")
    const gemini3 = getModelConfig("gemini-3-experimental")
    const gemini2 = getModelConfig("gemini-2-custom")
    const unknown = getModelConfig("my-custom-model")

    expect(gpt.provider).toBe("openai")
    expect(gpt.supportsTemperature).toBe(true)
    expect(claude.provider).toBe("anthropic")
    expect(gemini3.provider).toBe("google")
    expect(gemini3.defaultTemperature).toBe(1)
    expect(gemini2.defaultTemperature).toBe(0)
    expect(unknown.provider).toBe("openai")
    expect(unknown.maxTokensParam).toBe("maxTokens")
  })

  it("exposes helper wrappers and provider filtering", () => {
    expect(resolveModel("gpt-4o").id).toBe(getModelConfig("gpt-4o").id)
    expect(getModelId("sonnet-4")).toBe(getModelConfig("sonnet-4").id)
    expect(getModelProvider("gemini-2.5-flash")).toBe("google")

    const all = listAvailableModels()
    expect(all.length).toBeGreaterThan(0)
    expect(all).toContain("gpt-4o")

    const anthropic = listModelsByProvider("anthropic")
    expect(anthropic.length).toBeGreaterThan(0)
    expect(anthropic.every((m) => getModelConfig(m).provider === "anthropic")).toBe(true)
  })
})

