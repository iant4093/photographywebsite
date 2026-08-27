import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './PrintOrderModal.css'

const FOCUSABLE_SELECTOR = 'button:not([disabled]), iframe, [href], [tabindex]:not([tabindex="-1"])'

export default function PrintOrderModal({ src, onClose }) {
    const [loaded, setLoaded] = useState(false)
    const dialogRef = useRef(null)
    const closeRef = useRef(null)
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
        closeRef.current?.focus({ preventScroll: true })

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
        window.addEventListener('keydown', handleKeyDown)

        return () => {
            window.removeEventListener('keydown', handleKeyDown)
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
                    className={`print-order-modal__frame ${loaded ? 'is-loaded' : ''}`}
                    src={src}
                    title="Fotomoto print options"
                    referrerPolicy="no-referrer"
                    onLoad={() => setLoaded(true)}
                />
                <button
                    ref={closeRef}
                    type="button"
                    className="print-order-modal__close"
                    onClick={onClose}
                    aria-label="Close print options and return to photo"
                    title="Back to photo"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </div>
        </div>,
        portalTarget,
    )
}
