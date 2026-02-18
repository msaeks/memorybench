import { describe, expect, it } from "bun:test"
import { createProvider, getAvailableProviders, getProviderInfo } from "./index"

describe("providers registry", () => {
  it("lists available providers", () => {
    const providers = getAvailableProviders()
    expect(providers).toContain("filesystem")
    expect(providers).toContain("rag")
    expect(providers).toContain("hindsight")
  })

  it("creates providers and returns provider metadata", () => {
    const provider = createProvider("filesystem")
    expect(provider.name).toBe("filesystem")

    const info = getProviderInfo("filesystem")
    expect(info.name).toBe("filesystem")
    expect(info.displayName).toBe("Filesystem")
    expect(info.concurrency).not.toBeNull()
  })

  it("throws for unknown provider names", () => {
    expect(() => createProvider("not-real" as never)).toThrow("Unknown provider: not-real")
  })
})

