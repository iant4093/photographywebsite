const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(value) {
    if (value === null || value === undefined) return 'Not available'
    const bytes = Number(value)
    if (!Number.isFinite(bytes) || bytes < 0) return 'Not available'
    if (bytes === 0) return '0 B'
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
    const scaled = bytes / (1024 ** unitIndex)
    const maximumFractionDigits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(scaled)} ${BYTE_UNITS[unitIndex]}`
}
