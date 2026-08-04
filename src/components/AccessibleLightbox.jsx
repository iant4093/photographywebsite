import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(dialog) {
    return Array.from(dialog?.querySelectorAll(FOCUSABLE_SELECTOR) || [])
        .filter((element) => element.getAttribute('aria-hidden') !== 'true')
}

export default function AccessibleLightbox({
    ariaLabel,
    children,
    className = '',
    onClose,
    onNext,
    onPrevious,
}) {
    const dialogRef = useRef(null)
    const restoreFocusRef = useRef(null)
    const portalTarget = typeof document === 'undefined' ? null : document.body

    useEffect(() => {
        const dialog = dialogRef.current
        const previousOverflow = document.body.style.overflow
        const backgroundState = Array.from(dialog?.parentElement?.children || [])
            .filter((element) => element !== dialog)
            .map((element) => ({
                element,
                ariaHidden: element.getAttribute('aria-hidden'),
                inert: element.hasAttribute('inert'),
            }))

        restoreFocusRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null

        backgroundState.forEach(({ element }) => {
            element.setAttribute('inert', '')
            element.setAttribute('aria-hidden', 'true')
        })
        document.documentElement.classList.add('linen-lightbox-open')
        document.body.style.overflow = 'hidden'

        const initialFocus = dialog?.querySelector('[data-lightbox-initial-focus]')
            || focusableElements(dialog)[0]
        initialFocus?.focus()

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
                return
            }
            if (event.key === 'ArrowRight' && onNext) {
                event.preventDefault()
                onNext()
                return
            }
            if (event.key === 'ArrowLeft' && onPrevious) {
                event.preventDefault()
                onPrevious()
                return
            }
            if (event.key !== 'Tab') return

            const focusable = focusableElements(dialog)
            if (!focusable.length) {
                event.preventDefault()
                dialog?.focus()
                return
            }

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
            document.documentElement.classList.remove('linen-lightbox-open')
            document.body.style.overflow = previousOverflow
            backgroundState.forEach(({ element, ariaHidden, inert }) => {
                if (!inert) element.removeAttribute('inert')
                if (ariaHidden === null) element.removeAttribute('aria-hidden')
                else element.setAttribute('aria-hidden', ariaHidden)
            })
            restoreFocusRef.current?.focus()
        }
    }, [onClose, onNext, onPrevious])

    if (!portalTarget) return null

    return createPortal(
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            className={`linen-lightbox ${className}`}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose()
            }}
        >
            {children}
        </div>,
        portalTarget,
    )
}
