import { LicenseKV } from "./kv"
import type {
  ValidateRequest,
  ActivateRequest,
  LicenseKey,
  OAuthBindRequest,
  OAuthBindResponse,
} from "./schema"

interface Env {
  ARCANA_LICENSE: KVNamespace
  ARCANA_SIGNING_PRIVATE_KEY?: string
  ARCANA_ADMIN_KEY?: string
  ARCANA_ADMIN_ORIGIN?: string
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

type SeedKeys = Record<string, { tier: string; seats?: number; maxMachines?: number; expiresAt: number }>

type ResolvedLicense =
  | { kind: "seed"; seed: SeedKeys[string]; expiresAt: number }
  | { kind: "stored"; license: LicenseKey; expiresAt: number }

// Seed keys loaded from ARCANA_SEED_KEYS env var (JSON: {"key":{"tier":"enterprise","seats":100,"maxMachines":100}})
// Defaults to empty — no hardcoded backdoor.
//
// Note: seed key expiresAt is resolved once when the worker starts and stays fixed
// until the process restarts. If you need to shorten or rotate seed expiry,
// redeploy or restart the worker.
export function isKnownTier(tier: unknown): tier is LicenseKey["tier"] {
  return typeof tier === "string" && ["free", "pro", "team", "enterprise"].includes(tier)
}

export function isValidStoredLicense(value: unknown): value is LicenseKey {
  if (!value || typeof value !== "object") return false
  const l = value as Partial<LicenseKey>
  return (
    isNonEmptyString(l.key) &&
    isKnownTier(l.tier) &&
    Array.isArray(l.features) && l.features.every((f) => typeof f === "string") &&
    typeof l.seats === "number" && Number.isFinite(l.seats) && l.seats >= 0 &&
    typeof l.maxMachines === "number" && Number.isFinite(l.maxMachines) && l.maxMachines >= 0 &&
    typeof l.expiresAt === "number" && Number.isFinite(l.expiresAt) &&
    typeof l.createdAt === "number" && Number.isFinite(l.createdAt)
  )
}

function loadSeedKeys(env: Env): SeedKeys {
  try {
    if (env.ARCANA_SEED_KEYS) {
      const parsed = JSON.parse(env.ARCANA_SEED_KEYS) as Record<string, unknown>
      const valid: SeedKeys = {}
      for (const [key, entry] of Object.entries(parsed)) {
        if (
          entry && typeof entry === "object" &&
          isKnownTier((entry as { tier?: string }).tier)
        ) {
          const e = entry as { tier: string; seats?: number; maxMachines?: number; expiresAt?: number }
          const tier = e.tier
          valid[key] = {
            tier,
            seats: typeof e.seats === "number" && Number.isFinite(e.seats) ? e.seats : tierInfo(tier).seats,
            maxMachines: typeof e.maxMachines === "number" && Number.isFinite(e.maxMachines) ? e.maxMachines : tierInfo(tier).maxMachines,
            expiresAt: typeof e.expiresAt === "number" && Number.isFinite(e.expiresAt) && e.expiresAt > Date.now()
              ? e.expiresAt
              : Date.now() + 365 * 86400 * 1000,
          }
        }
      }
      return valid
    }
  } catch {}
  return {}
}

async function resolveLicense(
  licenseKey: string,
  kv: LicenseKV,
  seedKeys: SeedKeys,
): Promise<ResolvedLicense | null> {
  const seed = seedKeys[licenseKey]
  if (seed) return { kind: "seed", seed, expiresAt: seed.expiresAt }
  const raw = await kv.getLicense(licenseKey)
  if (raw && isValidStoredLicense(raw)) return { kind: "stored", license: raw, expiresAt: raw.expiresAt }
  return null
}

function tierInfo(tierName: string) {
  return TIERS[tierName] ?? TIERS.free
}

function maxMachinesFor(resolved: ResolvedLicense): number {
  if (resolved.kind === "seed") {
    return resolved.seed.maxMachines ?? tierInfo(resolved.seed.tier).maxMachines
  }
  return resolved.license.maxMachines
}

function seatsFor(resolved: ResolvedLicense): number {
  if (resolved.kind === "seed") {
    return resolved.seed.seats ?? tierInfo(resolved.seed.tier).seats
  }
  return resolved.license.seats
}

export function safeParseInt(value: string | null | undefined, fallback = 0): number {
  const parsed = parseInt(value ?? "", 10)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

function isNonEmptyString(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
}

function isOptionalString(value: unknown, maxLength = 256): value is string | undefined {
  return value === undefined || value === null || (typeof value === "string" && value.length <= maxLength)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(value: string): boolean {
  return value.length <= 256 && EMAIL_RE.test(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
}

function machineTtl(expiresAt: number): number {
  return Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000))
}

function storedMachineTtl(resolved: ResolvedLicense): number | undefined {
  return resolved.kind === "stored" ? machineTtl(resolved.license.expiresAt) : machineTtl(resolved.expiresAt)
}

const MAX_EXPIRES_IN_DAYS = 365 * 10 // 10 years

function validateCreateBody(body: { tier?: string; expiresInDays?: number; seats?: number }): { error?: string } {
  if (body.expiresInDays !== undefined && !isPositiveInteger(body.expiresInDays)) {
    return { error: "expiresInDays must be a positive integer" }
  }
  if (body.expiresInDays !== undefined && body.expiresInDays > MAX_EXPIRES_IN_DAYS) {
    return { error: `expiresInDays must be at most ${MAX_EXPIRES_IN_DAYS}` }
  }
  if (body.seats !== undefined && !isPositiveInteger(body.seats)) {
    return { error: "seats must be a positive integer" }
  }
  return {}
}

function validateActivateBody(body: ActivateRequest): { error?: string } {
  if (!isNonEmptyString(body.licenseKey, 256)) return { error: "licenseKey must be a non-empty string up to 256 characters" }
  if (!isNonEmptyString(body.machineId, 256)) return { error: "machineId must be a non-empty string up to 256 characters" }
  if (body.email !== undefined && body.email !== null && !isValidEmail(body.email)) return { error: "email must be a valid email address up to 256 characters" }
  if (!isOptionalString(body.username, 128)) return { error: "username must be a string up to 128 characters when provided" }
  return {}
}

function validateValidateBody(body: ValidateRequest): { error?: string } {
  if (!isNonEmptyString(body.licenseKey, 256)) return { error: "licenseKey must be a non-empty string up to 256 characters" }
  if (!isNonEmptyString(body.machineId, 256)) return { error: "machineId must be a non-empty string up to 256 characters" }
  if (body.version !== undefined && !isNonEmptyString(body.version, 64)) return { error: "version must be a non-empty string up to 64 characters when provided" }
  return {}
}

const worker = {
  // Keep-warm cron — pings validate with a no-op to prevent cold starts.
  // Without this, the infrequently-called validate endpoint cold-starts at
  // 2-5 seconds on the free tier, causing proxy auth timeouts.
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // No-op — the invocation itself keeps the isolate warm.
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!env.ARCANA_LICENSE) {
      return new Response(JSON.stringify({ error: "service_unavailable", message: "KV namespace not bound" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    }
    const kv = new LicenseKV(env.ARCANA_LICENSE)
    const seedKeys = loadSeedKeys(env)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }
    const adminCors = buildAdminCors(env.ARCANA_ADMIN_ORIGIN)

    if (request.method === "OPTIONS") {
      const isAdminPath = url.pathname === "/api/license/create" ||
        url.pathname === "/api/license/list" ||
        url.pathname === "/api/license/revoke" ||
        url.pathname === "/api/__smoke"
      return new Response(null, { headers: isAdminPath ? adminCors : corsHeaders })
    }

    // Rate limiting check
    if (
      url.pathname.startsWith("/api/license/validate") ||
      url.pathname.startsWith("/api/license/activate") ||
      url.pathname.startsWith("/api/license/status") ||
      url.pathname.startsWith("/api/oauth/bind") ||
      url.pathname === "/api/__smoke"
    ) {
      const rawClientIp = request.headers.get("cf-connecting-ip")
      const clientIp = isNonEmptyString(rawClientIp, 45) ? rawClientIp : "unknown"
      const rateLimitKey = `ratelimit:${clientIp}:${Math.floor(Date.now() / 60000)}`
      const count = safeParseInt(await env.ARCANA_LICENSE.get(rateLimitKey), 0)
      // Raised for agentic/dev (was 25/min)
      if (count >= 250) {
        return new Response(JSON.stringify({ error: "rate_limited", message: "Too many requests. 250 per minute max." }), {
          status: 429,
          headers: { "Content-Type": "application/json", ...corsHeaders, "Retry-After": "60" },
        })
      }
      await env.ARCANA_LICENSE.put(rateLimitKey, String(count + 1), { expirationTtl: 120 })
    }

    try {
      switch (url.pathname) {
        case "/api/license/validate":
          if (request.method !== "POST") return methodNotAllowed(corsHeaders)
          return await handleValidate(request, kv, corsHeaders, seedKeys, env.ARCANA_SIGNING_PRIVATE_KEY)
        case "/api/license/activate": {
          if (request.method !== "POST") return methodNotAllowed(corsHeaders)
          // Per-key activation rate limit (raised for agentic/dev; was 5/min)
          const body = await parseJson<ActivateRequest>(request.clone(), corsHeaders)
          if (body instanceof Response) return body
          if (isNonEmptyString(body.licenseKey)) {
            const keyLimitKey = `ratelimit:key:${body.licenseKey}:${Math.floor(Date.now() / 60000)}`
            const keyCount = safeParseInt(await env.ARCANA_LICENSE.get(keyLimitKey), 0)
            if (keyCount >= 50) {
              return new Response(JSON.stringify({ error: "rate_limited", message: "Too many activation attempts. 50 per minute per key." }), {
                status: 429,
                headers: { "Content-Type": "application/json", ...corsHeaders, "Retry-After": "120" },
              })
            }
            await env.ARCANA_LICENSE.put(keyLimitKey, String(keyCount + 1), { expirationTtl: 180 })
          }
          return await handleActivate(request, kv, corsHeaders, seedKeys, env.ARCANA_SIGNING_PRIVATE_KEY)
        }
        case "/api/license/status":
          if (request.method !== "GET") return methodNotAllowed(corsHeaders)
          return await handleStatus(url, kv, corsHeaders, seedKeys, env.ARCANA_SIGNING_PRIVATE_KEY)
        case "/api/oauth/bind":
          if (request.method !== "POST") return methodNotAllowed(corsHeaders)
          return await handleOAuthBind(request, kv, corsHeaders, env.ARCANA_SIGNING_PRIVATE_KEY)
        case "/api/license/create":
          if (request.method !== "POST") return methodNotAllowed(adminCors)
          return await handleCreate(request, kv, adminCors, env.ARCANA_ADMIN_KEY)
        case "/api/license/list":
          if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed(adminCors)
          return await handleList(request, kv, adminCors, env.ARCANA_ADMIN_KEY)
        case "/api/license/revoke":
          if (request.method !== "POST") return methodNotAllowed(adminCors)
          return await handleRevoke(request, kv, adminCors, env.ARCANA_ADMIN_KEY)
        case "/api/health":
          if (request.method !== "GET") return methodNotAllowed(corsHeaders)
          return new Response(JSON.stringify({ status: "ok", service: "arcana-license" }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        case "/api/__smoke":
          if (request.method !== "POST" || !env.ARCANA_ADMIN_KEY) return methodNotAllowed(adminCors)
          return await runSmokeTests(env, adminCors)
        default:
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          })
      }
    } catch (e) {
      console.error("Unhandled error:", e)
      return new Response(JSON.stringify({ error: "internal_error", message: "An unexpected error occurred" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }
  },
}

export default worker

async function parseJson<T>(request: Request, cors: Record<string, string>): Promise<T | Response> {
  try {
    return await request.json() as T
  } catch {
    return json({ error: "bad_request", message: "Invalid JSON body" }, 400, cors)
  }
}

function methodNotAllowed(cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", ...cors, "Allow": "GET, POST, OPTIONS" },
  })
}

export function buildAdminCors(origin: string | undefined): Record<string, string> {
  const base = { "Content-Type": "application/json" }
  if (!origin) return base
  return {
    ...base,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  }
}

// In-worker smoke test endpoint. Only available when ARCANA_ADMIN_KEY is configured.
// Calls handler functions directly to avoid double-counting against rate limits.
async function runSmokeTests(env: Env, cors: Record<string, string>): Promise<Response> {
  const kv = new LicenseKV(env.ARCANA_LICENSE)
  const seedKeys = loadSeedKeys(env)
  const testMachineId = `smoke-${crypto.randomUUID()}`
  const adminHeaders = { "Authorization": `Bearer ${env.ARCANA_ADMIN_KEY}`, "Content-Type": "application/json" }
  const failures: string[] = []
  let key: string | undefined

  async function parseRes(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  try {
    // 1. Create a pro license
    const createReq = new Request("http://localhost/api/license/create", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ tier: "pro", expiresInDays: 1, seats: 1 }),
    })
    const createRes = await handleCreate(createReq, kv, cors, env.ARCANA_ADMIN_KEY)
    const createBody = await parseRes(createRes) as { licenseKey?: string }
    if (!createBody?.licenseKey) throw new Error("create did not return licenseKey")
    key = createBody.licenseKey

    // 2. Activate
    const activateReq = new Request("http://localhost/api/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: key, machineId: testMachineId, email: "test@example.com" }),
    })
    const activateRes = await handleActivate(activateReq, kv, cors, seedKeys, env.ARCANA_SIGNING_PRIVATE_KEY)
    const activateBody = await parseRes(activateRes) as { valid?: boolean; machinesActivated?: number }
    if (!activateBody?.valid || activateBody.machinesActivated !== 1) throw new Error(`activate failed: ${JSON.stringify(activateBody)}`)

    // 3. Validate
    const validateReq = new Request("http://localhost/api/license/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: key, machineId: testMachineId }),
    })
    const validateRes = await handleValidate(validateReq, kv, cors, seedKeys, env.ARCANA_SIGNING_PRIVATE_KEY)
    const validateBody = await parseRes(validateRes) as { valid?: boolean }
    if (!validateBody?.valid) throw new Error(`validate failed: ${JSON.stringify(validateBody)}`)

