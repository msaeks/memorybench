import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"

const DEFAULT_BASE_URL = "http://127.0.0.1:8888"
const DEFAULT_TOP_K = 30

type HindsightMemory = {
  id?: string
  [key: string]: unknown
}

type HindsightRetainResponse = {
  memory?: HindsightMemory
  [key: string]: unknown
}

type HindsightRecallResponse = {
  memories?: unknown[]
  [key: string]: unknown
}

export class HindsightProvider implements Provider {
  name = "hindsight"
  concurrency = {
    default: 50,
  }

  private baseUrl = DEFAULT_BASE_URL
  private apiKey = ""

  async initialize(config: ProviderConfig): Promise<void> {
    this.baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "")
    this.apiKey = String(config.apiKey || "")
    logger.info(`Initialized Hindsight provider (${this.baseUrl})`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const documentIds: string[] = []

    for (const session of sessions) {
      const memoryText = this.renderSessionAsMemory(session)
      const response = await this.request<HindsightRetainResponse>(
        "POST",
        `/v1/default/banks/${encodeURIComponent(options.containerTag)}/memories`,
        {
          content: memoryText,
          payload: {
            sessionId: session.sessionId,
            ...session.metadata,
            ...options.metadata,
          },
        }
      )

      const memoryId = response?.memory?.id || session.sessionId
      documentIds.push(memoryId)
    }

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const response = await this.request<HindsightRecallResponse>(
      "POST",
      `/v1/default/banks/${encodeURIComponent(options.containerTag)}/memories/recall`,
      {
        query,
        top_k: options.limit ?? DEFAULT_TOP_K,
      }
    )

    if (Array.isArray(response?.memories)) return response.memories
    return []
  }

  async clear(containerTag: string): Promise<void> {
    const bank = encodeURIComponent(containerTag)
    const response = await fetch(`${this.baseUrl}/v1/default/banks/${bank}`, {
      method: "DELETE",
      headers: this.headers(),
    })

    if (!response.ok && response.status !== 404) {
      const body = await response.text()
      throw new Error(`Hindsight clear failed (${response.status}): ${body}`)
    }
  }

  private renderSessionAsMemory(session: UnifiedSession): string {
    const date = (session.metadata?.formattedDate as string) || (session.metadata?.date as string)
    const datePrefix = date ? `[${date}] ` : ""
    const conversation = session.messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n")
    return `${datePrefix}Session ${session.sessionId}\n${conversation}`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (this.apiKey && this.apiKey !== "none") {
      headers.Authorization = `Bearer ${this.apiKey}`
    }
    return headers
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (!response.ok) {
      const raw = await response.text()
      throw new Error(`Hindsight request failed (${response.status}) ${method} ${path}: ${raw}`)
    }

    return (await response.json()) as T
  }
}

export default HindsightProvider
