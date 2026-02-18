import { describe, expect, it } from "bun:test"
import { resolveConcurrency } from "./concurrency"

describe("resolveConcurrency", () => {
  it("prefers CLI per-phase over all defaults", () => {
    const value = resolveConcurrency(
      "search",
      { default: 10, search: 25 },
      { default: 3, search: 5 }
    )
    expect(value).toBe(25)
  })

  it("falls back to CLI default when per-phase not set", () => {
    const value = resolveConcurrency("answer", { default: 11 }, { default: 3, answer: 9 })
    expect(value).toBe(11)
  })

  it("falls back to provider per-phase then provider default then 1", () => {
    expect(resolveConcurrency("indexing", undefined, { default: 7, indexing: 13 })).toBe(13)
    expect(resolveConcurrency("evaluate", undefined, { default: 7 })).toBe(7)
    expect(resolveConcurrency("ingest")).toBe(1)
  })
})

