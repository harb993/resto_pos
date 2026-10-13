/**
 * ESC/POS command bytes for the XPrinter (Xinye) thermal printers on the counter.
 *
 * Everything the restaurant prints is Arabic, and no thermal printer's built-in
 * character set renders Arabic correctly — the letters come out disconnected,
 * left-to-right, or as question marks. So this module deliberately does NOT build
 * text commands: the receipt is rendered as HTML by Chromium (which shapes Arabic
 * properly) and sent to the printer as a 1-bit raster image. The only commands
 * here are the ones around that image: initialise, align, feed, cut, drawer.
 *
 * Command references are from the XP-80XX / XP-58XX programmer manuals on the
 * printer's own DVD (printer/Manual/).
 */

const ESC = 0x1b
const GS = 0x1d

/** Printable area of each supported paper size, in printer dots at 203 dpi. */
export const PAPER_DOTS: Record<number, number> = {
  58: 384,
  80: 576,
}

/** Printable width in millimetres — the paper is wider than what the head covers. */
export const PAPER_PRINTABLE_MM: Record<number, number> = {
  58: 48,
  80: 72,
}

export function dotsForPaper(paperWidthMm: number): number {
  return PAPER_DOTS[paperWidthMm] ?? PAPER_DOTS[80]
}

export function printableMmForPaper(paperWidthMm: number): number {
  return PAPER_PRINTABLE_MM[paperWidthMm] ?? PAPER_PRINTABLE_MM[80]
}

/** ESC @ — clear the buffer and reset every mode left over from the last job. */
export function init(): Buffer {
  return Buffer.from([ESC, 0x40])
}

/** ESC a n — 0 left, 1 centre, 2 right. */
export function align(mode: 'left' | 'center' | 'right'): Buffer {
  const n = mode === 'center' ? 1 : mode === 'right' ? 2 : 0
  return Buffer.from([ESC, 0x61, n])
}

/** ESC d n — feed n lines. */
export function feed(lines: number): Buffer {
  return Buffer.from([ESC, 0x64, Math.max(0, Math.min(255, Math.round(lines)))])
}

/**
 * GS V m — cut. A partial cut leaves a small tab holding the receipt on, which is
 * what a counter wants: the ticket stays put until someone tears it off, instead of
 * dropping on the floor. `feedBefore` pushes the print past the blade first, since
 * the cutter sits several millimetres above the head.
 */
export function cut(partial = true, feedBefore = 4): Buffer {
  return Buffer.concat([
    feed(feedBefore),
    Buffer.from([GS, 0x56, partial ? 0x42 : 0x41, 0x00]),
  ])
}

/**
 * ESC p m t1 t2 — kick the cash drawer connected to the printer's RJ11 port.
 * Pin 2 is the near-universal wiring; pin 5 exists for the rare drawer that uses it.
 * The pulse widths are in 2 ms units: 25/250 is the value XPrinter's own manual uses.
 */
export function openDrawer(pin: 2 | 5 = 2): Buffer {
  return Buffer.from([ESC, 0x70, pin === 5 ? 0x01 : 0x00, 0x19, 0xfa])
}

/**
 * ESC B n t — sound the printer's buzzer n times, each lasting t × 50ms.
 *
 * This is the one command here that is NOT safe to assume. Cut, feed and drawer are
 * core ESC/POS that every printer in this class implements; the buzzer is a Xinye
 * extension, present only on models that physically have a beeper. A model without
 * one may ignore the bytes — or may print them, putting stray characters on the
 * paper.
 *
 * Two things follow from that, and both are deliberate:
 *
 *   it is off until switched on   per printer, with a test button next to it, so it
 *                                 is proven on the actual hardware before it is
 *                                 anywhere near a customer's receipt;
 *   it goes AFTER the cut         so on a printer that does print it, the stray marks
 *                                 land on the next ticket's leader rather than in the
 *                                 middle of the one being served.
 *
 * Defaults of 2 beeps × 150ms: long enough to carry across a kitchen, short enough
 * not to become the thing everyone wants switched off by Friday.
 */
export function beep(times = 2, durationUnits = 3): Buffer {
  const n = Math.max(1, Math.min(9, Math.round(times)))
  const t = Math.max(1, Math.min(9, Math.round(durationUnits)))
  return Buffer.from([ESC, 0x42, n, t])
}

/**
 * The tallest ticket we will ever send — about 50cm of paper at 203dpi. Nothing this
 * restaurant prints comes close, so exceeding it means a fault upstream, and the way
 * that fault presents itself is a printer emptying the roll onto the floor.
 */
export const MAX_TICKET_DOTS = 4000

