import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigationType, useSearchParams } from 'react-router'
import { useAuth } from '../context/auth'
import { fetchRawPhotoFolder } from '../utils/api'
import {
    cachedRawPhotoFolder,
    createLightboxPrefetchPool,
    rawPhotoFolderHref as folderHref,
    storeRawPhotoFolder,
    toViewerPhoto,
} from '../utils/rawPhotoViewer'
import AlbumLoadingSkeleton from '../components/AlbumLoadingSkeleton'
import AlbumPhotoSections from '../components/AlbumPhotoSections'
import DashboardBackLink from '../components/DashboardBackLink'
import PhotoLightbox from '../components/PhotoLightbox'
import usePhotoSections from '../hooks/usePhotoSections'
import './RawPhotoViewer.css'

const REFRESH_INTERVAL_MILLISECONDS = 60 * 1000
const HOVER_INTENT_MILLISECONDS = 120

function photoCount(count) {
    return `${count.toLocaleString('en-US')} ${count === 1 ? 'photo' : 'photos'}`
}

function folderCount(count) {
    return `${count.toLocaleString('en-US')} ${count === 1 ? 'folder' : 'folders'}`
}

function FolderIcon() {
    return (
        <svg className="raw-photos-folder-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
        </svg>
    )
}

export default function RawPhotoViewer() {
    const { getIdToken } = useAuth()
    const [searchParams] = useSearchParams()
    const navigationType = useNavigationType()
    const folderId = searchParams.get('folder') || ''
    const [reloadVersion, setReloadVersion] = useState(0)
    const [result, setResult] = useState(null)
    const [prefetchPool] = useState(createLightboxPrefetchPool)
    const forceReloadRef = useRef(false)
    const refreshedFolderRef = useRef(null)
    const shownFolderRef = useRef(undefined)
    const intentTimerRef = useRef(0)

    useEffect(() => {
        const controller = new AbortController()
        const force = forceReloadRef.current
        forceReloadRef.current = false
        Promise.resolve()
            .then(async () => {
                const cached = force ? null : cachedRawPhotoFolder(folderId)
                if (cached) return cached
                const token = await getIdToken()
                const data = await fetchRawPhotoFolder(token, folderId, { signal: controller.signal })
                storeRawPhotoFolder(folderId, data)
                return data
            })
            .then((data) => {
                if (!controller.signal.aborted) setResult({ folderId, version: reloadVersion, data })
            })
            .catch((error) => {
                if (error?.name === 'AbortError' || controller.signal.aborted) return
                setResult({ folderId, version: reloadVersion, error: error?.message || 'The raw photo backup could not be loaded.' })
            })
        return () => controller.abort()
    }, [folderId, getIdToken, reloadVersion])

    // The folder on screen stays until the next one is ready, so opening a
    // folder never collapses the page or jumps through a loading state.
    const failed = result?.error && result.folderId === folderId && result.version === reloadVersion ? result.error : ''
    const data = result?.data
    const pending = !failed && (!result || result.folderId !== folderId || Boolean(result.error && result.version !== reloadVersion))
    const shownFolderId = data ? result.folderId : undefined

    // A newly shown folder starts at its top in the same frame it appears.
    // Back and forward keep the position the route scroll memory restores.
    useLayoutEffect(() => {
        const previous = shownFolderRef.current
        shownFolderRef.current = shownFolderId
        if (previous === undefined || shownFolderId === undefined || previous === shownFolderId) return
        if (navigationType !== 'POP') window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    }, [shownFolderId, navigationType])

    const photos = useMemo(() => (data?.photos || []).map(toViewerPhoto), [data])
    const { sections, activeImages, lightboxIndex, openPhoto, resetLightbox, goNext, goPrev } = usePhotoSections(photos, false)
    const eagerImageCount = window.matchMedia?.('(min-width: 1024px)').matches ? 3
        : window.matchMedia?.('(min-width: 640px)').matches ? 2 : 1

    // Keep the open photo and its neighbours warm at the viewer's size.
    useEffect(() => {
        if (lightboxIndex === null || !activeImages.length) return
        const count = activeImages.length
        prefetchPool.keep([0, 1, -1, 2].map(offset => activeImages[(lightboxIndex + offset + count) % count]))
    }, [activeImages, lightboxIndex, prefetchPool])

    useEffect(() => () => {
        window.clearTimeout(intentTimerRef.current)
        prefetchPool.clear()
    }, [prefetchPool])

    const handleIntent = useCallback((photo, immediate) => {
        window.clearTimeout(intentTimerRef.current)
        if (immediate) prefetchPool.keep([photo])
        else intentTimerRef.current = window.setTimeout(() => prefetchPool.keep([photo]), HOVER_INTENT_MILLISECONDS)
    }, [prefetchPool])

    const closeLightbox = useCallback(() => {
        prefetchPool.keep([])
        resetLightbox()
    }, [prefetchPool, resetLightbox])

    const reload = useCallback(() => {
        forceReloadRef.current = true
        setReloadVersion((version) => version + 1)
    }, [])

    // Drive thumbnail links expire. Fetch fresh links, at most once a minute
    // per folder, so a missing image cannot cause a request loop.
    const handleMediaError = useCallback(() => {
        const previous = refreshedFolderRef.current
        if (previous?.folderId === folderId && Date.now() - previous.at < REFRESH_INTERVAL_MILLISECONDS) return
        refreshedFolderRef.current = { folderId, at: Date.now() }
        reload()
    }, [folderId, reload])

    const path = data?.path || []
    const folders = data?.folders || []
    const title = data?.folder?.name || 'Raw Photo Backup'

    return (
        <div aria-busy={pending} className="linen-gallery-page raw-photos-page flex-1 animate-fade-in min-h-screen pb-16 pt-[88px] md:pt-[104px]">
            <div className="max-w-7xl mx-auto px-6 pt-8 md:pt-12">
                <DashboardBackLink className="linen-gallery-back inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-6 cursor-pointer">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Dashboard
                </DashboardBackLink>

                {failed && (
                    <div className="raw-photos-error" role="alert">
                        <p className="raw-photos-error-title">This folder could not be loaded.</p>
                        <p className="raw-photos-error-message">{failed}</p>
                        <button type="button" className="raw-photos-retry" onClick={reload}>Try again</button>
                    </div>
                )}

                {!failed && !data && <AlbumLoadingSkeleton />}

                {!failed && data && (
                    <div className={`raw-photos-content ${pending ? 'is-pending' : ''}`}>
                        <div key={shownFolderId} className="animate-fade-in">
                            <nav aria-label="Folder path" className="raw-photos-path">
                                <ol>
                                    {path.map((entry, index) => (
                                        <li key={entry.id}>
                                            {index === path.length - 1
                                                ? <span aria-current="page">{entry.name}</span>
                                                : <Link to={folderHref(entry, index === 0)}>{entry.name}</Link>}
                                        </li>
                                    ))}
                                </ol>
                            </nav>

                            <div className="linen-gallery-header mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-warm-gray/10 animate-fade-in">
                                <div className="min-w-0 animate-slide-up">
                                    {!photos.length && <p className="raw-photos-eyebrow">{data.isRoot ? 'Camera originals' : 'Raw photo backup'}</p>}
                                    <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4 w-fit">{title}</h1>
                                    <p className="text-sm text-warm-gray/70 mt-4 uppercase tracking-wider font-medium">
                                        {data.album || photos.length ? photoCount(photos.length) : folderCount(folders.length)}
                                    </p>
                                </div>
                            </div>

                            {data.truncated && (
                                <p className="raw-photos-notice" role="status">
                                    This folder is very large, so only its first 10,000 items are shown.
                                </p>
                            )}

                            {folders.length > 0 && (
                                <ul className="raw-photos-folders" aria-label="Folders">
                                    {folders.map((entry) => (
                                        <li key={entry.id}>
                                            <Link className="raw-photos-folder" to={folderHref(entry, false)} title={entry.name}>
                                                <FolderIcon />
                                                <span className="raw-photos-folder-name">{entry.name}</span>
                                            </Link>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            {photos.length > 0 && (
                                <div className="mb-12">
                                    <AlbumPhotoSections
                                        sections={sections}
                                        albumTitle={title}
                                        onOpen={openPhoto}
                                        onIntent={handleIntent}
                                        onMediaError={handleMediaError}
                                        eagerImageCount={eagerImageCount}
                                        itemLabel="Photo"
                                        prioritizeViewport
                                    />
                                </div>
                            )}

                            {!folders.length && !photos.length && (
                                <div className="text-center py-20 text-warm-gray">
                                    <p className="text-lg">This folder has no photos.</p>
                                </div>
                            )}
                        </div>

                        {lightboxIndex !== null && activeImages[lightboxIndex] && (
                            <PhotoLightbox
                                images={activeImages}
                                index={lightboxIndex}
                                ariaLabel={`Photo viewer for ${title}`}
                                onClose={closeLightbox}
                                onNext={goNext}
                                onPrevious={goPrev}
                                canShare={false}
                                onMediaError={handleMediaError}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
