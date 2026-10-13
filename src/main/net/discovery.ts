/**
 * Finding what is on the shop's network.
 *
 * There is no service-discovery protocol here on purpose. mDNS/Bonjour is not
 * installed on a bare Windows till, and a broadcast probe is exactly the sort of
 * traffic a cheap switch or Windows Firewall drops silently — leaving the owner
 * staring at an empty list with nothing to try. A direct TCP connect to a known port
 * either succeeds or fails, works through any switch, and tells the truth.
 *
 * Two things are looked for:
 *   - another till running this app, on the configured master port
 *   - a thermal printer, on 9100, the RAW port every ESC/POS unit listens on
 *
 * EVERY till is findable now, in every mode, because every till listens — see
 * tillServer. That is also what makes `findTillByName` below possible, and with it
 * the automatic recovery: a till whose address has changed is still answering on the
 * same port under the same computer name, so the master can go and find it again
 * rather than sitting on a stale IP showing an error about a cable.
 */

import net from 'node:net'
import os from 'node:os'
import log from 'electron-log/main'
import { DEFAULT_PORT, HEALTH_PATH, type HealthBody } from './protocol'

export interface DiscoveredDevice {
  ip: string
  port: number
  kind: 'till' | 'printer' | 'this-machine' | 'unknown'
  /**
   * What that till currently is. Every till answers /health in every mode, so a
   * machine that has not been set up yet shows as 'standalone' and can be pointed at
   * — rather than being invisible, which is what used to happen and is the reason
   * "it didn't find the other PC" was the normal experience.
   */
  role?: 'master' | 'node' | 'standalone'
  /** The Windows computer name — how a person tells one till from another. */
  machineName?: string
  /** Business name from /health. */
  name?: string
  appVersion?: string
  connectedNodes?: number
  /** True when the till has no master yet, so it can be adopted with one press. */
  adoptable?: boolean
  /** node only — whether its master currently has a link open to it. */
  linked?: boolean
}

/** Every LAN address this machine has, for the settings screen and for logs. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address)
    }
  }
  return out
}

/**
 * Is that address on one of this machine's own subnets?
 *
 * Compared against every interface's network rather than a hardcoded range, so a shop
 * on 10.0.0.x works the same as one on 192.168.1.x. Not a security boundary on its
 * own — anyone on the shop's LAN is inside it — but it stops an enrolment or a link
 * from reaching anything routed in from outside.
 */
export function isSameLan(address: string): boolean {
  if (address === '127.0.0.1' || address === '::1') return true
  const peer = address.split('.').map(Number)
  if (peer.length !== 4 || peer.some(n => !Number.isFinite(n))) return false

  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      const own = iface.address.split('.').map(Number)
      const mask = (iface.netmask ?? '255.255.255.0').split('.').map(Number)
      if (own.every((o, i) => (o & mask[i]) === (peer[i] & mask[i]))) return true
    }
  }
  return false
}

/** One TCP connect. Resolves true when something answers on that port. */
function probe(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket()
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, ip)
  })
}

