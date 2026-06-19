import { LicenseKV } from "./kv"
import type { ValidateRequest, ValidateResponse, ActivateRequest, ActivateResponse, LicenseKey } from "./schema"

interface Env {
  ARCANA_LICENSE: KVNamespace
  ARCANA_LICENSE_SIGNING_KEY?: string
}

const TIERS: Record<string, { features: string[]; seats: number; maxMachines: number }> = {
  free: { features: ["basic_models", "local_memory"], seats: 1, maxMachines: 2 },
  pro: { features: ["basic_models", "premium_models", "local_memory", "session_sharing", "gateway"], seats: 1, maxMachines: 3 },
  team: { features: ["basic_models", "premium_models", "local_memory", "shared_memory", "session_sharing", "gateway", "team_vault"], seats: 10, maxMachines: 20 },
  enterprise: { features: ["basic_models", "premium_models", "local_memory", "shared_memory", "session_sharing", "gateway", "team_vault", "audit_log", "sso", "custom_branding", "sla"], seats: 100, maxMachines: 100 },
}

const SEED_KEYS: Record<string, Partial<LicenseKey>> = {
  "ARCANA-DEV-0000-0000-0000-000000000001": { tier: "enterprise", seats: 100, maxMachines: 100 },
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const kv = new LicenseKV(env.ARCANA_LICENSE)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders })
    }

    try {
      switch (url.pathname) {
        case "/api/license/validate":
          return handleValidate(request, kv, corsHeaders)
        case "/api/license/activate":
          return handleActivate(request, kv, corsHeaders)
        case "/api/license/status":
          return handleStatus(url, kv, corsHeaders)
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
      return new Response(JSON.stringify({ error: "internal_error", message: String(e) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }
  },
}

async function handleValidate(request: Request, kv: LicenseKV, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as ValidateRequest
  if (!body.licenseKey || !body.machineId) {
    return json({ valid: false, error: "Missing licenseKey or machineId" }, 400, cors)
  }

  // Check seed/dev keys first
  const seed = SEED_KEYS[body.licenseKey]
  if (seed) {
    const tier = TIERS[seed.tier!]
    return json({
      valid: true,
      tier: seed.tier,
      features: tier.features,
      expiresAt: Date.now() + 365 * 86400 * 1000,
      machinesActivated: 1,
      seatsUsed: 1,
    }, 200, cors)
  }

  const license = await kv.getLicense(body.licenseKey)
  if (!license) {
    return json({ valid: false, error: "Invalid license key" }, 401, cors)
  }

  if (Date.now() > license.expiresAt) {
    return json({ valid: false, error: "License expired" }, 402, cors)
  }

  // Update machine last seen
  const existing = await kv.getMachine(body.machineId)
  if (existing) {
    existing.lastSeen = Date.now()
    await kv.putMachine(existing)
  }

  const machines = await kv.countMachines(body.licenseKey)
  const tier = TIERS[license.tier]

  return json({
    valid: true,
    tier: license.tier,
    features: tier.features,
    expiresAt: license.expiresAt,
    machinesActivated: machines,
    seatsUsed: machines,
  }, 200, cors)
}

async function handleActivate(request: Request, kv: LicenseKV, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as ActivateRequest
  if (!body.licenseKey || !body.machineId) {
    return json({ valid: false, error: "Missing licenseKey or machineId" }, 400, cors)
  }

  // Check seed keys
  const seed = SEED_KEYS[body.licenseKey]
  if (seed) {
    await kv.putMachine({ licenseKey: body.licenseKey, machineId: body.machineId, activatedAt: Date.now(), lastSeen: Date.now() })
    const tier = TIERS[seed.tier!]
    return json({ valid: true, tier: seed.tier, features: tier.features, machinesActivated: 1, maxMachines: seed.maxMachines! }, 200, cors)
  }

  const license = await kv.getLicense(body.licenseKey)
  if (!license) {
    return json({ valid: false, error: "Invalid license key" }, 401, cors)
  }

  const machines = await kv.countMachines(body.licenseKey)
  if (machines >= license.maxMachines) {
    return json({ valid: false, error: "Maximum machines activated", machinesActivated: machines, maxMachines: license.maxMachines }, 403, cors)
  }

  await kv.putMachine({ licenseKey: body.licenseKey, machineId: body.machineId, activatedAt: Date.now(), lastSeen: Date.now() })
  const tier = TIERS[license.tier]

  return json({
    valid: true,
    tier: license.tier,
    features: tier.features,
    machinesActivated: machines + 1,
    maxMachines: license.maxMachines,
  }, 200, cors)
}

async function handleStatus(url: URL, kv: LicenseKV, cors: Record<string, string>): Promise<Response> {
  const key = url.searchParams.get("key")
  if (!key) {
    return json({ error: "Missing key parameter" }, 400, cors)
  }

  const seed = SEED_KEYS[key]
  if (seed) {
    return json({ tier: seed.tier, expiresAt: null, machinesActivated: 0, maxMachines: seed.maxMachines }, 200, cors)
  }

  const license = await kv.getLicense(key)
  if (!license) {
    return json({ error: "License not found" }, 404, cors)
  }

  const machines = await kv.countMachines(key)
  return json({
    tier: license.tier,
    expiresAt: license.expiresAt,
    machinesActivated: machines,
    maxMachines: license.maxMachines,
  }, 200, cors)
}

function json(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  })
}
