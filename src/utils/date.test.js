import { describe, expect, it } from 'vitest'
import { currentLocalDateInputValue } from './date'

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
