import { eq, desc, and } from "drizzle-orm"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { db, schema } from "../db"
import { CheckpointManager } from "../../orchestrator/checkpoint"
import { createBenchmark } from "../../benchmarks"
import type { BenchmarkName } from "../../types/benchmark"
import { isSafeId } from "../../utils/security"
import { z } from "zod"
import { logger } from "../../utils/logger"
import { HttpBodyError, readJsonBody } from "../../utils/http"

const checkpointManager = new CheckpointManager()

const benchmarkRegistryCache: Record<string, any> = {}
const addLeaderboardRequestSchema = z
  .object({
    runId: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => isSafeId(value), {
        message: "runId must contain only letters, numbers, _ or -",
      }),
    notes: z.string().max(2000).optional(),
    version: z.string().trim().min(1).max(64).optional(),
  })
  .strict()

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

function parseEntryId(rawValue: string): number | null {
  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

export async function handleLeaderboardRoutes(req: Request, url: URL): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname

  // GET /api/leaderboard - List all leaderboard entries
  if (method === "GET" && pathname === "/api/leaderboard") {
    try {
      const entries = db
        .select()
        .from(schema.leaderboardEntries)
        .orderBy(desc(schema.leaderboardEntries.accuracy))
        .all()

      // Parse JSON fields with error handling
      const parsed = entries.map((entry) => {
        let byQuestionType = {}
        let latencyStats = null
        let evaluations: unknown[] = []
        let promptsUsed = null

        try {
          byQuestionType = JSON.parse(entry.byQuestionType)
        } catch {
          /* ignore */
        }
        try {
          latencyStats = entry.latencyStats ? JSON.parse(entry.latencyStats) : null
        } catch {
          /* ignore */
        }
        try {
          evaluations = entry.evaluations ? JSON.parse(entry.evaluations) : []
        } catch {
          /* ignore */
        }
        try {
          promptsUsed = entry.promptsUsed ? JSON.parse(entry.promptsUsed) : null
        } catch {
          /* ignore */
        }

        return {
          ...entry,
          byQuestionType,
          questionTypeRegistry: getQuestionTypeRegistry(entry.benchmark),
          latencyStats,
          evaluations,
          promptsUsed,
        }
      })

      return json({ entries: parsed })
    } catch (e) {
      logger.error(`Failed to load leaderboard entries: ${e}`)
      return json({ error: "Failed to load leaderboard" }, 500)
    }
  }

  // POST /api/leaderboard - Add run to leaderboard
  if (method === "POST" && pathname === "/api/leaderboard") {
    try {
      const parsed = addLeaderboardRequestSchema.safeParse(await readJsonBody(req))
      if (!parsed.success) {
        return json({ error: "Invalid request body" }, 400)
      }
      const { runId, notes, version } = parsed.data

      // Use provided version or default to "baseline"
      const entryVersion = version?.trim() || "baseline"

      // Load checkpoint
      const checkpoint = checkpointManager.load(runId)
      if (!checkpoint) {
        return json({ error: `Run not found: ${runId}` }, 404)
      }

      // Check if run is completed
      const summary = checkpointManager.getSummary(checkpoint)
      if (summary.evaluated !== summary.total) {
        return json({ error: "Run must be fully evaluated before adding to leaderboard" }, 400)
      }

      // Check if entry with same provider+benchmark+version exists (for upsert)
      const existing = db
        .select()
        .from(schema.leaderboardEntries)
        .where(
          and(
            eq(schema.leaderboardEntries.provider, checkpoint.provider),
            eq(schema.leaderboardEntries.benchmark, checkpoint.benchmark),
            eq(schema.leaderboardEntries.version, entryVersion)
          )
        )
        .get()

      // Load report for accuracy stats
      const reportPath = join(checkpointManager.getRunPath(runId), "report.json")
      let report: any = null
      if (existsSync(reportPath)) {
        report = JSON.parse(readFileSync(reportPath, "utf8"))
      }

      // Calculate accuracy from checkpoint if no report
      const questions = Object.values(checkpoint.questions)
      const correctCount = questions.filter((q: any) => q.phases?.evaluate?.score === 1).length
      const accuracy = report?.summary?.accuracy ?? correctCount / summary.total

      // Get provider code
      const providerCode = getProviderCode(checkpoint.provider)

      // Get prompts (if available in provider)
      const promptsUsed = getProviderPrompts(checkpoint.provider)

      // Build by question type stats
      const byQuestionType: Record<string, { total: number; correct: number; accuracy: number }> =
        {}
      for (const q of questions) {
        const qData = q as any
        const type = qData.questionType || "unknown"
        if (!byQuestionType[type]) {
          byQuestionType[type] = { total: 0, correct: 0, accuracy: 0 }
        }
        byQuestionType[type].total++
        if (qData.phases?.evaluate?.score === 1) {
          byQuestionType[type].correct++
        }
      }
      for (const type of Object.keys(byQuestionType)) {
        byQuestionType[type].accuracy = byQuestionType[type].correct / byQuestionType[type].total
      }

      // Build evaluations from checkpoint if no report
      let evaluations = report?.evaluations || []
      if (!report?.evaluations) {
        evaluations = questions.map((q: any) => ({
          questionId: q.questionId,
          questionType: q.questionType,
          question: q.question,
          groundTruth: q.groundTruth,
          hypothesis: q.phases?.answer?.hypothesis || "",
          score: q.phases?.evaluate?.score || 0,
          label: q.phases?.evaluate?.label || "incorrect",
          explanation: q.phases?.evaluate?.explanation || "",
          searchResults: q.phases?.search?.results || [],
        }))
      }

      const entryData = {
        runId,
        provider: checkpoint.provider,
        benchmark: checkpoint.benchmark,
        version: entryVersion,
        accuracy,
        totalQuestions: summary.total,
        correctCount,
        byQuestionType: JSON.stringify(byQuestionType),
        latencyStats: report?.latency ? JSON.stringify(report.latency) : null,
        evaluations: JSON.stringify(evaluations),
        providerCode,
        promptsUsed: promptsUsed ? JSON.stringify(promptsUsed) : null,
        judgeModel: checkpoint.judge,
        answeringModel: checkpoint.answeringModel,
        addedAt: new Date().toISOString(),
        notes: notes || null,
      }

      let entry
      let isUpdate = false

      if (existing) {
        // Update existing entry (upsert)
        entry = db
          .update(schema.leaderboardEntries)
          .set(entryData)
          .where(eq(schema.leaderboardEntries.id, existing.id))
          .returning()
          .get()
        isUpdate = true
      } else {
        // Insert new entry
        entry = db.insert(schema.leaderboardEntries).values(entryData).returning().get()
      }

      return json({
        message: isUpdate ? "Updated leaderboard entry" : "Added to leaderboard",
        entry: {
          ...entry,
          byQuestionType,
          latencyStats: report?.latency || null,
        },
      })
    } catch (e) {
      if (e instanceof HttpBodyError) {
        return json({ error: e.message }, e.status)
      }
      logger.error(`Failed to add leaderboard entry: ${e}`)
      return json({ error: "Failed to add to leaderboard" }, 500)
    }
  }

  // DELETE /api/leaderboard/:id - Remove from leaderboard
  const deleteMatch = pathname.match(/^\/api\/leaderboard\/(\d+)$/)
  if (method === "DELETE" && deleteMatch) {
    try {
      const id = parseEntryId(deleteMatch[1])
      if (id === null) {
        return json({ error: "Invalid leaderboard entry id" }, 400)
      }

      const entry = db
        .select()
        .from(schema.leaderboardEntries)
        .where(eq(schema.leaderboardEntries.id, id))
        .get()

      if (!entry) {
        return json({ error: "Entry not found" }, 404)
      }

      db.delete(schema.leaderboardEntries).where(eq(schema.leaderboardEntries.id, id)).run()

      return json({ message: "Removed from leaderboard", id })
    } catch (e) {
      logger.error(`Failed to remove leaderboard entry: ${e}`)
      return json({ error: "Failed to remove from leaderboard" }, 500)
    }
  }

  // GET /api/leaderboard/:id - Get single entry with full details
  const getMatch = pathname.match(/^\/api\/leaderboard\/(\d+)$/)
  if (method === "GET" && getMatch) {
    try {
      const id = parseEntryId(getMatch[1])
      if (id === null) {
        return json({ error: "Invalid leaderboard entry id" }, 400)
      }

      const entry = db
        .select()
        .from(schema.leaderboardEntries)
        .where(eq(schema.leaderboardEntries.id, id))
        .get()

      if (!entry) {
        return json({ error: "Entry not found" }, 404)
      }

      let evaluations = []
      let promptsUsed = null
      let latencyStats = null
      let byQuestionType = {}

      try {
        byQuestionType = JSON.parse(entry.byQuestionType)
      } catch {
        byQuestionType = {}
      }

      try {
        latencyStats = entry.latencyStats ? JSON.parse(entry.latencyStats) : null
      } catch {
        latencyStats = null
      }

      try {
        evaluations = entry.evaluations ? JSON.parse(entry.evaluations) : []
      } catch {
        evaluations = []
      }

      try {
        promptsUsed = entry.promptsUsed ? JSON.parse(entry.promptsUsed) : null
      } catch {
        promptsUsed = null
      }

      return json({
        ...entry,
        byQuestionType,
        questionTypeRegistry: getQuestionTypeRegistry(entry.benchmark),
        latencyStats,
        evaluations,
        promptsUsed,
      })
    } catch (e) {
      logger.error(`Failed to get leaderboard entry: ${e}`)
      return json({ error: "Failed to get entry" }, 500)
    }
  }

  return null
}

