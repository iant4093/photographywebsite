export function currentLocalDateInputValue(date = new Date()) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')

    return `${year}-${month}-${day}`
}

export function isWithinRecentDays(value, days, now = Date.now()) {
    const timestamp = Date.parse(value || '')
    const currentTimestamp = now instanceof Date ? now.getTime() : Number(now)
    const windowMs = Number(days) * 24 * 60 * 60 * 1000

    return Number.isFinite(timestamp)
        && Number.isFinite(currentTimestamp)
        && Number.isFinite(windowMs)
        && windowMs > 0
        && timestamp <= currentTimestamp
        && currentTimestamp - timestamp < windowMs
}
