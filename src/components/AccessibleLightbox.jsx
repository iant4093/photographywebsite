import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import './AccessibleLightbox.css'
import './LightboxMotion.css'
import { registerLightboxLayer } from '../utils/lightboxLayers'
import { mountLightboxMotion, requestLightboxClose, settleLightboxEntrance } from '../utils/lightboxMotionControl'

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
    motion,
}) {
    const dialogRef = useRef(null)
    const callbacksRef = useRef({ onClose, onNext, onPrevious })
    const motionRef = useRef(motion)
    const portalTarget = typeof document === 'undefined' ? null : document.body

    useLayoutEffect(() => {
        callbacksRef.current = { onClose, onNext, onPrevious }
        motionRef.current = motion
    }, [onClose, onNext, onPrevious, motion])

    useLayoutEffect(() => {
        const dialog = dialogRef.current
        const focusDialog = window.matchMedia?.(
            '(orientation: landscape) and (max-height: 600px) and (max-width: 1024px) and (pointer: coarse)',
        ).matches === true
        const trigger = document.activeElement
        const releaseLayer = registerLightboxLayer(dialog)
        const releaseMotion = mountLightboxMotion(dialog, () => motionRef.current, trigger)

        const initialFocus = focusDialog
            ? dialog
            : dialog?.querySelector('[data-lightbox-initial-focus]') || focusableElements(dialog)[0]
        initialFocus?.focus({ preventScroll: true })

        const handleKeyDown = (event) => {
            // A photograph can open above an album dialog. Its portal makes
            // this dialog inert; only the visible top layer owns keyboard input.
            if (event.defaultPrevented || dialog?.hasAttribute('inert')) return
            if (event.key === 'Escape') {
                event.preventDefault()
                requestLightboxClose(dialog, () => callbacksRef.current.onClose())
                return
            }
            if (event.key === 'ArrowRight' && callbacksRef.current.onNext) {
                event.preventDefault()
                settleLightboxEntrance(dialog)
                callbacksRef.current.onNext()
                return
            }
            if (event.key === 'ArrowLeft' && callbacksRef.current.onPrevious) {
                event.preventDefault()
                settleLightboxEntrance(dialog)
                callbacksRef.current.onPrevious()
                return
            }
            if (event.key !== 'Tab') return
            settleLightboxEntrance(dialog)

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
            releaseMotion?.()
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
            onClickCapture={(event) => {
                if (!motion || !event.target.closest('.linen-lightbox-close, .section-stats-close, [data-lightbox-close]')) return
                event.preventDefault()
                event.stopPropagation()
                requestLightboxClose(event.currentTarget, () => callbacksRef.current.onClose())
            }}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) requestLightboxClose(event.currentTarget, () => callbacksRef.current.onClose())
            }}
        >
            {children}
        </div>,
        portalTarget,
    )
}
