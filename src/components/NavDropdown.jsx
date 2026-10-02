import { useEffect, useRef } from 'react'
import { Link } from 'react-router'

const CLOSE_DELAY_MS = 160

// A desktop navigation link that reveals a panel of related pages on hover.
// Keyboard users open it with ArrowDown and move through it with the arrow
// keys; Escape returns focus to the link. Touch taps navigate as usual.
export default function NavDropdown({ id, label, to, active, open, onOpen, onClose, children }) {
    const wrapperRef = useRef(null)
    const triggerRef = useRef(null)
    const panelRef = useRef(null)
    const closeTimer = useRef(null)
    const focusFirstRef = useRef(false)
    const panelId = `nav-dropdown-${id}`

    useEffect(() => () => window.clearTimeout(closeTimer.current), [])

    useEffect(() => {
        if (!open || !focusFirstRef.current) return
        focusFirstRef.current = false
        panelRef.current?.querySelector('a')?.focus()
    }, [open])

    const cancelClose = () => window.clearTimeout(closeTimer.current)
    const show = () => {
        cancelClose()
        onOpen(id)
    }
    const close = () => {
        cancelClose()
        onClose(id)
    }
    const hoverable = event => event.pointerType !== 'touch'

    const handleKeyDown = (event) => {
        const links = [...(panelRef.current?.querySelectorAll('a') || [])]
        const index = links.indexOf(document.activeElement)
        if (event.key === 'Escape' && open) {
            event.preventDefault()
            close()
            triggerRef.current?.focus()
        } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (!open) {
                focusFirstRef.current = true
                show()
            } else {
                links[Math.min(index + 1, links.length - 1)]?.focus()
            }
        } else if (event.key === 'ArrowUp' && index >= 0) {
            event.preventDefault()
            if (index === 0) triggerRef.current?.focus()
            else links[index - 1].focus()
        }
    }

    return (
        <div
            ref={wrapperRef}
            className={`linen-nav-dropdown${open ? ' is-open' : ''}`}
            onPointerEnter={event => { if (hoverable(event)) show() }}
            onPointerLeave={event => {
                if (!hoverable(event)) return
                cancelClose()
                closeTimer.current = window.setTimeout(() => onClose(id), CLOSE_DELAY_MS)
            }}
            onBlur={event => { if (!wrapperRef.current?.contains(event.relatedTarget)) close() }}
            onKeyDown={handleKeyDown}
        >
            <Link
                ref={triggerRef}
                to={to}
                className={active ? 'is-active' : undefined}
                aria-current={active ? 'page' : undefined}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={close}
            >
                {label}
            </Link>
            <div
                ref={panelRef}
                id={panelId}
                className="linen-nav-dropdown-panel"
                aria-hidden={!open}
                inert={open ? undefined : true}
                onClick={event => { if (event.target.closest('a')) close() }}
            >
                <div className="linen-nav-dropdown-inner">{children}</div>
            </div>
        </div>
    )
}
