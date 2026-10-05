// Shooting calendar: turns the stats snapshot's per-day counts into a
// GitHub-style year grid. Days are calendar dates ("2026-09-12") and are
// handled in UTC so no time zone ever shifts a photo onto another day.

const DAY_MS = 24 * 60 * 60 * 1000
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function utcDay(value) {
    const match = DATE_RE.exec(value || '')
    if (!match) return null
    const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null
}

const dayKey = (time) => new Date(time).toISOString().slice(0, 10)

/** {date: {date, photos, videos, total, albumIds}} from the snapshot's calendar. */
export function calendarDays(calendar) {
    const albums = Array.isArray(calendar?.albums) ? calendar.albums : []
    const days = new Map()
    for (const row of Array.isArray(calendar?.days) ? calendar.days : []) {
        if (!Array.isArray(row) || utcDay(row[0]) === null) continue
        const photos = Math.max(0, Number(row[1]) || 0)
        const videos = Math.max(0, Number(row[2]) || 0)
        if (!photos && !videos) continue
        const albumIds = (Array.isArray(row[3]) ? row[3] : []).map((index) => albums[index]).filter((id) => typeof id === 'string')
        days.set(row[0], { date: row[0], photos, videos, total: photos + videos, albumIds })
    }
    return days
}

/** Years with any shooting, newest first. */
export function calendarYears(days) {
    return [...new Set([...days.keys()].map((date) => Number(date.slice(0, 4))))].sort((a, b) => b - a)
}

/** 1-4 by where a day's count falls among that year's shooting days (quartiles). */
export function levelFor(total, thresholds) {
    if (!total) return 0
    if (total <= thresholds[0]) return 1
    if (total <= thresholds[1]) return 2
    if (total <= thresholds[2]) return 3
    return 4
}

function quartiles(values) {
    const sorted = [...values].sort((a, b) => a - b)
    if (!sorted.length) return [0, 0, 0]
    const at = (fraction) => sorted[Math.floor(fraction * (sorted.length - 1))]
    return [at(0.25), at(0.5), at(0.75)]
}

/**
 * The year as week columns (Sunday first), with month label positions and
 * a summary. `today` bounds the current year so the future stays blank.
 */
export function buildYear(days, year, today = new Date()) {
    const start = Date.UTC(year, 0, 1)
    const end = Date.UTC(year, 11, 31)
    const gridStart = start - new Date(start).getUTCDay() * DAY_MS
    const todayTime = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
    const inYear = [...days.values()].filter((day) => day.date.startsWith(`${year}-`))
    const thresholds = quartiles(inYear.map((day) => day.total))
    const weeks = []
    const months = []
    for (let weekStart = gridStart; weekStart <= end; weekStart += 7 * DAY_MS) {
        const week = []
        for (let offset = 0; offset < 7; offset += 1) {
            const time = weekStart + offset * DAY_MS
            if (time < start || time > end) {
                week.push(null)
                continue
            }
            const date = dayKey(time)
            const day = days.get(date)
            week.push({
                date,
                future: time > todayTime,
                total: day?.total || 0,
                level: levelFor(day?.total || 0, thresholds),
                day: day || null,
            })
            if (new Date(time).getUTCDate() === 1) months.push({ month: new Date(time).getUTCMonth(), week: weeks.length })
        }
        weeks.push(week)
    }

    let longest = 0
    let run = 0
    let previous = null
    for (const day of [...inYear].sort((a, b) => a.date.localeCompare(b.date))) {
        const time = utcDay(day.date)
        run = previous !== null && time - previous === DAY_MS ? run + 1 : 1
        longest = Math.max(longest, run)
        previous = time
    }
    const busiest = inYear.reduce((best, day) => (!best || day.total > best.total ? day : best), null)
    return {
        weeks,
        months,
        summary: {
            days: inYear.length,
            photos: inYear.reduce((sum, day) => sum + day.photos, 0),
            videos: inYear.reduce((sum, day) => sum + day.videos, 0),
            longestStreak: longest,
            busiest,
        },
    }
}

const longDate = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export function formatDay(date, style = 'long') {
    const time = utcDay(date)
    if (time === null) return ''
    return (style === 'short' ? shortDate : longDate).format(new Date(time))
}

export function countLabel(photos, videos) {
    const parts = []
    if (photos) parts.push(`${photos.toLocaleString('en-US')} photo${photos === 1 ? '' : 's'}`)
    if (videos) parts.push(`${videos.toLocaleString('en-US')} video${videos === 1 ? '' : 's'}`)
    return parts.join(' · ') || 'Nothing published'
}
