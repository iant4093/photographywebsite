import { useEffect, useState } from 'react'
import AdminToasts from '../components/AdminToasts'
import DashboardBackLink from '../components/DashboardBackLink'
import { useAuth } from '../context/auth'
import { useAdminToasts } from '../hooks/useAdminToasts'
import { deleteAlbum, fetchAlbumsFiltered, updateAlbum } from '../utils/api'

export const RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

const formatDate = (time) => new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

function formerPlace(album) {
    const former = album.trashedFrom || {}
    if (former.visibility === 'public') return 'Main Gallery'
    if (former.visibility === 'private') return former.ownerEmail ? `Client: ${former.ownerEmail}` : 'Specific user'
    return former.isShared ? 'Link only (shared)' : 'Link only'
}

function contents(album) {
    const count = Number(album.imageCount)
    const video = album.type === 'video'
    if (!Number.isFinite(count)) return video ? 'Video album' : 'Photo album'
    const noun = video ? 'video' : 'photo'
    return `${video ? 'Video' : 'Photo'} album · ${count} ${noun}${count === 1 ? '' : 's'}`
}

function purgeLabel(album, now) {
    const purgeAt = Date.parse(album.trashedAt) + RETENTION_DAYS * DAY_MS
    if (!Number.isFinite(purgeAt)) return ''
    const days = Math.ceil((purgeAt - now) / DAY_MS)
    if (days <= 0) return 'Permanently deleted within a day'
    return `Permanently deleted ${formatDate(purgeAt)} (in ${days} day${days === 1 ? '' : 's'})`
}

// Admin: albums moved out of Manage Albums wait here, hidden from everyone,
// for 30 days before they are permanently deleted.
export default function RecentlyDeleted() {
    const { getIdToken } = useAuth()
    const { toasts, notify, dismiss } = useAdminToasts()
    const [albums, setAlbums] = useState([])
    const [state, setState] = useState('loading')
    const [attempt, setAttempt] = useState(0)
    const [busy, setBusy] = useState(() => new Set())
    const [now] = useState(() => Date.now())

    useEffect(() => {
        let active = true
        getIdToken()
            .then((token) => fetchAlbumsFiltered({ visibility: 'unlisted', trashed: '1', limit: 100 }, token, { force: true }))
            .then((items) => {
                if (!active) return
                setAlbums([...items].sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt))))
                setState('ready')
            }, (error) => {
                if (!active) return
                setState('error')
                notify(error?.message || 'Recently deleted albums could not be loaded.', 'error')
            })
        return () => { active = false }
    }, [attempt, getIdToken, notify])

    const retry = () => {
        setState('loading')
        setAttempt((value) => value + 1)
    }

    async function act(album, work, message) {
        setBusy((current) => new Set(current).add(album.albumId))
        try {
            await work(await getIdToken())
            setAlbums((current) => current.filter((item) => item.albumId !== album.albumId))
            notify(message)
        } catch (error) {
            notify(error?.message || 'That did not work. Please try again.', 'error')
        } finally {
            setBusy((current) => {
                const next = new Set(current)
                next.delete(album.albumId)
                return next
            })
        }
    }

    const restore = (album) => act(
        album,
        (token) => updateAlbum(token, album.albumId, { restore: true }),
        `"${album.title}" restored (${formerPlace(album)}).`,
    )

    const deleteForever = (album) => {
        if (!window.confirm(`Permanently delete "${album.title}" and its gallery files now? This cannot be undone. Google Drive backups and separate archives are kept.`)) return
        return act(album, (token) => deleteAlbum(token, album.albumId), `"${album.title}" permanently deleted.`)
    }

    return (
        <div className="max-w-4xl mx-auto px-6 py-12 pt-[88px] md:pt-[104px]">
            <div className="animate-slide-up">
                <DashboardBackLink className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Dashboard
                </DashboardBackLink>

                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Recently Deleted</h1>
                    <p className="mt-2 text-warm-gray">
                        Deleted albums stay here for {RETENTION_DAYS} days, hidden from everyone, then are permanently deleted. Restoring puts an album back where it was.
                    </p>
                </div>
                <AdminToasts toasts={toasts} dismiss={dismiss} />

                {state === 'loading' && <p role="status" className="py-12 text-center text-warm-gray">Loading recently deleted albums…</p>}
                {state === 'error' && (
                    <div className="py-12 text-center text-warm-gray">
                        <p>Recently deleted albums could not be loaded.</p>
                        <button type="button" onClick={retry} className="mt-3 px-4 py-2 rounded-lg bg-cream text-charcoal text-sm font-medium cursor-pointer hover:bg-cream-dark transition-colors">Try again</button>
                    </div>
                )}
                {state === 'ready' && !albums.length && (
                    <div className="rounded-2xl border border-dashed border-warm-border px-6 py-16 text-center text-warm-gray">
                        <p className="font-serif text-2xl text-charcoal">Nothing here</p>
                        <p className="mt-2 text-sm">Albums you delete in Manage Albums appear here for {RETENTION_DAYS} days.</p>
                    </div>
                )}
                {state === 'ready' && albums.length > 0 && (
                    <ul className="space-y-4" aria-label="Recently deleted albums">
                        {albums.map((album) => {
                            const working = busy.has(album.albumId)
                            return (
                                <li key={album.albumId} className="bg-white rounded-2xl p-4 shadow-warm-sm border border-warm-border flex flex-col gap-4 sm:flex-row sm:items-center">
                                    <div className="shrink-0 overflow-hidden rounded-xl bg-cream-dark" style={{ width: '7rem', height: '5rem' }}>
                                        {album.coverThumbnailUrl && (
                                            <img src={album.coverThumbnailUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                                        )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <h2 className="font-serif text-lg font-semibold text-charcoal truncate">{album.title}</h2>
                                        <p className="text-sm text-warm-gray">{contents(album)} · was in {formerPlace(album)}</p>
                                        <p className="mt-1 text-xs text-warm-gray">
                                            Deleted {formatDate(album.trashedAt)} · {purgeLabel(album, now)}
                                        </p>
                                    </div>
                                    <div className="flex gap-2 shrink-0">
                                        <button type="button" disabled={working} onClick={() => restore(album)} className="px-3 py-1.5 rounded-lg bg-amber text-white text-xs font-medium cursor-pointer hover:bg-amber-dark disabled:opacity-60 transition-colors">
                                            {working ? 'Working…' : 'Restore'}
                                        </button>
                                        <button type="button" disabled={working} onClick={() => deleteForever(album)} className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium cursor-pointer hover:bg-red-100 disabled:opacity-60 transition-colors">
                                            Delete permanently
                                        </button>
                                    </div>
                                </li>
                            )
                        })}
                    </ul>
                )}
            </div>
        </div>
    )
}
