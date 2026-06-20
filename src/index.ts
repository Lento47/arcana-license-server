import { LicenseKV } from "./kv"
import type { ValidateRequest, ValidateResponse, ActivateRequest, ActivateResponse, LicenseKey } from "./schema"

interface Env {
  ARCANA_LICENSE: KVNamespace
  ARCANA_SIGNING_PRIVATE_KEY?: string
  ARCANA_ADMIN_KEY?: string
  ARCANA_SEED_KEYS?: string
}

const TIERS: Record<string, { features: string[]; seats: number; maxMachines: number; tools: string[]; limits: { toolsPerSession: number; sessionsPerDay: number } }> = {
  free: {
    features: ["basic_models", "local_memory"],
    seats: 5,
    maxMachines: 2,
    tools: ["read", "glob", "grep", "web_search", "web_fetch", "memory_search", "memory_store_fact", "skill_list", "skill_activate", "env_probe", "env_caps", "env_paths", "env_network", "diagnose", "reflect", "loop_detect", "confidence_check", "success_rate", "strategy_log", "goal_set", "goal_check", "kanban"],
    limits: { toolsPerSession: 50, sessionsPerDay: 2 },
  },
  pro: {
    features: ["basic_models", "premium_models", "local_memory", "session_sharing", "gateway", "artifact_tools"],
    seats: 1,
    maxMachines: 3,
    tools: ["read", "glob", "grep", "web_search", "web_fetch", "memory_search", "memory_store_fact", "skill_list", "skill_activate", "env_probe", "env_caps", "env_paths", "env_network", "diagnose", "reflect", "loop_detect", "confidence_check", "success_rate", "strategy_log", "goal_set", "goal_check", "kanban", "write", "edit", "git_status", "git_diff", "git_commit", "git_autocommit", "artifact_save", "artifact_update", "artifact_search", "artifact_get", "code_review", "cost_estimate", "speak", "skill_create", "prompt_propose", "session_summary", "batch"],
    limits: { toolsPerSession: 500, sessionsPerDay: 100 },
  },
  team: {
    features: ["basic_models", "premium_models", "local_memory", "shared_memory", "session_sharing", "gateway", "artifact_tools", "team_vault"],
    seats: 10,
    maxMachines: 20,
    tools: ["read", "glob", "grep", "web_search", "web_fetch", "memory_search", "memory_store_fact", "skill_list", "skill_activate", "env_probe", "env_caps", "env_paths", "env_network", "diagnose", "reflect", "loop_detect", "confidence_check", "success_rate", "strategy_log", "goal_set", "goal_check", "kanban", "write", "edit", "git_status", "git_diff", "git_commit", "git_autocommit", "artifact_save", "artifact_update", "artifact_search", "artifact_get", "code_review", "cost_estimate", "speak", "skill_create", "prompt_propose", "session_summary", "batch", "team_list", "team_share"],
    limits: { toolsPerSession: 2000, sessionsPerDay: 1000 },
  },
  enterprise: {
    features: ["basic_models", "premium_models", "local_memory", "shared_memory", "session_sharing", "gateway", "artifact_tools", "team_vault", "audit_log", "sso", "custom_branding", "sla"],
    seats: 100,
    maxMachines: 100,
    tools: ["read", "glob", "grep", "web_search", "web_fetch", "memory_search", "memory_store_fact", "skill_list", "skill_activate", "env_probe", "env_caps", "env_paths", "env_network", "diagnose", "reflect", "loop_detect", "confidence_check", "success_rate", "strategy_log", "goal_set", "goal_check", "kanban", "write", "edit", "git_status", "git_diff", "git_commit", "git_autocommit", "artifact_save", "artifact_update", "artifact_search", "artifact_get", "code_review", "cost_estimate", "speak", "skill_create", "prompt_propose", "session_summary", "batch", "team_list", "team_share", "admin_audit", "admin_users"],
    limits: { toolsPerSession: 10000, sessionsPerDay: 10000 },
  },
}

