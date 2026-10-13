import React, { useState, useEffect, useRef } from 'react'

/**
 * A number field that behaves the way people expect at a till.
 *
 * `<input type="number">` bound straight to a number has two problems this fixes:
 *
 *   The stuck zero  Clearing the box gives '', which Number('') turns into 0, which
 *                   is written straight back — so the field refills with "0" and you
 *                   end up typing in front of it ("0350"). Here the text being typed
 *                   is kept as its own state, so the box can genuinely be empty while
 *                   the value reported to the form is 0.
 *
 *   The arrows      The spinner is a tiny target next to a real one, and nudges the
 *                   figure by one when misclicked. This is a text field with a numeric
 *                   keypad hint, so only the keyboard digits change it.
 */
export interface NumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number | null | undefined
  onValueChange: (value: number) => void
  /** Allow a leading minus — used by stocktake adjustments. */
  allowNegative?: boolean
  /** Decimal places accepted. 0 makes it whole numbers only. */
  decimals?: number
}

export default function NumberInput({
  value,
  onValueChange,
  allowNegative = false,
  decimals = 2,
  className = 'input',
  ...rest
}: NumberInputProps) {
  const [text, setText] = useState(() => formatValue(value))
  const focused = useRef(false)

  // Follow the value when it changes from outside (a preset button, a reset, a
  // calculated amount) — but never while typing, or the caret would jump.
  useEffect(() => {
    if (focused.current) return
    setText(formatValue(value))
  }, [value])

  const pattern = buildPattern(allowNegative, decimals)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Arabic-Indic digits are what an Arabic keyboard produces; accept them and
    // store the Western equivalent.
    let raw = toWesternDigits(e.target.value)

    /*
      A decimal point typed into a whole-number field used to be rejected outright, and
      rejecting a keystroke in a controlled input does not just ignore it — React
      re-renders the old text and the caret jumps to the end. Typing "7.5" into the
      discount cap therefore produced "75", and pressing "." in the middle of a number
      threw the cursor to the end mid-edit. From the counter that reads as a field that
      has stopped taking input.

      A trailing point on a whole-number field is now simply dropped — the person meant
      a whole number and the field only takes whole numbers — and anything else still
      fails the pattern below. Same for a second point in a decimal field.
    */
    if (decimals <= 0 && raw.endsWith('.')) raw = raw.slice(0, -1)

    if (raw !== '' && !pattern.test(raw)) return // genuinely not a number we can take

    setText(raw)

    // '', '-' and a trailing '.' are all mid-typing states, not a number yet.
    const parsed = Number(raw)
    onValueChange(raw === '' || Number.isNaN(parsed) ? 0 : parsed)
  }

  return (
    <input
      {...rest}
      className={className}
      type="text"
      inputMode={decimals > 0 ? 'decimal' : 'numeric'}
      autoComplete="off"
      value={text}
      onFocus={(e) => {
        focused.current = true
        // Select what is there so typing replaces it instead of appending to a 0.
        e.target.select()
        rest.onFocus?.(e)
      }}
      onBlur={(e) => {
        focused.current = false
        // Tidy up half-typed input on the way out ('', '-', '12.').
        setText(formatValue(value))
        rest.onBlur?.(e)
      }}
      onChange={handleChange}
    />
  )
}

function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return ''
  if (value === 0) return '' // an empty box reads better than a 0 that must be deleted
  return String(value)
}

function buildPattern(allowNegative: boolean, decimals: number): RegExp {
  const sign = allowNegative ? '-?' : ''
  if (decimals <= 0) return new RegExp(`^${sign}\\d*$`)
  return new RegExp(`^${sign}\\d*(\\.\\d{0,${decimals}})?$`)
}

/** ٠١٢٣٤٥٦٧٨٩ and ۰۱۲۳۴۵۶۷۸۹ → 0123456789 */
function toWesternDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[،٫]/g, '.')
    .trim()
}
