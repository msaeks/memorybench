import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { CheckpointManager } from "../../orchestrator/checkpoint"
import { orchestrator } from "../../orchestrator"
import { wsManager } from "../index"
import { activeRuns, startRun, endRun, requestStop, isRunActive, getRunState } from "../runState"
import { createBenchmark } from "../../benchmarks"
import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { PhaseId, SamplingConfig } from "../../types/checkpoint"
import type { ConcurrencyConfig } from "../../types/concurrency"
import { getPhasesFromPhase, PHASE_ORDER } from "../../types/checkpoint"
import { parseBoundedInt, isSafeId } from "../../utils/security"
import { logger } from "../../utils/logger"
import { z } from "zod"
import { HttpBodyError, readJsonBody } from "../../utils/http"

const checkpointManager = new CheckpointManager()

const benchmarkRegistryCache: Record<string, any> = {}
const PHASE_VALUES = ["ingest", "indexing", "search", "answer", "evaluate", "report"] as const

const identifierSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => isSafeId(value), { message: "Must contain only letters, numbers, _ or -" })

const samplingSchema = z
  .object({
    mode: z.enum(["full", "sample", "limit"]),
    sampleType: z.enum(["consecutive", "random"]).optional(),
    perCategory: z.number().int().min(1).max(1000).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "sample" && value.perCategory === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "sampling.perCategory is required when mode=sample",
      })
    }
    if (value.mode === "limit" && value.limit === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "sampling.limit is required when mode=limit",
      })
    }
  })

const concurrencySchema = z
  .object({
    default: z.number().int().min(1).max(128).optional(),
    ingest: z.number().int().min(1).max(128).optional(),
    indexing: z.number().int().min(1).max(128).optional(),
    search: z.number().int().min(1).max(128).optional(),
    answer: z.number().int().min(1).max(128).optional(),
    evaluate: z.number().int().min(1).max(128).optional(),
  })
  .strict()

const startRunRequestSchema = z
  .object({
    provider: identifierSchema,
    benchmark: identifierSchema,
    runId: identifierSchema,
    judgeModel: z.string().min(1).max(120),
    answeringModel: z.string().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    sampling: samplingSchema.optional(),
    concurrency: concurrencySchema.optional(),
    force: z.boolean().optional(),
    fromPhase: z.enum(PHASE_VALUES).optional(),
    sourceRunId: identifierSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sourceRunId && !value.fromPhase) {
      ctx.addIssue({
        code: "custom",
        message: "fromPhase is required when sourceRunId is provided",
      })
    }
  })

