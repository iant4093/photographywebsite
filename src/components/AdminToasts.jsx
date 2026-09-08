import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

function Toast({ toast, dismiss }) {
    const [paused, setPaused] = useState(false)
    useEffect(() => {
        if (paused || toast.kind === 'error') return undefined
        const timer = window.setTimeout(() => dismiss(toast.id), 4000)
        return () => window.clearTimeout(timer)
    }, [dismiss, paused, toast.id, toast.kind])
    return (
        <div
            role={toast.kind === 'error' ? 'alert' : 'status'}
            aria-atomic="true"
            onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false) }}
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border p-4 text-sm shadow-lg ${toast.kind === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-green-200 bg-green-50 text-green-900'}`}
        >
            <span className="flex-1">{toast.message}</span>
            <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss notification" className="shrink-0 rounded px-1 font-semibold focus-visible:outline-2">×</button>
        </div>
    )
}

export default function AdminToasts({ toasts, dismiss }) {
    return createPortal(
        <div aria-label="Notifications" className="pointer-events-none fixed inset-x-4 z-[200] flex flex-col gap-2 sm:left-auto sm:right-6 sm:w-96" style={{ bottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
            {toasts.map((toast) => <Toast key={toast.id} toast={toast} dismiss={dismiss} />)}
        </div>, document.body,
    )
}
