import { app, BrowserWindow, clipboard, dialog, nativeImage, shell, type NativeImage } from 'electron'
import log from 'electron-log/main'

/**
 * WhatsApp — one window, and a campaign that sends itself.
 *
 * The campaign screen used to open WhatsApp on one customer at a time and wait for a
 * person to press «إرسال» there and «التالي» here, sixty times. Now one press starts
 * it and it goes through the whole list on its own: each customer's chat is opened in
 * the same signed-in WhatsApp window, the message (and picture) goes, and the screen
 * shows who has had it, who could not be reached, and how long is left.
 *
 * How it sends
 * ------------
 * Through WhatsApp Web itself, the way a person would: the chat is opened with the
 * documented `send?phone=…&text=…` link, which types the message in, and the Enter key
 * sends it. A picture is pasted in with Ctrl+V, as if from the clipboard. Nothing
 * reaches into WhatsApp's own code, so an update on their side is far less likely to
 * stop it working than the hooks into its internals that bulk senders use.
 *
 * The key presses go in through the window's own DevTools connection. They arrive as
 * real key presses — and, unlike Electron's sendInputEvent, without the window having
 * to hold the keyboard. So the WhatsApp window stays out of sight while it works, the
 * till keeps the keyboard, and nothing typed at the till can land in a customer's chat.
 *
 * Pace
 * ----
 * Deliberately not as fast as it could go. A number that fires off a message every
 * second looks like what it is, and WhatsApp restricts numbers that look like that.
 * Each chat takes a few seconds to open anyway, and a further pause of a few seconds,
 * never quite the same twice, is added between customers.
 */

// ===== The window =====

let waWindow: BrowserWindow | null = null

/** The app is on its way out: windows close without being asked about. */
let quitting = false
app.on('before-quit', () => { quitting = true })

/**
 * Where WhatsApp Web lives. Only ever changed by the test harness — through the
 * environment of the process, never by anything a screen can send.
 */
const BASE = (process.env.CRISPO_WA_BASE || 'https://web.whatsapp.com').replace(/\/+$/, '')
/** Shortened pauses and time limits for the test harness, again only from the environment. */
const FAST = process.env.CRISPO_WA_FAST === '1'
const limit = (ms: number) => (FAST ? Math.max(1500, ms / 10) : ms)

export function whatsappWindow(): BrowserWindow {
  if (waWindow && !waWindow.isDestroyed()) return waWindow
  return createWhatsappWindow()
}

/** The window if it is open — without opening one just to ask. */
whatsappWindow.peek = (): BrowserWindow | null => (waWindow && !waWindow.isDestroyed() ? waWindow : null)

const busy = () => progress.state === 'sending' || progress.state === 'waiting-login'

function createWhatsappWindow(): BrowserWindow {

  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'واتساب',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      // Its own persistent profile: the QR code is scanned once, and nothing WhatsApp
      // stores can reach the till's own page — or the other way round.
      partition: 'persist:whatsapp',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A campaign runs in a window nobody is looking at; it must not be slowed to a
      // crawl, or treated by the page as hidden, for being out of sight.
      backgroundThrottling: false,
    },
  })

  // WhatsApp Web turns away anything that does not look like a current browser, and
  // Electron's own user agent names Electron and the app.
  const ua = app.userAgentFallback
    .replace(/\s(?!Mozilla|AppleWebKit|Chrome|Safari)[\w.-]+\/[\w.-]+(?=\s|$)/g, '')
  win.webContents.setUserAgent(ua)

  // A link inside a chat opens in the real browser, not in another app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Closing it mid-campaign is as likely to mean "out of my way" as "stop" — ask which.
  win.on('close', event => {
    if (quitting || !busy()) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'واتساب',
      message: 'إرسال الحملة ما زال جارياً',
      detail: `وصلت إلى ${progress.sent} من ${progress.total}. يمكن إخفاء النافذة ويكمل الإرسال وحده.`,
      buttons: ['إخفاء النافذة — يكمل الإرسال', 'إيقاف الإرسال', 'رجوع'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    // Hidden either way rather than closed: a stop still lets the customer in hand be
    // finished (see waitFor), and that needs the window.
    event.preventDefault()
    if (choice === 1) stopRequested = true
    if (choice !== 2) win.hide()
  })

  win.on('closed', () => {
    if (waWindow === win) waWindow = null
    if (busy()) stopRequested = true
  })
  waWindow = win
  return win
}

