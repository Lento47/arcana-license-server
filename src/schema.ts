export interface LicenseKey {
  key: string
  tier: "free" | "pro" | "team" | "enterprise"
  features: string[]
  seats: number
  maxMachines: number
  expiresAt: number
  createdAt: number
}

// seats  = number of paid entitlements / users the license grants
// maxMachines = maximum distinct machines that may activate with this license
// In the current product model, maxMachines is the hard enforcement limit;
// seats is metadata returned to clients and used for billing/quotas.

export interface MachineBinding {
  licenseKey: string
  machineId: string
  activatedAt: number
  lastSeen: number
}

export interface ValidateRequest {
  licenseKey: string
  machineId: string
  version?: string
}

export interface ValidateResponse {
  valid: boolean
  tier?: string
  features?: string[]
  expiresAt?: number
  machinesActivated?: number
  seatsUsed?: number
  error?: string
}

export interface ActivateRequest {
  licenseKey: string
  machineId: string
  email?: string
  username?: string
}

export interface ActivateResponse {
  valid: boolean
  tier?: string
  features?: string[]
  machinesActivated: number
  maxMachines: number
  error?: string
}

// OAuth device-flow bind: the engine calls this after the user completes the
// device-code login at the Arcana console. We verify the access_token by
// hitting the console's /api/user endpoint, then mint a fresh free-tier
// license key bound to a generated machineId. The returned `proxyKey` is
// what the TUI writes to ~/.arcana/proxy_key.
export interface OAuthBindRequest {
  accessToken: string
  server: string
  email?: string
}

export interface OAuthBindResponse {
  ok: boolean
  proxyKey?: string
  tier?: string
  email?: string
  error?: string
}