/** The IPv4 networks this machine sits on, and its own address on each. */
function localNetworks(): { own: string; hosts: string[] }[] {
  const out: { own: string; hosts: string[] }[] = []

  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue

      // Only /24 and smaller are swept. A /16 is 65,000 probes — minutes of scanning
      // and a burst of traffic that looks like a port scan to anything watching. A
      // shop LAN is a /24; anything wider is not what this feature is for.
      const parts = iface.address.split('.').map(Number)
      if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) continue

      const mask = iface.netmask?.split('.').map(Number) ?? [255, 255, 255, 0]
      if (mask[0] !== 255 || mask[1] !== 255 || mask[2] !== 255) {
        log.info(`[Discover] Skipping ${iface.address}/${iface.netmask} — wider than /24`)
        continue
      }

      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`
      const hosts: string[] = []
      for (let h = 1; h <= 254; h++) hosts.push(`${prefix}.${h}`)
      out.push({ own: iface.address, hosts })
    }
  }
  return out
}

/** Run `task` over `items` with a fixed number in flight. */
async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results.push(await task(items[i]))
    }
  })
  await Promise.all(workers)
  return results
}

/** Ask a responding till who it is. Never throws — a stranger on the port is fine. */
export async function identifyTill(ip: string, port: number): Promise<DiscoveredDevice | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try {
    const res = await fetch(`http://${ip}:${port}${HEALTH_PATH}`, { signal: controller.signal })
    if (!res.ok) return null
    const body = await res.json() as Partial<HealthBody>
    // Any role counts. A till that has not been configured yet is exactly the machine
    // the person scanning is looking for.
    if (body?.ok !== true || !body?.role) return null

    return {
      ip, port, kind: 'till',
      role: body.role,
      machineName: body.machineName,
      name: body.businessName,
      appVersion: body.appVersion,
      connectedNodes: body.connectedNodes,
      adoptable: !!body.adoptable,
      linked: !!body.linked,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Find a till again by its Windows computer name.
 *
 * This is the whole of the automatic recovery. A till's address is not a fact about
 * the till — DHCP hands out a different one after a power cut, someone moves a cable
 * to a different socket, a router is replaced — but the computer name is stable, and
 * the master already recorded it at enrolment. So when the stored address stops
 * answering, the master sweeps its own subnets, asks every till that responds who it
 * is, and adopts the new address of the one it was looking for.
 *
 * Without this, a changed IP means a till that is dead until a human retypes an
 * address, while showing an error that blames the cable.
 */
export async function findTillByName(machineName: string, port: number): Promise<DiscoveredDevice | null> {
  const wanted = machineName.trim().toLowerCase()
  if (!wanted) return null

  const hosts = [...new Set(localNetworks().flatMap(n => n.hosts))]
  const hits = await pool(hosts, 64, async ip => (await probe(ip, port, 400)) ? ip : null)

  for (const ip of hits.filter(Boolean) as string[]) {
    const till = await identifyTill(ip, port)
    if (till?.machineName?.trim().toLowerCase() === wanted) return till
  }
  return null
}

/**
 * Sweep the LAN for tills and printers.
 *
 * `masterPort` is whatever the owner configured, so a shop that moved off the default
 * is still found. 9100 is fixed — it is the RAW port, not a preference.
 */
export async function discoverDevices(masterPort = DEFAULT_PORT): Promise<{
  devices: DiscoveredDevice[]
  scanned: number
  networks: string[]
}> {
  const networks = localNetworks()
  if (networks.length === 0) {
    log.warn('[Discover] No usable IPv4 network found')
    return { devices: [], scanned: 0, networks: [] }
  }

  const ownAddresses = new Set(networks.map(n => n.own))
  const hosts = [...new Set(networks.flatMap(n => n.hosts))]
  const started = Date.now()

  // 64 at a time with a short timeout: a /24 finishes in a couple of seconds without
  // opening so many sockets at once that Windows starts refusing them.
  const PORTS: { port: number; kind: 'till' | 'printer' }[] = [
    { port: masterPort, kind: 'till' },
    { port: 9100, kind: 'printer' },
  ]

  const found: DiscoveredDevice[] = []
  for (const { port, kind } of PORTS) {
    const hits = await pool(hosts, 64, async (ip) => (await probe(ip, port, 400)) ? ip : null)
    for (const ip of hits.filter(Boolean) as string[]) {
      if (kind === 'till') {
        const identified = await identifyTill(ip, port)
        // Something answered but is not this app — say so rather than claiming a till.
        found.push(identified ?? { ip, port, kind: 'unknown' })
      } else {
        found.push({ ip, port, kind: 'printer' })
      }
    }
  }

  // Mark this machine so the owner is not puzzled to see their own address listed.
  for (const d of found) if (ownAddresses.has(d.ip) && d.kind === 'till') d.kind = 'this-machine'

  log.info(
    `[Discover] Swept ${hosts.length} host(s) on ${networks.map(n => n.own).join(', ')} ` +
    `in ${Date.now() - started}ms — ${found.length} device(s)`
  )

  return {
    devices: found.sort((a, b) => a.kind.localeCompare(b.kind) || a.ip.localeCompare(b.ip)),
    scanned: hosts.length,
    networks: networks.map(n => n.own),
  }
}