/** Bring the window up — to watch a campaign, or to sign in. */
export function showWhatsappWindow(): void {
  const win = whatsappWindow()
  if (!win.webContents.getURL()) {
    win.loadURL(BASE).catch(err => log.debug('[WhatsApp] load:', err?.message || err))
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** The till is closing: no question asked, and no campaign left running unseen. */
export function closeWhatsappWindow(): void {
  if (busy()) stopRequested = true
  whatsappWindow.peek()?.destroy()
}

/** Egyptian mobile → international digits, as WhatsApp wants them. */
export function whatsappNumber(raw: unknown): string {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.startsWith('20') && digits.length >= 11) return digits
  if (digits.startsWith('0') && digits.length === 11) return '2' + digits
  return digits
}

export function chatUrl(number: string, text: string): string {
  return `${BASE}/send?phone=${number}` + (text ? `&text=${encodeURIComponent(text)}` : '')
}

/** Open one chat, for a person to deal with by hand — the client book's «فتح واتساب». */
export function openChat(phone: string, text: string): void {
  // Taking the window to another chat would pull it out from under the campaign.
  if (busy()) throw new Error('واتساب مشغول بإرسال الحملة الآن — انتظر حتى ينتهي أو أوقفه')
  const number = whatsappNumber(phone)
  if (number.length < 8) throw new Error('رقم الهاتف غير صحيح')
  const win = whatsappWindow()
  // Not awaited to completion: WhatsApp Web redirects while it loads, which rejects the
  // load promise for a page that is in fact arriving.
  win.loadURL(chatUrl(number, text)).catch(err => log.debug('[WhatsApp] load:', err?.message || err))
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ===== The picture to send with it =====

interface Picture {
  name: string
  image: NativeImage
  png: boolean
}

let picture: Picture | null = null

function loadPicture(path: string): Picture {
  let image = nativeImage.createFromPath(path)
  if (image.isEmpty()) throw new Error('تعذر فتح الصورة — اختر ملف JPG أو PNG')
  // WhatsApp sends nothing bigger than this anyway; a photo straight off a camera would
  // only make every paste slower.
  const { width, height } = image.getSize()
  if (Math.max(width, height) > 1600) {
    image = image.resize(width >= height ? { width: 1600, quality: 'best' } : { height: 1600, quality: 'best' })
  }
  return { name: path.split(/[\\/]/).pop() || 'صورة', image, png: /\.png$/i.test(path) }
}

/** Choose the picture in the main process, so the screen never hands it a file path. */
export async function pickPicture(parent?: BrowserWindow): Promise<{ name: string; preview: string } | null> {
  const options = {
    title: 'اختر صورة العرض',
    filters: [{ name: 'صور', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    properties: ['openFile'] as 'openFile'[],
  }
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (picked.canceled || !picked.filePaths[0]) return null

  picture = loadPicture(picked.filePaths[0])
  return { name: picture.name, preview: picture.image.resize({ width: 240 }).toDataURL() }
}

export function clearPicture(): void {
  picture = null
}

/** For the harness: the picture without a file dialog. */
export function setPictureFromPath(path: string): void {
  picture = loadPicture(path)
}

// ===== The campaign =====

export interface CampaignRecipient {
  phone: string
  name?: string | null
}

export interface CampaignProgress {
  state: 'idle' | 'sending' | 'waiting-login' | 'finished' | 'stopped' | 'error'
  total: number
  done: number
  sent: number
  failed: number
  current: { phone: string; name: string | null } | null
  /** `permanent`: the number is not on WhatsApp — trying again would not change that. */
  failures: { phone: string; name: string | null; reason: string; permanent: boolean }[]
  withPicture: boolean
  startedAt: number | null
  finishedAt: number | null
  /** Seconds a customer has been taking, pauses included — for the time-left estimate. */
  secondsEach: number
  message: string | null
  /** How many customers of this campaign «إعادة المحاولة» would still reach. */
  again: number
}

const idle = (): CampaignProgress => ({
  state: 'idle', total: 0, done: 0, sent: 0, failed: 0, current: null, failures: [],
  withPicture: false, startedAt: null, finishedAt: null, secondsEach: 0, message: null, again: 0,
})

interface Item {
  number: string
  phone: string
  name: string | null
  status: 'pending' | 'sent' | 'failed' | 'invalid'
}

/** The last campaign started — kept so the customers it did not reach can be tried again. */
let last: { items: Item[]; body: string; picture: Picture | null } | null = null

let progress: CampaignProgress = idle()
let stopRequested = false
/** Time spent waiting for the QR code to be scanned — not part of how long a customer takes. */
let loginWaitMs = 0
let listener: ((p: CampaignProgress) => void) | null = null

export function onCampaignProgress(fn: ((p: CampaignProgress) => void) | null): void {
  listener = fn
}

export function campaignProgress(): CampaignProgress {
  return { ...progress, failures: [...progress.failures] }
}

function report(patch: Partial<CampaignProgress>): void {
  const again = last ? last.items.filter(i => i.status === 'pending' || i.status === 'failed').length : 0
  progress = { ...progress, ...patch, again }
  try { listener?.(campaignProgress()) } catch (err) { log.warn('[WhatsApp] progress listener failed:', err) }
}

export function stopCampaign(): void {
  if (busy()) stopRequested = true
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** A pause that is never quite the same twice — see "Pace" above — and that a stop cuts short. */
async function pause(): Promise<void> {
  const until = Date.now() + (FAST ? 150 : 3000 + Math.random() * 4000)
  while (!stopRequested && Date.now() < until) await sleep(Math.min(250, until - Date.now()))
}

/**
 * Send one message — and a picture with it, if one was chosen — to every recipient,
 * one after another, without anybody pressing anything.
 *
 * `{الاسم}` in the text is replaced with each customer's own name.
 *
 * Returns at once; progress arrives through onCampaignProgress.
 */
export function startCampaign(recipients: CampaignRecipient[], text: string, opts: { withPicture?: boolean } = {}): number {
  if (busy()) throw new Error('يوجد إرسال جارٍ بالفعل — انتظر حتى ينتهي أو أوقفه')
  const body = String(text ?? '').trim()
  const pic = opts.withPicture ? picture : null
  if (!body && !pic) throw new Error('اكتب الرسالة أو اختر صورة أولاً')
  if (body.length > 4000) throw new Error('الرسالة أطول من المسموح (4000 حرف)')

  // Each number once, however many times it is in the list.
  const seen = new Set<string>()
  const items: Item[] = []
  for (const r of Array.isArray(recipients) ? recipients : []) {
    const number = whatsappNumber(r?.phone)
    if (!number || seen.has(number)) continue
    seen.add(number)
    items.push({ number, phone: String(r.phone), name: r.name ? String(r.name) : null, status: 'pending' })
  }
  if (items.length === 0) throw new Error('لا يوجد عملاء محددون للإرسال')
  if (items.length > 1000) throw new Error('أقصى عدد في المرة الواحدة 1000 عميل')

  last = { items, body, picture: pic }
  return begin(items)
}

/**
 * The same message again, to every customer of the last campaign it has not reached:
 * those it failed on, and those a stop left waiting. Not the numbers WhatsApp said
 * are not on it.
 */
export function campaignAgain(): number {
  if (busy()) throw new Error('يوجد إرسال جارٍ بالفعل — انتظر حتى ينتهي أو أوقفه')
  const items = last ? last.items.filter(i => i.status === 'pending' || i.status === 'failed') : []
  if (items.length === 0) throw new Error('لا يوجد عملاء متبقون لإعادة الإرسال')
  return begin(items)
}

function begin(items: Item[]): number {
  const campaign = last!
  for (const item of items) item.status = 'pending'
  stopRequested = false
  loginWaitMs = 0
  progress = { ...idle(), state: 'sending', total: items.length, withPicture: !!campaign.picture, startedAt: Date.now() }
  report({})

  void run(items, campaign.body, campaign.picture).catch(err => {
    log.error('[WhatsApp] campaign halted:', err?.message || err)
    report({ state: 'error', current: null, finishedAt: Date.now(), message: err?.message || 'خطأ غير متوقع' })
  })
  return items.length
}

// What one customer's chat came to. The Arabic ones are shown to the owner as they are.
const SENT = 'sent'
const STOPPED = 'stopped'
const SIGN_IN_TIMED_OUT = 'sign-in-timed-out'
const NOT_ON_WHATSAPP = 'الرقم ليس على واتساب'
const BAD_NUMBER = 'رقم غير صحيح'
const NO_CONNECTION = 'لم يفتح واتساب (تأكد من الإنترنت)'
/** Nothing a second try would change. */
const PERMANENT = new Set([NOT_ON_WHATSAPP, BAD_NUMBER])

async function run(items: Item[], body: string, pic: Picture | null) {
  const win = whatsappWindow()

  // Three customers in a row with WhatsApp not opening at all is the connection, not
  // them — better to stop and say so than to fail the rest of the list one by one.
  let offlineInARow = 0

  for (let i = 0; i < items.length; i++) {
    if (stopRequested) break
    const item = items[i]
    report({ current: { phone: item.phone, name: item.name } })

    const text = body.replace(/\{\s*الاسم\s*\}/g, item.name?.trim() || '').replace(/[ \t]{2,}/g, ' ').trim()
    const outcome = item.number.length < 10 ? BAD_NUMBER : await sendOne(win, item.number, text, pic)

    // Stopped half-way through this customer: they are neither sent nor failed.
    if (outcome === STOPPED) break
    if (outcome === SIGN_IN_TIMED_OUT) {
      throw new Error('لم يتم تسجيل الدخول في واتساب — امسح الكود من موبايل المحل ثم اضغط «إعادة المحاولة»')
    }

    item.status = outcome === SENT ? 'sent' : PERMANENT.has(outcome) ? 'invalid' : 'failed'
    const done = progress.done + 1
    const secondsEach = Math.max(0, Date.now() - (progress.startedAt ?? Date.now()) - loginWaitMs) / 1000 / done
    if (item.status === 'sent') {
      report({ done, sent: progress.sent + 1, secondsEach })
    } else {
      report({
        done, failed: progress.failed + 1, secondsEach,
        failures: [...progress.failures, { phone: item.phone, name: item.name, reason: outcome, permanent: item.status === 'invalid' }],
      })
    }

    offlineInARow = outcome === NO_CONNECTION ? offlineInARow + 1 : 0
    if (offlineInARow >= 3) {
      throw new Error('واتساب لا يفتح — تأكد من الإنترنت ثم اضغط «إعادة المحاولة» لإكمال الباقي')
    }
    if (i < items.length - 1) await pause()
  }

  report({
    state: stopRequested ? 'stopped' : 'finished',
    current: null,
    finishedAt: Date.now(),
  })
  log.info(`[WhatsApp] campaign ${stopRequested ? 'stopped' : 'finished'}: ${progress.sent} sent, ${progress.failed} failed of ${progress.total}`)
}

// ===== The page =====

/** Run a snippet in the WhatsApp page; a page that is mid-navigation answers null. */
async function evaluate<T>(win: BrowserWindow, js: string): Promise<T | null> {
  if (win.isDestroyed()) return null
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(js, true) as Promise<T>,
      sleep(8000).then(() => null),
    ])
  } catch {
    return null
  }
}

/**
 * Ask the page the same question until it has an answer, or the time runs out.
 *
 * A stop cuts the wait short — unless something has already gone to this customer
 * (`finishing`), when the rest of it is seen through first. Stopping half-way must not
 * leave somebody with the picture and no message, nor count them as not reached so
 * that «إعادة المحاولة» sends them the same thing twice.
 */
async function waitFor(
  win: BrowserWindow, probe: string, timeoutMs: number,
  opts: { every?: number; finishing?: boolean } = {},
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((stopRequested && !opts.finishing) || win.isDestroyed()) return null
    const answer = await evaluate<string>(win, probe)
    if (answer) return answer
    await sleep(opts.every ?? 350)
  }
  return null
}

/**
 * Press a key in the page — see "How it sends" above for why through DevTools. False
 * if it could not be delivered (DevTools opened on the window, say), so the caller can
 * fall back to clicking.
 */
async function press(win: BrowserWindow, k: { key: string; code: string; keyCode: number; text?: string; modifiers?: number; commands?: string[] }): Promise<boolean> {
  if (win.isDestroyed()) return false
  const dbg = win.webContents.debugger
  // A page swapped out mid-press never answers; do not wait on it for ever.
  const send = (params: Record<string, unknown>) => Promise.race([
    dbg.sendCommand('Input.dispatchKeyEvent', params),
    sleep(5000).then(() => { throw new Error('no answer from the page') }),
  ])
  try {
    if (!dbg.isAttached()) dbg.attach('1.3')
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers ?? 0 }
    await send({
      ...base,
      type: k.text ? 'keyDown' : 'rawKeyDown',
      ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
      ...(k.commands ? { commands: k.commands } : {}),
    })
    await send({ ...base, type: 'keyUp' })
    return true
  } catch (err: any) {
    log.warn('[WhatsApp] key press not delivered:', err?.message || err)
    return false
  }
}

