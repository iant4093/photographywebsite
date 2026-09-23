import { useEffect, useRef } from 'react'

// Closing a dialog stops waiting, not an already accepted server operation.
export default function useDialogOperation() {
    const active = useRef(null)
    useEffect(() => () => active.current?.abort(), [])
    const cancel = () => { active.current?.abort(); active.current = null }
    const begin = () => {
        cancel()
        const controller = new AbortController()
        active.current = controller
        return { signal: controller.signal, current: () => active.current === controller && !controller.signal.aborted }
    }
    return { begin, cancel }
}
