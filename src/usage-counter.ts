// UsageCounter Durable Object
//
// KV does not support atomic read-modify-write, so concurrent usage updates can
// lose increments. This Durable Object provides strictly atomic per-tenant,
// per-date token/call counters. Requests to a single Durable Object instance are
// processed sequentially, making get-then-put updates safe without explicit
// transactions.


export interface UsageTrackRequest {
  date: string
  tokens: number
  calls: number
}

export interface UsageEntry {
  tokens: number
  calls: number
}

export class UsageCounter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    try {
      switch (url.pathname) {
        case "/track": {
          if (request.method !== "POST") {
            return this.json({ error: "method_not_allowed" }, 405, { Allow: "POST" })
          }
          const body = (await request.json()) as UsageTrackRequest
          if (!this.isValidTrackRequest(body)) {
            return this.json({ error: "bad_request", message: "Invalid track request" }, 400)
          }
          await this.track(body.date, Math.max(0, body.tokens), Math.max(0, body.calls))
          return this.json({ success: true }, 200)
        }
        case "/get": {
          if (request.method !== "GET") {
            return this.json({ error: "method_not_allowed" }, 405, { Allow: "GET" })
          }
          const date = url.searchParams.get("date")
          if (!date) {
            return this.json({ error: "bad_request", message: "Missing date query parameter" }, 400)
          }
          const entry = await this.get(date)
          return this.json(entry, 200)
        }
        default:
          return this.json({ error: "not_found" }, 404)
      }
    } catch (e) {
      console.error("UsageCounter error:", e)
      return this.json({ error: "internal_error" }, 500)
    }
  }

  private async track(date: string, tokens: number, calls: number): Promise<void> {
    // Sequential execution within a Durable Object makes this read-modify-write
    // atomic relative to other requests for the same tenant.
    const current = await this.state.storage.get<UsageEntry>(date)
    const next: UsageEntry = {
      tokens: (current?.tokens ?? 0) + tokens,
      calls: (current?.calls ?? 0) + calls,
    }
    await this.state.storage.put(date, next)
  }

  private async get(date: string): Promise<UsageEntry> {
    return (await this.state.storage.get<UsageEntry>(date)) ?? { tokens: 0, calls: 0 }
  }

  private isValidTrackRequest(body: unknown): body is UsageTrackRequest {
    if (!body || typeof body !== "object") return false
    const b = body as Partial<UsageTrackRequest>
    return (
      typeof b.date === "string" &&
      b.date.length > 0 &&
      typeof b.tokens === "number" &&
      Number.isFinite(b.tokens) &&
      typeof b.calls === "number" &&
      Number.isFinite(b.calls)
    )
  }

  private json(data: unknown, status: number, extraHeaders?: Record<string, string>): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...extraHeaders },
    })
  }
}
