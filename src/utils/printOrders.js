const DEFAULT_PRINT_ORIGIN = 'https://prints.iantruongphotography.com'

function printOrigin() {
    const configured = String(import.meta.env.VITE_PRINT_ORIGIN || DEFAULT_PRINT_ORIGIN).trim()
    try {
        const url = new URL(configured)
        const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
        if (url.protocol !== 'https:' && !localHttp) {
            throw new Error('The print service must use HTTPS.')
        }
        return url.origin
    } catch {
        throw new Error('The print service is not configured correctly.')
    }
}

function prepareWindow() {
    const popup = window.open('', '_blank', 'popup,width=1180,height=860')
    if (!popup) throw new Error('Allow pop-ups for this site to open the print store.')
    try {
        popup.opener = null
        popup.document.title = 'Preparing Print — Ian Truong Photography'
        popup.document.documentElement.style.cssText = 'color-scheme:dark;background:#171613'
        popup.document.body.style.cssText = 'margin:0;min-height:100vh;display:grid;place-items:center;background:#171613;color:#f3eee4;font:16px system-ui,sans-serif'
        popup.document.body.textContent = 'Preparing print…'
    } catch {
        // The retained WindowProxy can still be navigated even when a browser
        // limits access to the temporary about:blank document.
    }
    return popup
}

export async function openPrintOrder(requestSession) {
    if (typeof requestSession !== 'function') throw new TypeError('A print session request is required.')
    const popup = prepareWindow()
    try {
        const response = await requestSession()
        const sessionToken = response?.sessionToken
        if (typeof sessionToken !== 'string' || sessionToken.length < 80 || sessionToken.length > 2048) {
            throw new Error('The print service returned an invalid session.')
        }
        if (popup.closed) throw new Error('The print window was closed before it finished loading.')
        popup.location.replace(`${printOrigin()}/print.html#session=${encodeURIComponent(sessionToken)}`)
    } catch (error) {
        try { popup.close() } catch { /* best effort */ }
        throw error
    }
}

export function configuredPrintOrigin() {
    return printOrigin()
}
