/**
 * Turning receipt markup into something a printer will take.
 *
 * Two outputs, because there are two ways to reach these printers:
 *   - `renderToMono` rasterises the page to 1-bit dots for the ESC/POS paths;
 *   - `printViaDriver` hands the page to the Windows driver as an ordinary print job.
 *
 * Both go through an off-screen Chromium window, which is what shapes the Arabic.
 */

import { BrowserWindow, app } from 'electron'
import log from 'electron-log/main'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { bgraToMono, type MonoBitmap } from './escpos'

/** Chromium lays pages out at 96 CSS pixels to the inch, whatever the printer does. */
const CSS_PX_PER_INCH = 96
const MICRONS_PER_INCH = 25400

export function mmToMicrons(mm: number): number {
  return Math.round(mm * 1000)
}

export function cssPxToMicrons(px: number): number {
  return Math.round((px / CSS_PX_PER_INCH) * MICRONS_PER_INCH)
}

export function mmToCssPx(mm: number): number {
  return Math.round((mm / MICRONS_PER_INCH) * 1000 * CSS_PX_PER_INCH)
}

/** Ceiling on how tall one ticket may be, in CSS pixels of the render surface. */
const MAX_TICKET_PX = 40000

/**
 * Past this height a ticket is captured in slices rather than in one frame.
 *
 * A close-out with a line per invoice runs to metres, and a render surface that tall
 * is past what the compositor will hand back as a single image — the capture comes
 * back empty or cut short. So the window stays one slice high and the page is scrolled
 * under it, a slice at a time, and the slices are stacked back into one bitmap. An
 * ordinary receipt is far below this and takes the single-frame path it always has.
 */
const SINGLE_CAPTURE_PX = 4000
const SLICE_PX = 2000

/** Longest single page handed to a Windows driver — about 80cm. */
const DRIVER_PAGE_PX = 3000

function tempHtmlPath(): string {
  const dir = path.join(app.getPath('temp'), 'resto-pos-print')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `ticket-${randomUUID()}.html`)
}

/**
 * ONE render window per mode, kept alive between tickets.
 *
 * Creating and destroying an off-screen window per ticket does not survive: the
 * second window's load aborts with ERR_FAILED, which on an order that fans out to
 * four printers means only the first one ever prints. Reusing the window also skips
 * the window-creation cost on every sale, which is most of the time a ticket takes.
 *
 * `offscreen` is not an optimisation either — it is the reason capture works at all.
 * A merely hidden window is free to skip compositing and capturePage() on one comes
 * back blank on some machines; an off-screen window always renders. The driver path
 * does not capture anything, so it uses a normal hidden window.
 */
const windows: Partial<Record<'raster' | 'driver', BrowserWindow>> = {}

function renderWindow(mode: 'raster' | 'driver', widthPx: number): BrowserWindow {
  const existing = windows[mode]
  if (existing && !existing.isDestroyed()) return existing

  const win = new BrowserWindow({
    width: widthPx,
    height: 600,
    show: false,
    useContentSize: true,
    frame: false,
    webPreferences: {
      offscreen: mode === 'raster',
      // A ticket is markup we generated, with every value out of the database
      // escaped on the way in — but it still gets no bridge to the app and no Node.
      // (Scripting stays on: measuring the rendered height needs executeJavaScript.)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })

  // If it ever does go away — app shutting down, renderer crash — drop the handle so
  // the next ticket builds a fresh one instead of talking to a dead window.
  win.on('closed', () => { delete windows[mode] })
  windows[mode] = win
  return win
}

/** Load the markup into the shared window and size it to the finished ticket. */
async function layOutTicket(
  html: string,
  widthPx: number,
  mode: 'raster' | 'driver',
): Promise<{ win: BrowserWindow; heightPx: number; cleanup: () => void }> {
  const file = tempHtmlPath()
  fs.writeFileSync(file, html, 'utf8')

  // The window is shared, so cleanup drops the temp file but leaves the window up.
  const cleanup = () => {
    try { fs.unlinkSync(file) } catch { /* a leftover temp file is not worth an error */ }
  }

  try {
    const win = renderWindow(mode, widthPx)
    // Reset the height before loading: a tall ticket followed by a short one would
    // otherwise be captured inside the previous ticket's viewport, trailing blank paper.
    win.setContentSize(widthPx, 600)
    await win.loadFile(file)

    // Fonts arrive after first paint; measuring before they land gives a height that
    // clips the last line or two off the bottom of the ticket.
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')

    const measured = (await win.webContents.executeJavaScript(
      'Math.ceil(document.documentElement.getBoundingClientRect().height)',
    )) as number

    const heightPx = Math.max(1, Math.min(MAX_TICKET_PX, Math.ceil(measured) || 600))
    if (mode === 'raster' && heightPx > SINGLE_CAPTURE_PX) {
      // Captured a slice at a time — see SLICE_PX. The page now scrolls, and a
      // scrollbar down the side would be burnt into every slice.
      win.setContentSize(widthPx, SLICE_PX)
      await win.webContents.insertCSS('::-webkit-scrollbar { display: none; }')
    } else {
      win.setContentSize(widthPx, heightPx)
    }

    touchIdleTimer()
    return { win, heightPx, cleanup }
  } catch (err) {
    cleanup()
    touchIdleTimer()
    throw err
  }
}

/** Let go of the render windows — called on shutdown so they cannot hold the app open. */
export function closeRenderWindows(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  for (const mode of ['raster', 'driver'] as const) {
    const win = windows[mode]
    if (win && !win.isDestroyed()) win.destroy()
    delete windows[mode]
  }
}

/**
 * A held-open render window is invisible but still a window, and Electron's
 * 'window-all-closed' does not fire while one exists — so a POS whose window had
 * been closed would sit in the task list forever. Releasing them after a quiet spell
 * fixes that, and hands back the memory on a machine that is usually the cheapest PC
 * in the building. A till in service prints often enough to keep them warm.
 */
const IDLE_RELEASE_MS = 90_000
let idleTimer: NodeJS.Timeout | null = null

function touchIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    closeRenderWindows()
    log.debug('[Print] Render windows released after idle')
  }, IDLE_RELEASE_MS)
  // Do not let this timer alone keep the process alive at shutdown.
  idleTimer.unref?.()
}

