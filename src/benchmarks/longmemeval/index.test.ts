import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { LongMemEvalBenchmark } from "./index"
import { logger } from "../../utils/logger"

const FIXTURE_PATH = join(process.cwd(), "src", "benchmarks", "__fixtures__", "longmemeval-raw.json")

describe("LongMemEvalBenchmark", () => {
  let tempDir: string
  let tempRel: string

  beforeEach(async () => {
    tempRel = join(
      "tmp-benchmark-tests",
      `longmemeval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    )
    tempDir = join(process.cwd(), tempRel)
    await mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("splits raw dataset into question files and loads sessions/questions", async () => {
    await mkdir(tempDir, { recursive: true })
    const rawPath = join(tempDir, "longmemeval_s_cleaned.json")
    await writeFile(rawPath, await readFile(FIXTURE_PATH, "utf8"), "utf8")

    const benchmark = new LongMemEvalBenchmark()
    await benchmark.load({ dataPath: tempRel })

    const questions = benchmark.getQuestions()
    expect(questions).toHaveLength(1)
    expect(questions[0].questionType).toBe("temporal-reasoning")
    expect(benchmark.getGroundTruth("lme-1")).toBe("Kyoto")
    expect(benchmark.getQuestions({ questionTypes: ["temporal-reasoning"] })).toHaveLength(1)

    const sessions = benchmark.getHaystackSessions("lme-1")
    expect(sessions).toHaveLength(1)
    expect(sessions[0].metadata?.formattedDate).toBeString()
    expect(Object.keys(benchmark.getQuestionTypes()).length).toBeGreaterThan(0)

    const questionFile = join(tempDir, "questions", "lme-1.json")
    expect(existsSync(questionFile)).toBe(true)
    const splitItem = JSON.parse(await readFile(questionFile, "utf8"))
    expect(splitItem.haystack_sessions[0][0].has_answer).toBeUndefined()
  })

  it("downloads raw dataset when missing using streamed response", async () => {
    const payload = await readFile(FIXTURE_PATH, "utf8")
    const bytes = new TextEncoder().encode(payload)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      })
    )

    const benchmark = new LongMemEvalBenchmark()
    await benchmark.load({ dataPath: tempRel })
    expect(fetchSpy).toHaveBeenCalled()
    expect(benchmark.getQuestions().length).toBe(1)

    fetchSpy.mockRestore()
  })

  it("warns on unparseable dates and still loads", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
    const malformed = [
      {
        question_id: "bad-date",
        question: "q",
        answer: "a",
        question_type: "single-session-user",
        haystack_dates: ["bad date format"],
        haystack_sessions: [[{ role: "user", content: "x" }]],
      },
    ]
    await writeFile(join(tempDir, "longmemeval_s_cleaned.json"), JSON.stringify(malformed), "utf8")

    const benchmark = new LongMemEvalBenchmark()
    await benchmark.load({ dataPath: tempRel })
    expect(warnSpy).toHaveBeenCalled()
    expect(benchmark.getQuestions()).toHaveLength(1)

    warnSpy.mockRestore()
  })
})
