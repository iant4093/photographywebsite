import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './PrintOrderModal.css'

const FOCUSABLE_SELECTOR = 'button:not([disabled]), iframe, [href], [tabindex]:not([tabindex="-1"])'

export default function PrintOrderModal({ src, onClose }) {
    const [loaded, setLoaded] = useState(false)
    const dialogRef = useRef(null)
    const frameRef = useRef(null)
    const restoreFocusRef = useRef(null)
    const portalTarget = typeof document === 'undefined' ? null : document.body

    useEffect(() => {
        if (!src) return undefined
        restoreFocusRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null
        const dialog = dialogRef.current
        const previousOverflow = document.body.style.overflow
        const alreadyLocked = document.documentElement.hasAttribute('data-lightbox-scroll-lock')
        const backgroundDialogs = Array.from(document.body.querySelectorAll('[role="dialog"]'))
            .filter(element => element !== dialog)
            .map(element => ({
                element,
                ariaHidden: element.getAttribute('aria-hidden'),
                inert: element.hasAttribute('inert'),
            }))

        if (!alreadyLocked) document.body.style.overflow = 'hidden'
        backgroundDialogs.forEach(({ element }) => {
            element.setAttribute('aria-hidden', 'true')
            element.setAttribute('inert', '')
        })
        frameRef.current?.focus({ preventScroll: true })

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
                return
            }
            if (event.key !== 'Tab') return
            const focusable = Array.from(dialog?.querySelectorAll(FOCUSABLE_SELECTOR) || [])
            if (!focusable.length) return
            const first = focusable[0]
            const last = focusable.at(-1)
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
            }
        }
        const printOrigin = new URL(src).origin
        const handleFrameMessage = (event) => {
            if (
                event.origin === printOrigin
                && event.source === frameRef.current?.contentWindow
                && event.data?.type === 'ian-photography:close-print-dialog'
            ) {
                onClose()
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        window.addEventListener('message', handleFrameMessage)

        return () => {
            window.removeEventListener('keydown', handleKeyDown)
            window.removeEventListener('message', handleFrameMessage)
            if (!alreadyLocked) document.body.style.overflow = previousOverflow
            backgroundDialogs.forEach(({ element, ariaHidden, inert }) => {
                if (!inert) element.removeAttribute('inert')
                if (ariaHidden === null) element.removeAttribute('aria-hidden')
                else element.setAttribute('aria-hidden', ariaHidden)
            })
            restoreFocusRef.current?.focus({ preventScroll: true })
        }
    }, [onClose, src])

    if (!portalTarget || !src) return null

    return createPortal(
        <div
            ref={dialogRef}
            className="print-order-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Print options"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose()
            }}
        >
            <div className="print-order-modal__panel">
                <div className={`print-order-modal__loading ${loaded ? 'is-hidden' : ''}`} role="status">
                    Preparing print options…
                </div>
                <iframe
                    ref={frameRef}
                    className={`print-order-modal__frame ${loaded ? 'is-loaded' : ''}`}
                    src={src}
                    title="Fotomoto print options"
                    referrerPolicy="no-referrer"
                    onLoad={() => setLoaded(true)}
                />
            </div>
        </div>,
        portalTarget,
    )
}
