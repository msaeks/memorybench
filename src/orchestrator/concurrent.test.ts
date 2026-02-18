import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { ConcurrentExecutor } from "./concurrent"
import { activeRuns, requestStop, startRun } from "../server/runState"

describe("ConcurrentExecutor", () => {
  const originalSetTimeout = globalThis.setTimeout

  beforeEach(() => {
    activeRuns.clear()
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  it("returns empty results for empty input and rejects non-positive concurrency", async () => {
    const empty = await ConcurrentExecutor.execute([], 2, "r1", "phase", async () => 1)
    expect(empty).toEqual([])

    await expect(
      ConcurrentExecutor.executeBatched({
        items: [1],
        concurrency: 0,
        rateLimitMs: 0,
        runId: "r1",
        phaseName: "phase",
        executeTask: async () => 1,
      })
    ).rejects.toThrow("Concurrency must be positive")
  })

  it("processes tasks in batches with callbacks and rate limiting", async () => {
    const batchStarts: Array<[number, number]> = []
    const batchCompletions: Array<[number, number]> = []
    const taskDone: number[] = []

    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((cb: (...args: unknown[]) => void) => {
        cb()
        return 0 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout
    )

    const results = await ConcurrentExecutor.executeBatched({
      items: [1, 2, 3, 4, 5],
      concurrency: 2,
      rateLimitMs: 50,
      runId: "r2",
      phaseName: "phase",
      executeTask: async ({ item }) => item * 10,
      onBatchStart: (idx, size) => batchStarts.push([idx, size]),
      onBatchComplete: (idx, rs) => batchCompletions.push([idx, rs.length]),
      onTaskComplete: ({ item }) => taskDone.push(item),
    })

    expect(results).toEqual([10, 20, 30, 40, 50])
    expect(batchStarts).toEqual([
      [0, 2],
      [1, 2],
      [2, 1],
    ])
    expect(batchCompletions).toEqual([
      [0, 2],
      [1, 2],
      [2, 1],
    ])
    expect(taskDone.sort()).toEqual([1, 2, 3, 4, 5])
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2)
    setTimeoutSpy.mockRestore()
  })

  it("stops when run has been marked as stopping", async () => {
    startRun("run-stop", "locomo")
    requestStop("run-stop")

    await expect(
      ConcurrentExecutor.executeBatched({
        items: [1, 2],
        concurrency: 1,
        rateLimitMs: 0,
        runId: "run-stop",
        phaseName: "search",
        executeTask: async ({ item }) => item,
      })
    ).rejects.toThrow("Run stopped by user")
  })

  it("fails fast on first task error and reports onError callback", async () => {
    const errors: string[] = []
    await expect(
      ConcurrentExecutor.executeBatched({
        items: [1, 2, 3],
        concurrency: 3,
        rateLimitMs: 0,
        runId: "run-error",
        phaseName: "ingest",
        executeTask: async ({ item }) => {
          if (item === 2) throw new Error("boom")
          return item
        },
        onError: ({ item }, err) => errors.push(`${item}:${err.message}`),
      })
    ).rejects.toThrow("boom")

    expect(errors).toEqual(["2:boom"])
  })
})
