import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './SiteSelect.css'

const PALETTE = ['cream', 'cream-dark', 'charcoal', 'amber', 'amber-dark', 'warm-gray', 'warm-border']

// Select-only and editable, manual-selection comboboxes share one site-rendered
// popup. DOM focus stays on the control; aria-activedescendant follows choices.
export default function SiteSelect({
    options = [], value = '', onChange, editable = false, id, name, required = false,
    disabled = false, className = '', placeholder = 'Choose an option', ...props
}) {
    const generatedId = useId()
    const controlId = id || generatedId
    const listId = `${controlId}-choices`
    const errorId = `${controlId}-error`
    const controlRef = useRef(null)
    const menuRef = useRef(null)
    const typeahead = useRef({ text: '', time: 0 })
    const [open, setOpen] = useState(false)
    const [activeValue, setActiveValue] = useState(null)
    const [invalid, setInvalid] = useState(false)
    const [placement, setPlacement] = useState(null)
    const [portalRoot, setPortalRoot] = useState(null)
    const items = useMemo(() => options.map(option => typeof option === 'object'
        ? { ...option, value: String(option.value), label: String(option.label) }
        : { value: String(option), label: String(option) }), [options])
    const currentValue = String(value ?? '')
    const selected = items.find(option => option.value === currentValue)
    const visibleItems = useMemo(() => editable && currentValue.trim()
        ? items.filter(option => option.label.toLocaleLowerCase().includes(currentValue.trim().toLocaleLowerCase()))
        : items, [currentValue, editable, items])
    const available = visibleItems.filter(option => !option.disabled)
    const active = available.find(option => option.value === activeValue)
    const expanded = open && !disabled
    const invalidValue = required && (!currentValue || (!editable && (!selected || selected.disabled)))
    const showError = invalid && invalidValue && !disabled

    function showMenu() {
        setPortalRoot(document.fullscreenElement || controlRef.current?.closest('dialog, [role="dialog"]') || document.body)
        setOpen(true)
    }

    function openMenu(preferLast = false) {
        if (disabled) return
        setActiveValue(editable ? null : (selected && !selected.disabled ? selected.value : (preferLast ? available.at(-1) : available[0])?.value) ?? null)
        showMenu()
    }

    function choose(option, restoreFocus = true) {
        if (!option || option.disabled) return
        setOpen(false)
        setInvalid(false)
        if (restoreFocus) controlRef.current?.focus({ preventScroll: true })
        onChange?.(option.value)
    }

    useEffect(() => {
        if (!required || disabled || !invalidValue) return undefined
        const control = controlRef.current
        const form = control?.closest('form')
        const validate = event => {
            event.preventDefault()
            event.stopImmediatePropagation()
            setInvalid(true)
            control.focus({ preventScroll: true })
        }
        form?.addEventListener('submit', validate, true)
        return () => form?.removeEventListener('submit', validate, true)
    }, [disabled, invalidValue, required])

    useLayoutEffect(() => {
        if (!expanded) return undefined
        const control = controlRef.current
        const menu = menuRef.current
        let frame = null
        const update = () => {
            frame = null
            const rect = control.getBoundingClientRect()
            const viewport = window.visualViewport
            const leftEdge = viewport?.offsetLeft || 0
            const topEdge = viewport?.offsetTop || 0
            const width = viewport?.width || window.innerWidth
            const height = viewport?.height || window.innerHeight
            const below = topEdge + height - rect.bottom - 12
            const above = rect.top - topEdge - 12
            const flip = below < Math.min(240, menu?.scrollHeight || 240) && above > below
            const maxHeight = Math.max(40, Math.min(320, flip ? above : below))
            const menuWidth = Math.min(Math.max(rect.width, 160), width - 16)
            const colors = getComputedStyle(control)
            const nextPlacement = {
                left: Math.max(leftEdge + 8, Math.min(rect.left, leftEdge + width - menuWidth - 8)),
                top: flip ? Math.max(topEdge + 8, rect.top - Math.min(menu?.scrollHeight || maxHeight, maxHeight) - 6) : rect.bottom + 6,
                width: menuWidth, maxHeight,
                ...Object.fromEntries(PALETTE.map(color => [`--color-${color}`, colors.getPropertyValue(`--color-${color}`)])),
            }
            setPlacement(previous => previous && Object.keys(nextPlacement).every(key => previous[key] === nextPlacement[key])
                ? previous : nextPlacement)
        }
        const schedule = () => {
            if (frame === null) frame = window.requestAnimationFrame(update)
        }
        const outside = event => {
            if (!control.contains(event.target) && !menu?.contains(event.target)) setOpen(false)
        }
        const scroll = event => { if (!menu?.contains(event.target)) schedule() }
        update()
        const resize = new ResizeObserver(schedule)
        resize.observe(control)
        // Scroll motion transforms ancestors after the scroll event. Track only
        // this open control's ancestor chain so its portal stays attached.
        const motion = new MutationObserver(schedule)
        for (let ancestor = control; ancestor; ancestor = ancestor.parentElement) {
            motion.observe(ancestor, { attributes: true, attributeFilter: ['style', 'class'] })
        }
        document.addEventListener('pointerdown', outside, true)
        document.addEventListener('focusin', outside)
        document.addEventListener('scroll', scroll, true)
        window.addEventListener('resize', schedule)
        window.visualViewport?.addEventListener('resize', schedule)
        window.visualViewport?.addEventListener('scroll', schedule)
        return () => {
            resize.disconnect()
            motion.disconnect()
            if (frame !== null) window.cancelAnimationFrame(frame)
            document.removeEventListener('pointerdown', outside, true)
            document.removeEventListener('focusin', outside)
            document.removeEventListener('scroll', scroll, true)
            window.removeEventListener('resize', schedule)
            window.visualViewport?.removeEventListener('resize', schedule)
            window.visualViewport?.removeEventListener('scroll', schedule)
        }
    }, [expanded, visibleItems.length])

    useLayoutEffect(() => {
        const menu = menuRef.current
        const option = menu?.querySelector('[data-active="true"]')
        if (!option) return
        if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop
        else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
            menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight
        }
    }, [activeValue, expanded])

    function handleKeyDown(event) {
        if (event.isComposing || event.nativeEvent?.isComposing || disabled) return
        const { key } = event
        // Keep gallery shortcuts from navigating while a field owns focus.
        if (key === 'ArrowLeft' || key === 'ArrowRight') event.stopPropagation()
        if (key === 'Escape' && expanded) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
        } else if (key === 'Tab') {
            if (expanded && !editable && active) choose(active, false)
            setOpen(false)
        } else if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault()
            event.stopPropagation()
            if (!expanded) openMenu(key === 'ArrowUp')
            else {
                const index = available.findIndex(option => option.value === activeValue)
                const next = index < 0 ? (key === 'ArrowDown' ? 0 : available.length - 1)
                    : Math.max(0, Math.min(available.length - 1, index + (key === 'ArrowDown' ? 1 : -1)))
                setActiveValue(available[next]?.value ?? null)
            }
        } else if (!editable && (key === 'Home' || key === 'End')) {
            event.preventDefault()
            showMenu()
            setActiveValue((key === 'Home' ? available[0] : available.at(-1))?.value ?? null)
        } else if (key === 'Enter' || (!editable && key === ' ')) {
            if (!editable || (expanded && active)) {
                event.preventDefault()
                event.stopPropagation()
                if (expanded) choose(active)
                else openMenu()
            } else if (expanded) setOpen(false)
        } else if (!editable && key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault()
            const previous = typeahead.current
            const typed = (event.timeStamp - previous.time > 700 ? '' : previous.text) + key.toLocaleLowerCase()
            typeahead.current = { text: typed, time: event.timeStamp }
            const search = [...typed].every(character => character === typed[0]) ? typed[0] : typed
            const index = available.findIndex(option => option.value === activeValue)
            const ordered = search.length === 1 ? [...available.slice(index + 1), ...available.slice(0, index + 1)] : available
            const match = ordered.find(option => option.label.toLocaleLowerCase().startsWith(search))
            showMenu()
            if (match) setActiveValue(match.value)
        }
    }

    const common = {
        ...props, id: controlId, ref: controlRef, disabled,
        className: `site-select-control ${editable ? 'site-select-input' : 'site-select-trigger'} ${className}`,
        role: 'combobox', 'aria-haspopup': 'listbox', 'aria-expanded': expanded,
        'aria-controls': expanded ? listId : undefined,
        'aria-activedescendant': expanded && active ? `${listId}-${visibleItems.indexOf(active)}` : undefined,
        'aria-required': required || undefined, 'aria-invalid': showError || undefined,
        'aria-describedby': [props['aria-describedby'], showError && errorId].filter(Boolean).join(' ') || undefined,
        onKeyDown: handleKeyDown,
    }
    return (
        <>
            {editable ? (
                <input {...common} type="text" name={name} value={currentValue} placeholder={placeholder}
                    autoComplete="off" aria-autocomplete="list" required={required}
                    onFocus={() => openMenu()} onClick={() => openMenu()}
                    onChange={event => { showMenu(); setActiveValue(null); onChange?.(event.target.value) }} />
            ) : (
                <button {...common} type="button" value={currentValue} onClick={() => expanded ? setOpen(false) : openMenu()}>
                    <span className="site-select-value">{selected?.label || placeholder}</span>
                    <svg className="site-select-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
                </button>
            )}
            {!editable && name && <input type="hidden" name={name} value={currentValue} disabled={disabled} />}
            {showError && <span id={errorId} className="site-select-error" role="alert">Choose an option.</span>}
            {expanded && createPortal(
                <div ref={menuRef} id={listId} role="listbox"
                    aria-label={props['aria-label']} aria-labelledby={props['aria-labelledby'] || (!props['aria-label'] ? controlId : undefined)}
                    className="site-select-menu" style={{ ...placement, visibility: placement ? 'visible' : 'hidden' }}>
                    {visibleItems.map((option, index) => (
                        <div key={option.value} id={`${listId}-${index}`} role="option"
                            aria-selected={option.value === currentValue} aria-disabled={option.disabled || undefined}
                            data-active={option.value === activeValue} data-value={option.value} data-camera-cursor="link"
                            className="site-select-option"
                            onPointerMove={() => { if (!option.disabled) setActiveValue(option.value) }}
                            onPointerDown={event => event.preventDefault()}
                            onClick={event => { event.preventDefault(); event.stopPropagation(); choose(option) }}>
                            <span>{option.label}</span>
                            {option.value === currentValue && <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>}
                        </div>
                    ))}
                    {!visibleItems.length && <div className="site-select-empty">{editable ? 'No matching categories. Keep typing to use a new one.' : 'No options available.'}</div>}
                </div>, portalRoot,
            )}
        </>
    )
}
