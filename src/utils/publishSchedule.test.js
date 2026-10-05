import { describe, expect, it, vi } from 'vitest'
import {
    defaultPublishValue, formatPublishAt, localDateTimeValue, publishAtIso, publishScheduleError, timeZoneName,
} from './publishSchedule'

describe('publish schedule helpers', () => {
    const now = new Date(2026, 9, 5, 14, 7, 30)

    it('converts between local input values and ISO times', () => {
        expect(localDateTimeValue(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02T03:04')
        expect(localDateTimeValue(new Date('nope'))).toBe('')
        expect(localDateTimeValue('2026-01-02')).toBe('')
        expect(publishAtIso('2026-01-02T03:04')).toBe(new Date(2026, 0, 2, 3, 4).toISOString())
        expect(publishAtIso('2026-01-02')).toBeNull()
        expect(publishAtIso('2026-13-45T99:99')).toBeNull()
        expect(publishAtIso(null)).toBeNull()
    })

    it('starts on the quarter hour at least an hour ahead', () => {
        expect(defaultPublishValue(now)).toBe('2026-10-05T15:15')
        expect(defaultPublishValue(new Date(2026, 9, 5, 14, 0))).toBe('2026-10-05T15:00')
        expect(defaultPublishValue(new Date(2026, 9, 5, 23, 50))).toBe('2026-10-06T01:00')
        expect(defaultPublishValue()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    })

    it('explains unusable times', () => {
        expect(publishScheduleError('', now)).toBe('Choose a date and time to publish.')
        expect(publishScheduleError('2026-10-05T14:00', now)).toBe('Choose a time in the future.')
        expect(publishScheduleError('2027-11-01T09:00', now)).toBe('Choose a time within the next year.')
        expect(publishScheduleError('2026-10-06T09:00', now)).toBe('')
        expect(publishScheduleError('2099-01-01T09:00')).toBe('Choose a time within the next year.')
    })

    it('formats times for people and names the time zone', () => {
        expect(formatPublishAt('2026-10-06T17:30:00Z')).toMatch(/2026/)
        expect(formatPublishAt('')).toBe('')
        expect(formatPublishAt('later')).toBe('')
        expect(typeof timeZoneName()).toBe('string')
        const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new Error('no intl') })
        expect(timeZoneName()).toBe('')
        spy.mockRestore()
    })
})
