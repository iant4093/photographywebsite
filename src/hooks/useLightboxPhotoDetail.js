import { useEffect, useRef, useState } from 'react'

const PHOTO_DWELL_MS = 800

function decodePhoto(url) {
    const image = new Image()
    if (typeof image.decode === 'function') {
        image.src = url
        return image.decode()
    }

    return new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = reject
        image.src = url
    })
}

export default function useLightboxPhotoDetail(source, active, frameRef) {
    const [detail, setDetail] = useState({ source, active, url: '' })
    const current = detail.source === source && detail.active === active
    if (!current) setDetail({ source, active, url: '' })
    const loadNow = useRef(null)

    useEffect(() => {
        if (!active || !source) return undefined
        const dialog = frameRef.current?.closest('.linen-lightbox')
        let closing = false
        let controller
        let objectUrl = ''
        const load = async () => {
            window.clearTimeout(timer)
            if (closing || controller) return
            controller = new AbortController()
            const { signal } = controller
            try {
                const response = await fetch(source, { signal })
                if (!response.ok) return
                const blob = await response.blob()
                if (signal.aborted) return
                objectUrl = URL.createObjectURL(blob)
                await decodePhoto(objectUrl)
                if (!signal.aborted) setDetail({ source, active, url: objectUrl })
            } catch {
                if (objectUrl) URL.revokeObjectURL(objectUrl)
                objectUrl = ''
            } finally {
                // A failed upgrade keeps the preview and can retry on zoom.
                if (!objectUrl) controller = undefined
            }
        }

        const timer = window.setTimeout(load, PHOTO_DWELL_MS)
        const stop = () => {
            closing = true
            window.clearTimeout(timer)
            controller?.abort()
        }
        dialog?.addEventListener('lightboxclosing', stop)
        loadNow.current = load
        return () => {
            dialog?.removeEventListener('lightboxclosing', stop)
            stop()
            if (objectUrl) URL.revokeObjectURL(objectUrl)
            objectUrl = ''
            loadNow.current = null
        }
    }, [source, active, frameRef])

    return { detailUrl: current ? detail.url : '', loadNow }
}
