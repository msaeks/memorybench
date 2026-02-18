import { describe, expect, it } from "bun:test"
import { createJudge, getAvailableJudges } from "./index"

describe("judges registry", () => {
  it("lists available judges", () => {
    const judges = getAvailableJudges()
    expect(judges).toEqual(["openai", "anthropic", "google"])
  })

  it("creates judge instances and throws for unknown names", () => {
    const openaiJudge = createJudge("openai")
    expect(openaiJudge.name).toBe("openai")
    expect(() => createJudge("not-real" as never)).toThrow("Unknown judge: not-real")
  })
})

