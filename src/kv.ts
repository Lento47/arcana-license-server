import type { LicenseKey, MachineBinding } from "./schema"

const LICENSE_PREFIX = "license:"
const MACHINE_PREFIX = "machine:"
const ACCOUNT_PREFIX = "account:"
const USAGE_PREFIX = "usage:"

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

export class LicenseKV {
  constructor(private readonly kv: KVNamespace) {}

  private async getJsonSafe<T>(key: string): Promise<T | null> {
    try {
      return await this.kv.get(key, "json") as T | null
    } catch {
      return null
    }
  }

  async getLicense(licenseKey: string): Promise<LicenseKey | null> {
    const key = LICENSE_PREFIX + await this.licenseHash(licenseKey)
    return this.getJsonSafe<LicenseKey>(key)
  }

  async putLicense(license: LicenseKey): Promise<void> {
    const key = LICENSE_PREFIX + await this.licenseHash(license.key)
    await this.kv.put(key, JSON.stringify(license), {
      expirationTtl: this.ttlUntil(license.expiresAt),
    })
  }

  async deleteLicense(licenseKey: string): Promise<void> {
    await this.kv.delete(LICENSE_PREFIX + await this.licenseHash(licenseKey))
  }

  async getMachine(licenseKey: string, machineId: string): Promise<MachineBinding | null> {
    return this.getJsonSafe<MachineBinding>(await this.machineKey(licenseKey, machineId))
  }

  async putMachine(binding: MachineBinding, expirationTtl?: number): Promise<void> {
    const options = expirationTtl ? { expirationTtl } : undefined
    await this.kv.put(
      await this.machineKey(binding.licenseKey, binding.machineId),
      JSON.stringify(binding),
      options,
    )
  }

  async deleteMachine(licenseKey: string, machineId: string): Promise<void> {
    await this.kv.delete(await this.machineKey(licenseKey, machineId))
  }

  async countMachines(licenseKey: string): Promise<number> {
    const prefix = await this.machinePrefix(licenseKey)
    let count = 0
    let cursor: string | undefined
    let complete = false
    while (!complete) {
      const list = await this.kv.list({ prefix, cursor })
      count += list.keys.length
      complete = list.list_complete
      if (!complete) {
        cursor = (list as { cursor: string }).cursor
      }
    }
    return count
  }

  async deleteMachinesForLicense(licenseKey: string): Promise<void> {
    const prefix = await this.machinePrefix(licenseKey)
    let cursor: string | undefined
    let complete = false
    while (!complete) {
      const list = await this.kv.list({ prefix, cursor })
      await Promise.all(list.keys.map(({ name }) => this.kv.delete(name)))
      complete = list.list_complete
      if (!complete) {
        cursor = (list as { cursor: string }).cursor
      }
    }
  }

  async listAll(): Promise<LicenseKey[]> {
    const keys: LicenseKey[] = []
    let cursor: string | undefined
    let complete = false
    while (!complete) {
      const list = await this.kv.list({ prefix: LICENSE_PREFIX, cursor })
      for (const { name } of list.keys) {
        const val = await this.getJsonSafe<LicenseKey>(name)
        if (val) keys.push(val)
      }
      complete = list.list_complete
      if (!complete) {
        cursor = (list as { cursor: string }).cursor
      }
    }
    return keys
  }

  async putAccount(licenseKey: string, data: { email?: string; username?: string }, expirationTtl?: number): Promise<void> {
    const options = expirationTtl ? { expirationTtl } : undefined
    await this.kv.put(ACCOUNT_PREFIX + await this.licenseHash(licenseKey), JSON.stringify(data), options)
  }

  async getAccount(licenseKey: string): Promise<{ email?: string; username?: string } | null> {
    return this.getJsonSafe<{ email?: string; username?: string }>(ACCOUNT_PREFIX + await this.licenseHash(licenseKey))
  }

  async deleteAccount(licenseKey: string): Promise<void> {
    await this.kv.delete(ACCOUNT_PREFIX + await this.licenseHash(licenseKey))
  }

  async trackUsage(tenantId: string, date: string, tokens: number, calls: number): Promise<void> {
    // KV-backed best-effort counter. Concurrent updates may lose increments
    // under contention; acceptable for usage analytics, not for rate-limit
    // enforcement.
    const key = USAGE_PREFIX + tenantId + ":" + date
    const current = await this.getJsonSafe<{ tokens: number; calls: number }>(key)
    const next = {
      tokens: Math.max(0, (current?.tokens ?? 0) + tokens),
      calls: Math.max(0, (current?.calls ?? 0) + calls),
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.kv.put(key, JSON.stringify(next))
        return
      } catch {
        // Retry on transient KV errors; last attempt falls through silently.
      }
    }
  }

  private async machineKey(licenseKey: string, machineId: string): Promise<string> {
    return (await this.machinePrefix(licenseKey)) + machineId
  }

  private async machinePrefix(licenseKey: string): Promise<string> {
    return MACHINE_PREFIX + (await this.licenseHash(licenseKey)) + ":"
  }

  private async licenseHash(key: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
    return bytesToHex(new Uint8Array(digest))
  }

  private ttlUntil(timestamp: number): number {
    return Math.max(60, Math.ceil((timestamp - Date.now()) / 1000))
  }
}