    // 4. Idempotent re-activation does not inflate count
    const activate2Res = await handleActivate(activateReq, kv, cors, seedKeys, env.ARCANA_SIGNING_PRIVATE_KEY)
    const activate2Body = await parseRes(activate2Res) as { machinesActivated?: number }
    if (activate2Body?.machinesActivated !== 1) throw new Error(`idempotent activate failed: ${JSON.stringify(activate2Body)}`)

    // 5. Status
    const statusUrl = new URL(`http://localhost/api/license/status?key=${encodeURIComponent(key)}`)
    const statusRes = await handleStatus(statusUrl, kv, cors, seedKeys, env.ARCANA_SIGNING_PRIVATE_KEY)
    const statusBody = await parseRes(statusRes) as { machinesActivated?: number }
    if (statusBody?.machinesActivated !== 1) throw new Error(`status failed: ${JSON.stringify(statusBody)}`)

    // 6. Revoke
    const revokeReq = new Request("http://localhost/api/license/revoke", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ licenseKey: key }),
    })
    const revokeRes = await handleRevoke(revokeReq, kv, cors, env.ARCANA_ADMIN_KEY)
    const revokeBody = await parseRes(revokeRes) as { success?: boolean }
    if (!revokeBody?.success) throw new Error(`revoke failed: ${JSON.stringify(revokeBody)}`)

    // 7. Validation after revoke fails
    const postRevokeRes = await handleValidate(validateReq, kv, cors, seedKeys, env.ARCANA_SIGNING_PRIVATE_KEY)
    const postRevokeBody = await parseRes(postRevokeRes) as { valid?: boolean }
    if (postRevokeBody?.valid) throw new Error("validate succeeded after revoke")
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e))
  } finally {
    // Best-effort cleanup of the test license and its bindings.
    if (key) {
      try {
        await kv.deleteMachinesForLicense(key)
        await kv.deleteAccount(key)
        await kv.deleteLicense(key)
      } catch {}
    }
  }

  if (failures.length > 0) {
    return json({ success: false, failures }, 500, cors)
  }
  return json({ success: true, message: "smoke tests passed" }, 200, cors)
}

