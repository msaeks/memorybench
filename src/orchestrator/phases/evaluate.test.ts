import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runEvaluatePhase } from "./evaluate"
import { CheckpointManager } from "../checkpoint"
import type { Benchmark } from "../../types/benchmark"
import type { Judge } from "../../types/judge"
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

describe("runEvaluatePhase", () => {
  let tempDir: string
  let manager: CheckpointManager
  let checkpoint: RunCheckpoint

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evaluate-phase-"))
    manager = new CheckpointManager(tempDir)
    checkpoint = manager.create("run_eval", "filesystem", "locomo", "gpt-4o", "gpt-4o")
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("evaluates answers and records judge output with retrieval metrics", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q1",
        question: "Where do I live?",
        questionType: "single-hop",
        groundTruth: "Seattle",
        haystackSessionIds: [],
      },
    ]
    const benchmark = makeBenchmark(questions)
    manager.initQuestion(checkpoint, "q1", "q1-run_eval", {
      question: "Where do I live?",
      groundTruth: "Seattle",
      questionType: "single-hop",
    })
    checkpoint.questions.q1.phases.answer.status = "completed"
    checkpoint.questions.q1.phases.answer.hypothesis = "Seattle"
    checkpoint.questions.q1.phases.search.status = "completed"
    checkpoint.questions.q1.phases.search.results = []

    const judge: Judge = {
      name: "openai",
      initialize: async () => {},
      evaluate: async () => ({
        score: 1,
        label: "correct",
        explanation: "matches",
      }),
      getPromptForQuestionType: () => "",
      getModel: () => ({}) as never,
    }

    const provider: Provider = {
      name: "filesystem",
      prompts: {
        answerPrompt: "x",
      },
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
      concurrency: { default: 10, evaluate: 10 },
    }

    await runEvaluatePhase(judge, benchmark, checkpoint, manager, undefined, provider)

    const phase = checkpoint.questions.q1.phases.evaluate
    expect(phase.status).toBe("completed")
    expect(phase.score).toBe(1)
    expect(phase.label).toBe("correct")
    expect(phase.explanation).toBe("matches")
    expect(phase.retrievalMetrics?.k).toBe(0)
  })

  it("captures evaluation failures with resumable errors", async () => {
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
    manager.initQuestion(checkpoint, "q_fail", "q_fail-run_eval", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_fail.phases.answer.status = "completed"
    checkpoint.questions.q_fail.phases.answer.hypothesis = "bad"
    checkpoint.questions.q_fail.phases.search.status = "completed"
    checkpoint.questions.q_fail.phases.search.results = []

    const judge: Judge = {
      name: "openai",
      initialize: async () => {},
      evaluate: async () => {
        throw new Error("judge boom")
      },
      getPromptForQuestionType: () => "",
      getModel: () => ({}) as never,
    }

    await expect(runEvaluatePhase(judge, benchmark, checkpoint, manager)).rejects.toThrow(
      "Evaluate failed at q_fail"
    )
    expect(checkpoint.questions.q_fail.phases.evaluate.status).toBe("failed")
    expect(checkpoint.questions.q_fail.phases.evaluate.error).toContain("judge boom")
  })

  it("returns early when no questions are pending evaluation", async () => {
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
    manager.initQuestion(checkpoint, "q_done", "q_done-run_eval", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_done.phases.evaluate.status = "completed"

    const judge: Judge = {
      name: "openai",
      initialize: async () => {},
      evaluate: async () => ({ score: 1, label: "correct", explanation: "" }),
      getPromptForQuestionType: () => "",
      getModel: () => ({}) as never,
    }

    await runEvaluatePhase(judge, benchmark, checkpoint, manager)
    expect(checkpoint.questions.q_done.phases.evaluate.status).toBe("completed")
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
    manager.initQuestion(checkpoint, "q1", "q1-run_eval", {
      question: "Q1",
      groundTruth: "A1",
      questionType: "single-hop",
    })
    manager.initQuestion(checkpoint, "q2", "q2-run_eval", {
      question: "Q2",
      groundTruth: "A2",
      questionType: "single-hop",
    })
    checkpoint.questions.q1.phases.answer.status = "completed"
    checkpoint.questions.q1.phases.answer.hypothesis = "A1"
    checkpoint.questions.q1.phases.search.status = "completed"
    checkpoint.questions.q1.phases.search.results = []
    checkpoint.questions.q2.phases.answer.status = "completed"
    checkpoint.questions.q2.phases.answer.hypothesis = "A2"
    checkpoint.questions.q2.phases.search.status = "completed"
    checkpoint.questions.q2.phases.search.results = []

    let evaluatedCount = 0
    const judge: Judge = {
      name: "openai",
      initialize: async () => {},
      evaluate: async () => {
        evaluatedCount += 1
        return { score: 1, label: "correct", explanation: "ok" }
      },
      getPromptForQuestionType: () => "",
      getModel: () => ({}) as never,
    }

    await runEvaluatePhase(judge, benchmark, checkpoint, manager, ["q2"])
    expect(evaluatedCount).toBe(1)
    expect(checkpoint.questions.q2.phases.evaluate.status).toBe("completed")
    expect(checkpoint.questions.q1.phases.evaluate.status).toBe("pending")
  })
})
