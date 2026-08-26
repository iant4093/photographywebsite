import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import './AccessibleLightbox.css'

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
    const callbacksRef = useRef({ onClose, onNext, onPrevious })
    const portalTarget = typeof document === 'undefined' ? null : document.body

    useLayoutEffect(() => {
        callbacksRef.current = { onClose, onNext, onPrevious }
    }, [onClose, onNext, onPrevious])

    useLayoutEffect(() => {
        const dialog = dialogRef.current
        const scrollPosition = {
            x: window.scrollX,
            y: window.scrollY,
        }
        const previousBodyStyles = {
            overflow: document.body.style.overflow,
            position: document.body.style.position,
            top: document.body.style.top,
            left: document.body.style.left,
            right: document.body.style.right,
            width: document.body.style.width,
        }
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

        document.documentElement.setAttribute('data-lightbox-scroll-lock', '')
        backgroundState.forEach(({ element }) => {
            element.setAttribute('inert', '')
            element.setAttribute('aria-hidden', 'true')
        })
        Object.assign(document.body.style, {
            overflow: 'hidden',
            position: 'fixed',
            top: `-${scrollPosition.y}px`,
            left: `-${scrollPosition.x}px`,
            right: '0',
            width: '100%',
        })

        const initialFocus = dialog?.querySelector('[data-lightbox-initial-focus]')
            || focusableElements(dialog)[0]
        initialFocus?.focus({ preventScroll: true })

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                callbacksRef.current.onClose()
                return
            }
            if (event.key === 'ArrowRight' && callbacksRef.current.onNext) {
                event.preventDefault()
                callbacksRef.current.onNext()
                return
            }
            if (event.key === 'ArrowLeft' && callbacksRef.current.onPrevious) {
                event.preventDefault()
                callbacksRef.current.onPrevious()
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
            Object.assign(document.body.style, previousBodyStyles)
            backgroundState.forEach(({ element, ariaHidden, inert }) => {
                if (!inert) element.removeAttribute('inert')
                if (ariaHidden === null) element.removeAttribute('aria-hidden')
                else element.setAttribute('aria-hidden', ariaHidden)
            })
            restoreFocusRef.current?.focus({ preventScroll: true })
            window.scrollTo(scrollPosition.x, scrollPosition.y)
            document.documentElement.removeAttribute('data-lightbox-scroll-lock')
        }
    }, [])

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
