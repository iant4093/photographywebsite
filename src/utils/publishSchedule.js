// Scheduled publishing: an album stays link-only (sharing off) until its time,
// then the server moves it to the main gallery within a few minutes.

export const PUBLISH_CHECK_MINUTES = 5
const YEAR_MS = 365 * 24 * 60 * 60 * 1000
const pad = (value) => String(value).padStart(2, '0')

/** A Date as a datetime-local input value, in the browser's time zone. */
export function localDateTimeValue(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The next quarter hour at least an hour away: a sensible starting value. */
export function defaultPublishValue(now = new Date()) {
    const date = new Date(now.getTime() + 60 * 60 * 1000)
    date.setSeconds(0, 0)
    date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15)
    return localDateTimeValue(date)
}

function parseLocal(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

/** The ISO time the API expects, or null for an unusable value. */
export function publishAtIso(value) {
    return parseLocal(value)?.toISOString() ?? null
}

/** Why a chosen time cannot be used, or '' when it can. */
export function publishScheduleError(value, now = new Date()) {
    const date = parseLocal(value)
    if (!date) return 'Choose a date and time to publish.'
    if (date.getTime() <= now.getTime()) return 'Choose a time in the future.'
    if (date.getTime() - now.getTime() > YEAR_MS) return 'Choose a time within the next year.'
    return ''
}

export function formatPublishAt(iso) {
    const date = new Date(iso)
    if (!iso || Number.isNaN(date.getTime())) return ''
    return date.toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    })
}

export function timeZoneName() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    } catch {
        return ''
    }
}
