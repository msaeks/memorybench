import { describe, expect, it } from "bun:test"
import { config, getJudgeConfig, getProviderConfig } from "./config"

describe("config utils", () => {
  it("returns provider config mappings", () => {
    expect(getProviderConfig("supermemory")).toEqual({
      apiKey: config.supermemoryApiKey,
      baseUrl: config.supermemoryBaseUrl,
    })
    expect(getProviderConfig("mem0")).toEqual({ apiKey: config.mem0ApiKey })
    expect(getProviderConfig("zep")).toEqual({ apiKey: config.zepApiKey })
    expect(getProviderConfig("hindsight")).toEqual({
      apiKey: config.hindsightApiKey,
      baseUrl: config.hindsightBaseUrl,
    })
    expect(getProviderConfig("filesystem")).toEqual({ apiKey: config.openaiApiKey })
    expect(getProviderConfig("rag")).toEqual({ apiKey: config.openaiApiKey })
  })

  it("throws for unknown providers", () => {
    expect(() => getProviderConfig("not-real")).toThrow("Unknown provider: not-real")
  })

  it("returns judge config mappings and errors on unknown judge", () => {
    expect(getJudgeConfig("openai")).toEqual({ apiKey: config.openaiApiKey })
    expect(getJudgeConfig("anthropic")).toEqual({ apiKey: config.anthropicApiKey })
    expect(getJudgeConfig("google")).toEqual({ apiKey: config.googleApiKey })
    expect(() => getJudgeConfig("other")).toThrow("Unknown judge: other")
  })
})

