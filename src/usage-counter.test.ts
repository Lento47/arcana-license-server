import { describe, it } from "node:test"
import assert from "node:assert"
import { UsageCounter, type UsageEntry } from "./usage-counter"

class FakeStorage {
  private data = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.has(key) ? (this.data.get(key) as T) : undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value)
  }
}

class FakeState {
  storage = new FakeStorage()
}

function makeCounter() {
  const state = new FakeState() as unknown as DurableObjectState
  return { counter: new UsageCounter(state), storage: state.storage as FakeStorage }
}

async function postTrack(counter: UsageCounter, body: { date: string; tokens: number; calls: number }): Promise<Response> {
  return counter.fetch(new Request("http://usage/track", {
    method: "POST",
    body: JSON.stringify(body),
  }))
}

async function getUsage(counter: UsageCounter, date: string): Promise<UsageEntry> {
  const res = await counter.fetch(new Request(`http://usage/get?date=${encodeURIComponent(date)}`, { method: "GET" }))
  return res.json() as Promise<UsageEntry>
}

describe("UsageCounter", () => {
  it("tracks usage atomically for a single date", async () => {
    const { counter } = makeCounter()
    const res = await postTrack(counter, { date: "2026-06-21", tokens: 100, calls: 5 })
    assert.strictEqual(res.status, 200)
    const usage = await getUsage(counter, "2026-06-21")
    assert.deepStrictEqual(usage, { tokens: 100, calls: 5 })
  })

  it("accumulates multiple track requests for the same date", async () => {
    const { counter } = makeCounter()
    await postTrack(counter, { date: "2026-06-21", tokens: 10, calls: 1 })
    await postTrack(counter, { date: "2026-06-21", tokens: 20, calls: 2 })
    const usage = await getUsage(counter, "2026-06-21")
    assert.deepStrictEqual(usage, { tokens: 30, calls: 3 })
  })

  it("keeps different dates isolated", async () => {
    const { counter } = makeCounter()
    await postTrack(counter, { date: "2026-06-21", tokens: 10, calls: 1 })
    await postTrack(counter, { date: "2026-06-22", tokens: 5, calls: 2 })
    const day1 = await getUsage(counter, "2026-06-21")
    const day2 = await getUsage(counter, "2026-06-22")
    assert.deepStrictEqual(day1, { tokens: 10, calls: 1 })
    assert.deepStrictEqual(day2, { tokens: 5, calls: 2 })
  })

  it("clamps negative token/call values to zero", async () => {
    const { counter } = makeCounter()
    await postTrack(counter, { date: "2026-06-21", tokens: -50, calls: -10 })
    const usage = await getUsage(counter, "2026-06-21")
    assert.deepStrictEqual(usage, { tokens: 0, calls: 0 })
  })

  it("returns zeros for unknown dates", async () => {
    const { counter } = makeCounter()
    const usage = await getUsage(counter, "2026-06-21")
    assert.deepStrictEqual(usage, { tokens: 0, calls: 0 })
  })

  it("rejects invalid track requests", async () => {
    const { counter } = makeCounter()
    const res = await counter.fetch(new Request("http://usage/track", {
      method: "POST",
      body: JSON.stringify({ date: 123, tokens: "x", calls: 1 }),
    }))
    assert.strictEqual(res.status, 400)
  })

  it("rejects wrong methods", async () => {
    const { counter } = makeCounter()
    const trackGet = await counter.fetch(new Request("http://usage/track", { method: "GET" }))
    assert.strictEqual(trackGet.status, 405)
    const getPost = await counter.fetch(new Request("http://usage/get?date=2026-06-21", { method: "POST" }))
    assert.strictEqual(getPost.status, 405)
  })

  it("returns 404 for unknown paths", async () => {
    const { counter } = makeCounter()
    const res = await counter.fetch(new Request("http://usage/unknown"))
    assert.strictEqual(res.status, 404)
  })
})
