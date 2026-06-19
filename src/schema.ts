export interface LicenseKey {
  key: string
  tier: "free" | "pro" | "team" | "enterprise"
  features: string[]
  seats: number
  maxMachines: number
  expiresAt: number
  createdAt: number
}

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
  email?: string
  machineId: string
}

export interface ActivateResponse {
  valid: boolean
  tier?: string
  features?: string[]
  machinesActivated: number
  maxMachines: number
  error?: string
}
