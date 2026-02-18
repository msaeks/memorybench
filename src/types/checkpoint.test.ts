import { describe, expect, it } from "bun:test"
import { PHASE_ORDER, getPhasesFromPhase } from "./checkpoint"

describe("checkpoint types helpers", () => {
  it("returns suffix phase list from requested phase", () => {
    expect(getPhasesFromPhase("search")).toEqual(["search", "answer", "evaluate", "report"])
  })

  it("returns full phase order when phase is not found", () => {
    const invalidPhase = "not-real" as unknown as (typeof PHASE_ORDER)[number]
    expect(getPhasesFromPhase(invalidPhase)).toEqual(PHASE_ORDER)
  })
})

