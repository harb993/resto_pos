import { getDb } from '../db/db'
import log from 'electron-log/main'
import type { Expense, ExpenseCategory } from '../../shared/types'

export function addExpense(
  category: ExpenseCategory,
  description: string | null,
  amount: number,
  recordedBy: number,
  expenseDate?: string
): Expense {
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO expenses (category, description, amount, recorded_by, expense_date)
    VALUES (?, ?, ?, ?, COALESCE(?, date('now','localtime')))
  `).run(category, description, amount, recordedBy, expenseDate || null)

  const id = result.lastInsertRowid as number
  log.info(`[Expense] Added expense #${id}: ${category} - ${amount}`)
  return db.prepare('SELECT * FROM expenses WHERE expense_id = ?').get(id) as Expense
}

export function listExpenses(filters: {
  dateFrom?: string
  dateTo?: string
  category?: string
} = {}): Expense[] {
  const db = getDb()
  const conditions: string[] = []
  const params: any[] = []

  if (filters.dateFrom) {
    conditions.push('e.expense_date >= ?')
    params.push(filters.dateFrom)
  }
  if (filters.dateTo) {
    conditions.push('e.expense_date <= ?')
    params.push(filters.dateTo)
  }
  if (filters.category) {
    conditions.push('e.category = ?')
    params.push(filters.category)
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''
  return db.prepare(`
    SELECT e.*, u.full_name as recorded_by_name
    FROM expenses e
    JOIN users u ON u.user_id = e.recorded_by
    ${where}
    ORDER BY e.expense_date DESC, e.created_at DESC
    LIMIT 500
  `).all(...params) as Expense[]
}

export function deleteExpense(expenseId: number): void {
  const db = getDb()
  db.prepare('DELETE FROM expenses WHERE expense_id = ?').run(expenseId)
  log.info(`[Expense] Deleted expense #${expenseId}`)
}

export function getExpensesTotal(dateFrom: string, dateTo: string): number {
  const db = getDb()
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses
    WHERE expense_date BETWEEN ? AND ?
  `).get(dateFrom, dateTo) as { total: number }
  return row.total
}
