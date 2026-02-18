import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CheckpointManager } from "./checkpoint"
import type { RunCheckpoint } from "../types/checkpoint"
import { logger } from "../utils/logger"

describe("CheckpointManager", () => {
  let baseDir: string
  let manager: CheckpointManager

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "memorybench-checkpoint-"))
    manager = new CheckpointManager(baseDir)
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it("creates, saves, flushes, loads, and lists checkpoints", async () => {
    const checkpoint = manager.create("run_a", "filesystem", "locomo", "gpt-4o", "gpt-4o", {
      limit: 5,
      status: "running",
    })

    await manager.flush("run_a")
    expect(manager.exists("run_a")).toBe(true)

    const loaded = manager.load("run_a")
    expect(loaded?.runId).toBe("run_a")
    expect(loaded?.provider).toBe("filesystem")
    expect(loaded?.limit).toBe(5)
    expect(manager.listRuns()).toEqual(["run_a"])

    expect(manager.exists("../bad")).toBe(false)
  })

  it("supports question lifecycle updates and summary aggregation", async () => {
    const checkpoint = manager.create("run_b", "rag", "longmemeval", "gpt-4o", "gpt-4o")
    manager.initQuestion(checkpoint, "q1", "tag1", {
      question: "Where do I live?",
      groundTruth: "Seattle",
      questionType: "single-hop",
    })
    manager.updateSessions(checkpoint, "q1", [{ sessionId: "s1", date: "2026-01-01", messageCount: 2 }])
    manager.updatePhase(checkpoint, "q1", "ingest", {
      status: "completed",
      ingestResult: { documentIds: ["d1", "d2"], taskIds: ["t1"] },
    })
    manager.updatePhase(checkpoint, "q1", "indexing", {
      status: "completed",
      completedIds: ["d1", "t1"],
      failedIds: ["d2"],
    })
    manager.updatePhase(checkpoint, "q1", "search", { status: "completed", resultCount: 1 })
    manager.updatePhase(checkpoint, "q1", "answer", { status: "completed", hypothesis: "Seattle" })
    manager.updatePhase(checkpoint, "q1", "evaluate", { status: "completed", label: "correct", score: 1 })
    await manager.flush("run_b")

    expect(manager.getPhaseStatus(checkpoint, "q1", "evaluate")).toBe("completed")
    expect(manager.getPhaseStatus(checkpoint, "missing", "evaluate")).toBe("pending")

    const summary = manager.getSummary(checkpoint)
    expect(summary).toEqual({
      total: 1,
      ingested: 1,
      indexed: 1,
      searched: 1,
      answered: 1,
      evaluated: 1,
      indexingEpisodes: {
        total: 3,
        completed: 2,
        failed: 1,
      },
    })
  })

  it("handles corrupt checkpoints and invalid delete safely", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
    const runDir = join(baseDir, "run_corrupt")
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, "checkpoint.json"), "{not-json", "utf8")

    const loaded = manager.load("run_corrupt")
    expect(loaded).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    manager.delete("../invalid")
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("copies checkpoints from a phase and can copy results dir", async () => {
    const source = manager.create("run_source", "filesystem", "locomo", "gpt-4o", "gpt-4o", {
      status: "running",
      sampling: { mode: "limit", limit: 2 },
    })

    source.questions = {
      q1: {
        questionId: "q1",
        containerTag: "tag",
        question: "Q",
        groundTruth: "A",
        questionType: "single-hop",
        phases: {
          ingest: { status: "completed", completedSessions: ["s1"], ingestResult: { documentIds: ["d1"] } },
          indexing: { status: "completed", completedIds: ["d1"], failedIds: [] },
          search: { status: "completed", resultFile: "q1.json", resultCount: 1 },
          answer: { status: "completed", hypothesis: "A" },
          evaluate: { status: "completed", score: 1, label: "correct", explanation: "ok" },
        },
      },
    }
    manager.save(source)
    await manager.flush("run_source")

    const sourceResults = manager.getResultsDir("run_source")
    await mkdir(sourceResults, { recursive: true })
    await writeFile(join(sourceResults, "q1.json"), '{"ok":true}', "utf8")

    const copied = manager.copyCheckpoint("run_source", "run_copy", "answer", {
      judge: "sonnet-4",
      answeringModel: "gpt-4.1",
    })
    await manager.flush("run_copy")

    expect(copied.runId).toBe("run_copy")
    expect(copied.dataSourceRunId).toBe("run_source")
    expect(copied.judge).toBe("sonnet-4")
    expect(copied.answeringModel).toBe("gpt-4.1")
    expect(copied.questions.q1.phases.ingest.status).toBe("completed")
    expect(copied.questions.q1.phases.search.status).toBe("completed")
    expect(copied.questions.q1.phases.answer.status).toBe("pending")
    expect(copied.questions.q1.phases.evaluate.status).toBe("pending")

    const copiedResult = manager.getResultsDir("run_copy")
    expect(manager.exists("run_copy")).toBe(true)
    expect(await Bun.file(join(copiedResult, "q1.json")).text()).toContain('"ok":true')
  })

  it("throws when copying from a missing source checkpoint", () => {
    expect(() => manager.copyCheckpoint("missing", "new_run", "search")).toThrow(
      "Source checkpoint not found: missing"
    )
  })

  it("updates overall checkpoint status", async () => {
    const checkpoint: RunCheckpoint = manager.create(
      "run_status",
      "filesystem",
      "locomo",
      "gpt-4o",
      "gpt-4o"
    )
    manager.updateStatus(checkpoint, "completed")
    await manager.flush("run_status")
    const loaded = manager.load("run_status")
    expect(loaded?.status).toBe("completed")
  })
})

