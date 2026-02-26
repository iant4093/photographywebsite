import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/authContext'
import {
    fetchAlbumsFiltered,
    listUsers,
    updateAlbum,
    deleteAlbum,
    deleteImages,
    requestUploadUrl,
    uploadFileToS3,
    fetchAlbum,
} from '../utils/api'

// Manage albums page — full CRUD for main gallery and per-user albums
function ManageAlbums() {
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
    const [uploadingMore, setUploadingMore] = useState(false)
    const addFilesRef = useRef(null)

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
    }, [])

    // Load albums when scope changes
    useEffect(() => {
        loadAlbums()
    }, [scope])

    // Fetch albums for the current scope
    async function loadAlbums() {
        setLoading(true)
        setExpandedAlbumId(null)
        setAlbumImages([])
        try {
            const params = scope === 'public'
                ? { visibility: 'public' }
                : { visibility: 'private', ownerEmail: scope }
            const data = await fetchAlbumsFiltered(params)
            setAlbums(data)
        } catch (err) {
            console.error('Failed to load albums:', err)
            setAlbums([])
        } finally {
            setLoading(false)
        }
    }

    // Toggle album detail to manage images — shows inline under the album card
    async function toggleAlbumImages(album) {
        if (expandedAlbumId === album.albumId) {
            // Collapse
            setExpandedAlbumId(null)
            setAlbumImages([])
            return
        }
        setLoadingImages(true)
        setExpandedAlbumId(album.albumId)
        setAddingFiles([])
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
    async function handleRemoveImage(key) {
        if (!confirm('Remove this image?')) return
        try {
            const token = await getIdToken()
            await deleteImages(token, expandedAlbumId, [key])
            setAlbumImages((prev) => prev.filter((img) => img.key !== key))
            setActionSuccess('Image removed!')
            setTimeout(() => setActionSuccess(''), 3000)
        } catch (err) {
            setActionError(err.message)
        }
    }

    // Set an image as the album cover
    async function handleSetCover(img) {
        try {
            const token = await getIdToken()
            const imgKey = img.rawKey || img.key;
            const updates = { coverImageUrl: imgKey };
            if (img.thumbKey) updates.coverThumbKey = img.thumbKey;
            if (img.blurhash) updates.coverBlurhash = img.blurhash;

            await updateAlbum(token, expandedAlbumId, updates)
            setActionSuccess('Cover image updated!')
            loadAlbums()
            setTimeout(() => setActionSuccess(''), 3000)
        } catch (err) {
            setActionError(err.message)
        }
    }

    // Add more images to an existing album
    async function handleAddImages() {
        if (!addingFiles.length || !expandedAlbumId) return
        setUploadingMore(true)
        setActionError('')
        const expandedAlbum = albums.find((a) => a.albumId === expandedAlbumId)
        try {
            const token = await getIdToken()
            const s3Prefix = expandedAlbum?.s3Prefix || `albums/${expandedAlbumId}/`

            for (const file of addingFiles) {
                const { uploadUrl } = await requestUploadUrl(token, `${s3Prefix}${file.name}`, file.type)
                await uploadFileToS3(uploadUrl, file)
            }

            setAddingFiles([])
            if (addFilesRef.current) addFilesRef.current.value = ''
            setActionSuccess(`Added ${addingFiles.length} image(s)!`)
            // Reload images
            const data = await fetchAlbum(expandedAlbumId)
            setAlbumImages(data.images || [])
            setTimeout(() => setActionSuccess(''), 3000)
        } catch (err) {
            setActionError(err.message)
        } finally {
            setUploadingMore(false)
        }
    }

    // Filter users by search
    const filteredUsers = users.filter((u) =>
        u.email.toLowerCase().includes(userSearch.toLowerCase())
    )

    // Derived list of existing categories for autocomplete
    const existingCategories = [...new Set(albums.map(a => a.category).filter(Boolean))]

    return (
        <div className="max-w-5xl mx-auto px-6 py-12">
            <div className="animate-slide-up">
                {/* Back link */}
                <Link to="/admin" className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Dashboard
                </Link>

                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Manage Albums</h1>
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
                    {scope !== 'public' && (
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
                    <div className="space-y-4">
                        {albums.map((album) => (
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
                                                    {album.category && (
                                                        <span className="px-2.5 py-0.5 rounded-full bg-cream-dark text-xs font-medium text-warm-gray">
                                                            {album.category}
                                                        </span>
                                                    )}
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
                                                    Photos
                                                </button>
                                                <button onClick={() => startEdit(album)} className="px-3 py-1.5 rounded-lg bg-amber/10 text-amber-dark text-xs font-medium cursor-pointer hover:bg-amber/20 transition-colors">Edit</button>
                                                <button onClick={() => handleDelete(album.albumId)} className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium cursor-pointer hover:bg-red-100 transition-colors">Delete</button>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Inline photo panel — renders directly below this album card */}
                                {expandedAlbumId === album.albumId && (
                                    <div className="mt-2 bg-white rounded-2xl p-6 shadow-warm-lg border border-warm-border animate-slide-up">
                                        <div className="flex justify-between items-center mb-6">
                                            <h3 className="font-serif text-xl font-semibold text-charcoal">
                                                Photos in "{album.title}"
                                            </h3>
                                            <button onClick={() => { setExpandedAlbumId(null); setAlbumImages([]) }} className="text-warm-gray hover:text-charcoal cursor-pointer">
                                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                </svg>
                                            </button>
                                        </div>

                                        {/* Add more images */}
                                        <div className="mb-6 p-4 bg-cream/50 rounded-xl border border-warm-border">
                                            <p className="text-sm font-medium text-charcoal mb-2">Add more photos</p>
                                            <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
                                                <input
                                                    ref={addFilesRef}
                                                    type="file"
                                                    accept="image/*"
                                                    multiple
                                                    onChange={(e) => setAddingFiles(Array.from(e.target.files))}
                                                    className="flex-1 w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-amber/10 file:text-amber-dark file:font-medium file:cursor-pointer"
                                                />
                                                <button
                                                    onClick={handleAddImages}
                                                    disabled={!addingFiles.length || uploadingMore}
                                                    className="w-full sm:w-auto px-4 py-2 rounded-lg bg-amber text-white text-sm font-medium cursor-pointer hover:bg-amber-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                >
                                                    {uploadingMore ? 'Uploading…' : 'Add'}
                                                </button>
                                            </div>
                                        </div>

                                        {/* Images grid */}
                                        {loadingImages ? (
                                            <div className="flex justify-center py-10">
                                                <div className="w-8 h-8 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                                            </div>
                                        ) : albumImages.length === 0 ? (
                                            <p className="text-center py-8 text-warm-gray">No photos yet.</p>
                                        ) : (
                                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 border border-warm-border/50 p-3 rounded-xl bg-white/50">
                                                {albumImages.map((img, idx) => {
                                                    const isLegacy = !img.thumbKey
                                                    const thumbUrl = isLegacy ? img.url : `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${img.thumbKey}`
                                                    const imgKey = img.rawKey || img.key || `fallback-${idx}`

                                                    return (
                                                        <div key={imgKey} className="group relative rounded-xl overflow-hidden aspect-square bg-cream border border-warm-border/30">
                                                            <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                                                            {/* Set as cover button (top-left) */}
                                                            <button
                                                                onClick={() => handleSetCover(img)}
                                                                title="Set as cover image"
                                                                className="absolute top-2 left-2 w-7 h-7 rounded-full bg-amber/80 hover:bg-amber text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                                                                </svg>
                                                            </button>
                                                            {/* Remove button (top-right) */}
                                                            <button
                                                                onClick={() => handleRemoveImage(imgKey)}
                                                                title="Remove image"
                                                                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-red-500/80 hover:bg-red-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                                </svg>
                                                            </button>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export default ManageAlbums