/**
 * Chromium ignores key presses aimed at a page that has not been drawn yet, and a page
 * in a window that is never shown may not have been. Taking a picture of it makes it
 * draw — once is enough for each page loaded.
 */
async function ensurePainted(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || win.isVisible()) return
  try {
    await Promise.race([win.webContents.capturePage(undefined, { stayHidden: false }), sleep(3000)])
  } catch { /* the key presses have their own fallbacks */ }
}

const pressEnter = (win: BrowserWindow) => press(win, { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
const pressPaste = (win: BrowserWindow) => press(win, { key: 'v', code: 'KeyV', keyCode: 86, modifiers: 2, commands: ['paste'] })

/** The message box at the foot of the open chat. */
const COMPOSE = `document.querySelector('#main footer div[contenteditable="true"]')`

/** Put the caret at the end of an editable box, so the key presses go there. */
const caretAtEnd = (box: string) => `(() => {
  const box = ${box}
  if (!box) return false
  box.focus()
  const sel = window.getSelection()
  sel.selectAllChildren(box)
  sel.collapseToEnd()
  return true
})()`

const FOCUS_COMPOSE = caretAtEnd(COMPOSE)

/**
 * A picture's caption box, if the caret is not in it already. WhatsApp puts it there
 * itself when the picture opens; this only makes sure the Enter that follows sends the
 * picture rather than whatever is behind it.
 */
const FOCUS_CAPTION = `(() => {
  const now = document.activeElement
  if (now && now.isContentEditable && !now.closest('#main footer') && !now.closest('#side')) return true
  const boxes = [...document.querySelectorAll('div[contenteditable="true"]')]
    .filter(b => !b.closest('#main footer') && !b.closest('#side'))
  return boxes.length ? ${caretAtEnd('boxes[boxes.length - 1]')} : false
})()`

const COMPOSE_TEXT = `(() => { const b = ${COMPOSE}; return b ? b.innerText.trim() : null })()`
const COMPOSE_EMPTY = `(() => { const b = ${COMPOSE}; return b && b.innerText.trim() === '' ? 'sent' : null })()`

/** A message still showing its clock is only queued, not sent. */
const QUEUED_GONE = `document.querySelector('#main [data-icon="msg-time"]') ? null : 'gone'`

/**
 * What a picture being prepared looks like from outside: one more place to type (its
 * caption), or one more send button that is not the chat's own.
 */
const MEDIA_COUNTS = `[
  document.querySelectorAll('div[contenteditable="true"]').length,
  [...document.querySelectorAll('[data-icon*="send"]')].filter(i => !i.closest('#main footer')).length,
]`
const MEDIA_OPEN = (before: number[]) =>
  `(() => { const [e, s] = ${MEDIA_COUNTS}; return e > ${before[0]} || s > ${before[1]} ? 'open' : null })()`
const MEDIA_CLOSED = (before: number[]) =>
  `(() => { const [e, s] = ${MEDIA_COUNTS}; return e <= ${before[0]} && s <= ${before[1]} ? 'sent' : null })()`

/** The send button, for when Enter has not done it. Matched on its icon or its label, in either language. */
const CLICK_SEND = (where: 'chat' | 'picture') => `(() => {
  const inChat = el => !!el.closest('#main footer')
  const found = [...document.querySelectorAll('[data-icon*="send"], [aria-label="Send"], [aria-label="إرسال"]')]
    .filter(el => ${where === 'chat' ? 'inChat(el)' : "!inChat(el) && !el.closest('#side')"})
  const icon = found[found.length - 1]
  const button = icon && (icon.closest('button, [role="button"]') || icon)
  if (!button) return false
  button.click()
  return true
})()`

/** The picture handed to the chat as a pasted file — for when the Ctrl+V did not take. */
function pasteFile(pic: Picture): string {
  const bytes = pic.png ? pic.image.toPNG() : pic.image.toJPEG(90)
  const [type, name] = pic.png ? ['image/png', 'offer.png'] : ['image/jpeg', 'offer.jpg']
  return `(() => {
    const box = ${COMPOSE}
    if (!box) return false
    const raw = atob('${bytes.toString('base64')}')
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    const data = new DataTransfer()
    data.items.add(new File([bytes], '${name}', { type: '${type}' }))
    box.focus()
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    return true
  })()`
}

/**
 * Where a freshly loaded chat link has got to: 'ready' (the chat is open with the
 * message typed in), 'login', 'invalid', or null for not there yet.
 */
const OPEN_PROBE = (expectText: boolean) => `(() => {
  const q = s => document.querySelector(s)
  const page = document.body ? document.body.innerText : ''
  // The same number open in another browser: WhatsApp asks which one to use. The
  // campaign was started here, so here it is.
  const useHere = [...document.querySelectorAll('button, div[role="button"]')]
    .find(b => /^\\s*(use here|استخدم هنا|استخدام هنا)\\s*$/i.test(b.innerText || ''))
  if (useHere) { useHere.click(); return null }
  // Signed out: WhatsApp is showing the code to scan.
  if (!q('#side') && !q('#main') && (q('canvas[aria-label]') || q('[data-ref]') || /scan|امسح|link with phone|ربط/i.test(page))) return 'login'
  const box = ${COMPOSE}
  if (box && ${expectText ? 'box.innerText.trim().length > 0' : 'true'}) return 'ready'
  // The number has no WhatsApp: a notice, and no chat behind it. Read from the notice
  // only — the chat list beside it can hold any words at all.
  if (!q('#main')) {
    const popups = [...document.querySelectorAll('[role="dialog"], [data-animate-modal-popup]')]
    const notice = popups.length
      ? popups.map(p => p.innerText).join(' ')
      : page.replace(q('#side') ? q('#side').innerText : '', '')
    if (/invalid|غير صالح|غير صحيح|isn.t on whatsapp|ليس على واتساب/i.test(notice)) return 'invalid'
  }
  return null
})()`

/**
 * Open one customer's chat and send.
 * Returns SENT, STOPPED, SIGN_IN_TIMED_OUT or — in Arabic, for the screen — why it could not.
 */
async function sendOne(win: BrowserWindow, number: string, text: string, pic: Picture | null): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (win.isDestroyed()) return STOPPED
    win.loadURL(chatUrl(number, text)).catch(err => log.debug('[WhatsApp] load:', err?.message || err))

    const state = await waitFor(win, OPEN_PROBE(!!text), limit(45_000))
    if (stopRequested || win.isDestroyed()) return STOPPED
    if (state === 'invalid') return NOT_ON_WHATSAPP

    if (state === null) {
      // WhatsApp itself is up and only this chat would not open: the number, not the
      // line — and not worth the same wait twice.
      const up = await evaluate<boolean>(win, `!!document.querySelector('#side')`)
      if (up) return 'لم تفتح المحادثة'
      if (attempt === 0) continue // a slow connection is worth one more go
      return NO_CONNECTION
    }

    if (state === 'login') {
      // Once per machine: the owner scans the code with the shop's phone, and the
      // campaign carries on from this same customer.
      report({ state: 'waiting-login' })
      const began = Date.now()
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      const signedIn = await waitFor(win, `document.querySelector('#side') ? 'in' : null`, limit(10 * 60_000), { every: 1500 })
      loginWaitMs += Date.now() - began
      if (!signedIn) return stopRequested || win.isDestroyed() ? STOPPED : SIGN_IN_TIMED_OUT
      report({ state: 'sending' })
      attempt = -1 // start this customer again, signed in this time
      continue
    }

    // Let the chat settle before pressing anything in it.
    await sleep(FAST ? 50 : 600)
    await ensurePainted(win)
    // The last moment a stop can leave this customer untouched.
    if (stopRequested) return STOPPED

    if (pic) {
      const failed = await sendPicture(win, pic)
      if (failed) return failed
    }

    // ---- Then the message ----
    // Pasting a picture can take the typed text with it as the caption, in which case
    // the box is empty now and there is nothing more to send. From here on this
    // customer is finished, stop or no stop — see waitFor.
    const left = await evaluate<string>(win, COMPOSE_TEXT)
    if (left) {
      await evaluate(win, FOCUS_COMPOSE)
      await pressEnter(win)
      let cleared = await waitFor(win, COMPOSE_EMPTY, limit(2_500), { finishing: true })
      if (!cleared) {
        // A second Enter cannot send it twice: the box empties the moment it goes, and
        // Enter in an empty box sends nothing.
        await ensurePainted(win)
        await evaluate(win, FOCUS_COMPOSE)
        await pressEnter(win)
        cleared = await waitFor(win, COMPOSE_EMPTY, limit(3_000), { finishing: true })
      }
      if (!cleared) {
        await evaluate(win, CLICK_SEND('chat'))
        cleared = await waitFor(win, COMPOSE_EMPTY, limit(6_000), { finishing: true })
      }
      if (!cleared) return win.isDestroyed() ? STOPPED : 'لم تُرسل الرسالة'
    } else if (!pic) {
      return 'لم تُكتب الرسالة في المحادثة'
    }

    // Give it time to leave: opening the next chat straight away would leave a message
    // still waiting in this one.
    await waitFor(win, QUEUED_GONE, limit(15_000), { every: 400, finishing: true })
    return SENT
  }
  return NO_CONNECTION
}