async function handleValidate(request: Request, kv: LicenseKV, cors: Record<string, string>, seedKeys: SeedKeys, signingKey?: string): Promise<Response> {
  const body = await parseJson<ValidateRequest>(request, cors)
  if (body instanceof Response) return body
  const validation = validateValidateBody(body)
  if (validation.error) {
    return await json({ valid: false, error: validation.error }, 400, cors, signingKey)
  }

  const resolved = await resolveLicense(body.licenseKey, kv, seedKeys)
  if (!resolved) {
    return await json({ valid: false, error: "Invalid license key" }, 401, cors, signingKey)
  }

  if (Date.now() > resolved.expiresAt) {
    return await json({ valid: false, error: "License expired" }, 402, cors, signingKey)
  }

  const existing = await kv.getMachine(body.licenseKey, body.machineId)
  if (!existing) {
    return await json({ valid: false, error: "Machine not activated" }, 401, cors, signingKey)
  }

  existing.lastSeen = Date.now()
  await kv.putMachine(existing, storedMachineTtl(resolved))

  const machines = await kv.countMachines(body.licenseKey)
  const tier = resolved.kind === "seed" ? tierInfo(resolved.seed.tier) : tierInfo(resolved.license.tier)

  const totalSeats = seatsFor(resolved)
  const seatsUsed = Math.min(machines, totalSeats)
  return await json({
    valid: true,
    tier: resolved.kind === "seed" ? resolved.seed.tier : resolved.license.tier,
    features: tier.features,
    tools: tier.tools,
    limits: tier.limits,
    expiresAt: resolved.expiresAt,
    machinesActivated: machines,
    seatsUsed,
    seats: totalSeats,
  }, 200, cors, signingKey)
}

