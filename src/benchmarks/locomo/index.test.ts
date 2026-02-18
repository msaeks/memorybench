import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { LoCoMoBenchmark } from "./index"
import { logger } from "../../utils/logger"

const FIXTURE_PATH = join(process.cwd(), "src", "benchmarks", "__fixtures__", "locomo-sample.json")

describe("LoCoMoBenchmark", () => {
  let tempDir: string
  let tempRel: string

  beforeEach(async () => {
    tempRel = join("tmp-benchmark-tests", `locomo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    tempDir = join(process.cwd(), tempRel)
    await mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("loads from fixture file and exposes questions/sessions/filters", async () => {
    const target = join(tempDir, "locomo10.json")
    const targetRel = join(tempRel, "locomo10.json")
    await writeFile(target, await readFile(FIXTURE_PATH, "utf8"), "utf8")

    const benchmark = new LoCoMoBenchmark()
    await benchmark.load({ dataPath: targetRel })

    const questions = benchmark.getQuestions()
    expect(questions).toHaveLength(2)
    expect(questions[0].questionType).toBe("single-hop")
    expect(questions[1].questionType).toBe("temporal")
    expect(benchmark.getGroundTruth(questions[0].questionId)).toBe("Seattle")
    expect(benchmark.getQuestions({ questionTypes: ["temporal"] })).toHaveLength(1)
    expect(benchmark.getQuestions({ offset: 1, limit: 1 })).toHaveLength(1)

    const sessions = benchmark.getHaystackSessions(questions[0].questionId)
    expect(sessions.length).toBeGreaterThan(0)
    expect(sessions[0].metadata?.formattedDate).toBeString()
  })

  it("downloads when dataset file is missing", async () => {
    const target = join(tempDir, "locomo10.json")
    const targetRel = join(tempRel, "locomo10.json")
    const fixtureText = await readFile(FIXTURE_PATH, "utf8")
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(fixtureText, { status: 200 }))

    const benchmark = new LoCoMoBenchmark()
    await benchmark.load({ dataPath: targetRel })
    expect(fetchSpy).toHaveBeenCalled()
    expect(benchmark.getQuestions().length).toBeGreaterThan(0)

    fetchSpy.mockRestore()
  })

  it("warns on unparseable dates and throws on unknown category", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
    const badCategoryPath = join(tempDir, "locomo-bad.json")
    const badCategoryRel = join(tempRel, "locomo-bad.json")
    await writeFile(
      badCategoryPath,
      JSON.stringify([
        {
          sample_id: "x",
          qa: [{ question: "q", answer: "a", evidence: [], category: 99 }],
          conversation: {
            speaker_a: "A",
            speaker_b: "B",
            session_1: [{ speaker: "A", dia_id: "1", text: "hello" }],
            session_1_date_time: "not a date",
          },
          event_summary: {},
          observation: {},
          session_summary: {},
        },
      ]),
      "utf8"
    )

    const benchmark = new LoCoMoBenchmark()
    await expect(benchmark.load({ dataPath: badCategoryRel })).rejects.toThrow("Unknown LoCoMo category")
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