/**
 * The ceiling for a REPORT — a close-out or a sales sheet — about 5m at 203dpi.
 *
 * A report is as long as the day was busy: a line per invoice, and a good Friday has
 * hundreds. Held to the ticket limit, the close-out refused to print on exactly the
 * days it mattered most. It still has a ceiling, because the fault the limit exists
 * for — a page that never ends — is the same fault whatever is being printed.
 */
export const MAX_REPORT_DOTS = 40000

/** A 1-bit-per-pixel bitmap, packed MSB-first, where a set bit means a black dot. */
export interface MonoBitmap {
  width: number
  height: number
  /** ceil(width / 8) * height bytes. */
  data: Buffer
}

/**
 * GS v 0 — print a raster bitmap.
 *
 * The image is emitted in horizontal bands rather than as one command. Printers in
 * this class have a receipt-sized input buffer, and a full-page image sent as a
 * single command overruns it: the print comes out truncated or garbled, with no
 * error anywhere. Banding keeps each command well inside the buffer, and the
 * printer stitches the bands back together with no visible seam.
 */
export function rasterImage(bmp: MonoBitmap, bandHeight = 24): Buffer {
  const widthBytes = Math.ceil(bmp.width / 8)
  const parts: Buffer[] = []

  // A band this size is what the XPrinter manuals themselves use, and it matters more
  // than it looks. If the printer's input buffer fills mid-band it drops bytes, and a
  // raster command that loses bytes does not fail — the printer keeps consuming the
  // rest of the receipt as though it were still image data, then as though it were
  // commands, and runs paper until it is switched off. Small bands give the head time
  // to drain between them, so a stall costs a pause rather than the whole roll.
  if (bandHeight < 1 || bandHeight > 255) bandHeight = 24

  for (let y = 0; y < bmp.height; y += bandHeight) {
    const rows = Math.min(bandHeight, bmp.height - y)
    const header = Buffer.from([
      GS, 0x76, 0x30, 0x00,
      widthBytes & 0xff, (widthBytes >> 8) & 0xff,
      rows & 0xff, (rows >> 8) & 0xff,
    ])
    parts.push(header, bmp.data.subarray(y * widthBytes, (y + rows) * widthBytes))
  }

  return Buffer.concat(parts)
}

/**
 * Pack the BGRA pixels Chromium hands back into the 1-bit rows the printer wants.
 *
 * Anything darker than `threshold` becomes a dot. There is no dithering on purpose:
 * receipts are black text on white, and dithering solid text turns it into a grey
 * mesh that a thermal head prints as mush. Rows are padded to a byte boundary with
 * white, so an image whose width is not a multiple of 8 does not shear.
 */
export function bgraToMono(
  bgra: Buffer,
  width: number,
  height: number,
  threshold = 160,
): MonoBitmap {
  const widthBytes = Math.ceil(width / 8)
  const out = Buffer.alloc(widthBytes * height, 0)

  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4
    const outRow = y * widthBytes
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4
      const b = bgra[i], g = bgra[i + 1], r = bgra[i + 2], a = bgra[i + 3]

      // Un-premultiply against white: a transparent pixel is paper, not black.
      const alpha = a / 255
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) * alpha + 255 * (1 - alpha)

      if (lum < threshold) {
        out[outRow + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }

  return { width, height, data: out }
}

/**
 * The bytes for one complete ticket: reset, centre, image, cut, and optionally the
 * drawer kick. The drawer is kicked BEFORE the cut so the till opens the moment the
 * paper starts moving rather than after the cashier has already reached for it.
 */
export function buildTicket(bmp: MonoBitmap, opts: {
  cutPaper: boolean
  openDrawer: boolean
  drawerPin?: 2 | 5
  /** Sound the buzzer once the paper is cut — see beep() for why it goes last. */
  beep?: boolean
  /** Tallest bitmap to accept. Defaults to the ticket limit; reports pass their own. */
  maxDots?: number
}): Buffer {
  // Roughly 50cm of paper at 203dpi. No receipt this restaurant prints is anywhere
  // near it, so a bitmap that tall means something upstream is wrong — and the way
  // that failure shows up is a printer running the roll onto the floor. Refuse to
  // send it rather than find out at the counter.
  if (bmp.height > (opts.maxDots ?? MAX_TICKET_DOTS)) {
    throw new Error(
      `الفاتورة أطول من الحد المسموح (${bmp.height} نقطة) — تم إيقاف الطباعة لتفادي استهلاك الورق`,
    )
  }

  const parts: Buffer[] = [init(), align('center'), rasterImage(bmp)]
  if (opts.openDrawer) parts.push(openDrawer(opts.drawerPin ?? 2))
  parts.push(opts.cutPaper ? cut(true) : feed(5))
  // Last, so the ticket is complete and cut before the kitchen is told to look at it —
  // and so a printer that cannot beep marks the next leader, not this ticket.
  if (opts.beep) parts.push(beep())
  return Buffer.concat(parts)
}
