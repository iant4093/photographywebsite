import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AdminToasts from '../components/AdminToasts'
import DashboardBackLink from '../components/DashboardBackLink'
import SiteSelect from '../components/SiteSelect'
import { useAuth } from '../context/auth'
import { useAdminToasts } from '../hooks/useAdminToasts'
import useMediaQuery from '../hooks/useMediaQuery'
import { fetchAlbumMediaPage, fetchAlbumsFiltered, updateImageThumbnail } from '../utils/api'
import { mediaDisplayUrl, mediaPreviewSrcSet, mediaThumbnailUrl } from '../utils/mediaUrls'
import './FavoriteSwipe.css'

// A drag this far (px), or a quick flick, decides the photo.
export const SWIPE_THRESHOLD = 110
const FLICK_SPEED = 0.6
const URL_REFRESH_COOLDOWN_MS = 20_000
const WITH_FAVORITES = 'Albums with favorites'
const WITHOUT_FAVORITES = 'Albums without favorites'
const CARD_SIZES = '(max-width: 640px) 92vw, 560px'

const mediaKey = (item) => item?.rawKey || item?.key || ''
// Each card takes its photo's shape (3:2 until the size is known).
const cardRatio = (photo) => (photo?.width > 0 && photo?.height > 0 ? Math.min(3, Math.max(0.33, photo.width / photo.height)) : 1.5)

async function loadAlbumPhotos(token, albumId) {
    const items = []
    const seen = new Set()
    let cursor = null
    do {
        const page = await fetchAlbumMediaPage(token, albumId, { limit: 100, cursor })
        items.push(...(page.items || []))
        cursor = page.nextCursor || null
        if (cursor && seen.has(cursor)) break
        if (cursor) seen.add(cursor)
    } while (cursor)
    const unique = new Map()
    for (const item of items) {
        const key = mediaKey(item)
        if (key && !unique.has(key)) unique.set(key, item)
    }
    return [...unique.values()]
}

function SwipePhoto({ photo, eager = false, onError }) {
    return (
        <img
            src={mediaThumbnailUrl(photo) || mediaDisplayUrl(photo)}
            srcSet={mediaPreviewSrcSet(photo) || undefined}
            sizes={CARD_SIZES}
            alt={photo.altText || photo.originalFilename || 'Photo'}
            width={photo.width || undefined}
            height={photo.height || undefined}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            draggable={false}
            onError={onError}
        />
    )
}

const Icon = {
    skip: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>,
    favorite: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.6 3.9 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.7 1.1-1.6 2.7-2.7 4.7-2.7 3.4 0 5.7 3.1 4.5 6.6-1.7 4.8-9.2 9.4-9.2 9.4Z" /></svg>,
    undo: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M4.5 12H15a5 5 0 0 1 0 10h-2" /></svg>,
}

