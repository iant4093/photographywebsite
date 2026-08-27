const DASHBOARD_SCROLL_KEY = 'ian-photography-admin-dashboard-scroll'

export function rememberDashboardScroll() {
    if (typeof window === 'undefined') return
    window.sessionStorage.setItem(DASHBOARD_SCROLL_KEY, String(Math.max(0, window.scrollY || 0)))
}

export function readDashboardScroll() {
    if (typeof window === 'undefined') return 0
    const value = Number(window.sessionStorage.getItem(DASHBOARD_SCROLL_KEY))
    return Number.isFinite(value) && value >= 0 ? value : 0
}
