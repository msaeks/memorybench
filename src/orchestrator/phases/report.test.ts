import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { generateReport, printReport, saveReport } from "./report"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"

const RUNS_DIR = join(process.cwd(), "data", "runs")

describe("report phase helpers", () => {
  beforeEach(() => {
    rmSync(RUNS_DIR, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(RUNS_DIR, { recursive: true, force: true })
  })

  it("generates aggregate report with retrieval and per-type statistics", () => {
    const benchmark: Benchmark = {
      name: "test",
      load: async () => {},
      getQuestions: () => [
        {
          questionId: "q1",
          question: "Q1",
          questionType: "temporal",
          groundTruth: "A1",
          haystackSessionIds: [],
        },
        {
          questionId: "q2",
          question: "Q2",
          questionType: "single-hop",
          groundTruth: "A2",
          haystackSessionIds: [],
        },
      ],
      getHaystackSessions: () => [],
      getGroundTruth: () => "",
      getQuestionTypes: () => ({
        temporal: { id: "temporal", alias: "tmp", description: "Temporal reasoning" },
        "single-hop": { id: "single-hop", alias: "single", description: "Single-hop" },
      }),
    }

    const checkpoint: RunCheckpoint = {
      runId: "run_report",
      dataSourceRunId: "run_report",
      status: "completed",
      provider: "filesystem",
      benchmark: "locomo",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      questions: {
        q1: {
          questionId: "q1",
          containerTag: "q1-run_report",
          question: "Q1",
          groundTruth: "A1",
          questionType: "temporal",
          phases: {
            ingest: { status: "completed", completedSessions: [], durationMs: 10 },
            indexing: { status: "completed", durationMs: 20 },
            search: { status: "completed", durationMs: 30, results: [{ id: 1 }] },
            answer: { status: "completed", durationMs: 40, hypothesis: "A1" },
            evaluate: {
              status: "completed",
              durationMs: 50,
              score: 1,
              label: "correct",
              explanation: "ok",
              retrievalMetrics: {
                hitAtK: 1,
                precisionAtK: 0.5,
                recallAtK: 1,
                f1AtK: 2 / 3,
                mrr: 1,
                ndcg: 1,
                k: 1,
                relevantRetrieved: 1,
                totalRelevant: 1,
              },
            },
          },
        },
        q2: {
          questionId: "q2",
          containerTag: "q2-run_report",
          question: "Q2",
          groundTruth: "A2",
          questionType: "single-hop",
          phases: {
            ingest: { status: "completed", completedSessions: [], durationMs: 8 },
            indexing: { status: "completed", durationMs: 16 },
            search: { status: "completed", durationMs: 24, results: [{ id: 2 }] },
            answer: { status: "completed", durationMs: 32, hypothesis: "wrong" },
            evaluate: {
              status: "completed",
              durationMs: 48,
              score: 0,
              label: "incorrect",
              explanation: "bad",
            },
          },
        },
      },
    }

    const report = generateReport(benchmark, checkpoint)
    expect(report.summary.totalQuestions).toBe(2)
    expect(report.summary.correctCount).toBe(1)
    expect(report.summary.accuracy).toBe(0.5)
    expect(report.retrieval?.hitAtK).toBe(1)
    expect(report.byQuestionType.temporal.accuracy).toBe(1)
    expect(report.byQuestionType["single-hop"].accuracy).toBe(0)
    expect(report.evaluations).toHaveLength(2)
  })

  it("saves and prints report output", async () => {
    const result = {
      provider: "filesystem",
      benchmark: "locomo",
      runId: "run_report_save",
      dataSourceRunId: "run_report_save",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      timestamp: new Date().toISOString(),
      summary: {
        totalQuestions: 0,
        correctCount: 0,
        accuracy: 0,
      },
      latency: {
        ingest: { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 },
        indexing: { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 },
        search: { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 },
        answer: { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 },
        evaluate: { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 },
        total: { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 },
      },
      byQuestionType: {},
      questionTypeRegistry: {},
      evaluations: [],
    } as const

    const path = saveReport(result)
    expect(path).toContain("run_report_save")
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(await readFile(path, "utf8"))
    expect(parsed.runId).toBe("run_report_save")

    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    printReport(result)
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it("prints retrieval blocks for overall and per-question-type metrics", () => {
    const result = {
      provider: "filesystem",
      benchmark: "locomo",
      runId: "run_report_print_retrieval",
      dataSourceRunId: "run_report_print_retrieval",
      judge: "gpt-4o",
      answeringModel: "gpt-4o",
      timestamp: new Date().toISOString(),
      summary: {
        totalQuestions: 2,
        correctCount: 1,
        accuracy: 0.5,
      },
      latency: {
        ingest: { min: 1, max: 2, mean: 1, median: 1, p95: 2, p99: 2, stdDev: 0.5, count: 2 },
        indexing: { min: 1, max: 2, mean: 1, median: 1, p95: 2, p99: 2, stdDev: 0.5, count: 2 },
        search: { min: 3, max: 4, mean: 3, median: 3, p95: 4, p99: 4, stdDev: 0.5, count: 2 },
        answer: { min: 5, max: 6, mean: 5, median: 5, p95: 6, p99: 6, stdDev: 0.5, count: 2 },
        evaluate: { min: 7, max: 8, mean: 7, median: 7, p95: 8, p99: 8, stdDev: 0.5, count: 2 },
        total: { min: 10, max: 12, mean: 11, median: 11, p95: 12, p99: 12, stdDev: 1, count: 2 },
      },
      retrieval: {
        hitAtK: 0.5,
        precisionAtK: 0.25,
        recallAtK: 0.5,
        f1AtK: 0.33,
        mrr: 0.5,
        ndcg: 0.63,
        k: 10,
      },
      byQuestionType: {
        temporal: {
          total: 2,
          correct: 1,
          accuracy: 0.5,
          latency: {
            search: { min: 3, max: 3, mean: 3, median: 3, p95: 3, p99: 3, stdDev: 0, count: 1 },
            answer: { min: 5, max: 5, mean: 5, median: 5, p95: 5, p99: 5, stdDev: 0, count: 1 },
            total: { min: 10, max: 10, mean: 10, median: 10, p95: 10, p99: 10, stdDev: 0, count: 1 },
          },
          retrieval: {
            hitAtK: 1,
            precisionAtK: 0.5,
            recallAtK: 1,
            f1AtK: 0.67,
            mrr: 1,
            ndcg: 1,
            k: 5,
          },
        },
      },
      questionTypeRegistry: {
        temporal: { id: "temporal", alias: "tmp", description: "Temporal reasoning" },
      },
      evaluations: [],
    } as const

    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    printReport(result as any)

    const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")
    expect(output).toContain("RETRIEVAL QUALITY (K=10)")
    expect(output).toContain("Temporal reasoning")
    expect(output).toContain("Retrieval: Hit@5=100%")

    logSpy.mockRestore()
  })
})
