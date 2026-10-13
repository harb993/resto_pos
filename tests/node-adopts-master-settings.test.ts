import { describe, it, expect } from 'vitest'
import { masterSettingsToAdopt, MACHINE_OWN_SETTINGS } from '../src/main/net/nodeLink'

/**
 * A node runs the shop's settings, not its own.
 *
 * `settings:get` is answered locally on a node — it has to be, because the login
 * screen asks for the branding before anyone has signed in and before there is
 * necessarily a link. The cost was that a node ran the whole shift on whatever was in
 * its own database: its own VAT rate, its own discount cap, its own shift times. The
 * master pushed changes while both were running, so the tills agreed right up until
 * the node was restarted — and then quietly did not.
 *
 * The one thing that must NEVER be copied is the network identity. A till told it is
 * `net_mode: master` stops forwarding, opens its own empty books, and starts issuing
 * invoice numbers against them — two tills, two sets of accounts, same shop.
 */

const shopWide = {
  tax_rate: 0.14,
  max_cashier_discount: 10,
  shifts_per_day: 1,
  shift1_name: 'اليوم كامل',
  shift1_start: '12:00',
  shift1_end: '04:00',
  business_name: 'كريسبو بروست',
  receipt_footer: 'شكراً لزيارتكم',
  currency_symbol: 'ج.م',
  whatsapp_group: '01000000000',
  print_auto: 1,
}

describe('what a node takes from its master', () => {
  it('adopts the shop settings it does not already match', () => {
    const mine = { ...shopWide, tax_rate: 0, max_cashier_discount: 50, shifts_per_day: 2 }
    const changes = masterSettingsToAdopt(mine, shopWide)

    expect(changes).toEqual({ tax_rate: 0.14, max_cashier_discount: 10, shifts_per_day: 1 })
  })

  it('NEVER adopts net_mode — that is how a node would become a second master', () => {
    const mine = { net_mode: 'node', net_token: 'mine', net_port: 47615 }
    const master = { net_mode: 'master', net_token: 'theirs', net_port: 9999 }

    const changes = masterSettingsToAdopt(mine, master)

    expect(changes).not.toHaveProperty('net_mode')
    expect(changes).not.toHaveProperty('net_token')
    expect(changes).not.toHaveProperty('net_port')
    expect(changes).toEqual({})
  })

  it('leaves every machine-local path and counter alone', () => {
    const master = {
      backup_folder: 'D:\\master-backups',
      backup_hour: 4,
      backup_last_daily: '2026-09-11',
      shift_export_folder: 'D:\\master-reports',
      net_fleet_id: 'fleet-1',
      net_master_name: 'MASTER-PC',
      net_locked: 1,
      net_lock_reason: 'stocktake',
      net_tills: '[{"a":1}]',
    }
    expect(masterSettingsToAdopt({}, master)).toEqual({})
  })

  it('covers every net_* key, so a new one cannot leak in by being forgotten', () => {
    for (const key of Object.keys(shopWide)) expect(MACHINE_OWN_SETTINGS.has(key)).toBe(false)
    for (const key of ['net_mode', 'net_port', 'net_token', 'net_fleet_id',
                       'net_master_name', 'net_locked', 'net_lock_reason', 'net_tills']) {
      expect(MACHINE_OWN_SETTINGS.has(key), key).toBe(true)
    }
  })

  it('reports nothing to do when the two already agree', () => {
    expect(masterSettingsToAdopt({ ...shopWide }, shopWide)).toEqual({})
  })

  it('adopts a rate of zero — the master charging no VAT is a real instruction', () => {
    // The falsy-zero trap again: "the master says 0" must not read as "the master
    // said nothing".
    const changes = masterSettingsToAdopt({ tax_rate: 0.14 }, { tax_rate: 0 })
    expect(changes).toEqual({ tax_rate: 0 })
  })

  it('ignores a key the master sends as null or undefined', () => {
    const changes = masterSettingsToAdopt(
      { tax_rate: 0.14, business_name: 'كريسبو' },
      { tax_rate: null, business_name: undefined } as never,
    )
    expect(changes).toEqual({})
  })

  it('compares as text, so 1 and "1" do not count as a change', () => {
    expect(masterSettingsToAdopt({ shifts_per_day: 1 }, { shifts_per_day: '1' })).toEqual({})
    expect(masterSettingsToAdopt({ print_auto: '1' }, { print_auto: 1 })).toEqual({})
  })
})
