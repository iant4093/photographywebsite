import { describe, expect, it } from 'vitest'
import { currentLocalDateInputValue, isWithinRecentDays } from './date'

describe('currentLocalDateInputValue', () => {
    it('formats the local calendar date instead of the UTC date', () => {
        const localDate = {
            getFullYear: () => 2026,
            getMonth: () => 7,
            getDate: () => 31,
            toISOString: () => '2026-09-01T06:30:00.000Z',
        }

        expect(currentLocalDateInputValue(localDate)).toBe('2026-08-31')
    })

    it('zero-pads single-digit months and days', () => {
        const localDate = {
            getFullYear: () => 2026,
            getMonth: () => 0,
            getDate: () => 4,
        }

        expect(currentLocalDateInputValue(localDate)).toBe('2026-01-04')
    })
})

describe('isWithinRecentDays', () => {
    const now = Date.parse('2026-08-24T20:00:00Z')

    it('keeps timestamps inside the requested rolling window', () => {
        expect(isWithinRecentDays('2026-08-20T20:00:01Z', 4, now)).toBe(true)
        expect(isWithinRecentDays('2026-08-20T20:00:00Z', 4, now)).toBe(false)
    })

    it('rejects invalid and future timestamps', () => {
        expect(isWithinRecentDays('', 4, now)).toBe(false)
        expect(isWithinRecentDays('2026-08-25T00:00:00Z', 4, now)).toBe(false)
    })
})
