import { app, BrowserWindow, shell } from 'electron'
import log from 'electron-log/main'
import { handle, handleLocal } from '../net/router'
import * as whatsapp from '../services/whatsappService'
import { requireOwnerOrAccountant, getCurrentSession } from '../services/authService'
import type { IpcResponse } from '../../shared/types'

/**
 * ONE WhatsApp window for the whole campaign.
 *
 * A campaign used to open a `wa.me` link per customer, and every link became a new
 * browser tab: fifty customers, fifty tabs, each one loading WhatsApp Web from scratch
 * and each one needing to be found again to press send. Now there is a single window,
 * signed in once (the session is kept between runs), and each customer's chat is
 * loaded into that same window in turn.
 *
 * The message is typed in for you; pressing send stays with the person at the screen.
 */
let waWindow: BrowserWindow | null = null

function whatsappWindow(): BrowserWindow {
  if (waWindow && !waWindow.isDestroyed()) return waWindow

  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'واتساب',
    autoHideMenuBar: true,
    webPreferences: {
      // Its own persistent profile: the QR code is scanned once, and nothing WhatsApp
      // stores can reach the till's own page — or the other way round.
      partition: 'persist:whatsapp',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  win.on('closed', () => { if (waWindow === win) waWindow = null })
  waWindow = win
  return win
}

/** Egyptian mobile → international digits, as WhatsApp wants them. */
function whatsappNumber(raw: unknown): string {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.startsWith('20') && digits.length >= 11) return digits
  if (digits.startsWith('0') && digits.length === 11) return '2' + digits
  return digits
}

export function registerWhatsappIpc(): void {
  // Local, always: the window has to open on the machine the person is sitting at,
  // not on the master.
  handleLocal('whatsapp:openChat', async (_e, { phone, text } = {}): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      const number = whatsappNumber(phone)
      if (number.length < 8) throw new Error('رقم الهاتف غير صحيح')

      const win = whatsappWindow()
      const url = `https://web.whatsapp.com/send?phone=${number}` +
        `&text=${encodeURIComponent(String(text ?? ''))}`
      // Not awaited to completion: WhatsApp Web redirects while it loads, which
      // rejects the load promise for a page that is in fact arriving.
      win.loadURL(url).catch(err => log.debug('[WhatsApp] load:', err?.message || err))
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('whatsapp:getNotes', async (_e, { phone }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: whatsapp.getCustomerNotes(phone) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('whatsapp:addNote', async (_e, { phone, note }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      const session = getCurrentSession()
      if (!session) throw new Error('يجب تسجيل الدخول')
      return { success: true, data: whatsapp.addCustomerNote(phone, note, session.userId) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handle('whatsapp:deleteNote', async (_e, { noteId }): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      whatsapp.deleteCustomerNote(noteId)
      return { success: true, data: null }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
