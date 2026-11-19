import { useState } from 'react'
import { canPrintProtectedPhoto, pictoremOrderUrl, pictoremProtectedOrderUrl } from '../utils/printOrders'

export default function LightboxPrintLink({ photo, showingBefore, requestPrintSource }) {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState('')
    const publicHref = requestPrintSource ? '' : pictoremOrderUrl(photo)
    const protectedPrint = requestPrintSource && canPrintProtectedPhoto(photo)
    if (!publicHref && !protectedPrint) return null

    const label = showingBefore ? 'Order a print of the edited photo' : 'Order a print of this photo'
    const description = protectedPrint ? 'Sends this photo to Pictorem in a new tab' : 'Opens Pictorem in a new tab'
    const className = 'linen-lightbox-print inline-flex items-center gap-2 rounded-full border border-white/30 px-4 py-2.5 text-sm text-white/80 transition-colors hover:border-white/60 hover:bg-white/10 hover:text-white active:scale-[0.98] touch-manipulation'
    const contents = <>
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 9V3h12v6M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2m-12-4h12v7H6v-7z" />
        </svg>
        <span>Order a Print</span>
    </>

    async function openProtectedOrder(event) {
        event.stopPropagation()
        // Reserve a tab while the click is active. Opening it after the
        // authorization request would let browser popup blockers stop it.
        const popup = window.open('about:blank', '_blank')
        if (!popup) {
            setError('Allow pop-ups for this site to open print options.')
            return
        }
        setPending(true)
        setError('')
        try {
            popup.opener = null
            popup.document.title = 'Opening print options'
            popup.document.body.textContent = 'Opening print options…'
            const { printSourceUrl } = await requestPrintSource(photo)
            if (popup.closed) return
            const href = pictoremProtectedOrderUrl(printSourceUrl)
            if (!href) throw new Error('Invalid print source')
            const link = popup.document.createElement('a')
            link.href = href
            link.rel = 'noreferrer'
            popup.document.body.append(link)
            link.click()
        } catch {
            popup.close()
            setError('Print options could not be opened. Try again or reopen the gallery.')
        } finally {
            setPending(false)
        }
    }

    if (publicHref) return (
        <a href={publicHref} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
            onClick={event => event.stopPropagation()}
            className={className} aria-label={label} aria-description={description} title={description}>
            {contents}
        </a>
    )

    return <>
        <button type="button" onClick={openProtectedOrder} disabled={pending} aria-busy={pending || undefined}
            className={`${className} cursor-pointer disabled:opacity-60`}
            aria-label={label} aria-description={description} title={description}>
            {contents}
        </button>
        {error && <span role="alert" className="w-full text-center text-sm text-white">{error}</span>}
    </>
}