async function handleOAuthBind(
  request: Request,
  kv: LicenseKV,
  cors: Record<string, string>,
  signingKey: string | undefined,
): Promise<Response> {
  const body = await parseJson<OAuthBindRequest>(request, cors)
  if (body instanceof Response) return body
  if (!isNonEmptyString(body.accessToken, 4096)) {
    return json({ ok: false, error: "accessToken must be a non-empty string up to 4096 characters" }, 400, cors)
  }
  if (!isNonEmptyString(body.server, 512)) {
    return json({ ok: false, error: "server must be a non-empty string up to 512 characters" }, 400, cors)
  }

  // 1. Verify the access token by calling the console's /api/user.
  //    Fall back to the email field if the console didn't expose /api/user.
  let email = body.email
  try {
    const userRes = await fetch(`${body.server.replace(/\/$/, "")}/api/user`, {
      method: "GET",
      headers: { Authorization: `Bearer ${body.accessToken}` },
      signal: AbortSignal.timeout(8000),
    })
    if (userRes.ok) {
      const userJson = await userRes.json().catch(() => null) as { email?: string } | null
      if (userJson?.email && isValidEmail(userJson.email)) {
        email = userJson.email
      }
    } else if (userRes.status >= 500) {
      // Transient — let the caller retry; the access token itself is valid
      // because the client just received it from the device-code endpoint.
      email = email || `oauth-${body.accessToken.slice(0, 8)}@arcana.local`
    } else {
      return json({ ok: false, error: `console rejected access token (HTTP ${userRes.status})` }, 401, cors)
    }
  } catch (e) {
    // Network error talking to the console — proceed with the fallback email
    // so a brief console outage doesn't lock OAuth users out of their license.
    email = email || `oauth-${body.accessToken.slice(0, 8)}@arcana.local`
  }

  // 2. Mint a fresh free-tier license bound to a per-call machineId. The
  //    "machine" is the user's local arcana install; the binding is what
  //    makes the license_key usable as a proxy_key.
  const licenseKey = `oauth_${crypto.randomUUID().replace(/-/g, "")}`
  const machineId = `oauth-${crypto.randomUUID().slice(0, 16)}`
  const tier = "free"
  const info = tierInfo(tier)
  const now = Date.now()
  const expiresAt = now + 365 * 24 * 60 * 60 * 1000 // 1 year

  const license: LicenseKey = {
    key: licenseKey,
    tier,
    features: info.features,
    seats: 1,
    maxMachines: 1,
    expiresAt,
    createdAt: now,
  }
  await kv.putLicense(license)
  await kv.putMachine({ licenseKey, machineId, activatedAt: now, lastSeen: now }, machineTtl(expiresAt))
  if (email) {
    await kv.putAccount(licenseKey, { email }, machineTtl(expiresAt))
  }

  const response: OAuthBindResponse = {
    ok: true,
    proxyKey: licenseKey,
    tier,
    email,
  }
  return await json(response, 200, cors, signingKey)
}

