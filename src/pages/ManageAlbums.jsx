import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/auth'
import { processImage, processVideo, extractFrameFromVideoElement } from '../utils/mediaUtils'
import {
    fetchAlbumsFiltered,
    listUsers,
    updateAlbum,
    deleteAlbum,
    deleteImages,
    requestUploadUrl,
    uploadFileToS3,
    fetchAlbum,
    addImagesToAlbum,
    updateImageThumbnail,
} from '../utils/api'
import { mediaDisplayUrl, mediaThumbnailUrl } from '../utils/mediaUrls'
import { mapWithConcurrency } from '../utils/concurrency'

function urlPathMatchesKey(value, key) {
    if (!value || !key) return false
    if (value === key) return true
    try {
        const path = decodeURIComponent(new URL(value, window.location.origin).pathname).replace(/^\/+/, '')
        return path === key || path.endsWith(`/${key}`)
    } catch {
        return false
    }
}

function isCurrentAlbumCover(album, image) {
    if (!album || !image) return false
    const rawKey = image.rawKey || image.key || ''
    const thumbKey = image.thumbKey || ''
    return urlPathMatchesKey(album.coverImageUrl, rawKey)
        || urlPathMatchesKey(album.coverThumbnailUrl, thumbKey)
        || album.coverThumbKey === thumbKey
}

function managementMediaKey(image) {
    const value = image?.rawKey || image?.key
    return typeof value === 'string' && value.trim() ? value : ''
}

// Helper component for picking a thumbnail time for a video
function VideoThumbnailScrubber({ file, time, onTimeChange }) {
    const videoRef = useRef(null)
    const [duration, setDuration] = useState(0)
    const url = useMemo(() => URL.createObjectURL(file), [file])

    useEffect(() => {
        return () => URL.revokeObjectURL(url)
    }, [url])

    const handleLoadedMetadata = () => {
        if (videoRef.current) {
            setDuration(videoRef.current.duration)
            videoRef.current.currentTime = time
        }
    }

    const handleChange = (e) => {
        const newTime = parseInt(e.target.value, 10)
        onTimeChange(newTime)
        if (videoRef.current) {
            videoRef.current.currentTime = newTime
        }
    }

    return (
        <div className="flex items-center gap-4 bg-cream/30 p-3 rounded-lg border border-warm-border/50">
            <div className="w-24 h-16 bg-black rounded overflow-hidden shrink-0 relative">
                {url && (
                    <video
                        ref={videoRef}
                        src={url}
                        onLoadedMetadata={handleLoadedMetadata}
                        className="w-full h-full object-contain"
                        muted
                        playsInline
                    />
                )}
            </div>
            <div className="flex-1">
                <p className="text-sm font-medium text-charcoal truncate mb-2">{file.name}</p>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-warm-gray">{time}s</span>
                    <input
                        type="range"
                        min="0"
                        max={duration ? Math.floor(duration) : 100}
                        step="1"
                        value={time}
                        onChange={handleChange}
                        className="flex-1 text-amber accent-amber"
                    />
                    <span className="text-xs text-warm-gray">{Math.floor(duration)}s</span>
                </div>
            </div>
        </div>
    )
}

// Scrubber for an already-uploaded video identified by URL (used for thumbnail re-generation)
function VideoThumbnailFromUrl({ videoUrl, time, onTimeChange, onVideoRef }) {
    const videoRef = useRef(null)
    const [duration, setDuration] = useState(0)

    const setRef = (el) => {
        videoRef.current = el
        if (onVideoRef) onVideoRef(el)
    }

    const handleLoadedMetadata = () => {
        if (videoRef.current) {
            setDuration(videoRef.current.duration)
            videoRef.current.currentTime = time
        }
    }

    const handleChange = (e) => {
        const newTime = parseInt(e.target.value, 10)
        onTimeChange(newTime)
        if (videoRef.current) {
            videoRef.current.currentTime = newTime
        }
    }

    return (
        <div className="flex items-center gap-4 bg-cream/30 p-3 rounded-lg border border-warm-border/50">
            <div className="w-24 h-16 bg-black rounded overflow-hidden shrink-0">
                <video
                    ref={setRef}
                    src={videoUrl}
                    onLoadedMetadata={handleLoadedMetadata}
                    onError={(e) => console.error('VideoThumbnailFromUrl load error:', e.target.error)}
                    className="w-full h-full object-contain"
                    crossOrigin="anonymous"
                    muted
                    playsInline
                />
            </div>
            <div className="flex-1">
                <p className="text-xs text-warm-gray truncate mb-2">{videoUrl.split('/').pop()}</p>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-warm-gray">{time}s</span>
                    <input
                        type="range"
                        min="0"
                        max={duration ? Math.floor(duration) : 100}
                        step="1"
                        value={time}
                        onChange={handleChange}
                        className="flex-1 text-amber accent-amber"
                    />
                    <span className="text-xs text-warm-gray">{Math.floor(duration)}s</span>
                </div>
            </div>
        </div>
    )
}

