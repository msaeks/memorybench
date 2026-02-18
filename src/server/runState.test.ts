import { beforeEach, describe, expect, it } from "bun:test"
import {
  activeRuns,
  endRun,
  getActiveRunsWithBenchmarks,
  getRunState,
  isRunActive,
  requestStop,
  shouldStop,
  startRun,
} from "./runState"

describe("runState", () => {
  beforeEach(() => {
    activeRuns.clear()
  })

  it("tracks lifecycle for active runs", () => {
    expect(isRunActive("run1")).toBe(false)
    expect(requestStop("run1")).toBe(false)
    expect(shouldStop("run1")).toBe(false)

    startRun("run1", "locomo")
    expect(isRunActive("run1")).toBe(true)
    expect(getRunState("run1")?.status).toBe("running")
    expect(getRunState("run1")?.startedAt).toBeString()

    expect(requestStop("run1")).toBe(true)
    expect(shouldStop("run1")).toBe(true)

    endRun("run1")
    expect(isRunActive("run1")).toBe(false)
    expect(getRunState("run1")).toBeUndefined()
  })

  it("lists only runs with benchmark metadata", () => {
    startRun("run-with-benchmark", "longmemeval")
    startRun("run-no-benchmark")

    const listed = getActiveRunsWithBenchmarks()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual({ runId: "run-with-benchmark", benchmark: "longmemeval" })
  })
})