async function handleActivate(request: Request, kv: LicenseKV, cors: Record<string, string>, seedKeys: SeedKeys, signingKey?: string): Promise<Response> {
  const body = await parseJson<ActivateRequest>(request, cors)
  if (body instanceof Response) return body
  const validation = validateActivateBody(body)
  if (validation.error) {
    return await json({ valid: false, error: validation.error }, 400, cors, signingKey)
  }

  const resolved = await resolveLicense(body.licenseKey, kv, seedKeys)
  if (!resolved) {
    return await json({ valid: false, error: "Invalid license key" }, 401, cors, signingKey)
  }

  if (Date.now() > resolved.expiresAt) {
    return await json({ valid: false, error: "License expired" }, 402, cors, signingKey)
  }

  const maxMachines = maxMachinesFor(resolved)

  const machineTtl = storedMachineTtl(resolved)

  // Refresh account metadata on every activation, even if this machine is already bound.
  if (body.email || body.username) {
    await kv.putAccount(body.licenseKey, { email: body.email, username: body.username }, storedMachineTtl(resolved))
  }

  const existing = await kv.getMachine(body.licenseKey, body.machineId)
  if (existing) {
    existing.lastSeen = Date.now()
    await kv.putMachine(existing, machineTtl)
    const machines = await kv.countMachines(body.licenseKey)
    const tier = resolved.kind === "seed" ? tierInfo(resolved.seed.tier) : tierInfo(resolved.license.tier)
    return await json({
      valid: true,
      tier: resolved.kind === "seed" ? resolved.seed.tier : resolved.license.tier,
      features: tier.features,
      tools: tier.tools,
      limits: tier.limits,
      machinesActivated: machines,
      maxMachines,
      email: body.email,
      username: body.username,
    }, 200, cors, signingKey)
  }

  const beforeCount = await kv.countMachines(body.licenseKey)
  if (beforeCount >= maxMachines) {
    return await json({ valid: false, error: "Maximum machines activated", machinesActivated: beforeCount, maxMachines }, 403, cors, signingKey)
  }

  await kv.putMachine({ licenseKey: body.licenseKey, machineId: body.machineId, activatedAt: Date.now(), lastSeen: Date.now() }, machineTtl)

  // Recover from a concurrent activation race: if we oversold, remove our binding and reject.
  let machines = await kv.countMachines(body.licenseKey)
  if (machines > maxMachines) {
    await kv.deleteMachine(body.licenseKey, body.machineId)
    machines = await kv.countMachines(body.licenseKey)
    return await json({ valid: false, error: "Maximum machines activated", machinesActivated: machines, maxMachines }, 403, cors, signingKey)
  }

  const tier = resolved.kind === "seed" ? tierInfo(resolved.seed.tier) : tierInfo(resolved.license.tier)

  return await json({
    valid: true,
    tier: resolved.kind === "seed" ? resolved.seed.tier : resolved.license.tier,
    features: tier.features,
    tools: tier.tools,
    limits: tier.limits,
    machinesActivated: machines,
    maxMachines,
    email: body.email,
    username: body.username,
  }, 200, cors, signingKey)
}

