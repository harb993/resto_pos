import { describe, it, expect } from 'vitest'
import { registerWhatsappIpc } from '../src/main/ipc/whatsapp.ipc'
import { isLocalChannel } from '../src/main/net/router'

/**
 * A node's own screens run these on the node itself — none of them ever crosses the
 * wire. One arriving at the master from a till would drive the master's own WhatsApp
 * window and clipboard, so the master refuses them (masterLink.serveForTill).
 */
describe('channels that belong to the machine they run on', () => {
  registerWhatsappIpc()

  it('the WhatsApp window and its campaign are local', () => {
    for (const channel of [
      'whatsapp:campaignStart', 'whatsapp:campaignAgain', 'whatsapp:campaignStop',
      'whatsapp:campaignStatus', 'whatsapp:showWindow', 'whatsapp:openChat',
      'whatsapp:pickImage', 'whatsapp:clearImage',
    ]) {
      expect(isLocalChannel(channel), channel).toBe(true)
    }
  })

  it('the customer notes are the shop’s books, and a till may still reach them', () => {
    for (const channel of ['whatsapp:getNotes', 'whatsapp:addNote', 'whatsapp:deleteNote']) {
      expect(isLocalChannel(channel), channel).toBe(false)
    }
  })
})