// Seed keys loaded from ARCANA_SEED_KEYS env var (JSON: {"key":{"tier":"enterprise","seats":100,"maxMachines":100}})
// Defaults to empty — no hardcoded backdoor.
function loadSeedKeys(env: Env): Record<string, { tier: string; seats: number; maxMachines: number }> {
  try {
    if (env.ARCANA_SEED_KEYS) return JSON.parse(env.ARCANA_SEED_KEYS)
  } catch {}
  return {}
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const kv = new LicenseKV(env.ARCANA_LICENSE)
    const seedKeys = loadSeedKeys(env)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders })
    }

    // Rate limiting check
    if (url.pathname.startsWith("/api/license/validate") || url.pathname.startsWith("/api/license/activate") || url.pathname.startsWith("/api/license/status")) {
      const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown"
      const rateLimitKey = `ratelimit:${clientIp}:${Math.floor(Date.now() / 60000)}`
      const count = parseInt(await env.ARCANA_LICENSE.get(rateLimitKey) ?? "0", 10)
      if (count >= 25) {
        return new Response(JSON.stringify({ error: "rate_limited", message: "Too many requests. 25 per minute max." }), {
          status: 429,
          headers: { "Content-Type": "application/json", ...corsHeaders, "Retry-After": "60" },
        })
      }
      await env.ARCANA_LICENSE.put(rateLimitKey, String(count + 1), { expirationTtl: 120 })
    }

    try {
      switch (url.pathname) {
        case "/api/license/validate":
          return handleValidate(request, kv, corsHeaders, env.ARCANA_SIGNING_PRIVATE_KEY)
        case "/api/license/activate": {
          // Per-key activation rate limit (5/min)
          const body = await request.clone().json() as ActivateRequest
          if (body.licenseKey) {
            const keyLimitKey = `ratelimit:key:${body.licenseKey}:${Math.floor(Date.now() / 60000)}`
            const keyCount = parseInt(await env.ARCANA_LICENSE.get(keyLimitKey) ?? "0", 10)
            if (keyCount >= 5) {
              return new Response(JSON.stringify({ error: "rate_limited", message: "Too many activation attempts. 5 per minute per key." }), {
                status: 429,
                headers: { "Content-Type": "application/json", ...corsHeaders, "Retry-After": "120" },
              })
            }
            await env.ARCANA_LICENSE.put(keyLimitKey, String(keyCount + 1), { expirationTtl: 180 })
          }
          return handleActivate(request, kv, corsHeaders, env.ARCANA_SIGNING_PRIVATE_KEY)
        }
        case "/api/license/status":
          return handleStatus(url, kv, corsHeaders, env.ARCANA_SIGNING_PRIVATE_KEY)
        case "/api/license/create":
          return handleCreate(request, kv, corsHeaders, env.ARCANA_ADMIN_KEY)
        case "/api/license/list":
          return handleList(request, kv, corsHeaders, env.ARCANA_ADMIN_KEY)
        case "/api/license/revoke":
          return handleRevoke(request, kv, corsHeaders, env.ARCANA_ADMIN_KEY)
        case "/api/health":
          return new Response(JSON.stringify({ status: "ok", service: "arcana-license" }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        default:
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          })
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: "internal_error", message: "An unexpected error occurred" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }
  },
}

