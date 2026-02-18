import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Orchestrator, CheckpointManager } from "./index"
import { logger } from "../utils/logger"

const LOCOMO_DEFAULT_PATH = join(process.cwd(), "data", "benchmarks", "locomo", "locomo10.json")
const LOCOMO_FIXTURE = join(process.cwd(), "src", "benchmarks", "__fixtures__", "locomo-sample.json")

describe("Orchestrator", () => {
  let orch: Orchestrator
  let manager: CheckpointManager
  let tempRunsDir: string

  beforeEach(async () => {
    tempRunsDir = join(
      process.cwd(),
      "tmp-orchestrator-tests",
      `runs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    )
    await mkdir(join(process.cwd(), "data", "benchmarks", "locomo"), { recursive: true })
    await writeFile(LOCOMO_DEFAULT_PATH, await readFile(LOCOMO_FIXTURE, "utf8"), "utf8")

    orch = new Orchestrator()
    manager = new CheckpointManager(tempRunsDir)
    ;(orch as { checkpointManager: CheckpointManager }).checkpointManager = manager
  })

  afterEach(async () => {
    await manager.flush()
    await rm(join(process.cwd(), "tmp-orchestrator-tests"), { recursive: true, force: true })
    await rm(join(process.cwd(), "data", "runs"), { recursive: true, force: true })
  })

  it("runs a new flow with explicit questionIds and empty phases", async () => {
    const runId = `orch-new-${Date.now()}`
    await orch.run({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId,
      questionIds: ["locomo-1-q0"],
      phases: [],
    })
    await manager.flush(runId)

    const checkpoint = manager.load(runId)
    expect(checkpoint?.status).toBe("completed")
    expect(checkpoint?.targetQuestionIds).toEqual(["locomo-1-q0"])
    expect(Object.keys(checkpoint?.questions || {})).toEqual(["locomo-1-q0"])
  })

  it("resumes an old checkpoint and applies CLI limit to started questions", async () => {
    const runId = `orch-resume-${Date.now()}`
    const checkpoint = manager.create(runId, "hindsight", "locomo", "gpt-4o", "gpt-4o")
    checkpoint.questions = {
      "locomo-1-q0": {
        questionId: "locomo-1-q0",
        containerTag: `locomo-1-q0-${runId}`,
        question: "Q0",
        groundTruth: "A0",
        questionType: "single-hop",
        phases: {
          ingest: { status: "completed", completedSessions: ["s1"] },
          indexing: { status: "pending" },
          search: { status: "pending" },
          answer: { status: "pending" },
          evaluate: { status: "pending" },
        },
      },
      "locomo-1-q1": {
        questionId: "locomo-1-q1",
        containerTag: `locomo-1-q1-${runId}`,
        question: "Q1",
        groundTruth: "A1",
        questionType: "temporal",
        phases: {
          ingest: { status: "pending", completedSessions: [] },
          indexing: { status: "pending" },
          search: { status: "pending" },
          answer: { status: "pending" },
          evaluate: { status: "pending" },
        },
      },
    }
    manager.save(checkpoint)
    await manager.flush(runId)

    await orch.run({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId,
      limit: 1,
      phases: [],
    })
    await manager.flush(runId)

    const updated = manager.load(runId)
    expect(updated?.status).toBe("completed")
    expect(updated?.limit).toBe(1)
    expect(updated?.targetQuestionIds).toEqual(["locomo-1-q0"])
  })

  it("supports force reset and evaluate/report-only execution path", async () => {
    const runId = `orch-force-${Date.now()}`
    manager.create(runId, "hindsight", "locomo", "gpt-4o", "gpt-4o")
    await manager.flush(runId)

    await orch.run({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId,
      force: true,
      phases: ["evaluate", "report"],
    })
    await manager.flush(runId)

    const checkpoint = manager.load(runId)
    expect(checkpoint?.status).toBe("completed")
    expect(Object.keys(checkpoint?.questions || {}).length).toBeGreaterThan(0)
  })

  it("applies sampling modes (full, limit, sample) when starting new runs", async () => {
    const fullRunId = `orch-sample-full-${Date.now()}`
    await orch.run({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId: fullRunId,
      sampling: { mode: "full" },
      phases: [],
    })
    const fullCheckpoint = manager.load(fullRunId)
    expect(fullCheckpoint?.targetQuestionIds).toHaveLength(2)

    const limitRunId = `orch-sample-limit-${Date.now()}`
    await orch.run({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId: limitRunId,
      sampling: { mode: "limit", limit: 1 },
      phases: [],
    })
    const limitCheckpoint = manager.load(limitRunId)
    expect(limitCheckpoint?.targetQuestionIds).toHaveLength(1)

    const sampleConsecutiveRunId = `orch-sample-cons-${Date.now()}`
    await orch.run({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId: sampleConsecutiveRunId,
      sampling: { mode: "sample", perCategory: 1, sampleType: "consecutive" },
      phases: [],
    })
    const consecutiveCheckpoint = manager.load(sampleConsecutiveRunId)
    expect(consecutiveCheckpoint?.targetQuestionIds?.length).toBeGreaterThan(0)

    const sampleRandomRunId = `orch-sample-rand-${Date.now()}`
    await orch.run({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId: sampleRandomRunId,
      sampling: { mode: "sample", perCategory: 1, sampleType: "random" },
      phases: [],
    })
    const randomCheckpoint = manager.load(sampleRandomRunId)
    expect(randomCheckpoint?.targetQuestionIds?.length).toBeGreaterThan(0)
  })

  it("falls back to all questions when sampling mode omits perCategory", async () => {
    const runId = `orch-sample-fallback-${Date.now()}`
    await orch.run({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId,
      sampling: { mode: "sample" } as any,
      phases: [],
    })
    const checkpoint = manager.load(runId)
    expect(checkpoint?.targetQuestionIds).toHaveLength(2)
  })

  it("resumes old checkpoints without limit by restricting to started questions", async () => {
    const runId = `orch-resume-started-${Date.now()}`
    const checkpoint = manager.create(runId, "hindsight", "locomo", "gpt-4o", "gpt-4o")
    checkpoint.questions = {
      "locomo-1-q0": {
        questionId: "locomo-1-q0",
        containerTag: `locomo-1-q0-${runId}`,
        question: "Q0",
        groundTruth: "A0",
        questionType: "single-hop",
        phases: {
          ingest: { status: "in_progress", completedSessions: [] },
          indexing: { status: "pending" },
          search: { status: "pending" },
          answer: { status: "pending" },
          evaluate: { status: "pending" },
        },
      },
      "locomo-1-q1": {
        questionId: "locomo-1-q1",
        containerTag: `locomo-1-q1-${runId}`,
        question: "Q1",
        groundTruth: "A1",
        questionType: "temporal",
        phases: {
          ingest: { status: "pending", completedSessions: [] },
          indexing: { status: "pending" },
          search: { status: "pending" },
          answer: { status: "pending" },
          evaluate: { status: "pending" },
        },
      },
    }
    manager.save(checkpoint)
    await manager.flush(runId)

    await orch.run({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId,
      phases: [],
    })

    const updated = manager.load(runId)
    expect(updated?.targetQuestionIds).toEqual(["locomo-1-q0"])
  })

  it("resumes old checkpoints with no progress and applies limit to first questions", async () => {
    const runId = `orch-resume-noprogress-${Date.now()}`
    manager.create(runId, "hindsight", "locomo", "gpt-4o", "gpt-4o")
    await manager.flush(runId)

    await orch.run({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId,
      limit: 1,
      phases: [],
    })

    const updated = manager.load(runId)
    expect(updated?.limit).toBe(1)
    expect(updated?.targetQuestionIds).toHaveLength(1)
  })

  it("wrapper methods forward expected phases to run()", async () => {
    const runSpy = spyOn(orch, "run").mockResolvedValue()

    await orch.ingest({
      provider: "hindsight",
      benchmark: "locomo",
      runId: "r1",
      answeringModel: "gpt-4o",
    })
    await orch.search({
      provider: "hindsight",
      benchmark: "locomo",
      runId: "r2",
      answeringModel: "gpt-4o",
    })
    await orch.evaluate({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId: "r3",
    })
    await orch.testQuestion({
      provider: "hindsight",
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      runId: "r4",
      questionId: "locomo-1-q0",
    })

    expect(runSpy).toHaveBeenCalledTimes(4)
    expect(runSpy.mock.calls[0][0]).toMatchObject({ phases: ["ingest", "indexing"] })
    expect(runSpy.mock.calls[1][0]).toMatchObject({ phases: ["search"] })
    expect(runSpy.mock.calls[2][0]).toMatchObject({ phases: ["answer", "evaluate", "report"] })
    expect(runSpy.mock.calls[3][0]).toMatchObject({
      questionIds: ["locomo-1-q0"],
      phases: ["search", "answer", "evaluate", "report"],
    })
    runSpy.mockRestore()
  })

  it("getStatus prints run summary and reports missing runs", async () => {
    const runId = `orch-status-${Date.now()}`
    const checkpoint = manager.create(runId, "hindsight", "locomo", "gpt-4o", "gpt-4o")
    manager.initQuestion(checkpoint, "q1", "q1", {
      question: "Q1",
      groundTruth: "A1",
      questionType: "single-hop",
    })
    checkpoint.questions.q1.phases.ingest.status = "completed"
    checkpoint.questions.q1.phases.indexing.status = "completed"
    checkpoint.questions.q1.phases.search.status = "completed"
    checkpoint.questions.q1.phases.answer.status = "completed"
    checkpoint.questions.q1.phases.evaluate.status = "completed"
    manager.save(checkpoint)
    await manager.flush(runId)

    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {})
    orch.getStatus(runId)
    orch.getStatus("missing-run")
    expect(logSpy).toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith("No run found: missing-run")

    logSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
