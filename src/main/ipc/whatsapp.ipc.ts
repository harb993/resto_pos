import { BrowserWindow } from 'electron'
import { handle, handleLocal } from '../net/router'
import * as whatsapp from '../services/whatsappService'
import * as sender from '../services/whatsappSender'
import { requireOwnerOrAccountant, getCurrentSession } from '../services/authService'
import type { IpcResponse } from '../../shared/types'

/**
 * WhatsApp marketing: one window, and a campaign that sends itself — see
 * whatsappSender for how and why.
 *
 * Every channel here is LOCAL, always: the WhatsApp window, the picture file and the
 * campaign all belong to the machine the person is sitting at, not to the master.
 */
export function registerWhatsappIpc(): void {
  // Progress goes to this machine's own screens — not the WhatsApp window itself, and
  // not the other till, whose owner did not start anything.
  sender.onCampaignProgress(progress => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w === sender.whatsappWindow.peek()) continue
      w.webContents.send('app:whatsappProgress', progress)
    }
  })

  handleLocal('whatsapp:openChat', async (_e, { phone, text } = {}): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      sender.openChat(phone, text ?? '')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handleLocal('whatsapp:pickImage', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      const parent = BrowserWindow.getFocusedWindow() ?? undefined
      return { success: true, data: await sender.pickPicture(parent) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handleLocal('whatsapp:clearImage', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      sender.clearPicture()
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handleLocal('whatsapp:campaignStart', async (_e, { recipients, text, withPicture } = {}): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: { total: sender.startCampaign(recipients, text, { withPicture: !!withPicture }) } }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Everyone the last campaign has not reached yet — after a stop, a dropped
  // connection, or a few that failed.
  handleLocal('whatsapp:campaignAgain', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: { total: sender.campaignAgain() } }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handleLocal('whatsapp:showWindow', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      sender.showWhatsappWindow()
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  handleLocal('whatsapp:campaignStop', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      sender.stopCampaign()
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // The screen asks on opening, so leaving it mid-campaign and coming back shows the
  // campaign still running rather than an empty form.
  handleLocal('whatsapp:campaignStatus', async (): Promise<IpcResponse> => {
    try {
      requireOwnerOrAccountant()
      return { success: true, data: sender.campaignProgress() }
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
