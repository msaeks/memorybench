import { describe, expect, it } from "bun:test"
import { createBenchmark, getAvailableBenchmarks } from "./index"

describe("benchmarks registry", () => {
  it("lists available benchmarks", () => {
    const benchmarks = getAvailableBenchmarks()
    expect(benchmarks).toContain("locomo")
    expect(benchmarks).toContain("convomem")
    expect(benchmarks).toContain("longmemeval")
  })

  it("creates benchmark classes and throws on unknown names", () => {
    const b = createBenchmark("locomo")
    expect(b.name).toBe("locomo")
    expect(() => createBenchmark("not-real" as never)).toThrow("Unknown benchmark: not-real")
  })
})

