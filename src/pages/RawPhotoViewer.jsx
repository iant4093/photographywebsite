import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useAuth } from '../context/auth'
import { fetchRawPhotoFolder } from '../utils/api'
import {
    cachedRawPhotoFolder,
    rawPhotoFolderHref as folderHref,
    storeRawPhotoFolder,
    toViewerPhoto,
} from '../utils/rawPhotoViewer'
import AlbumPhotoSections from '../components/AlbumPhotoSections'
import DashboardBackLink from '../components/DashboardBackLink'
import PhotoLightbox from '../components/PhotoLightbox'
import usePhotoSections from '../hooks/usePhotoSections'
import './RawPhotoViewer.css'

const REFRESH_INTERVAL_MILLISECONDS = 60 * 1000

function photoCount(count) {
    return `${count.toLocaleString('en-US')} ${count === 1 ? 'photo' : 'photos'}`
}

function scrollToTop() {
    window.scrollTo({ top: 0, left: 0 })
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
    const folderId = searchParams.get('folder') || ''
    const [reloadVersion, setReloadVersion] = useState(0)
    const [result, setResult] = useState(null)
    const forceReloadRef = useRef(false)
    const refreshedFolderRef = useRef(null)

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

    // A refresh keeps the current folder on screen; a new folder shows loading.
    const current = result?.folderId === folderId ? result : null
    const loading = !current || (current.error && current.version !== reloadVersion)
    const data = current?.data
    const error = !loading ? current?.error : ''

    const photos = useMemo(() => (data?.photos || []).map(toViewerPhoto), [data])
    const { sections, activeImages, lightboxIndex, openPhoto, resetLightbox, goNext, goPrev } = usePhotoSections(photos, false)
    const eagerImageCount = window.matchMedia?.('(min-width: 1024px)').matches ? 3
        : window.matchMedia?.('(min-width: 640px)').matches ? 2 : 1

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

    const folder = data?.folder
    const path = data?.path || []
    const folders = data?.folders || []
    const title = folder?.name || 'Raw Photo Backup'

    return (
        <div aria-busy={loading} className="linen-gallery-page raw-photos-page flex-1 min-h-screen pb-16 pt-[88px] md:pt-[104px]">
            <div className="max-w-7xl mx-auto px-6 pt-8 md:pt-12">
                <DashboardBackLink className="raw-photos-back-link">
                    <svg className="raw-photos-back-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Dashboard
                </DashboardBackLink>

                {path.length > 0 && (
                    <nav aria-label="Folder path" className="raw-photos-path">
                        <ol>
                            {path.map((entry, index) => (
                                <li key={entry.id}>
                                    {index === path.length - 1
                                        ? <span aria-current="page">{entry.name}</span>
                                        : <Link to={folderHref(entry, index === 0)} onClick={scrollToTop}>{entry.name}</Link>}
                                </li>
                            ))}
                        </ol>
                    </nav>
                )}

                {loading && (
                    <div className="raw-photos-loading" role="status" aria-live="polite">
                        <span className="sr-only">Loading raw photo folder</span>
                        <div className="raw-photos-spinner" />
                    </div>
                )}

                {!loading && error && (
                    <div className="raw-photos-error" role="alert">
                        <p className="raw-photos-error-title">This folder could not be loaded.</p>
                        <p className="raw-photos-error-message">{error}</p>
                        <button type="button" className="raw-photos-retry" onClick={reload}>Try again</button>
                    </div>
                )}

                {!loading && !error && data && (
                    <div>
                        <div className="linen-gallery-header mb-12 pb-6 border-b border-warm-gray/10 animate-fade-in">
                            {!photos.length && <p className="raw-photos-eyebrow">{data.isRoot ? 'Camera originals' : 'Raw photo backup'}</p>}
                            <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4 w-fit">{title}</h1>
                            <p className="text-sm text-warm-gray/70 uppercase tracking-wider font-medium">
                                {data.album || photos.length
                                    ? photoCount(photos.length)
                                    : `${folders.length.toLocaleString('en-US')} ${folders.length === 1 ? 'folder' : 'folders'}`}
                            </p>
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
                                        <Link className="raw-photos-folder" to={folderHref(entry, false)} onClick={scrollToTop}>
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

                        {lightboxIndex !== null && activeImages[lightboxIndex] && (
                            <PhotoLightbox
                                images={activeImages}
                                index={lightboxIndex}
                                ariaLabel={`Photo viewer for ${title}`}
                                onClose={resetLightbox}
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
