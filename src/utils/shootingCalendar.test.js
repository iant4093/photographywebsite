import { describe, expect, it } from 'vitest'
import { buildYear, calendarDays, calendarYears, countLabel, formatDay, levelFor } from './shootingCalendar'

const calendar = {
    albums: ['trip', 'walk', 'reel'],
    days: [
        ['2025-12-31', 4, 0, [1]],
        ['2026-01-01', 10, 0, [0]],
        ['2026-01-02', 2, 1, [0, 2]],
        ['2026-01-03', 30, 0, [0, 9]],
        ['2026-01-05', 1, 0, [1]],
        ['2026-02-30', 5, 0, [0]],
        ['not a day', 5, 0, [0]],
        ['2026-03-01', 0, 0, [0]],
        'junk',
    ],
}

describe('shooting calendar data', () => {
    it('keeps real days with work, resolving album ids', () => {
        const days = calendarDays(calendar)
        expect([...days.keys()]).toEqual(['2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05'])
        expect(days.get('2026-01-02')).toEqual({ date: '2026-01-02', photos: 2, videos: 1, total: 3, albumIds: ['trip', 'reel'] })
        expect(days.get('2026-01-03').albumIds).toEqual(['trip'])
        expect(calendarYears(days)).toEqual([2026, 2025])
        expect(calendarDays(null).size).toBe(0)
        expect(calendarDays({ albums: 'x', days: [['2026-01-01', 'x', -2]] }).size).toBe(0)
    })

    it('grades days into four levels by quartile', () => {
        expect(levelFor(0, [1, 2, 3])).toBe(0)
        expect([1, 2, 3, 4].map((total) => levelFor(total, [1, 2, 3]))).toEqual([1, 2, 3, 4])
    })

    it('lays the year out in Sunday-first weeks with months and a summary', () => {
        const year = buildYear(calendarDays(calendar), 2026, new Date(2026, 0, 4))
        // Jan 1 2026 is a Thursday, so the first week starts on Sunday Dec 28.
        expect(year.weeks[0].slice(0, 4)).toEqual([null, null, null, null])
        expect(year.weeks[0][4]).toMatchObject({ date: '2026-01-01', total: 10 })
        expect(year.weeks).toHaveLength(53)
        expect(year.weeks.flat().filter(Boolean)).toHaveLength(365)
        expect(year.months[0]).toEqual({ month: 0, week: 0 })
        expect(year.months).toHaveLength(12)
        expect(year.weeks[1][1]).toMatchObject({ date: '2026-01-05', level: 1, future: true })
        expect(year.weeks[0][6]).toMatchObject({ date: '2026-01-03', level: 4, future: false })
        expect(year.summary).toEqual({
            days: 4,
            photos: 43,
            videos: 1,
            longestStreak: 3,
            busiest: expect.objectContaining({ date: '2026-01-03' }),
        })
        expect(buildYear(new Map(), 2024).summary).toEqual({ days: 0, photos: 0, videos: 0, longestStreak: 0, busiest: null })
    })

    it('formats days and counts', () => {
        expect(formatDay('2026-01-03')).toBe('Saturday, January 3, 2026')
        expect(formatDay('2026-01-03', 'short')).toBe('Jan 3')
        expect(formatDay('nope')).toBe('')
        expect(countLabel(1, 0)).toBe('1 photo')
        expect(countLabel(1200, 2)).toBe('1,200 photos · 2 videos')
        expect(countLabel(0, 1)).toBe('1 video')
        expect(countLabel(0, 0)).toBe('Nothing published')
    })
})
