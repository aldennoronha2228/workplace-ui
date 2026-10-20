export type EspNetworkSettings = { ssid: string; password: string }
const settings = new Map<string, EspNetworkSettings>()
export function getEspNetwork(projectId: string): EspNetworkSettings { return settings.get(projectId) ?? { ssid: 'myssid', password: 'mypassword' } }
export function setEspNetwork(projectId: string, next: EspNetworkSettings) {
  if (!next.ssid.trim() || new TextEncoder().encode(next.ssid).length > 32) throw new Error('SSID must be 1–32 bytes.')
  if (next.password && (next.password.length < 8 || next.password.length > 63)) throw new Error('Use an 8–63 character password, or leave it blank for an open simulated network.')
  settings.set(projectId, { ssid: next.ssid.trim(), password: next.password })
}
