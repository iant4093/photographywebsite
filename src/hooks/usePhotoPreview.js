import { useEffect, useState } from 'react'

const PHOTO_FADE_MS = 400
const PHOTO_WAIT_MS = 700

export default function usePhotoPreview(id, initialReady = null) {
    const [preview, setPreview] = useState(() => ({ id, ready: initialReady, outgoing: null, waitExpired: false }))
    const { ready, outgoing, waitExpired } = preview
    const fading = Boolean(outgoing && (ready || waitExpired))

    if (preview.id !== id) {
        setPreview({ id, ready: null, outgoing: ready ?? (fading ? null : outgoing), waitExpired: false })
    }

    useEffect(() => {
        if (!outgoing) return undefined
        const timer = window.setTimeout(() => {
            setPreview(current => {
                if (current.outgoing !== outgoing) return current
                return fading ? { ...current, outgoing: null } : { ...current, waitExpired: true }
            })
        }, fading ? PHOTO_FADE_MS : PHOTO_WAIT_MS)
        return () => window.clearTimeout(timer)
    }, [outgoing, fading])

    return { ready, outgoing, fading, setPreview }
}