async function handleStatus(url: URL, kv: LicenseKV, cors: Record<string, string>, seedKeys: SeedKeys, signingKey?: string): Promise<Response> {
  const key = url.searchParams.get("key")
  if (!isNonEmptyString(key, 256)) {
    return await json({ error: "key must be a non-empty string up to 256 characters" }, 400, cors, signingKey)
  }

  const seed = seedKeys[key]
  if (seed) {
    const machines = await kv.countMachines(key)
    const tier = tierInfo(seed.tier)
    return await json({
      tier: seed.tier,
      expiresAt: seed.expiresAt,
      machinesActivated: machines,
      maxMachines: seed.maxMachines ?? tier.maxMachines,
      seats: seed.seats ?? tier.seats,
    }, 200, cors, signingKey)
  }

  const raw = await kv.getLicense(key)
  if (!raw || !isValidStoredLicense(raw)) {
    return await json({ error: "License not found" }, 404, cors, signingKey)
  }
  const license = raw

  const machines = await kv.countMachines(key)
  return await json({
    tier: license.tier,
    expiresAt: license.expiresAt,
    machinesActivated: machines,
    maxMachines: license.maxMachines,
    seats: license.seats,
  }, 200, cors, signingKey)
}

async function handleCreate(request: Request, kv: LicenseKV, cors: Record<string, string>, adminKey: string | undefined): Promise<Response> {
  if (!adminKey) return json({ error: "admin_not_configured" }, 500, cors)

  const auth = request.headers.get("Authorization") ?? ""
  const expected = `Bearer ${adminKey}`
  if (!constantTimeEqual(auth, expected)) return json({ error: "unauthorized" }, 401, cors)

  const body = await parseJson<{ tier?: string; expiresInDays?: number; seats?: number }>(request, cors)
  if (body instanceof Response) return body
  const createValidation = validateCreateBody(body)
  if (createValidation.error) return json({ error: "bad_request", message: createValidation.error }, 400, cors)

  const tier = body.tier ?? "pro"
  const expiresInDays = body.expiresInDays ?? 365
  const seats = body.seats ?? 1

  if (!["free", "pro", "team", "enterprise"].includes(tier)) {
    return json({ error: "invalid_tier" }, 400, cors)
  }

  const randomBytes = crypto.getRandomValues(new Uint8Array(16))
  const randomPart = bytesToHex(randomBytes)
  const key = `ARCANA-${tier.toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${randomPart}`
  const expiresAt = Date.now() + expiresInDays * 86400 * 1000

  await kv.putLicense({
    key,
    tier: tier as LicenseKey["tier"],
    seats,
    maxMachines: tierInfo(tier).maxMachines,
    features: tierInfo(tier).features,
    expiresAt,
    createdAt: Date.now(),
  })

  return json({ valid: true, licenseKey: key, tier, expiresAt, seats, maxMachines: tierInfo(tier).maxMachines }, 200, cors)
}