function getProviderCode(provider: string): string {
  if (!isSafeId(provider)) {
    return "// Provider code unavailable for invalid provider id"
  }

  const providerDir = join(process.cwd(), "src", "providers", provider)
  const indexPath = join(providerDir, "index.ts")
  const promptPath = join(providerDir, "prompt.ts")
  const promptsPath = join(providerDir, "prompts.ts")

  const files: Record<string, string> = {}

  // Read index.ts
  if (existsSync(indexPath)) {
    files["index.ts"] = readFileSync(indexPath, "utf8")
  }

  // Read prompt.ts if exists
  if (existsSync(promptPath)) {
    files["prompt.ts"] = readFileSync(promptPath, "utf8")
  }

  // Read prompts.ts if exists
  if (existsSync(promptsPath)) {
    files["prompts.ts"] = readFileSync(promptsPath, "utf8")
  }

  if (Object.keys(files).length === 0) {
    return `// Provider code not found at ${providerDir}`
  }

  // Return as JSON with all files
  return JSON.stringify(files)
}

function getProviderPrompts(provider: string): Record<string, string> | null {
  if (!isSafeId(provider)) {
    return null
  }

  const providerDir = join(process.cwd(), "src", "providers", provider)
  const prompts: Record<string, string> = {}

  // Check for dedicated prompt files
  const promptFiles = ["prompt.ts", "prompts.ts"]
  for (const file of promptFiles) {
    const filePath = join(providerDir, file)
    if (existsSync(filePath)) {
      prompts[file] = readFileSync(filePath, "utf8")
    }
  }

  // Also extract inline prompts from index.ts
  const indexPath = join(providerDir, "index.ts")
  if (existsSync(indexPath)) {
    const code = readFileSync(indexPath, "utf8")

    // Match template literal prompts
    const promptMatches = code.matchAll(
      /(?:prompt|PROMPT|systemPrompt|userPrompt)\s*[=:]\s*[`"']([^`"']+)[`"']/g
    )
    for (const match of promptMatches) {
      const key = match[0].split(/[=:]/)[0].trim()
      prompts[`inline:${key}`] = match[1]
    }
  }

  return Object.keys(prompts).length > 0 ? prompts : null
}
