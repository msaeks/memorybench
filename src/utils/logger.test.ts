import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { logger } from "./logger"

describe("logger", () => {
  const originalWrite = process.stdout.write
  let writeSpy: ReturnType<typeof spyOn>
  let logSpy: ReturnType<typeof spyOn>
  let warnSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {})
    warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    errorSpy = spyOn(console, "error").mockImplementation(() => {})
    writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true)
    logger.setLevel("info")
  })

  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    writeSpy.mockRestore()
    process.stdout.write = originalWrite
  })

  it("respects log levels", () => {
    logger.setLevel("warn")
    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")

    expect(logSpy).toHaveBeenCalledTimes(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("includes metadata in formatted output and supports success/progress", () => {
    logger.setLevel("debug")
    logger.debug("debug message", { a: 1 })
    expect(logSpy).toHaveBeenCalled()
    expect(logSpy.mock.calls[0]?.[0]).toContain("DEBUG")
    expect(logSpy.mock.calls[0]?.[0]).toContain('"a":1')

    logger.success("done")
    expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("done"))).toBe(true)

    logger.progress(1, 4, "working")
    expect(writeSpy).toHaveBeenCalled()
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain("25% working")

    logger.progress(4, 4, "complete")
    expect(logSpy.mock.calls.some((c: unknown[]) => c.length === 0)).toBe(true)
  })
})
