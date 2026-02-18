import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runIngestPhase } from "./ingest"
import { CheckpointManager } from "../checkpoint"
import type { Benchmark } from "../../types/benchmark"
import type { Provider } from "../../types/provider"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { UnifiedQuestion, UnifiedSession } from "../../types/unified"

function makeBenchmark(
  questions: UnifiedQuestion[],
  sessionsByQuestion: Record<string, UnifiedSession[]>
): Benchmark {
  return {
    name: "test-benchmark",
    load: async () => {},
    getQuestions: () => questions,
    getHaystackSessions: (questionId: string) => sessionsByQuestion[questionId] || [],
    getGroundTruth: () => "",
    getQuestionTypes: () => ({}),
  }
}

describe("runIngestPhase", () => {
  let tempDir: string
  let manager: CheckpointManager
  let checkpoint: RunCheckpoint

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ingest-phase-"))
    manager = new CheckpointManager(tempDir)
    checkpoint = manager.create("run_ingest", "filesystem", "locomo", "gpt-4o", "gpt-4o")
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("ingests pending questions and merges with existing ingestResult", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q1",
        question: "Q1",
        questionType: "single-hop",
        groundTruth: "A1",
        haystackSessionIds: ["s1", "s2"],
      },
    ]
    const sessionsByQuestion: Record<string, UnifiedSession[]> = {
      q1: [
        {
          sessionId: "s1",
          messages: [{ role: "user", content: "hello" }],
          metadata: { date: "2026-01-01" },
        },
        {
          sessionId: "s2",
          messages: [{ role: "assistant", content: "world" }],
          metadata: { date: "2026-01-02" },
        },
      ],
    }
    const benchmark = makeBenchmark(questions, sessionsByQuestion)

    manager.initQuestion(checkpoint, "q1", "q1-run_ingest", {
      question: "Q1",
      groundTruth: "A1",
      questionType: "single-hop",
    })
    checkpoint.questions.q1.phases.ingest.ingestResult = { documentIds: ["existing-doc"], taskIds: ["t-old"] }

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async (sessions) => {
        const sid = sessions[0].sessionId
        return { documentIds: [`doc-${sid}`], taskIds: [`task-${sid}`] }
      },
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
      concurrency: { default: 5, ingest: 5 },
    }

    await runIngestPhase(provider, benchmark, checkpoint, manager)

    const ingestPhase = checkpoint.questions.q1.phases.ingest
    expect(ingestPhase.status).toBe("completed")
    expect(ingestPhase.completedSessions).toEqual(["s1", "s2"])
    expect(ingestPhase.ingestResult?.documentIds).toEqual(["existing-doc", "doc-s1", "doc-s2"])
    expect(ingestPhase.ingestResult?.taskIds).toEqual(["t-old", "task-s1", "task-s2"])
    expect(checkpoint.questions.q1.sessions).toEqual([
      { sessionId: "s1", date: "2026-01-01", messageCount: 1 },
      { sessionId: "s2", date: "2026-01-02", messageCount: 1 },
    ])
  })

  it("handles per-question ingest failures with resumable error message", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q_fail",
        question: "Q",
        questionType: "single-hop",
        groundTruth: "A",
        haystackSessionIds: ["s1"],
      },
    ]
    const sessionsByQuestion: Record<string, UnifiedSession[]> = {
      q_fail: [{ sessionId: "s1", messages: [{ role: "user", content: "x" }] }],
    }
    const benchmark = makeBenchmark(questions, sessionsByQuestion)
    manager.initQuestion(checkpoint, "q_fail", "q_fail-run_ingest", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => {
        throw new Error("provider boom")
      },
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
    }

    await expect(runIngestPhase(provider, benchmark, checkpoint, manager)).rejects.toThrow(
      "Ingest failed at q_fail"
    )
    expect(checkpoint.questions.q_fail.phases.ingest.status).toBe("failed")
    expect(checkpoint.questions.q_fail.phases.ingest.error).toContain("provider boom")
  })

  it("omits empty taskIds when provider does not return tasks", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q_no_tasks",
        question: "Q",
        questionType: "single-hop",
        groundTruth: "A",
        haystackSessionIds: ["s1"],
      },
    ]
    const sessionsByQuestion: Record<string, UnifiedSession[]> = {
      q_no_tasks: [{ sessionId: "s1", messages: [{ role: "user", content: "x" }] }],
    }
    const benchmark = makeBenchmark(questions, sessionsByQuestion)
    manager.initQuestion(checkpoint, "q_no_tasks", "q_no_tasks-run_ingest", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: ["doc-only"] }),
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
    }

    await runIngestPhase(provider, benchmark, checkpoint, manager)
    expect(checkpoint.questions.q_no_tasks.phases.ingest.ingestResult?.documentIds).toEqual(["doc-only"])
    expect(checkpoint.questions.q_no_tasks.phases.ingest.ingestResult?.taskIds).toBeUndefined()
  })

  it("filters execution to questionIds when provided", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q1",
        question: "Q1",
        questionType: "single-hop",
        groundTruth: "A1",
        haystackSessionIds: ["s1"],
      },
      {
        questionId: "q2",
        question: "Q2",
        questionType: "single-hop",
        groundTruth: "A2",
        haystackSessionIds: ["s2"],
      },
    ]
    const sessionsByQuestion: Record<string, UnifiedSession[]> = {
      q1: [{ sessionId: "s1", messages: [{ role: "user", content: "x1" }] }],
      q2: [{ sessionId: "s2", messages: [{ role: "user", content: "x2" }] }],
    }
    const benchmark = makeBenchmark(questions, sessionsByQuestion)
    manager.initQuestion(checkpoint, "q1", "q1-run_ingest", {
      question: "Q1",
      groundTruth: "A1",
      questionType: "single-hop",
    })
    manager.initQuestion(checkpoint, "q2", "q2-run_ingest", {
      question: "Q2",
      groundTruth: "A2",
      questionType: "single-hop",
    })

    const ingestedContainerTags: string[] = []
    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async (_sessions, options) => {
        ingestedContainerTags.push(options.containerTag)
        return { documentIds: ["doc"] }
      },
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
    }

    await runIngestPhase(provider, benchmark, checkpoint, manager, ["q2"])
    expect(ingestedContainerTags).toEqual(["q2-run_ingest"])
    expect(checkpoint.questions.q2.phases.ingest.status).toBe("completed")
    expect(checkpoint.questions.q1.phases.ingest.status).toBe("pending")
  })

  it("exits cleanly when nothing is pending", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q_done",
        question: "Q",
        questionType: "single-hop",
        groundTruth: "A",
        haystackSessionIds: [],
      },
    ]
    const benchmark = makeBenchmark(questions, {})
    manager.initQuestion(checkpoint, "q_done", "q_done-run_ingest", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_done.phases.ingest.status = "completed"

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
    }

    await runIngestPhase(provider, benchmark, checkpoint, manager)
    expect(checkpoint.questions.q_done.phases.ingest.status).toBe("completed")
  })
})