function getQuestionTypeRegistry(benchmarkName: string) {
  if (!benchmarkRegistryCache[benchmarkName]) {
    const benchmark = createBenchmark(benchmarkName as BenchmarkName)
    benchmarkRegistryCache[benchmarkName] = benchmark.getQuestionTypes()
  }
  return benchmarkRegistryCache[benchmarkName]
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function decodeAndValidateId(rawValue: string, fieldName: string): string | null {
  try {
    const value = decodeURIComponent(rawValue)
    if (!isSafeId(value)) return null
    return value
  } catch {
    logger.warn(`Rejected malformed ${fieldName} path value`)
    return null
  }
}

export async function handleRunsRoutes(req: Request, url: URL): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname

  // GET /api/runs - List all runs
  if (method === "GET" && pathname === "/api/runs") {
    const runs = checkpointManager.listRuns()
    const runDetails = runs
      .map((runId) => {
        const checkpoint = checkpointManager.load(runId)
        if (!checkpoint) return null
        const summary = checkpointManager.getSummary(checkpoint)

        // Calculate accuracy from checkpoint questions
        const questions = Object.values(checkpoint.questions)
        const evaluatedQuestions = questions.filter(
          (q: any) => q.phases?.evaluate?.status === "completed"
        )
        const correctCount = evaluatedQuestions.filter(
          (q: any) => q.phases?.evaluate?.score === 1
        ).length
        const accuracy =
          evaluatedQuestions.length > 0 ? correctCount / evaluatedQuestions.length : null

        return {
          runId,
          provider: checkpoint.provider,
          benchmark: checkpoint.benchmark,
          judge: checkpoint.judge,
          answeringModel: checkpoint.answeringModel,
          createdAt: checkpoint.createdAt,
          updatedAt: checkpoint.updatedAt,
          status: getRunStatus(checkpoint, summary),
          summary,
          accuracy,
        }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""))

    return json(runDetails)
  }

  // GET /api/runs/:runId - Get checkpoint
  const runIdMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (method === "GET" && runIdMatch) {
    const runId = decodeAndValidateId(runIdMatch[1], "runId")
    if (!runId) return json({ error: "Invalid runId" }, 400)

    const checkpoint = checkpointManager.load(runId)
    if (!checkpoint) {
      return json({ error: "Run not found" }, 404)
    }
    const summary = checkpointManager.getSummary(checkpoint)
    return json({
      ...checkpoint,
      status: getRunStatus(checkpoint, summary),
      summary,
    })
  }

  // GET /api/runs/:runId/report - Get report
  const reportMatch = pathname.match(/^\/api\/runs\/([^/]+)\/report$/)
  if (method === "GET" && reportMatch) {
    const runId = decodeAndValidateId(reportMatch[1], "runId")
    if (!runId) return json({ error: "Invalid runId" }, 400)

    const reportPath = join(checkpointManager.getRunPath(runId), "report.json")
    if (!existsSync(reportPath)) {
      return json({ error: "Report not found" }, 404)
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"))
    return json(report)
  }

  // GET /api/runs/:runId/questions - List questions
  const questionsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/questions$/)
  if (method === "GET" && questionsMatch) {
    const runId = decodeAndValidateId(questionsMatch[1], "runId")
    if (!runId) return json({ error: "Invalid runId" }, 400)

    const checkpoint = checkpointManager.load(runId)
    if (!checkpoint) {
      return json({ error: "Run not found" }, 404)
    }

    // Support pagination and filtering
    const page = parseBoundedInt(url.searchParams.get("page"), 1, 1, 100000)
    const limit = parseBoundedInt(url.searchParams.get("limit"), 50, 1, 200)
    if (page === null || limit === null) {
      return json({ error: "Invalid pagination parameters" }, 400)
    }

    const status = url.searchParams.get("status") // completed, failed, pending
    const type = url.searchParams.get("type") // question type filter

    if (status && !["completed", "failed", "pending"].includes(status)) {
      return json({ error: "Invalid status filter" }, 400)
    }

    let questions = Object.values(checkpoint.questions)

    // Filter by status
    if (status) {
      questions = questions.filter((q) => {
        const evalStatus = q.phases.evaluate.status
        if (status === "completed") return evalStatus === "completed"
        if (status === "failed") return evalStatus === "failed"
        if (status === "pending") return evalStatus !== "completed" && evalStatus !== "failed"
        return true
      })
    }

    // Filter by question type
    if (type) {
      questions = questions.filter((q) => q.questionType === type)
    }

    const total = questions.length
    const start = (page - 1) * limit
    const paged = questions.slice(start, start + limit)

    return json({
      questions: paged,
      questionTypeRegistry: getQuestionTypeRegistry(checkpoint.benchmark),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  }

  // GET /api/runs/:runId/questions/:questionId - Get question detail
  const questionDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)\/questions\/([^/]+)$/)
  if (method === "GET" && questionDetailMatch) {
    const runId = decodeAndValidateId(questionDetailMatch[1], "runId")
    const questionId = decodeAndValidateId(questionDetailMatch[2], "questionId")
    if (!runId) return json({ error: "Invalid runId" }, 400)
    if (!questionId) return json({ error: "Invalid questionId" }, 400)

    const checkpoint = checkpointManager.load(runId)
    if (!checkpoint) {
      return json({ error: "Run not found" }, 404)
    }
    const question = checkpoint.questions[questionId]
    if (!question) {
      return json({ error: "Question not found" }, 404)
    }

    // Also load the search results file if it exists
    const resultsPath = join(checkpointManager.getResultsDir(runId), `${questionId}.json`)
    let searchResults = null
    if (existsSync(resultsPath)) {
      searchResults = JSON.parse(readFileSync(resultsPath, "utf8"))
    }

    return json({
      ...question,
      searchResultsFile: searchResults,
    })
  }

  // POST /api/runs/start - Start new run
  if (method === "POST" && pathname === "/api/runs/start") {
    try {
      const parsed = startRunRequestSchema.safeParse(await readJsonBody(req))
      if (!parsed.success) {
        return json({ error: "Invalid request body" }, 400)
      }

      const {
        provider,
        benchmark,
        runId,
        judgeModel,
        answeringModel,
        limit,
        sampling,
        concurrency,
        force,
        fromPhase,
        sourceRunId,
      } = parsed.data

      if (fromPhase && !PHASE_ORDER.includes(fromPhase)) {
        return json({ error: `Invalid phase: ${fromPhase}` }, 400)
      }

      // Ingest is disabled in advanced mode (when using sourceRunId)
      if (sourceRunId && fromPhase === "ingest") {
        return json(
          {
            error:
              "Cannot start from ingest phase in advanced mode. Use indexing, search, answer, evaluate, or report.",
          },
          400
        )
      }

      if (activeRuns.has(runId)) {
        return json({ error: "Run is already active" }, 409)
      }

      // If sourceRunId is provided, copy checkpoint data from source run
      if (sourceRunId) {
        const sourceCheckpoint = checkpointManager.load(sourceRunId)
        if (!sourceCheckpoint) {
          return json({ error: `Source run not found: ${sourceRunId}` }, 404)
        }

        // Validate provider/benchmark match
        if (sourceCheckpoint.provider !== provider) {
          return json(
            {
              error: `Provider mismatch: source run has ${sourceCheckpoint.provider}, not ${provider}`,
            },
            400
          )
        }
        if (sourceCheckpoint.benchmark !== benchmark) {
          return json(
            {
              error: `Benchmark mismatch: source run has ${sourceCheckpoint.benchmark}, not ${benchmark}`,
            },
            400
          )
        }

        // Check if new runId already exists
        if (checkpointManager.exists(runId)) {
          return json({ error: `Run ${runId} already exists` }, 409)
        }

        // Copy checkpoint with new runId, resetting phases from fromPhase onwards
        checkpointManager.copyCheckpoint(sourceRunId, runId, fromPhase as PhaseId, {
          judge: judgeModel,
          answeringModel: answeringModel || sourceCheckpoint.answeringModel,
        })
        await checkpointManager.flush(runId)
      }

      startRun(runId, benchmark)

      runBenchmark({
        provider: provider as ProviderName,
        benchmark: benchmark as BenchmarkName,
        runId,
        judgeModel,
        answeringModel,
        limit,
        sampling: sampling as SamplingConfig | undefined,
        concurrency: concurrency as ConcurrencyConfig | undefined,
        force: sourceRunId ? false : force,
        fromPhase: fromPhase as PhaseId | undefined,
      }).finally(() => {
        endRun(runId)
      })

      return json({ message: "Run started", runId })
    } catch (e) {
      if (e instanceof HttpBodyError) {
        return json({ error: e.message }, e.status)
      }

      const isParseError = e instanceof SyntaxError
      logger.error(`Failed to start run: ${e}`)
      return json(
        { error: isParseError ? "Invalid request body" : "Failed to start run" },
        isParseError ? 400 : 500
      )
    }
  }

  // POST /api/runs/:runId/stop - Stop running benchmark
  const stopMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/)
  if (method === "POST" && stopMatch) {
    const runId = decodeAndValidateId(stopMatch[1], "runId")
    if (!runId) return json({ error: "Invalid runId" }, 400)

    if (!isRunActive(runId)) {
      return json({ error: "Run is not active" }, 404)
    }
    requestStop(runId)
    return json({ message: "Stop requested", runId })
  }

  // DELETE /api/runs/:runId - Delete run
  const deleteMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (method === "DELETE" && deleteMatch) {
    const runId = decodeAndValidateId(deleteMatch[1], "runId")
    if (!runId) return json({ error: "Invalid runId" }, 400)

    if (isRunActive(runId)) {
      return json({ error: "Cannot delete active run" }, 409)
    }
    checkpointManager.delete(runId)
    return json({ message: "Run deleted", runId })
  }

  return null
}

