import type { LicenseKey, MachineBinding } from "./schema"

const LICENSE_PREFIX = "license:"
const MACHINE_PREFIX = "machine:"
const USAGE_PREFIX = "usage:"

export class LicenseKV {
  constructor(private readonly kv: KVNamespace) {}

  async getLicense(licenseKey: string): Promise<LicenseKey | null> {
    const key = LICENSE_PREFIX + this.hashKey(licenseKey)
    const raw = await this.kv.get(key, "json")
    return raw as LicenseKey | null
  }

  async putLicense(license: LicenseKey): Promise<void> {
    const key = LICENSE_PREFIX + this.hashKey(license.key)
    await this.kv.put(key, JSON.stringify(license), {
      expirationTtl: this.ttlUntil(license.expiresAt),
    })
  }

  async getMachine(machineId: string): Promise<MachineBinding | null> {
    const raw = await this.kv.get(MACHINE_PREFIX + machineId, "json")
    return raw as MachineBinding | null
  }

  async putMachine(binding: MachineBinding): Promise<void> {
    await this.kv.put(MACHINE_PREFIX + binding.machineId, JSON.stringify(binding))
  }

  async incrementMachineCount(licenseKey: string, delta: 1 | -1): Promise<void> {
    const key = `machines:${licenseKey}`
    const current = parseInt(await this.kv.get(key) ?? "0", 10)
    await this.kv.put(key, String(Math.max(0, current + delta)))
  }

  async getMachineCount(licenseKey: string): Promise<number> {
    return parseInt(await this.kv.get(`machines:${licenseKey}`) ?? "0", 10)
  }

  async countMachines(licenseKey: string): Promise<number> {
    return this.getMachineCount(licenseKey)
  }

  async listAll(): Promise<LicenseKey[]> {
    const list = await this.kv.list({ prefix: LICENSE_PREFIX })
    const keys: LicenseKey[] = []
    for (const { name } of list.keys) {
      const val = await this.kv.get(name, "json") as LicenseKey | null
      if (val) keys.push(val)
    }
    return keys
  }

  async putAccount(licenseKey: string, data: { email?: string; username?: string }): Promise<void> {
    await this.kv.put(`account:${licenseKey}`, JSON.stringify(data), { expirationTtl: 86400 * 365 })
  }

  async getAccount(licenseKey: string): Promise<{ email?: string; username?: string } | null> {
    const raw = await this.kv.get(`account:${licenseKey}`, "json")
    return raw as { email?: string; username?: string } | null
  }

  async trackUsage(tenantId: string, date: string, tokens: number, calls: number): Promise<void> {
    const key = USAGE_PREFIX + tenantId + ":" + date
    const current = await this.kv.get(key, "json") as { tokens: number; calls: number } | null
    await this.kv.put(key, JSON.stringify({
      tokens: (current?.tokens ?? 0) + tokens,
      calls: (current?.calls ?? 0) + calls,
    }))
  }

  // WARNING: This hash has only ~32 bits of output and is NOT cryptographic.
  // At ~77K keys, birthday collisions become likely.
  // TODO: Replace with SHA-256 via crypto.subtle.digest()
  private hashKey(key: string): string {
    let hash = 0
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0
    }
    return Math.abs(hash).toString(16)
  }

  private ttlUntil(timestamp: number): number {
    return Math.max(60, Math.ceil((timestamp - Date.now()) / 1000))
  }
}
