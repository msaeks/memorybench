import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BatchManager, batchManager, type CompareManifest } from "./batch"
import { CheckpointManager, orchestrator } from "./index"
import { logger } from "../utils/logger"
import { activeRuns } from "../server/runState"
import type { BenchmarkResult } from "../types/unified"

const COMPARE_DIR = join(process.cwd(), "data", "compare")
const RUNS_DIR = join(process.cwd(), "data", "runs")

function buildReport(
  provider: string,
  accuracy: number,
  overrides?: Partial<BenchmarkResult>
): BenchmarkResult {
  return {
    provider,
    benchmark: "locomo",
    runId: `run-${provider}`,
    dataSourceRunId: `run-${provider}`,
    judge: "gpt-4o",
    answeringModel: "gpt-4o",
    timestamp: new Date().toISOString(),
    summary: {
      totalQuestions: 10,
      correctCount: Math.round(accuracy * 10),
      accuracy,
    },
    latency: {
      ingest: { min: 1, max: 1, mean: 1, median: 1, p95: 1, p99: 1, stdDev: 0, count: 1 },
      indexing: { min: 1, max: 1, mean: 1, median: 1, p95: 1, p99: 1, stdDev: 0, count: 1 },
      search: { min: 2, max: 2, mean: 2, median: 2, p95: 2, p99: 2, stdDev: 0, count: 1 },
      answer: { min: 3, max: 3, mean: 3, median: 3, p95: 3, p99: 3, stdDev: 0, count: 1 },
      evaluate: { min: 4, max: 4, mean: 4, median: 4, p95: 4, p99: 4, stdDev: 0, count: 1 },
      total: { min: 10, max: 10, mean: 10, median: 10, p95: 10, p99: 10, stdDev: 0, count: 1 },
    },
    byQuestionType: overrides?.byQuestionType || {
      temporal: {
        total: 10,
        correct: Math.round(accuracy * 10),
        accuracy,
        latency: {
          search: { min: 2, max: 2, mean: 2, median: 2, p95: 2, p99: 2, stdDev: 0, count: 1 },
          answer: { min: 3, max: 3, mean: 3, median: 3, p95: 3, p99: 3, stdDev: 0, count: 1 },
          total: { min: 10, max: 10, mean: 10, median: 10, p95: 10, p99: 10, stdDev: 0, count: 1 },
        },
      },
    },
    retrieval: overrides?.retrieval,
    evaluations: [],
    ...overrides,
  }
}

