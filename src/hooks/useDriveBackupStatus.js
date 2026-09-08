import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchDriveBackupStatus, retryDriveBackup } from '../utils/api'

export default function useDriveBackupStatus(albumIds, getIdToken, notify) {
    const [statuses, setStatuses] = useState({})
    const [revision, setRevision] = useState(0)
    const previous = useRef({})
    const idsKey = JSON.stringify(albumIds)
    const refresh = useCallback(() => setRevision((value) => value + 1), [])
    useEffect(() => {
        const ids = JSON.parse(idsKey)
        const controller = new AbortController()
        let timer
        let attempts = 0
        async function poll() {
            if (document.hidden) return
            try {
                const token = await getIdToken()
                const items = []
                for (let offset = 0; offset < ids.length; offset += 100) {
                    const result = await fetchDriveBackupStatus(token, ids.slice(offset, offset + 100), { signal: controller.signal })
                    items.push(...result.items)
                }
                if (controller.signal.aborted) return
                const next = Object.fromEntries(items.map((item) => [item.albumId, item]))
                for (const item of items) {
                    if (['queued', 'syncing'].includes(previous.current[item.albumId]?.status)) {
                        if (item.status === 'synced') notify('Google Drive backup updated.')
                        if (item.status === 'failed') notify('Your gallery is saved. A Drive backup needs attention; use Retry backup on the album.', 'error')
                    }
                }
                previous.current = next
                setStatuses(next)
                if (items.some((item) => ['queued', 'syncing'].includes(item.status))) {
                    timer = window.setTimeout(poll, Math.min(30000, 3000 * 2 ** Math.min(attempts++, 3)))
                }
            } catch {
                if (!controller.signal.aborted) {
                    setStatuses(Object.fromEntries(ids.map((id) => [id, { status: 'unavailable' }])))
                    if (attempts++ < 3) timer = window.setTimeout(poll, 15000)
                }
            }
        }
        const visibility = () => { if (!document.hidden) { window.clearTimeout(timer); poll() } }
        if (ids.length) poll()
        document.addEventListener('visibilitychange', visibility)
        return () => { controller.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
    }, [idsKey, revision, getIdToken, notify])
    const retry = useCallback(async (albumId) => {
        try {
            const token = await getIdToken()
            await retryDriveBackup(token, albumId)
            notify('Drive backup queued.')
            refresh()
        } catch (error) { notify(error.message, 'error') }
    }, [getIdToken, notify, refresh])
    return { statuses, refresh, retry }
}