// Manage albums page — full CRUD for main gallery and per-user albums
function ManageAlbums() {
    const [searchParams] = useSearchParams()
    const typeFilter = searchParams.get('type') || 'photo' // 'photo' or 'video'

    const { getIdToken } = useAuth()

    // Scope: 'public' for main gallery, or a user email for private albums
    const [scope, setScope] = useState('public')
    const [users, setUsers] = useState([])
    const [albums, setAlbums] = useState([])
    const [loading, setLoading] = useState(true)
    const [userSearch, setUserSearch] = useState('')

    // Editing state
    const [editingAlbum, setEditingAlbum] = useState(null)
    const [editTitle, setEditTitle] = useState('')
    const [editDesc, setEditDesc] = useState('')
    const [editDate, setEditDate] = useState('')
    const [editCategory, setEditCategory] = useState('')

    // Album detail view (images) — tracks which albumId is expanded
    const [expandedAlbumId, setExpandedAlbumId] = useState(null)
    const [albumImages, setAlbumImages] = useState([])
    const [loadingImages, setLoadingImages] = useState(false)
    const [addingFiles, setAddingFiles] = useState([])
    const [addingVideoFiles, setAddingVideoFiles] = useState([]) // [{ file, time }]
    const [uploadingMore, setUploadingMore] = useState(false)
    const addFilesRef = useRef(null)

    // Per-video thumbnail editing state
    const [editingThumbKey, setEditingThumbKey] = useState(null) // rawKey of video being edited
    const [editingThumbTime, setEditingThumbTime] = useState(0)
    const [updatingThumb, setUpdatingThumb] = useState(false)
    const scrubberVideoRef = useRef(null)  // ref to the scrubber's <video> element

    const [actionError, setActionError] = useState('')
    const [actionSuccess, setActionSuccess] = useState('')

    // Load users on mount
    useEffect(() => {
        async function load() {
            try {
                const token = await getIdToken()
                const data = await listUsers(token)
                setUsers(data)
            } catch (err) {
                console.error('Failed to load users:', err)
            }
        }
        load()
    }, [getIdToken])

    // Fetch albums for the current scope
    const loadAlbums = useCallback(async () => {
        setLoading(true)
        setExpandedAlbumId(null)
        setAlbumImages([])
        try {
            let params = { type: typeFilter }
            if (scope === 'public') {
                params = { ...params, visibility: 'public' }
            } else if (scope === 'unlisted') {
                params = { ...params, visibility: 'unlisted' }
            } else {
                params = { ...params, visibility: 'private', ownerEmail: scope }
            }
            const token = await getIdToken()
            const data = await fetchAlbumsFiltered(params, token)
            // Retain a client check for compatibility with the legacy endpoint.
            const typeMatched = data.filter((album) => (
                typeFilter === 'video' ? album.type === 'video' : album.type !== 'video'
            ))
            const scopeMatched = scope !== 'public' && scope !== 'unlisted'
                ? typeMatched.filter((album) => (
                    String(album.ownerEmail || '').trim().toLowerCase() === scope.trim().toLowerCase()
                ))
                : typeMatched
            setAlbums(scopeMatched)
        } catch (err) {
            console.error('Failed to load albums:', err)
            setAlbums([])
        } finally {
            setLoading(false)
        }
    }, [getIdToken, scope, typeFilter])

    // Load albums when the owner scope or media type changes.
    useEffect(() => {
        const timeout = window.setTimeout(loadAlbums, 0)
        return () => window.clearTimeout(timeout)
    }, [loadAlbums])
    async function toggleAlbumImages(album) {
        if (expandedAlbumId === album.albumId) {
            // Collapse
            setExpandedAlbumId(null)
            setAlbumImages([])
            setAddingFiles([])
            setAddingVideoFiles([])
            return
        }
        setExpandedAlbumId(album.albumId)
        setAddingFiles([])
        setAddingVideoFiles([])
        setLoadingImages(true)
        try {
            const token = await getIdToken()
            const data = await fetchAlbum(album.albumId, token)
            setAlbumImages(data.images || [])
        } catch (err) {
            console.error('Failed to load album images:', err)
        } finally {
            setLoadingImages(false)
        }
    }

    const handleVideoFileChange = (e) => {
        const files = Array.from(e.target.files)
        setAddingVideoFiles(files.map(file => ({ file, time: 0 })))
    }

    const handleVideoTimeChange = (index, newTime) => {
        setAddingVideoFiles(prev => {
            const copy = [...prev]
            copy[index].time = newTime
            return copy
        })
    }

    // Start editing album metadata
    function startEdit(album) {
        setEditingAlbum(album.albumId)
        setEditTitle(album.title)
        setEditDesc(album.description || '')
        setEditCategory(album.category || '')
        // Parse ISO date to YYYY-MM-DD for the date input
        setEditDate(album.createdAt ? album.createdAt.split('T')[0] : '')
    }

    // Save album edits
    async function saveEdit(albumId) {
        setActionError('')
        try {
            const token = await getIdToken()
            const updates = { title: editTitle, description: editDesc, category: editCategory }
            if (editDate) updates.createdAt = new Date(editDate + 'T12:00:00').toISOString()
            await updateAlbum(token, albumId, updates)
            setEditingAlbum(null)
            setActionSuccess('Album updated!')
            loadAlbums()
            setTimeout(() => setActionSuccess(''), 3000)
        } catch (err) {
            setActionError(err.message)
        }
    }

    // Delete entire album
    async function handleDelete(albumId) {
        if (!confirm('Are you sure you want to delete this album and all its photos?')) return
        setActionError('')
        try {
            const token = await getIdToken()
            await deleteAlbum(token, albumId)
            setActionSuccess('Album deleted!')
            setExpandedAlbumId(null)
            loadAlbums()
            setTimeout(() => setActionSuccess(''), 3000)
        } catch (err) {
            setActionError(err.message)
        }
    }



    // Remove specific image
    async function handleRemoveImage(img) {
        const key = managementMediaKey(img)
        if (!key) {
            setActionError('This item is missing its management key. Refresh the album and try again.')
            return
        }
        const expandedAlbum = albums.find((album) => album.albumId === expandedAlbumId)
        const deletingCover = isCurrentAlbumCover(expandedAlbum, img)
        const message = deletingCover
            ? 'This is the current album cover. Removing it will automatically use another remaining item as the cover, or clear the cover if the album becomes empty. Continue?'
            : 'Remove this item?'
        if (!confirm(message)) return
        setActionError('')
        try {
            const token = await getIdToken()
            await deleteImages(token, expandedAlbumId, [key])
            const data = await fetchAlbum(expandedAlbumId, token)
            const refreshedAlbum = data.album || data
            setAlbumImages(data.images || [])
            setAlbums((previous) => previous.map((album) => (
                album.albumId === expandedAlbumId ? { ...album, ...refreshedAlbum } : album
            )))
            setActionSuccess(deletingCover ? 'Item removed and album cover refreshed!' : 'Item removed!')
            setTimeout(() => setActionSuccess(''), 3000)
        } catch (err) {
            setActionError(err.message)
        }
    }

    // Set an image as the album cover
    async function handleSetCover(img) {
        const imgKey = managementMediaKey(img)
        if (!imgKey) {
            setActionError('This item is missing its management key. Refresh the album and try again.')
            return
        }
        setActionError('')
        try {
            const token = await getIdToken()
            const updates = {
                coverImageUrl: imgKey,
                coverThumbKey: img.thumbKey || '',
                coverBlurhash: img.blurhash || ''
            };

            await updateAlbum(token, expandedAlbumId, updates)
            setActionSuccess('Cover image updated!')
            loadAlbums()
            setTimeout(() => setActionSuccess(''), 3000)
        } catch (err) {
            setActionError(err.message)
        }
    }



    // Change the thumbnail of an already-uploaded video using the scrubber's video element
    async function handleChangeVideoThumbnail(img) {
        const rawKey = managementMediaKey(img)

        if (!rawKey) {
            setActionError('This video is missing its management key. Refresh the album and try again.')
            return
        }

        if (!scrubberVideoRef.current) {
            setActionError('Video not loaded yet — try again in a moment')
            return
        }

        setUpdatingThumb(true)
        setActionError('')
        try {
            // 1. Extract frame from the already-loaded scrubber video element
            const { thumbnail, blurhash } = await extractFrameFromVideoElement(scrubberVideoRef.current)

            // A content-derived suffix also avoids stale legacy CloudFront cache entries.
            const baseName = rawKey.split('/').slice(0, -1).join('/')
            const fileName = rawKey.split('/').pop()
            const contentSuffix = (blurhash || String(thumbnail.size)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
            const thumbKey = `${baseName}/thumb_${fileName}_${contentSuffix}.jpg`

            // 2. Upload the new thumbnail to S3 with the unique key
            const token = await getIdToken()
            const thumbUpload = await requestUploadUrl(
                token, expandedAlbumId, thumbKey, 'image/jpeg', thumbnail.size, 'thumbnail'
            )
            await uploadFileToS3(thumbUpload.uploadUrl, thumbnail, thumbUpload.requiredHeaders)
            const persistedThumbKey = thumbUpload.key || thumbKey

            // 3. Persist the new thumbKey + blurhash to DynamoDB
            await updateImageThumbnail(token, expandedAlbumId, rawKey, {
                thumbKey: persistedThumbKey,
                blurhash,
            })

            // 4. Refresh local state
            const data = await fetchAlbum(expandedAlbumId, token)
            setAlbumImages(data.images || [])

            setEditingThumbKey(null)
            setActionSuccess('Thumbnail updated!')
            setTimeout(() => setActionSuccess(''), 3000)
        } catch (err) {
            setActionError(err.message)
        } finally {
            setUpdatingThumb(false)
        }
    }

    // Add more images/videos to an existing album
    async function handleAddImages() {
        const isVideo = typeFilter === 'video'
        if (isVideo && !addingVideoFiles.length) return
        if (!isVideo && !addingFiles.length) return
        if (!expandedAlbumId) return

        setUploadingMore(true)
        setActionError('')
        const expandedAlbum = albums.find((a) => a.albumId === expandedAlbumId)
        try {
            const token = await getIdToken()
            const s3Prefix = expandedAlbum?.s3Prefix || `albums/${expandedAlbumId}/`

            const finalItems = isVideo
                ? await mapWithConcurrency(addingVideoFiles, 2, async (vf) => {
                    const { file, time } = vf
                    // 1. Process local thumbnail/hash
                    const { thumbnail, blurhash, width, height } = await processVideo(file, time)

                    // 2. Request both Pre-signed URLs
                    const legacyRawKey = `${s3Prefix}${file.name}`
                    const legacyThumbKey = `${s3Prefix}thumb_${file.name}.jpg`

                    const [rawUpload, thumbUpload] = await Promise.all([
                        requestUploadUrl(token, expandedAlbumId, legacyRawKey, file.type, file.size, 'original'),
                        requestUploadUrl(token, expandedAlbumId, legacyThumbKey, 'image/jpeg', thumbnail.size, 'thumbnail'),
                    ])

                    // 3. Upload both to S3
                    await Promise.all([
                        uploadFileToS3(rawUpload.uploadUrl, file, rawUpload.requiredHeaders),
                        uploadFileToS3(thumbUpload.uploadUrl, thumbnail, thumbUpload.requiredHeaders)
                    ])

                    const rawKey = rawUpload.key || legacyRawKey
                    const thumbKey = thumbUpload.key || legacyThumbKey

                    return {
                        rawKey,
                        thumbKey,
                        blurhash,
                        width,
                        height,
                        thumbnailTime: time,
                    }
                })
                : await mapWithConcurrency(addingFiles, 2, async (file) => {
                    // 1. Process local thumbnail/hash
                    const { thumbnail, blurhash, width, height } = await processImage(file)

                    // 2. Request both Pre-signed URLs
                    const legacyRawKey = `${s3Prefix}${file.name}`
                    const legacyThumbKey = `${s3Prefix}thumb_${file.name}`

                    const [rawUpload, thumbUpload] = await Promise.all([
                        requestUploadUrl(token, expandedAlbumId, legacyRawKey, file.type, file.size, 'original'),
                        requestUploadUrl(token, expandedAlbumId, legacyThumbKey, 'image/jpeg', thumbnail.size, 'thumbnail'),
                    ])

                    // 3. Upload both to S3
                    await Promise.all([
                        uploadFileToS3(rawUpload.uploadUrl, file, rawUpload.requiredHeaders),
                        uploadFileToS3(thumbUpload.uploadUrl, thumbnail, thumbUpload.requiredHeaders)
                    ])

                    const rawKey = rawUpload.key || legacyRawKey
                    const thumbKey = thumbUpload.key || legacyThumbKey

                    return {
                        rawKey,
                        thumbKey,
                        blurhash,
                        width,
                        height,
                    }
                })

            // Append to database
            await addImagesToAlbum(token, expandedAlbumId, finalItems)

            setAddingFiles([])
            setAddingVideoFiles([])
            if (addFilesRef.current) addFilesRef.current.value = ''
            setActionSuccess(`Added ${isVideo ? addingVideoFiles.length : addingFiles.length} ${isVideo ? 'video(s)' : 'image(s)'}!`)
            // Reload images
            const data = await fetchAlbum(expandedAlbumId, token)
            setAlbumImages(data.images || [])
            setTimeout(() => setActionSuccess(''), 3000)
        } catch (err) {
            setActionError(err.message)
        } finally {
            setUploadingMore(false)
        }
    }

    // Filter users by search
    const filteredUsers = useMemo(() => {
        return users.filter((u) =>
            u.email.toLowerCase().includes(userSearch.toLowerCase())
        )
    }, [users, userSearch]);

    // Derived list of existing categories for autocomplete
    const existingCategories = useMemo(() => {
        return [...new Set(albums.map(a => a.category).filter(Boolean))]
    }, [albums]);

    // Group albums by category
    const { groupedAlbums, sortedCategories } = useMemo(() => {
        const grouped = albums.reduce((acc, album) => {
            const cat = album.category || 'Uncategorized';
            if (!acc[cat]) acc[cat] = [];
            acc[cat].push(album);
            return acc;
        }, {});

        const sorted = Object.keys(grouped).sort((a, b) => {
            if (a === 'Uncategorized') return 1;
            if (b === 'Uncategorized') return -1;
            return a.localeCompare(b);
        });

        return { groupedAlbums: grouped, sortedCategories: sorted };
    }, [albums]);

    return (
        <div className="max-w-5xl mx-auto px-6 py-12 pt-[88px] md:pt-[104px]">
            <div className="animate-slide-up">
                {/* Back link */}
                <Link to="/admin" className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Dashboard
                </Link>

                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">
                        Manage {typeFilter === 'video' ? 'Video' : 'Photo'} Albums
                    </h1>
                    <p className="mt-2 text-warm-gray">Edit, add photos, remove photos, or delete albums.</p>
                </div>

                {/* Alerts */}
                {actionSuccess && (
                    <div className="mb-6 p-4 rounded-xl bg-green-50 border border-green-200 text-green-800 text-sm animate-fade-in">{actionSuccess}</div>
                )}
                {actionError && (
                    <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm animate-fade-in">{actionError}</div>
                )}

                {/* Scope selector */}
                <div className="bg-white rounded-2xl p-6 shadow-warm border border-warm-border mb-8">
                    <label className="block text-sm font-medium text-charcoal mb-3">Viewing</label>
                    <div className="flex gap-3 flex-wrap">
                        <button
                            onClick={() => setScope('public')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer ${scope === 'public'
                                ? 'bg-amber text-white'
                                : 'bg-cream text-warm-gray hover:bg-cream-dark'
                                }`}
                        >
                            Main Gallery
                        </button>
                        <button
                            onClick={() => setScope('unlisted')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer ${scope === 'unlisted'
                                ? 'bg-amber text-white'
                                : 'bg-cream text-warm-gray hover:bg-cream-dark'
                                }`}
                        >
                            Link Only
                        </button>
                        {/* User dropdown with search */}
                        <div className="flex-1 min-w-[200px]">
                            <input
                                type="text"
                                placeholder="Search users…"
                                value={userSearch}
                                onChange={(e) => setUserSearch(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-warm-border bg-cream/50 text-sm focus:outline-none focus:ring-2 focus:ring-amber/40"
                            />
                            {userSearch && (
                                <div className="mt-1 bg-white border border-warm-border rounded-lg shadow-warm max-h-40 overflow-y-auto">
                                    {filteredUsers.map((u) => (
                                        <button
                                            key={u.email}
                                            onClick={() => { setScope(u.email); setUserSearch('') }}
                                            className="w-full text-left px-3 py-2 text-sm hover:bg-cream transition-colors cursor-pointer"
                                        >
                                            {u.email}
                                        </button>
                                    ))}
                                    {filteredUsers.length === 0 && (
                                        <p className="px-3 py-2 text-sm text-warm-gray">No users found</p>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    {scope !== 'public' && scope !== 'unlisted' && (
                        <p className="mt-2 text-sm text-amber-dark font-medium">Viewing albums for: {scope}</p>
                    )}
                </div>

                {/* Albums list */}
                {loading ? (
                    <div className="flex justify-center py-20">
                        <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : albums.length === 0 ? (
                    <div className="text-center py-12 text-warm-gray">
                        <p>No albums found.</p>
                    </div>
                ) : (
                    <div className="space-y-12">
                        {sortedCategories.map((cat) => (
                            <div key={cat} className="animate-fade-in">
                                <div className="flex items-center gap-4 mb-6">
                                    <h2 className="font-serif text-2xl font-medium text-charcoal">{cat}</h2>
                                    <div className="h-px bg-warm-border flex-1"></div>
                                </div>
                                <div className="space-y-4">
                                    {groupedAlbums[cat].map((album) => (
                                        <div key={album.albumId}>
                                            {/* Album card */}
                                            <div className="bg-white rounded-2xl p-5 shadow-warm-sm border border-warm-border hover:shadow-warm transition-all">
                                                {editingAlbum === album.albumId ? (
                                                    /* Edit mode */
                                                    <div className="space-y-3">
                                                        <input
                                                            value={editTitle}
                                                            onChange={(e) => setEditTitle(e.target.value)}
                                                            className="w-full px-3 py-2 rounded-lg border border-warm-border text-sm focus:outline-none focus:ring-2 focus:ring-amber/40"
                                                        />
                                                        <textarea
                                                            value={editDesc}
                                                            onChange={(e) => setEditDesc(e.target.value)}
                                                            rows={2}
                                                            className="w-full px-3 py-2 rounded-lg border border-warm-border text-sm focus:outline-none focus:ring-2 focus:ring-amber/40 resize-none"
                                                        />
                                                        <input
                                                            type="text"
                                                            list={`categories-${album.albumId}`}
                                                            value={editCategory}
                                                            onChange={(e) => setEditCategory(e.target.value)}
                                                            placeholder="Category (e.g. Wildlife, Sports)"
                                                            className="w-full px-3 py-2 rounded-lg border border-warm-border text-sm focus:outline-none focus:ring-2 focus:ring-amber/40"
                                                        />
                                                        <datalist id={`categories-${album.albumId}`}>
                                                            {existingCategories.map(cat => (
                                                                <option key={cat} value={cat} />
                                                            ))}
                                                        </datalist>
                                                        <input
                                                            type="date"
                                                            value={editDate}
                                                            onChange={(e) => setEditDate(e.target.value)}
                                                            className="w-full px-3 py-2 rounded-lg border border-warm-border text-sm focus:outline-none focus:ring-2 focus:ring-amber/40"
                                                        />
                                                        <div className="flex gap-2">
                                                            <button onClick={() => saveEdit(album.albumId)} className="px-4 py-2 rounded-lg bg-amber text-white text-sm font-medium cursor-pointer hover:bg-amber-dark transition-colors">Save</button>
                                                            <button onClick={() => setEditingAlbum(null)} className="px-4 py-2 rounded-lg bg-cream text-warm-gray text-sm font-medium cursor-pointer hover:bg-cream-dark transition-colors">Cancel</button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    /* View mode */
                                                    <div className="flex items-start justify-between">
                                                        <div className="flex-1">
                                                            <div className="flex items-center gap-3">
                                                                <h3 className="font-serif text-lg font-semibold text-charcoal">{album.title}</h3>
                                                            </div>
                                                            {album.description && <p className="text-sm text-warm-gray mt-1">{album.description}</p>}
                                                            <p className="text-xs text-warm-gray/70 mt-1">
                                                                {new Date(album.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                                                            </p>
                                                        </div>
                                                        <div className="flex gap-2 shrink-0">
                                                            <button
                                                                onClick={() => toggleAlbumImages(album)}
                                                                className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors ${expandedAlbumId === album.albumId
                                                                    ? 'bg-amber text-white'
                                                                    : 'bg-cream text-charcoal hover:bg-cream-dark'
                                                                    }`}
                                                            >
                                                                {typeFilter === 'video' ? 'Video' : 'Photos'}
                                                            </button>
                                                            <button onClick={() => startEdit(album)} className="px-3 py-1.5 rounded-lg bg-amber/10 text-amber-dark text-xs font-medium cursor-pointer hover:bg-amber/20 transition-colors">Edit</button>
                                                            <button onClick={() => handleDelete(album.albumId)} className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium cursor-pointer hover:bg-red-100 transition-colors">Delete</button>
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Link Sharing Management Panel (Visible only for unlisted albums) */}
                                                {album.visibility === 'unlisted' && album.shareCode && (
                                                    <div className="mt-4 pt-4 border-t border-warm-border">
                                                        <div className="flex items-center justify-between gap-4">
                                                            <div>
                                                                <div className="flex items-center gap-2 mb-1">
                                                                    <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                                                                    <span className="text-sm font-medium text-charcoal">Link Sharing is Active</span>
                                                                </div>
                                                                <div className="flex items-center gap-2 mt-2">
                                                                    <code className="text-xs font-mono bg-cream-dark px-2 py-1 rounded text-charcoal border border-warm-border">
                                                                        {window.location.origin}/sharedalbum/{album.shareCode}
                                                                    </code>
                                                                    <button
                                                                        onClick={() => {
                                                                            navigator.clipboard.writeText(`${window.location.origin}/sharedalbum/${album.shareCode}`)
                                                                            setActionSuccess('Link copied to clipboard!')
                                                                            setTimeout(() => setActionSuccess(''), 3000)
                                                                        }}
                                                                        className="text-xs text-amber hover:text-amber-dark font-medium transition-colors cursor-pointer"
                                                                    >
                                                                        Copy Link
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>

                                            {/* Inline photo panel — renders directly below this album card */}
                                            {expandedAlbumId === album.albumId && (
                                                <div className="mt-2 bg-white rounded-2xl p-6 shadow-warm-lg border border-warm-border animate-slide-up">
                                                    <div className="flex justify-between items-center mb-6">
                                                        <h3 className="font-serif text-xl font-semibold text-charcoal">
                                                            {typeFilter === 'video' ? 'Video' : 'Photos'} in "{album.title}"
                                                        </h3>
                                                        <button onClick={() => { setExpandedAlbumId(null); setAlbumImages([]) }} className="text-warm-gray hover:text-charcoal cursor-pointer">
                                                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                            </svg>
                                                        </button>
                                                    </div>

                                                    {/* Add more images (only for photos) or Add more videos */}
                                                    <div className="mb-6 p-4 bg-cream/50 rounded-xl border border-warm-border">
                                                        <p className="text-sm font-medium text-charcoal mb-2">Add more {typeFilter === 'video' ? 'videos' : 'photos'}</p>
                                                        <div className="flex flex-col gap-3">
                                                            <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
                                                                <input
                                                                    ref={addFilesRef}
                                                                    type="file"
                                                                    accept={typeFilter === 'video' ? 'video/*' : 'image/*'}
                                                                    multiple
                                                                    onChange={typeFilter === 'video' ? handleVideoFileChange : (e) => setAddingFiles(Array.from(e.target.files))}
                                                                    className="flex-1 w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-amber/10 file:text-amber-dark file:font-medium file:cursor-pointer"
                                                                />
                                                                <button
                                                                    onClick={handleAddImages}
                                                                    disabled={(typeFilter === 'video' ? !addingVideoFiles.length : !addingFiles.length) || uploadingMore}
                                                                    className="w-full sm:w-auto px-4 py-2 rounded-lg bg-amber text-white text-sm font-medium cursor-pointer hover:bg-amber-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                                >
                                                                    {uploadingMore ? 'Uploading…' : 'Add'}
                                                                </button>
                                                            </div>

                                                            {typeFilter === 'video' && addingVideoFiles.length > 0 && (
                                                                <div className="mt-4 space-y-3">
                                                                    <p className="text-sm font-medium text-charcoal mb-1">Adjust Thumbnails (Optional):</p>
                                                                    {addingVideoFiles.map((vf, i) => (
                                                                        <VideoThumbnailScrubber
                                                                            key={i}
                                                                            file={vf.file}
                                                                            time={vf.time}
                                                                            onTimeChange={(val) => handleVideoTimeChange(i, val)}
                                                                        />
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* Images grid (Photos) or Video grid */}
                                                    {loadingImages ? (
                                                        <div className="flex justify-center py-10">
                                                            <div className="w-8 h-8 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                                                        </div>
                                                    ) : albumImages.length === 0 ? (
                                                        <p className="text-center py-8 text-warm-gray">No items yet.</p>
                                                    ) : (
                                                        <>
                                                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 border border-warm-border/50 p-3 rounded-xl bg-white/50">
                                                                {albumImages.map((img, idx) => {
                                                                    const thumbUrl = mediaThumbnailUrl(img)
                                                                    const imgKey = img.rawKey || img.key || img.id || `fallback-${idx}`
                                                                    const isEditingThisThumb = editingThumbKey === imgKey

                                                                    return (
                                                                        <div key={imgKey} className="group relative rounded-xl overflow-hidden aspect-square bg-cream border border-warm-border/30">
                                                                            <img
                                                                                src={thumbUrl}
                                                                                alt=""
                                                                                width={img.width}
                                                                                height={img.height}
                                                                                className="w-full h-full object-cover"
                                                                                loading="lazy"
                                                                                decoding="async"
                                                                            />
                                                                            {/* Set as cover button (top-left) */}
                                                                            <button
                                                                                onClick={() => handleSetCover(img)}
                                                                                title="Set as album cover"
                                                                                className="absolute top-2 left-2 w-7 h-7 rounded-full bg-amber/80 hover:bg-amber text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                                                            >
                                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                                                                                </svg>
                                                                            </button>
                                                                            {/* Remove button (top-right) */}
                                                                            <button
                                                                                onClick={() => handleRemoveImage(img)}
                                                                                title="Remove"
                                                                                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-red-500/80 hover:bg-red-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                                                            >
                                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                                                </svg>
                                                                            </button>

                                                                            {typeFilter === 'video' && (
                                                                                <>
                                                                                    {/* Play icon overlay */}
                                                                                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none group-hover:opacity-0 transition-opacity">
                                                                                        <div className="w-10 h-10 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center border border-white/30">
                                                                                            <svg className="w-5 h-5 text-white fill-current ml-1" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                                                                                        </div>
                                                                                    </div>
                                                                                    {/* Change thumbnail button */}
                                                                                    <button
                                                                                        onClick={() => {
                                                                                            if (isEditingThisThumb) {
                                                                                                setEditingThumbKey(null)
                                                                                            } else {
                                                                                                setEditingThumbKey(imgKey)
                                                                                                setEditingThumbTime(0)
                                                                                            }
                                                                                        }}
                                                                                        title="Change thumbnail"
                                                                                        className={`absolute bottom-2 left-1/2 -translate-x-1/2 px-2 py-1 rounded-lg text-white text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer flex items-center gap-1 ${isEditingThisThumb ? 'bg-amber' : 'bg-black/60 hover:bg-amber'}`}
                                                                                    >
                                                                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                                                                        </svg>
                                                                                        Thumbnail
                                                                                    </button>
                                                                                </>
                                                                            )}
                                                                        </div>
                                                                    )
                                                                })}
                                                            </div>

                                                            {/* Inline thumbnail editor */}
                                                            {typeFilter === 'video' && editingThumbKey && albumImages.some(i => (i.rawKey || i.key) === editingThumbKey) && (
                                                                <div className="mt-4 p-4 bg-cream/50 rounded-xl border border-warm-border animate-slide-up">
                                                                    <div className="flex items-center justify-between mb-3">
                                                                        <p className="text-sm font-medium text-charcoal">Change Thumbnail</p>
                                                                        <button onClick={() => setEditingThumbKey(null)} className="text-warm-gray hover:text-charcoal cursor-pointer">
                                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                                            </svg>
                                                                        </button>
                                                                    </div>
                                                                    <VideoThumbnailFromUrl
                                                                        videoUrl={mediaDisplayUrl(albumImages.find(i => (i.rawKey || i.key || i.id) === editingThumbKey))}
                                                                        time={editingThumbTime}
                                                                        onTimeChange={setEditingThumbTime}
                                                                        onVideoRef={(el) => { scrubberVideoRef.current = el }}
                                                                    />
                                                                    <div className="mt-3 flex gap-2">
                                                                        <button
                                                                            onClick={() => handleChangeVideoThumbnail(albumImages.find(i => (i.rawKey || i.key || i.id) === editingThumbKey))}
                                                                            disabled={updatingThumb}
                                                                            className="px-4 py-2 rounded-lg bg-amber text-white text-sm font-medium cursor-pointer hover:bg-amber-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                                        >
                                                                            {updatingThumb ? 'Saving\u2026' : 'Save Thumbnail'}
                                                                        </button>
                                                                        <button
                                                                            onClick={() => setEditingThumbKey(null)}
                                                                            className="px-4 py-2 rounded-lg bg-cream text-warm-gray text-sm font-medium cursor-pointer hover:bg-cream-dark transition-colors"
                                                                        >
                                                                            Cancel
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export default ManageAlbums
