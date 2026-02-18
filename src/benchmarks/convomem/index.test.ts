import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ConvoMemBenchmark } from "./index"
import { logger } from "../../utils/logger"

const FIXTURE_PATH = join(process.cwd(), "src", "benchmarks", "__fixtures__", "convomem-data.json")

describe("ConvoMemBenchmark", () => {
  let tempDir: string
  let tempRel: string

  beforeEach(async () => {
    tempRel = join("tmp-benchmark-tests", `convomem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    tempDir = join(process.cwd(), tempRel)
    await mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("loads fixture data and supports filtering", async () => {
    await mkdir(tempDir, { recursive: true })
    await writeFile(join(tempDir, "convomem_data.json"), await readFile(FIXTURE_PATH, "utf8"), "utf8")

    const benchmark = new ConvoMemBenchmark()
    await benchmark.load({ dataPath: tempRel })

    const questions = benchmark.getQuestions()
    expect(questions).toHaveLength(2)
    expect(benchmark.getQuestions({ questionTypes: ["preference_evidence"] })).toHaveLength(1)
    expect(benchmark.getQuestions({ offset: 1, limit: 1 })).toHaveLength(1)

    const q0 = questions[0]
    expect(benchmark.getGroundTruth(q0.questionId)).toBe("Seattle")
    const sessions = benchmark.getHaystackSessions(q0.questionId)
    expect(sessions[0].messages[0].role).toBe("user")
    expect(Object.keys(benchmark.getQuestionTypes()).length).toBeGreaterThan(0)
  })

  it("downloads category batches when local file is missing", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify([
          {
            evidenceItems: [
              {
                question: "Q",
                answer: "A",
                message_evidences: [],
                conversations: [{ messages: [{ speaker: "user", text: "hello" }] }],
              },
            ],
          },
        ]),
        { status: 200 }
      )
    })

    const benchmark = new ConvoMemBenchmark()
    await benchmark.load({ dataPath: tempRel })
    expect(fetchSpy).toHaveBeenCalled()
    expect(benchmark.getQuestions().length).toBeGreaterThan(0)

    fetchSpy.mockRestore()
  })

  it("handles load errors for malformed local files", async () => {
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {})
    await writeFile(join(tempDir, "convomem_data.json"), "{bad json", "utf8")

    const benchmark = new ConvoMemBenchmark()
    await benchmark.load({ dataPath: tempRel })
    expect(errorSpy).toHaveBeenCalled()
    expect(benchmark.getQuestions()).toEqual([])

    errorSpy.mockRestore()
  })
})
