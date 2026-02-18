import { handleRunsRoutes } from "./routes/runs"
import { handleBenchmarksRoutes } from "./routes/benchmarks"
import { handleLeaderboardRoutes } from "./routes/leaderboard"
import { handleCompareRoutes } from "./routes/compare"
import { WebSocketManager } from "./websocket"
import { logger } from "../utils/logger"
import { join } from "path"
import { Subprocess } from "bun"
import { timingSafeEqual } from "crypto"

export interface ServerOptions {
  port: number
  open?: boolean
}

let uiProcess: Subprocess | null = null

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
}

const BASE_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"] as const
const PUBLIC_READ_PATHS = new Set([
  "/api/providers",
  "/api/benchmarks",
  "/api/models",
  "/api/downloads",
])
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000
const DEFAULT_RATE_LIMIT_READ_MAX = 300
const DEFAULT_RATE_LIMIT_WRITE_MAX = 60
const DEFAULT_RATE_LIMIT_WS_MAX = 40
const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024

export const wsManager = new WebSocketManager()

export async function startServer(options: ServerOptions): Promise<void> {
  const parseEnvInt = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback
    const parsed = Number.parseInt(value, 10)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback
    return parsed
  }

  const { port, open = true } = options
  const authDisabled = process.env.MEMORYBENCH_DISABLE_AUTH === "true"
  const writeApiKey = process.env.MEMORYBENCH_API_KEY?.trim() || ""
  const readApiKey = process.env.MEMORYBENCH_READ_API_KEY?.trim() || ""
  const requireReadAuth = process.env.MEMORYBENCH_REQUIRE_READ_AUTH === "true"
  const allowQueryApiKey = process.env.MEMORYBENCH_ALLOW_QUERY_API_KEY === "true"
  const rateLimitWindowMs = parseEnvInt(
    process.env.MEMORYBENCH_RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS
  )
  const rateLimitReadMax = parseEnvInt(
    process.env.MEMORYBENCH_RATE_LIMIT_READ_MAX,
    DEFAULT_RATE_LIMIT_READ_MAX
  )
  const rateLimitWriteMax = parseEnvInt(
    process.env.MEMORYBENCH_RATE_LIMIT_WRITE_MAX,
    DEFAULT_RATE_LIMIT_WRITE_MAX
  )
  const rateLimitWsMax = parseEnvInt(
    process.env.MEMORYBENCH_RATE_LIMIT_WS_MAX,
    DEFAULT_RATE_LIMIT_WS_MAX
  )
  const maxJsonBodyBytes = parseEnvInt(
    process.env.MEMORYBENCH_MAX_JSON_BODY_BYTES,
    DEFAULT_MAX_JSON_BODY_BYTES
  )
  const configuredOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  const allowedOrigins = new Set<string>([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...configuredOrigins,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ])

  if (!authDisabled && !writeApiKey) {
    logger.warn(
      "MEMORYBENCH_API_KEY is not set. Mutating API routes will return 503 until configured."
    )
  }
  if (!authDisabled && !readApiKey && requireReadAuth) {
    logger.warn(
      "MEMORYBENCH_REQUIRE_READ_AUTH=true but MEMORYBENCH_READ_API_KEY is not set. Protected read routes will return 503."
    )
  }
  if (allowQueryApiKey) {
    logger.warn(
      "MEMORYBENCH_ALLOW_QUERY_API_KEY=true enables API key transport in URLs. This is less secure than Authorization headers."
    )
  }

  const secureTokenEquals = (candidate: string, expected: string): boolean => {
    if (!candidate || !expected) return false
    const candidateBuf = Buffer.from(candidate)
    const expectedBuf = Buffer.from(expected)
    if (candidateBuf.length !== expectedBuf.length) return false
    return timingSafeEqual(candidateBuf, expectedBuf)
  }

  const isAllowedOrigin = (origin: string | null): boolean => {
    if (!origin) return true
    return allowedOrigins.has(origin)
  }

  const buildResponseHeaders = (origin: string | null): Headers => {
    const headers = new Headers()
    Object.entries(SECURITY_HEADERS).forEach(([key, value]) => {
      headers.set(key, value)
    })
    Object.entries(BASE_CORS_HEADERS).forEach(([key, value]) => {
      headers.set(key, value)
    })
    headers.set("Cache-Control", "no-store")
    if (origin && isAllowedOrigin(origin)) {
      headers.set("Access-Control-Allow-Origin", origin)
      headers.append("Vary", "Origin")
    }
    return headers
  }

  const isProtectedReadPath = (pathname: string): boolean => {
    return pathname === "/ws" || (pathname.startsWith("/api/") && !PUBLIC_READ_PATHS.has(pathname))
  }

  type RateLimitKind = "read" | "write" | "ws"
  type RateLimitBucket = {
    windowStartMs: number
    readCount: number
    writeCount: number
    wsCount: number
  }

  const rateLimitBuckets = new Map<string, RateLimitBucket>()
  let requestCounter = 0

  const getClientIdentity = (req: Request, server: Bun.Server<any>): string => {
    const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    if (forwardedFor) return forwardedFor

    const realIp = req.headers.get("x-real-ip")?.trim()
    if (realIp) return realIp

    try {
      const ip = server.requestIP(req)
      if (ip?.address) return ip.address
    } catch {
      // ignore, fallback below
    }

    return req.headers.get("origin") || "unknown-client"
  }

  const getRateLimitKind = (pathname: string, method: string): RateLimitKind => {
    if (pathname === "/ws") return "ws"
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "read"
    return "write"
  }

  const pruneRateLimitBuckets = (nowMs: number) => {
    if (requestCounter % 50 !== 0) return
    for (const [key, bucket] of rateLimitBuckets.entries()) {
      if (nowMs - bucket.windowStartMs > rateLimitWindowMs * 3) {
        rateLimitBuckets.delete(key)
      }
    }
  }

  const enforceRateLimit = (
    req: Request,
    server: Bun.Server<any>,
    pathname: string,
    method: string
  ): { retryAfterSeconds: number } | null => {
    requestCounter++
    const nowMs = Date.now()
    pruneRateLimitBuckets(nowMs)

    const clientKey = getClientIdentity(req, server)
    const key = `${clientKey}:${pathname}`
    const current = rateLimitBuckets.get(key)
    const bucket: RateLimitBucket =
      current && nowMs - current.windowStartMs < rateLimitWindowMs
        ? current
        : { windowStartMs: nowMs, readCount: 0, writeCount: 0, wsCount: 0 }

    const kind = getRateLimitKind(pathname, method)
    if (kind === "read") bucket.readCount += 1
    if (kind === "write") bucket.writeCount += 1
    if (kind === "ws") bucket.wsCount += 1

    rateLimitBuckets.set(key, bucket)

    const maxForKind =
      kind === "read" ? rateLimitReadMax : kind === "write" ? rateLimitWriteMax : rateLimitWsMax
    const currentCount =
      kind === "read" ? bucket.readCount : kind === "write" ? bucket.writeCount : bucket.wsCount

    if (currentCount > maxForKind) {
      const elapsedMs = nowMs - bucket.windowStartMs
      const retryAfterSeconds = Math.max(1, Math.ceil((rateLimitWindowMs - elapsedMs) / 1000))
      return { retryAfterSeconds }
    }

    return null
  }

  const enforceRequestBodyLimit = (
    req: Request,
    pathname: string
  ): { status: number; message: string } | null => {
    const isMutatingApi =
      pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method)
    if (!isMutatingApi) return null

    const contentLengthHeader = req.headers.get("content-length")
    if (!contentLengthHeader) return null

    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return { status: 400, message: "Invalid content-length header" }
    }
    if (contentLength > maxJsonBodyBytes) {
      return { status: 413, message: "Request body too large" }
    }

    return null
  }

  const authorizeRequest = (req: Request, url: URL): { status: number; message: string } | null => {
    if (authDisabled) return null

    const pathname = url.pathname
    const isMutating =
      pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method)
    const needsReadAuth = isProtectedReadPath(pathname) && (requireReadAuth || !!readApiKey)

    if (!isMutating && !needsReadAuth) return null

    const authHeader = req.headers.get("authorization")
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : ""
    const hasQueryToken = url.searchParams.has("token") || url.searchParams.has("api_key")
    if (hasQueryToken && !allowQueryApiKey) {
      return {
        status: 400,
        message:
          "Query API keys are disabled. Use Authorization: Bearer <token> or enable MEMORYBENCH_ALLOW_QUERY_API_KEY.",
      }
    }
    const queryToken = allowQueryApiKey
      ? url.searchParams.get("token") || url.searchParams.get("api_key") || ""
      : ""
    const token = bearerToken || queryToken

    const hasWriteAccess = writeApiKey ? secureTokenEquals(token, writeApiKey) : false
    const hasReadAccess =
      (readApiKey ? secureTokenEquals(token, readApiKey) : false) || hasWriteAccess

    if (isMutating && !writeApiKey) {
      return {
        status: 503,
        message: "Server auth is not configured. Set MEMORYBENCH_API_KEY.",
      }
    }

    if (needsReadAuth && !readApiKey && requireReadAuth) {
      return {
        status: 503,
        message: "Server read auth is not configured. Set MEMORYBENCH_READ_API_KEY.",
      }
    }

    if (isMutating && !hasWriteAccess) {
      return {
        status: 401,
        message: "Unauthorized",
      }
    }

    if (needsReadAuth && !hasReadAccess) {
      return {
        status: 401,
        message: "Unauthorized",
      }
    }

    return null
  }

  const server = Bun.serve({
    port,

    async fetch(req, server) {
      const url = new URL(req.url)
      const origin = req.headers.get("origin")
      const responseHeaders = buildResponseHeaders(origin)

      if (origin && !isAllowedOrigin(origin)) {
        return new Response(JSON.stringify({ error: "Origin not allowed" }), {
          status: 403,
          headers: responseHeaders,
        })
      }

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: responseHeaders })
      }

      const rateLimitFailure = enforceRateLimit(req, server, url.pathname, req.method)
      if (rateLimitFailure) {
        responseHeaders.set("Retry-After", String(rateLimitFailure.retryAfterSeconds))
        return new Response(JSON.stringify({ error: "Too many requests" }), {
          status: 429,
          headers: responseHeaders,
        })
      }

      const bodyLimitFailure = enforceRequestBodyLimit(req, url.pathname)
      if (bodyLimitFailure) {
        return new Response(JSON.stringify({ error: bodyLimitFailure.message }), {
          status: bodyLimitFailure.status,
          headers: responseHeaders,
        })
      }

      const authFailure = authorizeRequest(req, url)
      if (authFailure) {
        if (authFailure.status === 401) {
          responseHeaders.set("WWW-Authenticate", "Bearer")
        }
        return new Response(JSON.stringify({ error: authFailure.message }), {
          status: authFailure.status,
          headers: responseHeaders,
        })
      }

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req)
        if (upgraded) return undefined
        return new Response("WebSocket upgrade failed", { status: 400, headers: responseHeaders })
      }

      // API routes
      try {
        let response: Response | null = null

        if (url.pathname.startsWith("/api/runs")) {
          response = await handleRunsRoutes(req, url)
        } else if (url.pathname.startsWith("/api/compare")) {
          response = await handleCompareRoutes(req, url)
        } else if (
          url.pathname.startsWith("/api/benchmarks") ||
          url.pathname.startsWith("/api/providers") ||
          url.pathname === "/api/models" ||
          url.pathname === "/api/downloads"
        ) {
          response = await handleBenchmarksRoutes(req, url)
        } else if (url.pathname.startsWith("/api/leaderboard")) {
          response = await handleLeaderboardRoutes(req, url)
        }

        if (response) {
          const headers = new Headers(response.headers)
          responseHeaders.forEach((value, key) => {
            headers.set(key, value)
          })
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        }

        // 404 for unknown routes
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: responseHeaders,
        })
      } catch (error) {
        const requestId = crypto.randomUUID()
        logger.error(
          `[${requestId}] Unhandled server error: ${error instanceof Error ? error.stack || error.message : error}`
        )
        return new Response(JSON.stringify({ error: "Internal server error", requestId }), {
          status: 500,
          headers: responseHeaders,
        })
      }
    },

    websocket: {
      open(ws) {
        wsManager.addClient(ws)
      },
      message(ws, message) {
        wsManager.handleMessage(ws, message)
      },
      close(ws) {
        wsManager.removeClient(ws)
      },
    },
  })

  logger.success(`MemoryBench API server running at http://localhost:${port}`)
  logger.info(`WebSocket available at ws://localhost:${port}/ws`)

  // Start UI dev server (capture output to detect port)
  const uiDir = join(process.cwd(), "ui")

  uiProcess = Bun.spawn(["bun", "run", "dev"], {
    cwd: uiDir,
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: `http://localhost:${port}`,
    },
  })

  // Handle cleanup on exit
  const cleanup = () => {
    if (uiProcess) {
      logger.info("Shutting down UI server...")
      uiProcess.kill()
      uiProcess = null
    }
    process.exit(0)
  }

  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  // Read stdout to detect the actual port Next.js uses
  if (uiProcess.stdout && typeof uiProcess.stdout !== "number") {
    const reader = (uiProcess.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let foundPort = false

    const readOutput = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value)

        // Look for the port in Next.js output (e.g., "Local: http://localhost:3000")
        const portMatch = text.match(/localhost:(\d+)/)
        if (portMatch && !foundPort) {
          foundPort = true
          const uiPort = portMatch[1]
          logger.success(`UI ready at http://localhost:${uiPort}`)

          if (open) {
            const openCommand =
              process.platform === "darwin"
                ? "open"
                : process.platform === "win32"
                  ? "start"
                  : "xdg-open"
            Bun.spawn([openCommand, `http://localhost:${uiPort}`])
          }
        }
      }
    }
    readOutput().catch(() => {})
  }
}
