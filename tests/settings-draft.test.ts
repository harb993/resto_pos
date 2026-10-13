import { describe, it, expect } from 'vitest'

/**
 * Why the settings fields "sometimes" would not take input.
 *
 * Three separate causes, all of them intermittent, which is what made it impossible to
 * describe as anything but "sometimes". Two are pinned here; the third — a toast with
 * no `pointer-events: none` sitting over the bottom-left corner and swallowing every
 * click aimed underneath it for three seconds after each save — is CSS, and is fixed
 * in index.css.
 */

// ── 1. The draft that copied the defaults ────────────────────────────────────────
//
// The settings screen edits a COPY of the shared store, so a push from the main
// process cannot overwrite half-typed text. But the store fills in asynchronously:
// before sign-in the main process returns only the public branding keys, and the real
// set lands a moment later. Seeding the copy once, on mount, meant a screen opened
// quickly enough copied the DEFAULTS — showing 14% VAT and two shifts to a shop that
// had neither, warning about unsaved changes nobody had made, and writing those
// defaults over the real values on the next save.
//
// This models the seeding rule exactly as the screen now implements it.

interface Draft { [k: string]: unknown }

function seedingRule() {
  let draft: Draft = {}
  let touched = false

  return {
    /** The store pushed a new set of settings. */
    storeChanged(store: Draft) {
      if (touched) return
      draft = { ...store }
    },
    /** Somebody typed. */
    edit(key: string, value: unknown) {
      touched = true
      draft = { ...draft, [key]: value }
    },
    /** Saved — draft and store agree again. */
    saved() { touched = false },
    get value() { return draft },
    get touched() { return touched },
  }
}

const DEFAULTS = { tax_rate: 0.14, shifts_per_day: 2, business_name: 'Restaurant' }
const REAL = { tax_rate: 0, shifts_per_day: 1, business_name: 'Crispo Fried Chicken' }

describe('the settings draft keeps up with what is actually saved', () => {
  it('follows the store until somebody types', () => {
    const form = seedingRule()

    form.storeChanged(DEFAULTS)          // mounted before the real settings arrived
    expect(form.value).toEqual(DEFAULTS)

    form.storeChanged(REAL)              // …and a moment later they do
    expect(form.value).toEqual(REAL)     // the screen corrects itself
  })

  it('stops following the moment somebody types, so nothing overwrites them', () => {
    const form = seedingRule()
    form.storeChanged(REAL)

    form.edit('tax_rate', 0.05)
    // A push arrives mid-edit — from another screen, or from this till's master.
    form.storeChanged({ ...REAL, business_name: 'Something Else' })

    expect(form.value.tax_rate).toBe(0.05)                    // the edit survives
    expect(form.value.business_name).toBe('Crispo Fried Chicken')
  })

  it('follows again once the edit has been saved', () => {
    const form = seedingRule()
    form.storeChanged(REAL)
    form.edit('tax_rate', 0.05)
    form.saved()

    form.storeChanged({ ...REAL, tax_rate: 0.05, shifts_per_day: 2 })
    expect(form.value.shifts_per_day).toBe(2)
    expect(form.touched).toBe(false)
  })

  it('never writes the defaults over real settings', () => {
    // The damaging case: mount early, never type, press save. What gets posted must
    // be the shop's real values, not the placeholders shown before they loaded.
    const form = seedingRule()
    form.storeChanged(DEFAULTS)
    form.storeChanged(REAL)

    expect(form.value).toEqual(REAL)
    expect(form.value.tax_rate).not.toBe(0.14)
  })
})

// ── 1b. The live refresh that typed over you ─────────────────────────────────────
//
// The networking screen refreshes itself every three seconds, because links come and
// go on their own and the list has to follow. That refresh wrote the SAVED mode and
// port straight back into the two controls the owner edits — so typing a port meant
// watching it revert a second later, and picking a mode could snap back before it was
// saved.
//
// It is the same mistake as the settings draft, in a place where it is far more
// visible: this is the one screen somebody is on precisely when they are trying to
// connect two machines, which is why it was reported as "the blocking happens when the
// two devices are connected".

