import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as ai from "ai"
import * as anthropic from "@ai-sdk/anthropic"
import * as google from "@ai-sdk/google"
import { runAnswerPhase } from "./answer"
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

describe("runAnswerPhase", () => {
  let tempDir: string
  let manager: CheckpointManager
  let checkpoint: RunCheckpoint

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "answer-phase-"))
    manager = new CheckpointManager(tempDir)
    checkpoint = manager.create("run_answer", "filesystem", "locomo", "gpt-4o", "gpt-4o")
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("generates answers using model providers and trims hypotheses", async () => {
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
    manager.initQuestion(checkpoint, "q1", "q1-run_answer", {
      question: "Where do I live?",
      groundTruth: "Seattle",
      questionType: "single-hop",
      questionDate: "2026-01-01",
    })
    checkpoint.questions.q1.phases.search.status = "completed"
    const resultFile = join(manager.getResultsDir(checkpoint.runId), "q1.json")
    await writeFile(
      resultFile,
      JSON.stringify({
        results: [{ content: "User lives in Seattle", score: 0.9 }],
      }),
      "utf8"
    )
    checkpoint.questions.q1.phases.search.resultFile = resultFile

    const generateTextSpy = spyOn(ai, "generateText").mockResolvedValue({ text: "  Seattle  " } as never)

    const provider: Provider = {
      name: "filesystem",
      prompts: {
        answerPrompt: (question, context, questionDate) =>
          `Q=${question}\nDATE=${questionDate}\nCTX=${JSON.stringify(context)}`,
      },
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
      concurrency: { default: 10, answer: 10 },
    }

    await runAnswerPhase(benchmark, checkpoint, manager, undefined, provider)

    const phase = checkpoint.questions.q1.phases.answer
    expect(phase.status).toBe("completed")
    expect(phase.hypothesis).toBe("Seattle")
    expect(generateTextSpy).toHaveBeenCalled()
    generateTextSpy.mockRestore()
  })

  it("supports template-style provider answerPrompt replacement", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q2",
        question: "Q2",
        questionType: "single-hop",
        groundTruth: "A2",
        haystackSessionIds: [],
      },
    ]
    const benchmark = makeBenchmark(questions)
    manager.initQuestion(checkpoint, "q2", "q2-run_answer", {
      question: "Q2",
      groundTruth: "A2",
      questionType: "single-hop",
    })
    checkpoint.questions.q2.phases.search.status = "completed"
    const resultFile = join(manager.getResultsDir(checkpoint.runId), "q2.json")
    await writeFile(resultFile, JSON.stringify({ results: [{ x: 1 }] }), "utf8")
    checkpoint.questions.q2.phases.search.resultFile = resultFile

    const generateTextSpy = spyOn(ai, "generateText").mockResolvedValue({ text: "ok" } as never)
    const provider: Provider = {
      name: "filesystem",
      prompts: {
        answerPrompt: "Question={{question}} Date={{questionDate}} Context={{context}}",
      },
      initialize: async () => {},
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async () => {},
      search: async () => [],
      clear: async () => {},
    }

    await runAnswerPhase(benchmark, checkpoint, manager, undefined, provider)
    expect(generateTextSpy).toHaveBeenCalled()
    generateTextSpy.mockRestore()
  })

  it("marks failures when generation errors", async () => {
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
    manager.initQuestion(checkpoint, "q_fail", "q_fail-run_answer", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_fail.phases.search.status = "completed"
    const resultFile = join(manager.getResultsDir(checkpoint.runId), "q_fail.json")
    await writeFile(resultFile, JSON.stringify({ results: [] }), "utf8")
    checkpoint.questions.q_fail.phases.search.resultFile = resultFile

    const generateTextSpy = spyOn(ai, "generateText").mockRejectedValue(new Error("llm boom") as never)
    await expect(runAnswerPhase(benchmark, checkpoint, manager)).rejects.toThrow("Answer failed at q_fail")
    expect(checkpoint.questions.q_fail.phases.answer.status).toBe("failed")
    expect(checkpoint.questions.q_fail.phases.answer.error).toContain("llm boom")
    generateTextSpy.mockRestore()
  })

  it("uses anthropic client for claude models and google client for gemini models", async () => {
    const questions: UnifiedQuestion[] = [
      {
        questionId: "q_provider",
        question: "Q",
        questionType: "single-hop",
        groundTruth: "A",
        haystackSessionIds: [],
      },
    ]
    const benchmark = makeBenchmark(questions)
    const generateTextSpy = spyOn(ai, "generateText").mockResolvedValue({ text: "ok" } as never)

    checkpoint.answeringModel = "sonnet-4"
    manager.initQuestion(checkpoint, "q_provider", "q_provider-run_answer", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_provider.phases.search.status = "completed"
    const anthropicResultFile = join(manager.getResultsDir(checkpoint.runId), "q_provider.json")
    await writeFile(anthropicResultFile, JSON.stringify({ results: [{ content: "ctx" }] }), "utf8")
    checkpoint.questions.q_provider.phases.search.resultFile = anthropicResultFile

    const anthropicFactory = ((model: string) => ({ model })) as any
    const anthropicSpy = spyOn(anthropic, "createAnthropic").mockReturnValue(anthropicFactory)
    await runAnswerPhase(benchmark, checkpoint, manager)
    expect(anthropicSpy).toHaveBeenCalled()

    const googleCheckpoint = manager.create(
      "run_answer_google",
      "filesystem",
      "locomo",
      "gpt-4o",
      "gemini-2.5-flash"
    )
    manager.initQuestion(googleCheckpoint, "q_provider", "q_provider-run_answer_google", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    googleCheckpoint.questions.q_provider.phases.search.status = "completed"
    const googleResultFile = join(manager.getResultsDir(googleCheckpoint.runId), "q_provider.json")
    await writeFile(googleResultFile, JSON.stringify({ results: [{ content: "ctx" }] }), "utf8")
    googleCheckpoint.questions.q_provider.phases.search.resultFile = googleResultFile

    const googleFactory = ((model: string) => ({ model })) as any
    const googleSpy = spyOn(google, "createGoogleGenerativeAI").mockReturnValue(googleFactory)
    await runAnswerPhase(benchmark, googleCheckpoint, manager)
    expect(googleSpy).toHaveBeenCalled()

    generateTextSpy.mockRestore()
    anthropicSpy.mockRestore()
    googleSpy.mockRestore()
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
    manager.initQuestion(checkpoint, "q1", "q1-run_answer", {
      question: "Q1",
      groundTruth: "A1",
      questionType: "single-hop",
    })
    manager.initQuestion(checkpoint, "q2", "q2-run_answer", {
      question: "Q2",
      groundTruth: "A2",
      questionType: "single-hop",
    })
    checkpoint.questions.q1.phases.search.status = "completed"
    checkpoint.questions.q2.phases.search.status = "completed"

    const q1File = join(manager.getResultsDir(checkpoint.runId), "q1.json")
    await writeFile(q1File, JSON.stringify({ results: [{ content: "ctx1" }] }), "utf8")
    checkpoint.questions.q1.phases.search.resultFile = q1File

    const q2File = join(manager.getResultsDir(checkpoint.runId), "q2.json")
    await writeFile(q2File, JSON.stringify({ results: [{ content: "ctx2" }] }), "utf8")
    checkpoint.questions.q2.phases.search.resultFile = q2File

    const generateTextSpy = spyOn(ai, "generateText").mockResolvedValue({ text: "ok" } as never)
    await runAnswerPhase(benchmark, checkpoint, manager, ["q2"])

    expect(generateTextSpy).toHaveBeenCalledTimes(1)
    expect(checkpoint.questions.q2.phases.answer.status).toBe("completed")
    expect(checkpoint.questions.q1.phases.answer.status).toBe("pending")

    generateTextSpy.mockRestore()
  })

  it("returns early when no questions are eligible for answering", async () => {
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
    manager.initQuestion(checkpoint, "q_done", "q_done-run_answer", {
      question: "Q",
      groundTruth: "A",
      questionType: "single-hop",
    })
    checkpoint.questions.q_done.phases.answer.status = "completed"

    await runAnswerPhase(benchmark, checkpoint, manager)
    expect(checkpoint.questions.q_done.phases.answer.status).toBe("completed")
  })
})
