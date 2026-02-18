import { describe, expect, it } from "bun:test"
import { assertSafeId, isSafeId, parseBoundedInt, resolveSafeSubpath } from "./security"

describe("security utils", () => {
  it("accepts safe IDs and rejects unsafe ones", () => {
    expect(isSafeId("abc_123-XYZ")).toBe(true)
    expect(isSafeId("")).toBe(false)
    expect(isSafeId("../escape")).toBe(false)
    expect(isSafeId("x".repeat(81))).toBe(false)
  })

  it("assertSafeId returns input for valid IDs and throws for invalid ones", () => {
    expect(assertSafeId("valid-id", "runId")).toBe("valid-id")
    expect(() => assertSafeId("bad/id", "runId")).toThrow("Invalid runId")
  })

  it("resolveSafeSubpath resolves inside base path and rejects traversal", () => {
    const resolved = resolveSafeSubpath("/tmp/base", "abc-1", "runId")
    expect(resolved.endsWith("/tmp/base/abc-1")).toBe(true)
    expect(() => resolveSafeSubpath("/tmp/base", "../outside", "runId")).toThrow("Invalid runId")
    expect(() => resolveSafeSubpath("/", "abc-1", "runId")).toThrow("Invalid runId")
  })

  it("parseBoundedInt applies fallback and bounds checks", () => {
    expect(parseBoundedInt(null, 7, 1, 10)).toBe(7)
    expect(parseBoundedInt("8", 7, 1, 10)).toBe(8)
    expect(parseBoundedInt("0", 7, 1, 10)).toBeNull()
    expect(parseBoundedInt("11", 7, 1, 10)).toBeNull()
    expect(parseBoundedInt("not-a-number", 7, 1, 10)).toBeNull()
  })
})