function livePollRule(saved: { mode: string; port: number }) {
  let shown = { ...saved }
  let editing = false

  return {
    /** The three-second refresh. */
    poll(fresh: { mode: string; port: number }) {
      if (editing) return          // …but never over what is being typed
      shown = { ...fresh }
    },
    edit(patch: Partial<{ mode: string; port: number }>) {
      editing = true
      shown = { ...shown, ...patch }
    },
    saved() { editing = false },
    get value() { return shown },
  }
}

describe('the networking screen refreshing while you type', () => {
  const STORED = { mode: 'standalone', port: 47615 }

  it('keeps the link list current when nobody is editing', () => {
    const screen = livePollRule(STORED)
    screen.poll({ mode: 'master', port: 47615 })
    expect(screen.value.mode).toBe('master')
  })

  it('does NOT type over a port being entered', () => {
    const screen = livePollRule(STORED)

    screen.edit({ port: 4761 })   // mid-typing: "4761"
    screen.poll(STORED)           // the three-second refresh lands

    // This is the whole bug: it used to come back as 47615 while the cursor was still
    // in the field.
    expect(screen.value.port).toBe(4761)
  })

  it('does not snap a chosen mode back before it is saved', () => {
    const screen = livePollRule(STORED)
    screen.edit({ mode: 'master' })
    screen.poll(STORED)
    expect(screen.value.mode).toBe('master')
  })

  it('follows the machine again once the change is saved', () => {
    const screen = livePollRule(STORED)
    screen.edit({ port: 47800 })
    screen.saved()

    screen.poll({ mode: 'master', port: 47800 })
    expect(screen.value).toEqual({ mode: 'master', port: 47800 })
  })

  it('survives many refreshes during one slow edit', () => {
    const screen = livePollRule(STORED)
    screen.edit({ port: 4 })
    for (let i = 0; i < 20; i++) screen.poll(STORED)   // a minute of refreshes
    expect(screen.value.port).toBe(4)
  })
})

// ── 2. The decimal point that threw the caret to the end ─────────────────────────
//
// Rejecting a keystroke in a controlled input does not merely ignore it: React
// re-renders the previous text and the caret jumps to the end. So a "." typed into a
// whole-number field turned "7.5" into "75", and a "." pressed mid-number moved the
// cursor. At the counter that reads as a field that has stopped responding.

function acceptKeystroke(current: string, decimals: number, allowNegative = false): string | null {
  const sign = allowNegative ? '-?' : ''
  const pattern = decimals <= 0
    ? new RegExp(`^${sign}\\d*$`)
    : new RegExp(`^${sign}\\d*(\\.\\d{0,${decimals}})?$`)

  let raw = current
  if (decimals <= 0 && raw.endsWith('.')) raw = raw.slice(0, -1)
  if (raw !== '' && !pattern.test(raw)) return null   // rejected
  return raw
}

describe('typing into a number field', () => {
  it('drops a trailing point on a whole-number field instead of rejecting it', () => {
    // "7" then "." — the person meant 7, the field takes whole numbers, so take 7
    // rather than bouncing the keystroke and moving their cursor.
    expect(acceptKeystroke('7.', 0)).toBe('7')
    expect(acceptKeystroke('75.', 0)).toBe('75')
  })

  it('still refuses something that is genuinely not a number', () => {
    expect(acceptKeystroke('7.5', 0)).toBeNull()     // a whole-number field
    expect(acceptKeystroke('abc', 0)).toBeNull()
    expect(acceptKeystroke('7..', 0)).toBeNull()
    expect(acceptKeystroke('-3', 0)).toBeNull()      // negatives not allowed here
  })

  it('takes decimals where the field allows them', () => {
    expect(acceptKeystroke('14.5', 2)).toBe('14.5')
    expect(acceptKeystroke('14.', 2)).toBe('14.')    // mid-typing, kept
    expect(acceptKeystroke('14.55', 2)).toBe('14.55')
    expect(acceptKeystroke('14.555', 2)).toBeNull()  // past the allowed places
  })

  it('allows an empty box — clearing a field is not an error', () => {
    expect(acceptKeystroke('', 0)).toBe('')
    expect(acceptKeystroke('', 2)).toBe('')
  })

  it('takes a negative where the field allows one', () => {
    expect(acceptKeystroke('-5', 0, true)).toBe('-5')
    expect(acceptKeystroke('-', 0, true)).toBe('-')  // mid-typing
  })
})