async function handleValidate(request: Request, kv: LicenseKV, cors: Record<string, string>, signingKey?: string): Promise<Response> {
  const body = await request.json() as ValidateRequest
  if (!body.licenseKey || !body.machineId) {
    return await json({ valid: false, error: "Missing licenseKey or machineId" }, 400, cors, signingKey)
  }

  const seed = seedKeys[body.licenseKey]
  if (seed) {
    const tier = TIERS[seed.tier!]
    return await json({
      valid: true,
      tier: seed.tier,
      features: tier.features,
      tools: tier.tools,
      limits: tier.limits,
      expiresAt: Date.now() + 365 * 86400 * 1000,
      machinesActivated: 1,
      seatsUsed: 1,
    }, 200, cors, signingKey)
  }

  const license = await kv.getLicense(body.licenseKey)
  if (!license) {
    return await json({ valid: false, error: "Invalid license key" }, 401, cors, signingKey)
  }

  if (Date.now() > license.expiresAt) {
    return await json({ valid: false, error: "License expired" }, 402, cors, signingKey)
  }

  const existing = await kv.getMachine(body.machineId)
  if (existing) {
    existing.lastSeen = Date.now()
    await kv.putMachine(existing)
  }

  const machines = await kv.getMachineCount(body.licenseKey)
  const tier = TIERS[license.tier]

  return await json({
    valid: true,
    tier: license.tier,
    features: tier.features,
    tools: tier.tools,
    limits: tier.limits,
    expiresAt: license.expiresAt,
    machinesActivated: machines,
    seatsUsed: machines,
  }, 200, cors, signingKey)
}

async function handleActivate(request: Request, kv: LicenseKV, cors: Record<string, string>, signingKey?: string): Promise<Response> {
  const body = await request.json() as ActivateRequest
  if (!body.licenseKey || !body.machineId) {
    return await json({ valid: false, error: "Missing licenseKey or machineId" }, 400, cors, signingKey)
  }

  const seed = seedKeys[body.licenseKey]
  if (seed) {
    if (body.email || body.username) {
      await kv.putAccount(body.licenseKey, { email: body.email, username: body.username })
    }
    await kv.putMachine({ licenseKey: body.licenseKey, machineId: body.machineId, activatedAt: Date.now(), lastSeen: Date.now() })
    await kv.incrementMachineCount(body.licenseKey, 1)
    const tier = TIERS[seed.tier!]
    return await json({ valid: true, tier: seed.tier, features: tier.features, tools: tier.tools, limits: tier.limits, machinesActivated: 1, maxMachines: seed.maxMachines!, email: body.email, username: body.username }, 200, cors, signingKey)
  }

  const license = await kv.getLicense(body.licenseKey)
  if (!license) {
    return await json({ valid: false, error: "Invalid license key" }, 401, cors, signingKey)
  }

  const machines = await kv.getMachineCount(body.licenseKey)
  if (machines >= license.maxMachines) {
    return await json({ valid: false, error: "Maximum machines activated", machinesActivated: machines, maxMachines: license.maxMachines }, 403, cors, signingKey)
  }

  await kv.putMachine({ licenseKey: body.licenseKey, machineId: body.machineId, activatedAt: Date.now(), lastSeen: Date.now() })
  await kv.incrementMachineCount(body.licenseKey, 1)
  const tier = TIERS[license.tier]

  if (body.email || body.username) {
    await kv.putAccount(body.licenseKey, { email: body.email, username: body.username })
  }

  return await json({
    valid: true,
    tier: license.tier,
    features: tier.features,
    tools: tier.tools,
    limits: tier.limits,
    machinesActivated: machines + 1,
    maxMachines: license.maxMachines,
  }, 200, cors, signingKey)
}

async function handleStatus(url: URL, kv: LicenseKV, cors: Record<string, string>, signingKey?: string): Promise<Response> {
  const key = url.searchParams.get("key")
  if (!key) {
    return await json({ error: "Missing key parameter" }, 400, cors, signingKey)
  }

  const seed = seedKeys[key]
  if (seed) {
    return await json({ tier: seed.tier, expiresAt: null, machinesActivated: 0, maxMachines: seed.maxMachines }, 200, cors, signingKey)
  }

  const license = await kv.getLicense(key)
  if (!license) {
    return await json({ error: "License not found" }, 404, cors, signingKey)
  }

  const machines = await kv.getMachineCount(key)
  return await json({
    tier: license.tier,
    expiresAt: license.expiresAt,
    machinesActivated: machines,
    maxMachines: license.maxMachines,
  }, 200, cors, signingKey)
}

