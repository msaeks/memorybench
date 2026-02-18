import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runIndexingPhase } from "./indexing"
import { CheckpointManager } from "../checkpoint"
import type { Provider } from "../../types/provider"
import type { RunCheckpoint } from "../../types/checkpoint"

describe("runIndexingPhase", () => {
  let tempDir: string
  let manager: CheckpointManager
  let checkpoint: RunCheckpoint

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "indexing-phase-"))
    manager = new CheckpointManager(tempDir)
    checkpoint = manager.create("run_indexing", "filesystem", "locomo", "gpt-4o", "gpt-4o")
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("awaits indexing and persists progress callbacks", async () => {
    manager.initQuestion(checkpoint, "q1", "q1-run_indexing", {
      question: "Q1",
      groundTruth: "A1",
      questionType: "single-hop",
    })
    checkpoint.questions.q1.phases.ingest.status = "completed"
    checkpoint.questions.q1.phases.ingest.ingestResult = {
      documentIds: ["d1", "d2"],
      taskIds: ["t1"],
    }

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async (_result, _containerTag, onProgress) => {
        onProgress?.({
          completedIds: ["d1"],
          failedIds: [],
          total: 3,
        })
        onProgress?.({
          completedIds: ["d1", "d2", "t1"],
          failedIds: [],
          total: 3,
        })
      },
      search: async () => [],
      clear: async () => {},
      concurrency: { default: 10, indexing: 10 },
    }

    await runIndexingPhase(provider, checkpoint, manager)

    const phase = checkpoint.questions.q1.phases.indexing
    expect(phase.status).toBe("completed")
    expect(phase.completedIds).toEqual(["d1", "d2", "t1"])
    expect(phase.failedIds).toEqual([])
    expect(phase.durationMs).toBeNumber()
  })

  it("marks indexing complete immediately when there are no episodes", async () => {
    manager.initQuestion(checkpoint, "q_empty", "q_empty-run_indexing", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_empty.phases.ingest.status = "completed"
    checkpoint.questions.q_empty.phases.ingest.ingestResult = { documentIds: [] }

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
    }

    await runIndexingPhase(provider, checkpoint, manager)
    expect(checkpoint.questions.q_empty.phases.indexing.status).toBe("completed")
    expect(checkpoint.questions.q_empty.phases.indexing.durationMs).toBe(0)
  })

  it("captures failures and throws resumable indexing errors", async () => {
    manager.initQuestion(checkpoint, "q_fail", "q_fail-run_indexing", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_fail.phases.ingest.status = "completed"
    checkpoint.questions.q_fail.phases.ingest.ingestResult = { documentIds: ["d1"] }

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {
        throw new Error("index boom")
      },
      search: async () => [],
      clear: async () => {},
    }

    await expect(runIndexingPhase(provider, checkpoint, manager)).rejects.toThrow(
      "Indexing failed at q_fail"
    )
    expect(checkpoint.questions.q_fail.phases.indexing.status).toBe("failed")
    expect(checkpoint.questions.q_fail.phases.indexing.error).toContain("index boom")
  })

  it("returns early when no questions are pending indexing", async () => {
    manager.initQuestion(checkpoint, "q_done", "q_done-run_indexing", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_done.phases.ingest.status = "completed"
    checkpoint.questions.q_done.phases.indexing.status = "completed"

    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
    }

    await runIndexingPhase(provider, checkpoint, manager)
    expect(checkpoint.questions.q_done.phases.indexing.status).toBe("completed")
  })

  it("filters execution to questionIds when provided", async () => {
    manager.initQuestion(checkpoint, "q1", "q1-run_indexing", {
      question: "Q1",
      groundTruth: "A1",
      questionType: "single-hop",
    })
    manager.initQuestion(checkpoint, "q2", "q2-run_indexing", {
      question: "Q2",
      groundTruth: "A2",
      questionType: "single-hop",
    })
    checkpoint.questions.q1.phases.ingest.status = "completed"
    checkpoint.questions.q2.phases.ingest.status = "completed"
    checkpoint.questions.q1.phases.ingest.ingestResult = { documentIds: ["d1"] }
    checkpoint.questions.q2.phases.ingest.ingestResult = { documentIds: ["d2"] }

    let awaitIndexingCalls = 0
    const provider: Provider = {
      name: "filesystem",
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async (_result, _containerTag, onProgress) => {
        awaitIndexingCalls += 1
        onProgress?.({ completedIds: ["d2"], failedIds: [], total: 1 })
      },
      search: async () => [],
      clear: async () => {},
    }

    await runIndexingPhase(provider, checkpoint, manager, ["q2"])
    expect(awaitIndexingCalls).toBe(1)
    expect(checkpoint.questions.q2.phases.indexing.status).toBe("completed")
    expect(checkpoint.questions.q1.phases.indexing.status).toBe("pending")
  })
})
