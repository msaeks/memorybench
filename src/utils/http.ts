export class HttpBodyError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024

export function getMaxJsonBodyBytes(): number {
  const configured = process.env.MEMORYBENCH_MAX_JSON_BODY_BYTES
  if (!configured) return DEFAULT_MAX_JSON_BODY_BYTES

  const parsed = Number.parseInt(configured, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_JSON_BODY_BYTES
  }
  return parsed
}

export async function readJsonBody(
  req: Request,
  maxBytes = getMaxJsonBodyBytes()
): Promise<unknown> {
  const contentType = req.headers.get("content-type")
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new HttpBodyError(415, "Unsupported content type")
  }

  const contentLengthHeader = req.headers.get("content-length")
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new HttpBodyError(400, "Invalid content-length header")
    }
    if (contentLength > maxBytes) {
      throw new HttpBodyError(413, "Request body too large")
    }
  }

  const bodyText = await req.text()
  const bodyBytes = Buffer.byteLength(bodyText, "utf8")
  if (bodyBytes > maxBytes) {
    throw new HttpBodyError(413, "Request body too large")
  }
  if (bodyText.trim().length === 0) {
    throw new HttpBodyError(400, "Request body is required")
  }

  try {
    return JSON.parse(bodyText) as unknown
  } catch {
    throw new HttpBodyError(400, "Invalid JSON body")
  }
}