async function handleList(request: Request, kv: LicenseKV, cors: Record<string, string>, adminKey: string | undefined): Promise<Response> {
  if (!adminKey) return json({ error: "admin_not_configured" }, 500, cors)

  const auth = request.headers.get("Authorization") ?? ""
  const expected = `Bearer ${adminKey}`
  if (!constantTimeEqual(auth, expected)) return json({ error: "unauthorized" }, 401, cors)

  const list = await kv.listAll()
  return json({ keys: list }, 200, cors)
}

async function handleRevoke(request: Request, kv: LicenseKV, cors: Record<string, string>, adminKey: string | undefined): Promise<Response> {
  if (!adminKey) return json({ error: "admin_not_configured" }, 500, cors)

  const auth = request.headers.get("Authorization") ?? ""
  const expected = `Bearer ${adminKey}`
  if (!constantTimeEqual(auth, expected)) return json({ error: "unauthorized" }, 401, cors)

  const body = await parseJson<{ licenseKey?: string }>(request, cors)
  if (body instanceof Response) return body
  if (!isNonEmptyString(body.licenseKey, 256)) return json({ error: "licenseKey must be a non-empty string up to 256 characters" }, 400, cors)

  const license = await kv.getLicense(body.licenseKey)
  if (!license) {
    return json({ error: "license_not_found" }, 404, cors)
  }

  await kv.deleteLicense(body.licenseKey)
  await kv.deleteMachinesForLicense(body.licenseKey)
  await kv.deleteAccount(body.licenseKey)

  return json({ success: true, message: `License ${body.licenseKey} revoked` }, 200, cors)
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("Invalid hex string: expected an even number of hex characters")
  }
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
  if (privateKeyHex.length !== 64) {
    throw new Error("Invalid signing key: expected 64 hex characters (32 bytes)")
  }
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
    try {
      const signed = await signResponse(data, signingKey)
      body = JSON.stringify(signed)
    } catch (e) {
      console.error("Signing failed:", e)
      return new Response(JSON.stringify({ error: "signing_error", message: "Response signing is misconfigured" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...cors },
      })
    }
  } else {
    body = JSON.stringify(data)
  }
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  })
}