function getRunStatus(checkpoint: any, summary: any): string {
  const runState = getRunState(checkpoint.runId)
  if (runState) {
    return runState.status
  }

  if (checkpoint.status === "completed") {
    return "completed"
  }
  if (checkpoint.status === "failed") {
    return "failed"
  }

  // Check if any question has a failed phase
  const questions = Object.values(checkpoint.questions || {}) as any[]
  const hasFailed = questions.some((q: any) => {
    const phases = q.phases || {}
    return (
      phases.ingest?.status === "failed" ||
      phases.indexing?.status === "failed" ||
      phases.search?.status === "failed" ||
      phases.answer?.status === "failed" ||
      phases.evaluate?.status === "failed"
    )
  })

  if (hasFailed) {
    return "failed"
  }

  if (summary.evaluated === summary.total && summary.total > 0) {
    return "completed"
  }

  // If checkpoint was ever started (status changed from initializing), it's partial
  if (checkpoint.status === "running" || checkpoint.status === "initializing") {
    // Was started but no active process - must have crashed/stopped
    if (summary.ingested > 0 || checkpoint.status === "running") {
      return "partial"
    }
    return "pending"
  }

  if (summary.ingested === 0) {
    return "pending"
  }
  return "partial"
}

async function runBenchmark(options: {
  provider: ProviderName
  benchmark: BenchmarkName
  runId: string
  judgeModel: string
  answeringModel?: string
  limit?: number
  sampling?: SamplingConfig
  concurrency?: ConcurrencyConfig
  force?: boolean
  fromPhase?: PhaseId
}) {
  try {
    wsManager.broadcast({
      type: "run_started",
      runId: options.runId,
      provider: options.provider,
      benchmark: options.benchmark,
    })

    const phases = options.fromPhase ? getPhasesFromPhase(options.fromPhase) : undefined

    await orchestrator.run({
      provider: options.provider,
      benchmark: options.benchmark,
      runId: options.runId,
      judgeModel: options.judgeModel,
      answeringModel: options.answeringModel,
      limit: options.limit,
      sampling: options.sampling,
      concurrency: options.concurrency,
      force: options.force,
      phases,
    })

    wsManager.broadcast({
      type: "run_complete",
      runId: options.runId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    const wasStoppedByUser = message.includes("stopped by user")
    logger.error(`Run ${options.runId} failed: ${error}`)

    // Update checkpoint status to persist the failure/stopped state
    const checkpoint = checkpointManager.load(options.runId)
    if (checkpoint) {
      checkpointManager.updateStatus(checkpoint, "failed")
    }

    wsManager.broadcast({
      type: wasStoppedByUser ? "run_stopped" : "error",
      runId: options.runId,
      message: wasStoppedByUser ? "Run stopped by user" : "Run failed",
    })
  }
}
