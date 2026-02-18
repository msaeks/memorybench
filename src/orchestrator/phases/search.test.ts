import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runSearchPhase } from "./search"
import { CheckpointManager } from "../checkpoint"
import type { Benchmark } from "../../types/benchmark"
import type { Provider } from "../../types/provider"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { UnifiedQuestion } from "../../types/unified"

function makeBenchmark(questions: UnifiedQuestion[]): Benchmark {
  return {
    name: "test",
    load: async () => {},
    getQuestions: () => questions,
    getHaystackSessions: () => [],
    getGroundTruth: () => "",
    getQuestionTypes: () => ({}),
  }
}

describe("runSearchPhase", () => {
  let tempDir: string
  let manager: CheckpointManager
  let checkpoint: RunCheckpoint

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "search-phase-"))
    manager = new CheckpointManager(tempDir)
    checkpoint = manager.create("run_search", "filesystem", "locomo", "gpt-4o", "gpt-4o")
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("writes search result files and updates checkpoint state", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q1",
        question: "Where am I?",
        questionType: "single-hop",
        groundTruth: "Seattle",
        haystackSessionIds: [],
      },
    ]
    const benchmark = makeBenchmark(questions)
    manager.initQuestion(checkpoint, "q1", "q1-run_search", {
      question: "Where am I?",
      groundTruth: "Seattle",
      questionType: "single-hop",
    })
    checkpoint.questions.q1.phases.indexing.status = "completed"

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {},
      search: async () => [{ id: "res1", score: 0.9 }],
      clear: async () => {},
      concurrency: { default: 5, search: 5 },
    }

    const missingResultsDir = join(tempDir, "results-missing")
    ;(manager as { getResultsDir: (runId: string) => string }).getResultsDir = () => missingResultsDir
    expect(existsSync(missingResultsDir)).toBe(false)

    await runSearchPhase(provider, benchmark, checkpoint, manager)

    const searchPhase = checkpoint.questions.q1.phases.search
    expect(searchPhase.status).toBe("completed")
    expect(searchPhase.results).toEqual([{ id: "res1", score: 0.9 }])
    expect(searchPhase.resultFile).toBeString()
    expect(existsSync(searchPhase.resultFile!)).toBe(true)
    expect(existsSync(missingResultsDir)).toBe(true)

    const parsed = JSON.parse(await readFile(searchPhase.resultFile!, "utf8"))
    expect(parsed.questionId).toBe("q1")
    expect(parsed.containerTag).toBe("q1-run_search")
  })

  it("marks search failures and throws resumable errors", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q_fail",
        question: "Q",
        questionType: "single-hop",
        groundTruth: "A",
        haystackSessionIds: [],
      },
    ]
    const benchmark = makeBenchmark(questions)
    manager.initQuestion(checkpoint, "q_fail", "q_fail-run_search", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_fail.phases.indexing.status = "completed"

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {},
      search: async () => {
        throw new Error("search boom")
      },
      clear: async () => {},
    }

    await expect(runSearchPhase(provider, benchmark, checkpoint, manager)).rejects.toThrow(
      "Search failed at q_fail"
    )
    expect(checkpoint.questions.q_fail.phases.search.status).toBe("failed")
    expect(checkpoint.questions.q_fail.phases.search.error).toContain("search boom")
  })

  it("returns early when no questions are eligible for search", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q_done",
        question: "Q",
        questionType: "single-hop",
        groundTruth: "A",
        haystackSessionIds: [],
      },
    ]
    const benchmark = makeBenchmark(questions)
    manager.initQuestion(checkpoint, "q_done", "q_done-run_search", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_done.phases.search.status = "completed"
    checkpoint.questions.q_done.phases.indexing.status = "completed"

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
    }

    await runSearchPhase(provider, benchmark, checkpoint, manager)
    expect(checkpoint.questions.q_done.phases.search.status).toBe("completed")
  })

  it("filters execution to questionIds when provided", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q1",
        question: "Q1",
        questionType: "single-hop",
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
    ]
    const benchmark = makeBenchmark(questions)
    manager.initQuestion(checkpoint, "q1", "q1-run_search", {
      question: "Q1",
      groundTruth: "A1",
      questionType: "single-hop",
    })
    manager.initQuestion(checkpoint, "q2", "q2-run_search", {
      question: "Q2",
      groundTruth: "A2",
      questionType: "single-hop",
    })
    checkpoint.questions.q1.phases.indexing.status = "completed"
    checkpoint.questions.q2.phases.indexing.status = "completed"

    const searchedContainerTags: string[] = []
    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {},
      search: async (_query, options) => {
        searchedContainerTags.push(options.containerTag)
        return []
      },
      clear: async () => {},
    }

    await runSearchPhase(provider, benchmark, checkpoint, manager, ["q2"])
    expect(searchedContainerTags).toEqual(["q2-run_search"])
    expect(checkpoint.questions.q2.phases.search.status).toBe("completed")
    expect(checkpoint.questions.q1.phases.search.status).toBe("pending")
  })
})
