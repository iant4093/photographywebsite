import { useEffect, useRef } from 'react'

export default function AccountDialog({ label, onClose, children }) {
    const dialog = useRef(null)
    const close = useRef(onClose)
    useEffect(() => { close.current = onClose }, [onClose])
    useEffect(() => {
        const previous = document.activeElement
        const node = dialog.current
        const controls = () => [...node.querySelectorAll('input:not(:disabled),button:not(:disabled),a[href],[tabindex="0"]')]
        controls()[0]?.focus()
        const keydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
            if (event.key !== 'Tab') return
            const targets = controls()
            const first = targets[0]
            const last = targets.at(-1)
            if (!first) { event.preventDefault(); node.focus() }
            else if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) {
                event.preventDefault(); last.focus()
            } else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) {
                event.preventDefault(); first.focus()
            }
        }
        const contain = event => { if (!node.contains(event.target)) (controls()[0] || node).focus() }
        document.addEventListener('keydown', keydown)
        document.addEventListener('focusin', contain)
        const overflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
            document.removeEventListener('keydown', keydown)
            document.removeEventListener('focusin', contain)
            document.body.style.overflow = overflow
            if (previous?.isConnected) previous.focus()
        }
    }, [])
    return <div ref={dialog} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className="account-dialog fixed inset-0 z-[100] bg-charcoal/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">{children}</div>
}
