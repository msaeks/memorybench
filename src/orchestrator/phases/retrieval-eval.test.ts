import { describe, expect, it, spyOn } from "bun:test"
import * as ai from "ai"
import { calculateRetrievalMetrics } from "./retrieval-eval"

describe("calculateRetrievalMetrics", () => {
  it("returns zeros when no search results are present", async () => {
    const metrics = await calculateRetrievalMetrics({} as never, "q", "a", [], 10)
    expect(metrics).toEqual({
      hitAtK: 0,
      precisionAtK: 0,
      recallAtK: 0,
      f1AtK: 0,
      mrr: 0,
      ndcg: 0,
      k: 0,
      relevantRetrieved: 0,
      totalRelevant: 1,
    })
  })

  it("computes retrieval metrics from parsed relevance JSON", async () => {
    const generateTextSpy = spyOn(ai, "generateText").mockResolvedValue({
      text: `[
        {"id":"result_1","relevant":1},
        {"id":"result_2","relevant":0},
        {"id":"result_3","relevant":1}
      ]`,
    } as never)

    const searchResults = [{ a: 1 }, { a: 2 }, { a: 3 }]
    const metrics = await calculateRetrievalMetrics({} as never, "q", "a", searchResults, 3)

    expect(metrics.k).toBe(3)
    expect(metrics.relevantRetrieved).toBe(2)
    expect(metrics.hitAtK).toBe(1)
    expect(metrics.precisionAtK).toBeCloseTo(2 / 3)
    expect(metrics.recallAtK).toBe(1)
    expect(metrics.mrr).toBe(1)
    expect(metrics.ndcg).toBeGreaterThan(0)
    expect(generateTextSpy).toHaveBeenCalled()

    generateTextSpy.mockRestore()
  })

  it("falls back to all-irrelevant results for malformed judge output", async () => {
    const generateTextSpy = spyOn(ai, "generateText").mockResolvedValue({
      text: "not-json",
    } as never)

    const metrics = await calculateRetrievalMetrics({} as never, "q", "a", [{ a: 1 }, { a: 2 }], 2)
    expect(metrics.relevantRetrieved).toBe(0)
    expect(metrics.hitAtK).toBe(0)
    expect(metrics.precisionAtK).toBe(0)
    expect(metrics.mrr).toBe(0)

    generateTextSpy.mockRestore()
  })

  it("falls back to all-irrelevant results when judge call throws", async () => {
    const generateTextSpy = spyOn(ai, "generateText").mockRejectedValue(new Error("judge down") as never)

    const metrics = await calculateRetrievalMetrics({} as never, "q", "a", [{ a: 1 }, { a: 2 }], 2)
    expect(metrics.relevantRetrieved).toBe(0)
    expect(metrics.hitAtK).toBe(0)
    expect(metrics.precisionAtK).toBe(0)
    expect(metrics.mrr).toBe(0)

    generateTextSpy.mockRestore()
  })
})
