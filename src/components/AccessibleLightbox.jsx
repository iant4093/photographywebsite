import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import './AccessibleLightbox.css'
import { registerLightboxLayer } from '../utils/lightboxLayers'

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
    explicitTabOrder = false,
    onFocusCapture,
    onPointerDownCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onKeyDownCapture,
}) {
    const dialogRef = useRef(null)
    const callbacksRef = useRef({ onClose, onNext, onPrevious })
    const portalTarget = typeof document === 'undefined' ? null : document.body

    useLayoutEffect(() => {
        callbacksRef.current = { onClose, onNext, onPrevious }
    }, [onClose, onNext, onPrevious])

    useLayoutEffect(() => {
        const dialog = dialogRef.current
        const useViewportScrollLock = window.matchMedia?.(
            '(orientation: landscape) and (max-height: 600px) and (max-width: 1024px) and (pointer: coarse)',
        ).matches === true
        const releaseLayer = registerLightboxLayer(dialog, useViewportScrollLock)

        const initialFocus = useViewportScrollLock
            ? dialog
            : dialog?.querySelector('[data-lightbox-initial-focus]') || focusableElements(dialog)[0]
        initialFocus?.focus({ preventScroll: true })

        const handleKeyDown = (event) => {
            // A photograph can open above an album dialog. Its portal makes
            // this dialog inert; only the visible top layer owns keyboard input.
            if (event.defaultPrevented || dialog?.hasAttribute('inert')) return
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

            // Safari can skip buttons in its native Tab order. Photo viewers
            // own only ordinary controls, so traverse them explicitly instead
            // of allowing a cold-viewer handoff to lose keyboard focus.
            if (explicitTabOrder) {
                const controls = focusable.filter(element => element.tabIndex !== -1)
                event.preventDefault()
                if (!controls.length) { dialog?.focus(); return }
                const current = controls.indexOf(document.activeElement)
                const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0)
                    : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
                controls[next].focus({ preventScroll: true })
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
            releaseLayer()
        }
    }, [explicitTabOrder])

    if (!portalTarget) return null

    return createPortal(
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            className={`linen-lightbox ${className}`}
            onFocusCapture={onFocusCapture}
            onPointerDownCapture={onPointerDownCapture}
            onPointerUpCapture={onPointerUpCapture}
            onPointerCancelCapture={onPointerCancelCapture}
            onKeyDownCapture={onKeyDownCapture}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose()
            }}
        >
            {children}
        </div>,
        portalTarget,
    )
}