describe("BatchManager", () => {
  const originalRun = orchestrator.run

  beforeEach(() => {
    rmSync(COMPARE_DIR, { recursive: true, force: true })
    rmSync(RUNS_DIR, { recursive: true, force: true })
    activeRuns.clear()
  })

  afterEach(() => {
    rmSync(COMPARE_DIR, { recursive: true, force: true })
    rmSync(RUNS_DIR, { recursive: true, force: true })
    activeRuns.clear()
    ;(orchestrator as { run: typeof orchestrator.run }).run = originalRun
  })

  it("saves/loads manifests and report files", () => {
    const manifest: CompareManifest = {
      compareId: "compare_123",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark: "locomo",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      targetQuestionIds: ["q1"],
      runs: [{ provider: "filesystem", runId: "run-filesystem" }],
    }

    batchManager.saveManifest(manifest)
    expect(batchManager.exists("compare_123")).toBe(true)
    expect(batchManager.loadManifest("compare_123")?.compareId).toBe("compare_123")

    const runDir = join(RUNS_DIR, "run-filesystem")
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, "report.json"), JSON.stringify(buildReport("filesystem", 0.8)))
    expect(batchManager.loadReport("run-filesystem")?.summary.accuracy).toBe(0.8)
    expect(batchManager.loadReport("../bad")).toBeNull()
  })

  it("executeRuns handles fulfilled and rejected runs and updates failure checkpoints", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {})
    const successSpy = spyOn(logger, "success").mockImplementation(() => {})

    const checkpointManager = new CheckpointManager()
    const failedCheckpoint = checkpointManager.create(
      "compare_x-failed",
      "filesystem",
      "locomo",
      "gpt-4o",
      "gpt-4o"
    )
    checkpointManager.save(failedCheckpoint)
    await checkpointManager.flush("compare_x-failed")

    const runMock = mock(async (opts: { runId: string }) => {
      if (opts.runId.includes("failed")) throw new Error("run exploded")
    })
    ;(orchestrator as { run: typeof orchestrator.run }).run = runMock as typeof orchestrator.run

    const manifest: CompareManifest = {
      compareId: "compare_x",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark: "locomo",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      targetQuestionIds: ["q1"],
      runs: [
        { provider: "filesystem", runId: "compare_x-ok" },
        { provider: "rag", runId: "compare_x-failed" },
      ],
    }

    const result = await batchManager.executeRuns(manifest)
    expect(result.successes).toBe(1)
    expect(result.failures).toBe(1)
    expect(warnSpy).toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
    expect(successSpy).toHaveBeenCalled()
    expect(activeRuns.size).toBe(0)

    const updated = checkpointManager.load("compare_x-failed")
    expect(updated?.status).toBe("failed")

    warnSpy.mockRestore()
    errorSpy.mockRestore()
    successSpy.mockRestore()
  })

  it("delete removes compare and associated run folders with safe-id checks", () => {
    const manifest: CompareManifest = {
      compareId: "compare_del",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark: "locomo",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      targetQuestionIds: ["q1"],
      runs: [
        { provider: "filesystem", runId: "run_good" },
        { provider: "rag", runId: "../invalid" },
      ],
    }
    batchManager.saveManifest(manifest)

    mkdirSync(join(RUNS_DIR, "run_good"), { recursive: true })
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
    batchManager.delete("compare_del")

    expect(existsSync(join(COMPARE_DIR, "compare_del"))).toBe(false)
    expect(existsSync(join(RUNS_DIR, "run_good"))).toBe(false)
    expect(warnSpy).toHaveBeenCalled()

    batchManager.delete("../bad")
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("resume handles force deletion and missing manifests", async () => {
    const manifest: CompareManifest = {
      compareId: "compare_resume",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark: "locomo",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      targetQuestionIds: ["q1"],
      runs: [{ provider: "filesystem", runId: "r1" }],
    }
    batchManager.saveManifest(manifest)

    await expect(batchManager.resume("compare_resume", true)).rejects.toThrow("deleted with --force")
    await expect(batchManager.resume("compare_missing")).rejects.toThrow("Comparison not found")
  })

  it("creates manifests from benchmark questions with sampling", async () => {
    const locomoDir = join(process.cwd(), "data", "benchmarks", "locomo")
    mkdirSync(locomoDir, { recursive: true })
    const fixture = Bun.file(
      join(process.cwd(), "src", "benchmarks", "__fixtures__", "locomo-sample.json")
    ).text()
    writeFileSync(join(locomoDir, "locomo10.json"), await fixture)

    const manifest = await batchManager.createManifest({
      providers: ["filesystem", "rag"],
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      answeringModel: "gpt-4o",
      sampling: { mode: "sample", perCategory: 1, sampleType: "consecutive" },
    })

    expect(manifest.compareId).toStartWith("compare-")
    expect(manifest.runs).toEqual([
      { provider: "filesystem", runId: `${manifest.compareId}-filesystem` },
      { provider: "rag", runId: `${manifest.compareId}-rag` },
    ])
    expect(manifest.targetQuestionIds.length).toBeGreaterThan(0)
  })

  it("creates manifests with all questions when sampling is omitted", async () => {
    const locomoDir = join(process.cwd(), "data", "benchmarks", "locomo")
    mkdirSync(locomoDir, { recursive: true })
    const fixture = Bun.file(
      join(process.cwd(), "src", "benchmarks", "__fixtures__", "locomo-sample.json")
    ).text()
    writeFileSync(join(locomoDir, "locomo10.json"), await fixture)

    const manifest = await batchManager.createManifest({
      providers: ["filesystem"],
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      answeringModel: "gpt-4o",
    })

    expect(manifest.targetQuestionIds).toHaveLength(2)
  })

  it("prints report summaries and handles empty report list", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {})

    const emptyManifest: CompareManifest = {
      compareId: "compare_empty",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark: "locomo",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      targetQuestionIds: [],
      runs: [],
    }
    batchManager.printComparisonReport(emptyManifest)
    expect(errorSpy).toHaveBeenCalledWith("No reports found to compare")

    const manifest: CompareManifest = {
      compareId: "compare_print",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark: "locomo",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      targetQuestionIds: ["q1"],
      runs: [
        { provider: "filesystem", runId: "run1" },
        { provider: "rag", runId: "run2" },
      ],
    }
    mkdirSync(join(RUNS_DIR, "run1"), { recursive: true })
    mkdirSync(join(RUNS_DIR, "run2"), { recursive: true })
    writeFileSync(join(RUNS_DIR, "run1", "report.json"), JSON.stringify(buildReport("filesystem", 0.9)))
    writeFileSync(join(RUNS_DIR, "run2", "report.json"), JSON.stringify(buildReport("rag", 0.7)))

    batchManager.printComparisonReport(manifest)
    expect(logSpy).toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledTimes(1)

    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it("compare delegates to createManifest then executeRuns", async () => {
    const manager = new BatchManager()
    const manifest: CompareManifest = {
      compareId: "compare_delegate",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark: "locomo",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      targetQuestionIds: ["q1"],
      runs: [{ provider: "filesystem", runId: "compare_delegate-filesystem" }],
    }
    const createSpy = spyOn(manager, "createManifest").mockResolvedValue(manifest)
    const executeSpy = spyOn(manager, "executeRuns").mockResolvedValue({
      compareId: manifest.compareId,
      manifest,
      successes: 1,
      failures: 0,
    })

    const result = await manager.compare({
      providers: ["filesystem"],
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      answeringModel: "gpt-4o",
    })

    expect(createSpy).toHaveBeenCalled()
    expect(executeSpy).toHaveBeenCalledWith(manifest)
    expect(result.successes).toBe(1)

    createSpy.mockRestore()
    executeSpy.mockRestore()
  })

  it("handles malformed manifest/report JSON and resumes existing comparisons", async () => {
    const manager = new BatchManager()

    const malformedComparePath = join(COMPARE_DIR, "compare_bad_json")
    mkdirSync(malformedComparePath, { recursive: true })
    writeFileSync(join(malformedComparePath, "manifest.json"), "{not-json")
    expect(manager.loadManifest("compare_bad_json")).toBeNull()

    const malformedRunPath = join(RUNS_DIR, "run_bad_json")
    mkdirSync(malformedRunPath, { recursive: true })
    writeFileSync(join(malformedRunPath, "report.json"), "{not-json")
    expect(manager.loadReport("run_bad_json")).toBeNull()

    const manifest: CompareManifest = {
      compareId: "compare_resume_ok",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark: "locomo",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      targetQuestionIds: ["q1"],
      runs: [{ provider: "filesystem", runId: "run_resume_ok" }],
    }
    manager.saveManifest(manifest)
    const executeSpy = spyOn(manager, "executeRuns").mockResolvedValue({
      compareId: manifest.compareId,
      manifest,
      successes: 1,
      failures: 0,
    })

    const resumed = await manager.resume("compare_resume_ok")
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ compareId: "compare_resume_ok" })
    )
    expect(resumed.successes).toBe(1)

    executeSpy.mockRestore()
  })

  it("supports full, limit, and random sampling when creating manifests", async () => {
    const locomoDir = join(process.cwd(), "data", "benchmarks", "locomo")
    mkdirSync(locomoDir, { recursive: true })
    const fixture = Bun.file(
      join(process.cwd(), "src", "benchmarks", "__fixtures__", "locomo-sample.json")
    ).text()
    writeFileSync(join(locomoDir, "locomo10.json"), await fixture)

    const full = await batchManager.createManifest({
      providers: ["filesystem"],
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      answeringModel: "gpt-4o",
      sampling: { mode: "full" },
    })
    expect(full.targetQuestionIds.length).toBe(2)

    const limited = await batchManager.createManifest({
      providers: ["filesystem"],
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      answeringModel: "gpt-4o",
      sampling: { mode: "limit", limit: 1 },
    })
    expect(limited.targetQuestionIds).toHaveLength(1)

    const random = await batchManager.createManifest({
      providers: ["filesystem"],
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      answeringModel: "gpt-4o",
      sampling: { mode: "sample", sampleType: "random", perCategory: 1 },
    })
    expect(random.targetQuestionIds.length).toBeGreaterThan(0)
    expect(random.targetQuestionIds.every((id) => full.targetQuestionIds.includes(id))).toBe(true)

    const fallbackSample = await batchManager.createManifest({
      providers: ["filesystem"],
      benchmark: "locomo",
      judgeModel: "gpt-4o",
      answeringModel: "gpt-4o",
      sampling: { mode: "sample" } as any,
    })
    expect(fallbackSample.targetQuestionIds).toEqual(full.targetQuestionIds)
  })

  it("prints retrieval metrics and N/A type cells when reports differ", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {})

    const manifest: CompareManifest = {
      compareId: "compare_retrieval",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      benchmark: "locomo",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      targetQuestionIds: ["q1", "q2"],
      runs: [
        { provider: "filesystem", runId: "run_retrieval_1" },
        { provider: "rag", runId: "run_retrieval_2" },
      ],
    }

    mkdirSync(join(RUNS_DIR, "run_retrieval_1"), { recursive: true })
    mkdirSync(join(RUNS_DIR, "run_retrieval_2"), { recursive: true })
    writeFileSync(
      join(RUNS_DIR, "run_retrieval_1", "report.json"),
      JSON.stringify(
        buildReport("filesystem", 0.9, {
          retrieval: {
            hitAtK: 0.8,
            precisionAtK: 0.6,
            recallAtK: 0.7,
            f1AtK: 0.64,
            mrr: 0.77,
            ndcg: 0.82,
            k: 10,
          },
          byQuestionType: {
            temporal: {
              total: 10,
              correct: 9,
              accuracy: 0.9,
              latency: {
                search: { min: 1, max: 1, mean: 1, median: 1, p95: 1, p99: 1, stdDev: 0, count: 1 },
                answer: { min: 1, max: 1, mean: 1, median: 1, p95: 1, p99: 1, stdDev: 0, count: 1 },
                total: { min: 1, max: 1, mean: 1, median: 1, p95: 1, p99: 1, stdDev: 0, count: 1 },
              },
            },
          },
        })
      )
    )
    writeFileSync(
      join(RUNS_DIR, "run_retrieval_2", "report.json"),
      JSON.stringify(
        buildReport("rag", 0.5, {
          byQuestionType: {
            preference: {
              total: 10,
              correct: 5,
              accuracy: 0.5,
              latency: {
                search: { min: 2, max: 2, mean: 2, median: 2, p95: 2, p99: 2, stdDev: 0, count: 1 },
                answer: { min: 2, max: 2, mean: 2, median: 2, p95: 2, p99: 2, stdDev: 0, count: 1 },
                total: { min: 2, max: 2, mean: 2, median: 2, p95: 2, p99: 2, stdDev: 0, count: 1 },
              },
            },
          },
        })
      )
    )

    batchManager.printComparisonReport(manifest)

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
    expect(output).toContain("RETRIEVAL METRICS (K=10)")
    expect(output).toContain("N/A")
    expect(output).toContain("BY QUESTION TYPE")
    expect(output).toContain("WINNER:")

    logSpy.mockRestore()
  })
})
