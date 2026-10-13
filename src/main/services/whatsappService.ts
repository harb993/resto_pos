import { getDb } from '../db/db'
import log from 'electron-log/main'

export interface CustomerNote {
  note_id: number
  phone: string
  note: string
  created_by: number
  created_at: string
  creator_name?: string
}

/** Fetch all notes for a customer (newest first). */
export function getCustomerNotes(phone: string): CustomerNote[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT n.*, u.full_name AS creator_name
       FROM customer_notes n
       JOIN users u ON u.user_id = n.created_by
       WHERE n.phone = ?
       ORDER BY n.created_at DESC`
    )
    .all(phone) as CustomerNote[]
}

/** Insert a new feedback note for a customer. */
export function addCustomerNote(
  phone: string,
  note: string,
  createdBy: number
): CustomerNote {
  const db = getDb()
  if (!phone?.trim()) throw new Error('رقم الهاتف مطلوب')
  if (!note?.trim()) throw new Error('نص الملاحظة مطلوب')

  const result = db
    .prepare(
      `INSERT INTO customer_notes (phone, note, created_by)
       VALUES (?, ?, ?)`
    )
    .run(phone.trim(), note.trim(), createdBy)

  const id = result.lastInsertRowid as number
  log.info(`[WhatsApp] Added note #${id} for ${phone}`)

  return db
    .prepare(
      `SELECT n.*, u.full_name AS creator_name
       FROM customer_notes n
       JOIN users u ON u.user_id = n.created_by
       WHERE n.note_id = ?`
    )
    .get(id) as CustomerNote
}

/** Delete a note by ID. */
export function deleteCustomerNote(noteId: number): void {
  const db = getDb()
  const row = db
    .prepare('SELECT note_id FROM customer_notes WHERE note_id = ?')
    .get(noteId)
  if (!row) throw new Error('الملاحظة غير موجودة')
  db.prepare('DELETE FROM customer_notes WHERE note_id = ?').run(noteId)
  log.info(`[WhatsApp] Deleted note #${noteId}`)
}
