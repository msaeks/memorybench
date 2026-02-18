import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { runCommand } from "./run"
import { compareCommand } from "./compare"
import { ingestCommand } from "./ingest"
import { searchCommand } from "./search"
import { statusCommand } from "./status"
import { testQuestionCommand } from "./test-question"
import { listQuestionsCommand } from "./list-questions"
import { orchestrator, CheckpointManager } from "../../orchestrator"
import { batchManager, type CompareManifest } from "../../orchestrator/batch"
import * as benchmarks from "../../benchmarks"
import { logger } from "../../utils/logger"
import type { UnifiedQuestion } from "../../types/unified"

function makeManifest(compareId = "cmp-1"): CompareManifest {
  const now = new Date().toISOString()
  return {
    compareId,
    createdAt: now,
    updatedAt: now,
    benchmark: "locomo",
    judge: "gpt-4o",
    answeringModel: "gpt-4o",
    targetQuestionIds: ["q1"],
    runs: [{ provider: "filesystem", runId: `${compareId}-filesystem` }],
  }
}

function makeCheckpoint(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    provider: "filesystem",
    benchmark: "locomo",
    judge: "gpt-4o",
    answeringModel: "gpt-4o",
    ...overrides,
  }
}

describe("CLI command handlers deep coverage", () => {
  let logSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>
  let loggerErrorSpy: ReturnType<typeof spyOn>
  let loggerInfoSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {})
    errorSpy = spyOn(console, "error").mockImplementation(() => {})
    loggerErrorSpy = spyOn(logger, "error").mockImplementation(() => {})
    loggerInfoSpy = spyOn(logger, "info").mockImplementation(() => {})
  })

  afterEach(() => {
    mock.restore()
  })

  it("runCommand handles new runs, continuation, and validation errors", async () => {
    const runSpy = spyOn(orchestrator, "run").mockResolvedValue()
    const existsSpy = spyOn(CheckpointManager.prototype, "exists").mockImplementation(
      (runId: string) => runId === "run-existing"
    )
    const loadSpy = spyOn(CheckpointManager.prototype, "load").mockImplementation((runId: string) => {
      if (runId === "run-existing") return makeCheckpoint({ answeringModel: "gpt-4.1" }) as any
      return null
    })

    await runCommand([
      "-p",
      "filesystem",
      "-b",
      "locomo",
      "-r",
      "run-new",
      "-s",
      "2",
      "--sample-type",
      "random",
      "--concurrency",
      "3",
      "--concurrency-answer",
      "5",
      "-f",
      "search",
      "--force",
    ])
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "filesystem",
        benchmark: "locomo",
        judgeModel: "gpt-4o",
        runId: "run-new",
        sampling: { mode: "sample", sampleType: "random", perCategory: 2 },
        concurrency: { default: 3, answer: 5 },
        force: true,
        phases: ["search", "answer", "evaluate", "report"],
      })
    )

    await runCommand(["-p", "filesystem", "-b", "locomo", "-r", "run-new-limit", "-l", "4"])
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-new-limit",
        sampling: { mode: "limit", limit: 4 },
      })
    )

    await runCommand(["-r", "run-existing"])
    expect(loadSpy).toHaveBeenCalledWith("run-existing")
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "filesystem",
        benchmark: "locomo",
        judgeModel: "gpt-4o",
        answeringModel: "gpt-4.1",
      })
    )

    await runCommand(["-r", "run-existing", "-p", "rag"])
    await runCommand(["-r", "run-existing", "-b", "longmemeval"])
    await runCommand(["-r", "run-new-missing"])
    await runCommand(["-p", "bad-provider", "-b", "locomo", "-r", "run-new-2"])
    await runCommand(["-p", "filesystem", "-b", "bad-benchmark", "-r", "run-new-3"])
    expect(loggerErrorSpy).toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()

    existsSpy.mockRestore()
    loadSpy.mockRestore()
    runSpy.mockRestore()
  })

  it("ingestCommand supports continuation and new-run validation branches", async () => {
    const ingestSpy = spyOn(orchestrator, "ingest").mockResolvedValue()
    spyOn(CheckpointManager.prototype, "exists").mockImplementation(
      (runId: string) => runId === "run-existing"
    )
    spyOn(CheckpointManager.prototype, "load").mockImplementation((runId: string) => {
      if (runId === "run-existing") return makeCheckpoint() as any
      return null
    })

    await ingestCommand(["-r", "run-existing"])
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "filesystem",
        benchmark: "locomo",
        runId: "run-existing",
      })
    )
    expect(loggerInfoSpy).toHaveBeenCalled()

    await ingestCommand(["-r", "run-existing", "-p", "rag"])
    await ingestCommand(["-r", "run-existing", "-b", "longmemeval"])
    await ingestCommand(["-r", "run-new-no-provider"])
    await ingestCommand(["-p", "bad-provider", "-b", "locomo", "-r", "run-new-bad-provider"])
    await ingestCommand(["-p", "filesystem", "-b", "bad-benchmark", "-r", "run-new-bad-benchmark"])

    await ingestCommand(["-p", "filesystem", "-b", "locomo", "-r", "run-new-ok", "--force"])
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "filesystem",
        benchmark: "locomo",
        runId: "run-new-ok",
        force: true,
      })
    )
    expect(loggerErrorSpy).toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()

    ingestSpy.mockRestore()
  })

  it("compareCommand covers resume, compare, sampling, and error handling", async () => {
    const manifest = makeManifest()
    const resumeSpy = spyOn(batchManager, "resume").mockResolvedValue({
      compareId: manifest.compareId,
      manifest,
      successes: 1,
      failures: 0,
    })
    const compareSpy = spyOn(batchManager, "compare")
      .mockResolvedValueOnce({
        compareId: manifest.compareId,
        manifest,
        successes: 1,
        failures: 0,
      })
      .mockResolvedValueOnce({
        compareId: manifest.compareId,
        manifest,
        successes: 0,
        failures: 1,
      })
      .mockRejectedValueOnce(new Error("compare exploded"))
    const printSpy = spyOn(batchManager, "printComparisonReport").mockImplementation(() => {})

    await compareCommand(["--compare-id", "cmp-1", "--force"])
    expect(resumeSpy).toHaveBeenCalledWith("cmp-1", true)
    expect(printSpy).toHaveBeenCalledWith(manifest)

    await compareCommand([
      "-p",
      "filesystem,rag",
      "-b",
      "locomo",
      "-j",
      "sonnet-4",
      "-m",
      "gpt-5",
      "-s",
      "2",
      "--sample-type",
      "random",
    ])
    expect(compareSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["filesystem", "rag"],
        benchmark: "locomo",
        judgeModel: "sonnet-4",
        answeringModel: "gpt-5",
        sampling: { mode: "sample", sampleType: "random", perCategory: 2 },
      })
    )

    await compareCommand(["-p", "filesystem", "-b", "locomo", "-l", "3"])
    expect(compareSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sampling: { mode: "limit", limit: 3 },
      })
    )

    await compareCommand(["-p", "filesystem,bad-provider", "-b", "locomo"])
    await compareCommand(["-p", "filesystem", "-b", "bad-benchmark"])
    await compareCommand(["-p", "filesystem", "-b", "locomo"])

    expect(loggerErrorSpy).toHaveBeenCalled()

    resumeSpy.mockRestore()
    compareSpy.mockRestore()
    printSpy.mockRestore()
  })

  it("search/test/status commands handle checkpoint and happy paths", async () => {
    const searchSpy = spyOn(orchestrator, "search").mockResolvedValue()
    const testSpy = spyOn(orchestrator, "testQuestion").mockResolvedValue()
    const statusSpy = spyOn(orchestrator, "getStatus").mockImplementation(() => {})

    const checkpoints: Record<string, any> = {
      "run-ok": makeCheckpoint(),
      "run-bad-provider": makeCheckpoint({ provider: "bad-provider" }),
      "run-bad-benchmark": makeCheckpoint({ benchmark: "bad-benchmark" }),
      "run-test-default-judge": makeCheckpoint({ judge: "", answeringModel: "gpt-4.1-mini" }),
    }

    spyOn(CheckpointManager.prototype, "exists").mockImplementation((runId: string) => !!checkpoints[runId])
    spyOn(CheckpointManager.prototype, "load").mockImplementation((runId: string) => checkpoints[runId] || null)

    await searchCommand(["-r", "missing-run"])
    await searchCommand(["-r", "run-bad-provider"])
    await searchCommand(["-r", "run-bad-benchmark"])
    await searchCommand(["-r", "run-ok"])
    expect(searchSpy).toHaveBeenCalledWith({
      provider: "filesystem",
      benchmark: "locomo",
      runId: "run-ok",
    })

    await testQuestionCommand(["-r", "missing-run", "-q", "q1"])
    await testQuestionCommand(["-r", "run-bad-provider", "-q", "q1"])
    await testQuestionCommand(["-r", "run-bad-benchmark", "-q", "q1"])
    await testQuestionCommand(["-r", "run-test-default-judge", "-q", "q2"])
    await testQuestionCommand([
      "-r",
      "run-ok",
      "-q",
      "q3",
      "-j",
      "sonnet-4",
      "-m",
      "gpt-5",
    ])
    expect(testSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "filesystem",
        benchmark: "locomo",
        runId: "run-test-default-judge",
        questionId: "q2",
        judgeModel: "gpt-4o",
        answeringModel: "gpt-4.1-mini",
      })
    )
    expect(testSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-ok",
        questionId: "q3",
        judgeModel: "sonnet-4",
        answeringModel: "gpt-5",
      })
    )

    await statusCommand(["-r", "run-status"])
    expect(statusSpy).toHaveBeenCalledWith("run-status")

    searchSpy.mockRestore()
    testSpy.mockRestore()
    statusSpy.mockRestore()
  })

  it("listQuestionsCommand handles load errors, filtering, paging, and next-page output", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q-temporal-1",
        question: "When did the user move to Seattle? Include specific month and year please.",
        questionType: "temporal",
        groundTruth: "May 2025",
        haystackSessionIds: [],
      },
      {
        questionId: "q-temporal-2",
        question: "What happened after the move?",
        questionType: "temporal",
        groundTruth: "Started a new job",
        haystackSessionIds: [],
      },
      {
        questionId: "q-preference-1",
        question: "What foods does the user prefer?",
        questionType: "preference",
        groundTruth: "Ramen",
        haystackSessionIds: [],
      },
    ]

    const failingBenchmark = {
      load: async () => {
        throw new Error("load boom")
      },
      getQuestions: () => questions,
    }
    const okBenchmark = {
      load: async () => {},
      getQuestions: () => questions,
    }

    const availableSpy = spyOn(benchmarks, "getAvailableBenchmarks").mockReturnValue([
      "locomo",
      "longmemeval",
    ])
    const createSpy = spyOn(benchmarks, "createBenchmark")
      .mockReturnValueOnce(failingBenchmark as any)
      .mockReturnValue(okBenchmark as any)

    await listQuestionsCommand(["-b", "bad-benchmark"])
    await listQuestionsCommand(["-b", "locomo"])
    await listQuestionsCommand(["-b", "locomo", "-o", "0", "-l", "1", "-t", "temporal"])
    await listQuestionsCommand(["-b", "locomo", "-o", "0", "-l", "5"])

    const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")
    expect(output).toContain('matching type "temporal"')
    expect(output).toContain("Next page:")
    expect(output).toContain("To test a specific question:")
    expect(output).toContain("q-temporal-1")
    expect(output).toContain("q-preference-1")
    expect(errorSpy).toHaveBeenCalledWith("Invalid benchmark: bad-benchmark")
    expect(errorSpy).toHaveBeenCalledWith("Failed to load benchmark: load boom")

    availableSpy.mockRestore()
    createSpy.mockRestore()
  })
})
