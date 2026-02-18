import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { runCommand } from "./run"
import { compareCommand } from "./compare"
import { ingestCommand } from "./ingest"
import { searchCommand } from "./search"
import { statusCommand } from "./status"
import { testQuestionCommand } from "./test-question"
import { listQuestionsCommand } from "./list-questions"
import { logger } from "../../utils/logger"

describe("CLI command handlers", () => {
  let logSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>
  let loggerErrorSpy: ReturnType<typeof spyOn>
  let loggerInfoSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {})
    errorSpy = spyOn(console, "error").mockImplementation(() => {})
    loggerErrorSpy = spyOn(logger, "error").mockImplementation(() => {})
    loggerInfoSpy = spyOn(logger, "info").mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    loggerErrorSpy.mockRestore()
    loggerInfoSpy.mockRestore()
  })

  it("prints usage/help for missing required args", async () => {
    await runCommand([])
    await compareCommand([])
    await ingestCommand([])
    await searchCommand([])
    await statusCommand([])
    await testQuestionCommand([])
    await listQuestionsCommand([])

    expect(logSpy).toHaveBeenCalled()
  })

  it("handles validation failures without invoking full orchestrator flow", async () => {
    const runId = `unit-run-${Date.now()}`

    await runCommand(["-p", "bad-provider", "-b", "locomo", "-r", runId])
    expect(errorSpy).toHaveBeenCalled()

    await compareCommand(["-p", "bad-provider", "-b", "locomo"])
    expect(loggerErrorSpy).toHaveBeenCalled()

    await ingestCommand(["-p", "bad-provider", "-b", "locomo", "-r", runId])
    expect(errorSpy).toHaveBeenCalled()

    await searchCommand(["-r", "nonexistent-run-id"])
    expect(loggerErrorSpy).toHaveBeenCalled()

    await testQuestionCommand(["-r", "nonexistent-run-id", "-q", "q1"])
    expect(loggerErrorSpy).toHaveBeenCalled()

    await listQuestionsCommand(["-b", "not-a-benchmark"])
    expect(errorSpy).toHaveBeenCalled()
  })
})
