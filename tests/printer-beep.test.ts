import { describe, it, expect } from 'vitest'
import { beep, buildTicket, cut, type MonoBitmap } from '../src/main/services/printing/escpos'

/**
 * The buzzer: ESC B n t, n beeps of t × 50ms.
 *
 * Unlike cut and drawer this is a Xinye extension rather than core ESC/POS, so it is
 * off until an owner switches it on for a specific printer and proves it with the
 * test button. What these tests pin is the part that IS under our control: the bytes
 * are right, the parameters cannot run away, and the command lands after the cut so a
 * printer that prints it instead of obeying it marks the next leader rather than the
 * ticket being served.
 */

const BMP: MonoBitmap = { width: 8, height: 2, data: Buffer.from([0xff, 0x00]) }
const ESC_B = Buffer.from([0x1b, 0x42])

describe('the buzzer command', () => {
  it('is ESC B with the documented defaults', () => {
    // 2 beeps, 3 units (150ms each) — audible across a kitchen, not a nuisance.
    expect([...beep()]).toEqual([0x1b, 0x42, 2, 3])
  })

  it('passes through the values it is given', () => {
    expect([...beep(5, 7)]).toEqual([0x1b, 0x42, 5, 7])
  })

  it('clamps to the 1–9 the printer accepts, rather than emitting a stray byte', () => {
    // A value outside the range is not merely ignored by the printer — it is read as
    // the next command, which is how a ticket turns into a paper feed.
    expect([...beep(0, 0)]).toEqual([0x1b, 0x42, 1, 1])
    expect([...beep(99, 99)]).toEqual([0x1b, 0x42, 9, 9])
    expect([...beep(-4, -4)]).toEqual([0x1b, 0x42, 1, 1])
    expect([...beep(2.6, 3.4)]).toEqual([0x1b, 0x42, 3, 3])
  })

  it('never emits a byte that could be mistaken for the start of a raster', () => {
    for (let n = -20; n < 40; n++) {
      const bytes = [...beep(n, n)]
      expect(bytes).toHaveLength(4)
      expect(bytes[2]).toBeGreaterThanOrEqual(1)
      expect(bytes[2]).toBeLessThanOrEqual(9)
      expect(bytes[3]).toBeGreaterThanOrEqual(1)
      expect(bytes[3]).toBeLessThanOrEqual(9)
    }
  })
})

describe('where the beep sits in a ticket', () => {
  it('is absent unless asked for', () => {
    const t = buildTicket(BMP, { cutPaper: true, openDrawer: false })
    expect(t.includes(ESC_B)).toBe(false)
  })

  it('comes after the cut, so the ticket is complete before the kitchen is called', () => {
    const t = buildTicket(BMP, { cutPaper: true, openDrawer: false, beep: true })
    const cutAt = t.indexOf(cut(true).subarray(-4))   // GS V B 0
    const beepAt = t.indexOf(ESC_B)
    expect(cutAt).toBeGreaterThan(-1)
    expect(beepAt).toBeGreaterThan(cutAt)
  })

  it('still comes last on a printer with no cutter', () => {
    const t = buildTicket(BMP, { cutPaper: false, openDrawer: false, beep: true })
    expect(t.indexOf(ESC_B)).toBe(t.length - 4)
  })

  it('works alongside the cash drawer without either displacing the other', () => {
    const t = buildTicket(BMP, { cutPaper: true, openDrawer: true, beep: true })
    const drawerAt = t.indexOf(Buffer.from([0x1b, 0x70]))
    const beepAt = t.indexOf(ESC_B)
    expect(drawerAt).toBeGreaterThan(-1)
    expect(beepAt).toBeGreaterThan(drawerAt)
    expect(t.indexOf(ESC_B)).toBe(t.length - 4)
  })
})