/** What is on the clipboard now, and a way to put it back. */
function borrowClipboard(): () => void {
  try {
    const text = clipboard.readText()
    const image = text ? null : clipboard.readImage()
    return () => {
      try {
        if (text) clipboard.writeText(text)
        else if (image && !image.isEmpty()) clipboard.writeImage(image)
        else clipboard.clear()
      } catch { /* not worth failing a campaign over */ }
    }
  } catch {
    return () => {}
  }
}

/** Paste the picture into the open chat and send it. Null when it has gone. */
async function sendPicture(win: BrowserWindow, pic: Picture): Promise<string | null> {
  const before = (await evaluate<number[]>(win, MEDIA_COUNTS)) ?? [1, 0]
  await evaluate(win, FOCUS_COMPOSE)

  // The clipboard is borrowed for the paste alone — a second or two — and handed back
  // as it was, so whoever is copying and pasting at the till meanwhile hardly notices.
  const giveBack = borrowClipboard()
  let opened: string | null
  try {
    clipboard.writeImage(pic.image)
    await pressPaste(win)
    opened = await waitFor(win, MEDIA_OPEN(before), limit(12_000))
  } finally {
    giveBack()
  }
  if (!opened && !stopRequested) {
    // The paste did not take: hand WhatsApp the picture as a pasted file instead.
    await evaluate(win, pasteFile(pic))
    opened = await waitFor(win, MEDIA_OPEN(before), limit(8_000))
  }
  if (!opened) return stopRequested ? STOPPED : 'تعذر إرفاق الصورة'

  await sleep(FAST ? 100 : 700)
  if (stopRequested) return STOPPED // the picture is only open, not sent

  // Sending: from here this customer is seen through — see waitFor.
  await evaluate(win, FOCUS_CAPTION)
  await pressEnter(win)
  let closed = await waitFor(win, MEDIA_CLOSED(before), limit(6_000), { finishing: true })
  if (!closed) {
    await evaluate(win, CLICK_SEND('picture'))
    closed = await waitFor(win, MEDIA_CLOSED(before), limit(30_000), { finishing: true })
  }
  if (!closed) return win.isDestroyed() ? STOPPED : 'لم تُرسل الصورة'
  await sleep(FAST ? 100 : 900)
  return null
}