async function handleCreate(request: Request, kv: LicenseKV, cors: Record<string, string>, adminKey: string | undefined): Promise<Response> {
  if (!adminKey) return json({ error: "admin_not_configured" }, 500, cors)

  const auth = request.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${adminKey}`) return json({ error: "unauthorized" }, 401, cors)

  const body = await request.json() as { tier?: string; expiresInDays?: number; seats?: number }
  const tier = body.tier ?? "pro"
  const expiresInDays = body.expiresInDays ?? 365
  const seats = body.seats ?? 1

  if (!["free", "pro", "team", "enterprise"].includes(tier)) {
    return json({ error: "invalid_tier" }, 400, cors)
  }

  const randomBytes = crypto.getRandomValues(new Uint8Array(8))
  const randomPart = btoa(String.fromCharCode(...randomBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 8)
  const key = `ARCANA-${tier.toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${randomPart}`
  const expiresAt = Date.now() + expiresInDays * 86400 * 1000

  await kv.putLicense({
    key,
    tier: tier as any,
    seats,
    maxMachines: tier === "enterprise" ? 100 : tier === "team" ? 20 : 3,
    expiresAt,
    createdAt: Date.now(),
  })

  return json({ valid: true, licenseKey: key, tier, expiresAt }, 200, cors)
}

async function handleList(request: Request, kv: LicenseKV, cors: Record<string, string>, adminKey: string | undefined): Promise<Response> {
  if (!adminKey) return json({ error: "admin_not_configured" }, 500, cors)

  const auth = request.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${adminKey}`) return json({ error: "unauthorized" }, 401, cors)

  const list = await kv.listAll()
  return json({ keys: list }, 200, cors)
}

async function handleRevoke(request: Request, kv: LicenseKV, cors: Record<string, string>, adminKey: string | undefined): Promise<Response> {
  if (!adminKey) return json({ error: "admin_not_configured" }, 500, cors)

  const auth = request.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${adminKey}`) return json({ error: "unauthorized" }, 401, cors)

  const body = await request.json() as any
  if (!body.licenseKey) return json({ error: "missing_licenseKey" }, 400, cors)

  // Delete from KV by overwriting with expired entry
  // Note: Revoking a license does not clean up machine: and machines: entries.
  // Stale machine bindings remain in KV indefinitely.
  // TODO: Add cleanup of machine records on revoke.
  await kv.putLicense({ key: body.licenseKey, tier: "free", seats: 0, maxMachines: 0, expiresAt: 0, createdAt: 0 })
  return json({ success: true, message: `License ${body.licenseKey} revoked` }, 200, cors)
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function pkcs8EncodeEd25519(privateKeyBytes: Uint8Array): Uint8Array {
  // PKCS#8 wrapper for Ed25519 private key
  const prefix = new Uint8Array([0x30, 0x2E, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2B, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
  const result = new Uint8Array(prefix.length + privateKeyBytes.length)
  result.set(prefix)
  result.set(privateKeyBytes, prefix.length)
  return result
}

async function signResponse(data: unknown, privateKeyHex: string): Promise<{ data: unknown; signature: string }> {
  const rawKey = hexToBytes(privateKeyHex)
  const pkcs8Key = pkcs8EncodeEd25519(rawKey)
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Key,
    { name: "Ed25519" },
    false,
    ["sign"],
  )
  const jsonStr = JSON.stringify(data)
  const encoded = new TextEncoder().encode(jsonStr)
  const signature = await crypto.subtle.sign("Ed25519", key, encoded)
  return {
    data,
    signature: bytesToHex(new Uint8Array(signature)),
  }
}

async function json(data: unknown, status: number, cors: Record<string, string>, signingKey?: string): Promise<Response> {
  let body: string
  if (signingKey && status < 400) {
    const signed = await signResponse(data, signingKey)
    body = JSON.stringify(signed)
  } else {
    body = JSON.stringify(data)
  }
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  })
}