// Admin: go through an album's photos one at a time and swipe right to
// favorite, left to skip. Skips are not saved, so the next visit shows every
// photo that is still not a favorite.
export default function FavoriteSwipe() {
    const { getIdToken } = useAuth()
    const { toasts, notify, dismiss } = useAdminToasts()
    const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
    const [albums, setAlbums] = useState([])
    const [albumsState, setAlbumsState] = useState('loading')
    const [deltas, setDeltas] = useState({})
    const [albumId, setAlbumId] = useState('')
    const [loadState, setLoadState] = useState('idle')
    const [deck, setDeck] = useState([])
    const [total, setTotal] = useState(0)
    const [history, setHistory] = useState([])
    const [favorited, setFavorited] = useState(0)
    const [drag, setDrag] = useState(null)
    const [flying, setFlying] = useState(null)
    const [saving, setSaving] = useState(0)
    const [announcement, setAnnouncement] = useState('')
    const dragRef = useRef(null)
    const writes = useRef(Promise.resolve())
    const request = useRef(0)
    const openAlbumId = useRef('')
    const sequence = useRef(0)
    const lastRefresh = useRef(0)

    const [albumsAttempt, setAlbumsAttempt] = useState(0)
    useEffect(() => {
        let active = true
        getIdToken()
            .then((token) => fetchAlbumsFiltered({ visibility: 'all', type: 'photo', favorites: '1', limit: 100 }, token))
            .then((items) => {
                if (!active) return
                setAlbums(items.filter((album) => album.type !== 'video'))
                setAlbumsState('ready')
            }, (error) => {
                if (!active) return
                setAlbumsState('error')
                notify(error?.message || 'Albums could not be loaded.', 'error')
            })
        return () => { active = false }
    }, [albumsAttempt, getIdToken, notify])
    const retryAlbums = () => {
        setAlbumsState('loading')
        setAlbumsAttempt((attempt) => attempt + 1)
    }

    const favoriteCount = useCallback(
        (album) => Math.max(0, (Number(album.favoriteCount) || 0) + (deltas[album.albumId] || 0)),
        [deltas],
    )
    const options = useMemo(() => {
        const option = (album, group) => {
            const count = favoriteCount(album)
            const photos = Number.isFinite(Number(album.imageCount)) ? Number(album.imageCount) : null
            const detail = count
                ? `${count}${photos !== null ? ` of ${photos}` : ''} favorited`
                : `${photos ?? 'No'} ${photos === 1 ? 'photo' : 'photos'}`
            return { value: album.albumId, label: `${album.title || 'Untitled album'} · ${detail}`, group }
        }
        return [
            ...albums.filter((album) => favoriteCount(album) > 0).map((album) => option(album, WITH_FAVORITES)),
            ...albums.filter((album) => favoriteCount(album) === 0).map((album) => option(album, WITHOUT_FAVORITES)),
        ]
    }, [albums, favoriteCount])

    const openAlbum = useCallback(async (id) => {
        const ticket = ++request.current
        openAlbumId.current = id
        setAlbumId(id)
        setDeck([])
        setHistory([])
        setFavorited(0)
        setFlying(null)
        setDrag(null)
        setLoadState('loading')
        try {
            const photos = await loadAlbumPhotos(await getIdToken(), id)
            if (ticket !== request.current) return
            const remaining = photos.filter((photo) => photo.isFavorite !== true)
            setDeck(remaining)
            setTotal(remaining.length)
            setLoadState('ready')
        } catch (error) {
            if (ticket !== request.current) return
            setLoadState('error')
            notify(error?.message || 'This album\'s photos could not be loaded.', 'error')
        }
    }, [getIdToken, notify])

    // Signed photo URLs of private albums expire; fetch fresh ones and keep
    // the order of the cards (and of the undo history) as it is.
    const refreshUrls = useCallback(async () => {
        if (!albumId || Date.now() - lastRefresh.current < URL_REFRESH_COOLDOWN_MS) return
        lastRefresh.current = Date.now()
        const ticket = request.current
        try {
            const fresh = new Map((await loadAlbumPhotos(await getIdToken(), albumId)).map((photo) => [mediaKey(photo), photo]))
            if (ticket !== request.current) return
            const update = (photo) => ({ ...photo, ...(fresh.get(mediaKey(photo)) || {}), isFavorite: photo.isFavorite })
            setDeck((current) => current.map(update))
            setHistory((current) => current.map((entry) => ({ ...entry, photo: update(entry.photo) })))
        } catch {
            // The card keeps its placeholder; the next error retries.
        }
    }, [albumId, getIdToken])

    // Favorite writes go one at a time: the album accepts one change at once.
    const writeFavorite = useCallback((id, photo, isFavorite) => {
        setSaving((count) => count + 1)
        const run = writes.current.then(async () => {
            await updateImageThumbnail(await getIdToken(), id, mediaKey(photo), { isFavorite })
        })
        writes.current = run.catch(() => {})
        return run.finally(() => setSaving((count) => count - 1))
    }, [getIdToken])

    const adjust = useCallback(
        (id, delta) => setDeltas((current) => ({ ...current, [id]: (current[id] || 0) + delta })),
        [],
    )

    const decide = useCallback((action, fromX = 0) => {
        const photo = deck[0]
        if (!photo) return
        const entry = { id: ++sequence.current, photo, action, albumId }
        setDeck((current) => current.slice(1))
        setHistory((current) => [...current, entry])
        setDrag(null)
        if (!reducedMotion) setFlying({ id: entry.id, photo, action, fromX })
        if (action === 'skip') {
            setAnnouncement('Skipped.')
            return
        }
        setAnnouncement('Added to favorites.')
        setFavorited((count) => count + 1)
        adjust(albumId, 1)
        writeFavorite(albumId, photo, true).catch((error) => {
            notify(`That photo was not favorited: ${error?.message || 'please try again.'}`, 'error')
            adjust(entry.albumId, -1)
            // Put the card back only if that album is still open.
            if (openAlbumId.current === entry.albumId) {
                setFavorited((count) => Math.max(0, count - 1))
                setHistory((current) => current.filter((item) => item.id !== entry.id))
                setDeck((current) => [photo, ...current.filter((item) => mediaKey(item) !== mediaKey(photo))])
            }
        })
    }, [adjust, albumId, deck, notify, reducedMotion, writeFavorite])

    const undo = useCallback(() => {
        const entry = history.at(-1)
        if (!entry) return
        setHistory((current) => current.slice(0, -1))
        setDeck((current) => [entry.photo, ...current])
        setFlying(null)
        if (entry.action === 'skip') {
            setAnnouncement('Brought the photo back.')
            return
        }
        setAnnouncement('Removed from favorites.')
        setFavorited((count) => Math.max(0, count - 1))
        adjust(entry.albumId, -1)
        writeFavorite(entry.albumId, entry.photo, false).catch((error) => {
            notify(`That photo is still a favorite: ${error?.message || 'please try again.'}`, 'error')
            adjust(entry.albumId, 1)
            if (openAlbumId.current === entry.albumId) {
                setFavorited((count) => count + 1)
                setDeck((current) => current.filter((item) => mediaKey(item) !== mediaKey(entry.photo)))
            }
        })
    }, [adjust, history, notify, writeFavorite])

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.defaultPrevented || event.altKey) return
            if (event.target?.closest?.('input, textarea, select, [role="combobox"], [role="listbox"]')) return
            const undoKey = (event.key === 'z' && (event.metaKey || event.ctrlKey)) || event.key === 'Backspace'
            if (undoKey) {
                event.preventDefault()
                undo()
            } else if (!event.metaKey && !event.ctrlKey && event.key === 'ArrowRight') {
                event.preventDefault()
                decide('favorite')
            } else if (!event.metaKey && !event.ctrlKey && event.key === 'ArrowLeft') {
                event.preventDefault()
                decide('skip')
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [decide, undo])

    const startDrag = (event) => {
        if (event.button !== 0 || !event.isPrimary) return
        dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp }
        event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    const moveDrag = (event) => {
        const start = dragRef.current
        if (!start || start.id !== event.pointerId) return
        setDrag({ dx: event.clientX - start.x, dy: event.clientY - start.y })
    }
    const endDrag = (event) => {
        const start = dragRef.current
        if (!start || start.id !== event.pointerId) return
        dragRef.current = null
        const dx = event.clientX - start.x
        const speed = Math.abs(dx) / Math.max(1, event.timeStamp - start.time)
        if (Math.abs(dx) >= SWIPE_THRESHOLD || (Math.abs(dx) > 40 && speed > FLICK_SPEED)) decide(dx > 0 ? 'favorite' : 'skip', dx)
        else setDrag(null)
    }
    const cancelDrag = () => {
        dragRef.current = null
        setDrag(null)
    }

    const top = deck[0]
    const dx = drag?.dx || 0
    const lean = Math.max(-1, Math.min(1, dx / SWIPE_THRESHOLD))
    const reviewed = total - deck.length
    const selectedTitle = albums.find((album) => album.albumId === albumId)?.title

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
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Swipe Favorites</h1>
                    <p className="mt-2 text-warm-gray">
                        Pick an album, then swipe right to favorite a photo or left to skip it. Skipped photos come back next time.
                    </p>
                </div>
                <AdminToasts toasts={toasts} dismiss={dismiss} />

                <div className="favorite-swipe-picker">
                    <span id="favorite-swipe-album" className="favorite-swipe-label">Album</span>
                    <SiteSelect
                        aria-labelledby="favorite-swipe-album"
                        options={options}
                        value={albumId}
                        disabled={albumsState !== 'ready'}
                        placeholder={albumsState === 'loading' ? 'Loading albums…' : 'Choose a photo album'}
                        onChange={(value) => openAlbum(String(value))}
                    />
                    {albumsState === 'error' && (
                        <button type="button" className="favorite-swipe-text-button" onClick={retryAlbums}>Try again</button>
                    )}
                </div>

                <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

                {loadState === 'loading' && <p className="favorite-swipe-message">Loading photos…</p>}
                {loadState === 'error' && (
                    <div className="favorite-swipe-message">
                        <p>The photos could not be loaded.</p>
                        <button type="button" className="favorite-swipe-text-button" onClick={() => openAlbum(albumId)}>Try again</button>
                    </div>
                )}
                {loadState === 'ready' && (
                    <section className="favorite-swipe" aria-label={`Photos to review${selectedTitle ? ` in ${selectedTitle}` : ''}`}>
                        <p className="favorite-swipe-progress">
                            {total === 0
                                ? 'Every photo in this album is already a favorite.'
                                : `${Math.min(reviewed + (top ? 1 : 0), total)} of ${total} · ${favorited} favorited${saving ? ' · saving…' : ''}`}
                        </p>
                        <div className="favorite-swipe-stack">
                            {deck.slice(1, 3).reverse().map((photo, index, behind) => (
                                <div key={mediaKey(photo)} className="favorite-swipe-card is-behind" data-depth={behind.length - index} style={{ '--ratio': cardRatio(photo) }} aria-hidden="true">
                                    <SwipePhoto photo={photo} />
                                </div>
                            ))}
                            {top && (
                                <div
                                    key={mediaKey(top)}
                                    className={`favorite-swipe-card is-top${drag ? ' is-dragging' : ''}`}
                                    style={{ '--drag-x': `${dx}px`, '--drag-y': `${(drag?.dy || 0) * 0.15}px`, '--lean': lean, '--ratio': cardRatio(top) }}
                                    onPointerDown={startDrag}
                                    onPointerMove={moveDrag}
                                    onPointerUp={endDrag}
                                    onPointerCancel={cancelDrag}
                                    onLostPointerCapture={cancelDrag}
                                >
                                    <SwipePhoto photo={top} eager onError={refreshUrls} />
                                    <span className="favorite-swipe-stamp is-favorite" style={{ opacity: Math.max(0, lean) }} aria-hidden="true">Favorite</span>
                                    <span className="favorite-swipe-stamp is-skip" style={{ opacity: Math.max(0, -lean) }} aria-hidden="true">Skip</span>
                                </div>
                            )}
                            {flying && (
                                <div
                                    key={`flying-${flying.id}`}
                                    className="favorite-swipe-card is-flying"
                                    data-action={flying.action}
                                    style={{ '--from-x': `${flying.fromX}px`, '--ratio': cardRatio(flying.photo) }}
                                    aria-hidden="true"
                                    onAnimationEnd={() => setFlying((current) => (current?.id === flying.id ? null : current))}
                                >
                                    <SwipePhoto photo={flying.photo} />
                                </div>
                            )}
                            {!top && total > 0 && (
                                <div className="favorite-swipe-done">
                                    <p className="favorite-swipe-done-title">All caught up</p>
                                    <p>You favorited {favorited} of {total} {total === 1 ? 'photo' : 'photos'} here.</p>
                                    <button type="button" className="favorite-swipe-text-button" onClick={() => openAlbum(albumId)}>
                                        Review skipped photos again
                                    </button>
                                </div>
                            )}
                        </div>
                        <div className="favorite-swipe-actions">
                            <button type="button" className="favorite-swipe-button is-skip" aria-label="Skip photo" disabled={!top} onClick={() => decide('skip')}>
                                {Icon.skip}
                            </button>
                            <button type="button" className="favorite-swipe-button is-undo" aria-label="Undo last swipe" disabled={!history.length} onClick={undo}>
                                {Icon.undo}
                            </button>
                            <button type="button" className="favorite-swipe-button is-favorite" aria-label="Favorite photo" disabled={!top} onClick={() => decide('favorite')}>
                                {Icon.favorite}
                            </button>
                        </div>
                        <p className="favorite-swipe-hint">Swipe or use ← skip, → favorite, ⌫ or ⌘Z undo.</p>
                    </section>
                )}
            </div>
        </div>
    )
}
