import { useCallback, useRef, useState } from 'react'

export function useAdminToasts() {
    const [toasts, setToasts] = useState([])
    const sequence = useRef(0)
    const notify = useCallback((message, kind = 'success') => {
        if (!message) return
        const id = ++sequence.current
        setToasts((current) => [...current.slice(-2), { id, message, kind }])
    }, [])
    const dismiss = useCallback((id) => setToasts((current) => current.filter((item) => item.id !== id)), [])
    return { toasts, notify, dismiss }
}