/** Give the compositor a frame or two to catch up with the resize before capturing. */
function settle(ms = 60): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * One frame of the render window as printer dots.
 *
 * `exactHeight` is for a slice of a long page, where every slice has to come out the
 * same number of rows or the stacked result shears at each join.
 */
async function captureMono(
  win: BrowserWindow,
  widthPx: number,
  threshold: number,
  exactHeight?: number,
): Promise<MonoBitmap> {
  await settle(exactHeight ? 120 : 60)
  let image = await win.webContents.capturePage()

  // An empty capture means the first frame had not landed yet. One retry costs a
  // few milliseconds and turns an occasional blank receipt into a printed one.
  if (image.isEmpty()) {
    await settle(180)
    image = await win.webContents.capturePage()
  }
  if (image.isEmpty()) {
    throw new Error('تعذر تجهيز صورة الفاتورة للطباعة')
  }

  const size = image.getSize()
  if (exactHeight && (size.width !== widthPx || size.height !== exactHeight)) {
    image = image.resize({ width: widthPx, height: exactHeight, quality: 'best' })
  } else if (size.width !== widthPx) {
    image = image.resize({ width: widthPx, quality: 'best' })
  }

  const finalSize = image.getSize()
  return bgraToMono(image.toBitmap(), finalSize.width, finalSize.height, threshold)
}

/**
 * Rasterise a ticket to the printer's dot grid.
 *
 * `widthPx` is in printer dots — 576 for an 80mm roll, 384 for 58mm — and the page
 * is laid out at exactly that many CSS pixels, so one CSS pixel is one dot and no
 * resampling of the text is needed. On a HiDPI machine Chromium hands back a larger
 * capture than asked for; that is scaled back down here, which if anything sharpens
 * the result, since the downscale supersamples before the black/white threshold.
 */
export async function renderToMono(
  html: string,
  widthPx: number,
  threshold = 160,
): Promise<MonoBitmap> {
  const { win, heightPx, cleanup } = await layOutTicket(html, widthPx, 'raster')

  try {
    if (heightPx <= SINGLE_CAPTURE_PX) return await captureMono(win, widthPx, threshold)

    // Too tall for one frame: scroll the page under a slice-high window and stack
    // the slices.
    const widthBytes = Math.ceil(widthPx / 8)
    const parts: Buffer[] = []
    for (let y = 0; y < heightPx; y += SLICE_PX) {
      // The page cannot scroll past its own end, so the last slice comes back
      // starting higher than asked. Where it really landed says how many rows at the
      // top of it have already been taken.
      const scrolled = (await win.webContents.executeJavaScript(`
        new Promise(resolve => {
          window.scrollTo(0, ${y})
          const done = () => resolve(Math.round(window.scrollY))
          requestAnimationFrame(() => requestAnimationFrame(done))
          setTimeout(done, 300)
        })
      `)) as number

      const slice = await captureMono(win, widthPx, threshold, SLICE_PX)
      const skip = Math.max(0, Math.min(SLICE_PX, y - (Number(scrolled) || 0)))
      const take = Math.min(SLICE_PX - skip, heightPx - y)
      if (take <= 0) continue
      parts.push(slice.data.subarray(skip * widthBytes, (skip + take) * widthBytes))
    }

    const data = Buffer.concat(parts)
    return { width: widthPx, height: data.length / widthBytes, data }
  } finally {
    cleanup()
    log.debug(`[Print] Rasterised ${widthPx}×${heightPx} ticket`)
  }
}

/**
 * Print through the installed Windows driver.
 *
 * Here the page is laid out in real CSS pixels of the printable width (72mm for an
 * 80mm roll), not in dots, and the paper is declared as a custom page exactly as
 * tall as the content — otherwise the driver pads every receipt out to a full A4
 * page and the printer spits a foot of blank paper after each sale.
 */
export async function printViaDriver(
  html: string,
  opts: {
    deviceName: string
    /** Printable width in millimetres. */
    printableMm: number
    copies?: number
  },
): Promise<void> {
  const widthPx = mmToCssPx(opts.printableMm)
  const { win, heightPx, cleanup } = await layOutTicket(html, widthPx, 'driver')

  try {
    await settle()
    await new Promise<void>((resolve, reject) => {
      win.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName: opts.deviceName,
          copies: Math.max(1, opts.copies ?? 1),
          margins: { marginType: 'none' },
          pageSize: {
            width: mmToMicrons(opts.printableMm),
            // A driver refuses a page metres long, so a close-out goes out as
            // several pages of ordinary length instead of one it will not take.
            height: cssPxToMicrons(Math.min(heightPx, DRIVER_PAGE_PX)),
          },
        },
        (success, failureReason) => {
          if (success) resolve()
          else reject(new Error(failureReason || 'تعذر إرسال المهمة إلى الطابعة'))
        },
      )
    })
  } finally {
    // The spooler has copied the job by the time the callback fires, so tearing the
    // window down here does not truncate anything.
    cleanup()
  }
}
