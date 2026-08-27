const DEFAULT_PRINT_ORIGIN = 'https://prints.iantruongphotography.com'
export const PRINT_ORDER_OPEN_EVENT = 'iantruong:print-order-open'

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

export async function openPrintOrder(requestSession) {
    if (typeof requestSession !== 'function') throw new TypeError('A print session request is required.')
    const response = await requestSession()
    const sessionToken = response?.sessionToken
    if (typeof sessionToken !== 'string' || sessionToken.length < 80 || sessionToken.length > 2048) {
        throw new Error('The print service returned an invalid session.')
    }

    const src = `${printOrigin()}/print.html#session=${encodeURIComponent(sessionToken)}`
    window.dispatchEvent(new CustomEvent(PRINT_ORDER_OPEN_EVENT, {
        detail: { src },
    }))
    return src
}

export function configuredPrintOrigin() {
    return printOrigin()
}
