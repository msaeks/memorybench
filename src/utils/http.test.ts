import { describe, expect, it } from "bun:test"
import { readJsonBody } from "./http"

describe("http utils", () => {
  it("parses valid json body", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    })

    await expect(readJsonBody(req)).resolves.toEqual({ ok: true })
  })

  it("rejects unsupported content-type", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"ok":true}',
    })

    await expect(readJsonBody(req)).rejects.toEqual(
      expect.objectContaining({
        status: 415,
        message: "Unsupported content type",
      })
    )
  })

  it("rejects invalid and oversized content-length", async () => {
    const invalidLengthReq = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "abc" },
      body: '{"ok":true}',
    })

    await expect(readJsonBody(invalidLengthReq)).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        message: "Invalid content-length header",
      })
    )

    const tooLargeReq = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "99" },
      body: '{"ok":true}',
    })

    await expect(readJsonBody(tooLargeReq, 10)).rejects.toEqual(
      expect.objectContaining({
        status: 413,
        message: "Request body too large",
      })
    )
  })

  it("rejects empty and malformed json body", async () => {
    const emptyReq = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "   ",
    })

    await expect(readJsonBody(emptyReq)).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        message: "Request body is required",
      })
    )

    const malformedReq = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    })

    await expect(readJsonBody(malformedReq)).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        message: "Invalid JSON body",
      })
    )
  })
})
