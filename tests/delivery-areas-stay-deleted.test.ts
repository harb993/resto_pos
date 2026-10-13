import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, closeDatabase, getDb } from '../src/main/db/db'

/**
 * A deleted delivery area must stay deleted.
 *
 * The seeder asked "is this table empty?" and refilled it if so. That is not the same
 * question as "has this database ever been given the examples", and the difference
 * undid people's work: the owner removed the districts the shop does not deliver to,
 * restarted the till, and every one of them was back — names and fees — on the counter
 * screen. Reported from this restaurant about الدقي, which came back twice.
 */

const areas = () => getDb()
  .prepare('SELECT area_name FROM delivery_areas ORDER BY area_name')
  .all()
  .map((r: any) => r.area_name)

/** What a restart does: the connection goes, the file stays, the seeders run again. */
const restart = () => { closeDatabase(); initDatabase() }

beforeAll(() => { initDatabase() })

describe('the example areas', () => {
  it('are given to a brand-new database once', () => {
    expect(areas().length).toBeGreaterThan(0)
  })

  it('are not given again on the next launch', () => {
    const first = areas()
    restart()
    expect(areas()).toEqual(first)
  })
})

describe('deleting one', () => {
  it('keeps it gone across a restart', () => {
    expect(areas()).toContain('الدقي')

    getDb().prepare('DELETE FROM delivery_areas WHERE area_name = ?').run('الدقي')
    expect(areas()).not.toContain('الدقي')

    restart()
    expect(areas(), 'الدقي must not come back').not.toContain('الدقي')
  })
})

describe('deleting all of them', () => {
  it('leaves the list empty, and it stays empty', () => {
    // A shop that delivers nowhere, or one about to type in its own districts. Either
    // way an empty list is an answer, not a database waiting to be refilled.
    getDb().prepare('DELETE FROM delivery_areas').run()
    expect(areas()).toEqual([])

    restart()
    expect(areas(), 'this is the one that refilled the table').toEqual([])

    restart()
    expect(areas()).toEqual([])
  })
})
