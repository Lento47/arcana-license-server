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

  async countMachines(licenseKey: string): Promise<number> {
    const list = await this.kv.list({ prefix: MACHINE_PREFIX })
    const keys = list.keys.filter(async (k) => {
      const val = await this.kv.get(k.name, "json") as MachineBinding | null
      return val?.licenseKey === licenseKey
    })
    return (await Promise.all(keys.map(async (k) => {
      const val = await this.kv.get(k.name, "json") as MachineBinding | null
      return val?.licenseKey === licenseKey ? 1 : 0
    }))).reduce((a, b) => a + b, 0)
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

  private hashKey(key: string): string {
    let hash = 0
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0
    }
    return Math.abs(hash).toString(16)
  }

  private ttlUntil(timestamp: number): number {
    return Math.max(60, Math.ceil((timestamp - Date.now() / 1000)))
  }
}
