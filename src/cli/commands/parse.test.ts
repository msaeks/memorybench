import { describe, expect, it } from "bun:test"
import { parseRunArgs } from "./run"
import { parseCompareArgs } from "./compare"
import { parseIngestArgs } from "./ingest"
import { parseListQuestionsArgs } from "./list-questions"
import { parseSearchArgs } from "./search"
import { parseStatusArgs } from "./status"
import { parseTestArgs } from "./test-question"

describe("CLI parse helpers", () => {
  it("parseRunArgs handles new run, generated runId, and concurrency options", () => {
    const parsed = parseRunArgs([
      "-p",
      "filesystem",
      "-b",
      "locomo",
      "--concurrency",
      "5",
      "--concurrency-search",
      "9",
      "--sample",
      "3",
      "--sample-type",
      "random",
      "--force",
    ])
    expect(parsed).not.toBeNull()
    expect(parsed!.provider).toBe("filesystem")
    expect(parsed!.benchmark).toBe("locomo")
    expect(parsed!.runId).toMatch(/^run-\d{8}-\d{6}$/)
    expect(parsed!.concurrency).toEqual({ default: 5, search: 9 })
    expect(parsed!.sample).toBe(3)
    expect(parsed!.sampleType).toBe("random")
    expect(parsed!.force).toBe(true)
  })

  it("parseRunArgs returns null on invalid phase/sampleType and missing required args", () => {
    expect(parseRunArgs(["-p", "filesystem"])).toBeNull()
    expect(parseRunArgs(["-p", "filesystem", "-b", "locomo", "--sample-type", "bad"])).toBeNull()
    expect(parseRunArgs(["-p", "filesystem", "-b", "locomo", "--from-phase", "bad"])).toBeNull()
    expect(parseRunArgs(["-r", "existing-run"])?.runId).toBe("existing-run")
  })

  it("parseCompareArgs handles compare-id and provider split", () => {
    const resume = parseCompareArgs(["--compare-id", "cmp-1"])
    expect(resume?.compareId).toBe("cmp-1")

    const fresh = parseCompareArgs([
      "-p",
      "supermemory, filesystem ,rag",
      "-b",
      "locomo",
      "-s",
      "10",
      "-l",
      "20",
      "--sample-type",
      "consecutive",
      "--force",
    ])
    expect(fresh).not.toBeNull()
    expect(fresh!.providers).toEqual(["supermemory", "filesystem", "rag"])
    expect(fresh!.benchmark).toBe("locomo")
    expect(fresh!.sample).toBe(10)
    expect(fresh!.limit).toBe(20)
    expect(fresh!.sampleType).toBe("consecutive")
    expect(fresh!.force).toBe(true)

    expect(parseCompareArgs(["-p", "filesystem"])).toBeNull()
    expect(parseCompareArgs(["-p", "filesystem", "-b", "locomo", "--sample-type", "bad"])).toBeNull()
  })

  it("parseIngestArgs supports continuation and generated run IDs", () => {
    expect(parseIngestArgs(["-r", "run-1"])?.runId).toBe("run-1")

    const fresh = parseIngestArgs(["-p", "filesystem", "-b", "locomo", "--force"])
    expect(fresh).not.toBeNull()
    expect(fresh!.runId).toMatch(/^run-\d{8}-\d{6}$/)
    expect(fresh!.force).toBe(true)
    expect(parseIngestArgs(["-p", "filesystem"])).toBeNull()
  })

  it("parseListQuestionsArgs, parseSearchArgs, parseStatusArgs, parseTestArgs", () => {
    expect(parseListQuestionsArgs(["-b", "locomo"])).toEqual({
      benchmark: "locomo",
      offset: 0,
      limit: 50,
    })
    expect(parseListQuestionsArgs(["-b", "locomo", "-o", "15", "-l", "5", "-t", "temporal"])).toEqual(
      {
        benchmark: "locomo",
        offset: 15,
        limit: 5,
        type: "temporal",
      }
    )
    expect(parseListQuestionsArgs([])).toBeNull()

    expect(parseSearchArgs(["-r", "run-2"])).toEqual({ runId: "run-2" })
    expect(parseSearchArgs(["-p", "filesystem"])).toBeNull()

    expect(parseStatusArgs(["-r", "run-3"])).toEqual({ runId: "run-3" })
    expect(parseStatusArgs([])).toBeNull()

    expect(parseTestArgs(["-r", "run-4", "-q", "q1"])).toEqual({ runId: "run-4", questionId: "q1" })
    expect(
      parseTestArgs(["-r", "run-4", "-q", "q1", "-p", "filesystem", "-b", "locomo", "-j", "gpt-4o"])
    ).toEqual({
      runId: "run-4",
      questionId: "q1",
      provider: "filesystem",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
    })
    expect(parseTestArgs(["-r", "run-4"])).toBeNull()
  })
})

