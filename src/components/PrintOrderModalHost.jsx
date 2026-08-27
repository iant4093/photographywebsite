import { createRoot } from 'react-dom/client'
import PrintOrderModal from './PrintOrderModal'
import { configuredPrintOrigin } from '../utils/printOrders'

let modalRoot

function trustedPrintSource(value) {
    if (typeof value !== 'string') return ''
    try {
        const url = new URL(value)
        if (url.origin !== configuredPrintOrigin() || url.pathname !== '/print.html') return ''
        return value
    } catch {
        return ''
    }
}

export function showPrintOrderModal(value) {
    const src = trustedPrintSource(value)
    if (!src) return false
    if (!modalRoot) {
        const host = document.createElement('div')
        host.dataset.printOrderHost = ''
        document.body.append(host)
        modalRoot = createRoot(host)
    }
    modalRoot.render(<PrintOrderModal src={src} onClose={() => modalRoot.render(null)} />)
    return true
}
