import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, closeDatabase, getDb } from '../src/main/db/db'

/**
 * A deleted delivery area must stay deleted.
 *
 * An earlier seeder asked "is this table empty?" and refilled it if so, which undid
 * people's work: the owner removed the districts the shop does not deliver to,
 * restarted the till, and every one of them was back on the counter screen. There are
 * no example areas now, and nothing may refill the list behind the owner's back.
 */

const areas = () => getDb()
  .prepare('SELECT area_name FROM delivery_areas ORDER BY area_name')
  .all()
  .map((r: any) => r.area_name)

/** What a restart does: the connection goes, the file stays, the seeders run again. */
const restart = () => { closeDatabase(); initDatabase() }

beforeAll(() => { initDatabase() })

const add = (name: string, fee: number) =>
  getDb().prepare('INSERT INTO delivery_areas (area_name, delivery_fee) VALUES (?, ?)').run(name, fee)

describe('a brand-new database', () => {
  it('starts with no example areas — the shop types in its own', () => {
    // It used to arrive with Cairo districts. أبو الدهب is on the North Coast; a list
    // of places the shop has never delivered to is only something to delete.
    expect(areas()).toEqual([])
  })

  it('stays empty across a restart', () => {
    restart()
    expect(areas()).toEqual([])
  })
})

describe('the areas the owner adds', () => {
  it('survive a restart', () => {
    add('زاوية العوامة', 10)
    add('الحمام', 25)
    restart()
    expect(areas()).toEqual(['الحمام', 'زاوية العوامة'])
  })

  it('stay gone once deleted', () => {
    getDb().prepare('DELETE FROM delivery_areas WHERE area_name = ?').run('الحمام')
    restart()
    expect(areas(), 'a deleted area must not come back').toEqual(['زاوية العوامة'])
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
