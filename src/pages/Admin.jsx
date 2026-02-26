import { useState, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/authContext'
import { requestUploadUrl, uploadFileToS3, createAlbum, listUsers } from '../utils/api'

// Upload page — create album for main gallery or specific user
function Upload() {
    const { getIdToken } = useAuth()

    // Form state
    const [title, setTitle] = useState('')
    const [description, setDescription] = useState('')
    const [photoFiles, setPhotoFiles] = useState([])
    const [visibility, setVisibility] = useState('public')
    const [ownerEmail, setOwnerEmail] = useState('')
    const [albumDate, setAlbumDate] = useState(() => new Date().toISOString().split('T')[0])
    const [users, setUsers] = useState([])
    const [usersLoaded, setUsersLoaded] = useState(false)

    // File input ref to clear after upload
    const fileInputRef = useRef(null)

    // Upload progress
    const [uploading, setUploading] = useState(false)
    const [progress, setProgress] = useState({ current: 0, total: 0 })
    const [success, setSuccess] = useState(false)
    const [error, setError] = useState('')

    // Load users when switching to private mode
    async function loadUsers() {
        if (usersLoaded) return
        try {
            const token = await getIdToken()
            const data = await listUsers(token)
            setUsers(data.filter((u) => u.email !== 'iant4093@gmail.com'))
            setUsersLoaded(true)
        } catch (err) {
            console.error('Failed to load users:', err)
        }
    }

    // Toggle handler
    function handleVisibilityChange(newVisibility) {
        setVisibility(newVisibility)
        if (newVisibility === 'private') loadUsers()
        if (newVisibility === 'public') setOwnerEmail('')
    }

    // Upload handler
    async function handleSubmit(e) {
        e.preventDefault()
        setError('')
        setSuccess(false)
        setUploading(true)

        try {
            const token = await getIdToken()
            const albumId = uuidv4()
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
            const s3Prefix = `albums/${slug}-${albumId.slice(0, 8)}/`

            setProgress({ current: 0, total: photoFiles.length })

            // Upload each file
            for (let i = 0; i < photoFiles.length; i++) {
                const file = photoFiles[i]
                const { uploadUrl } = await requestUploadUrl(
                    token,
                    `${s3Prefix}${file.name}`,
                    file.type
                )
                await uploadFileToS3(uploadUrl, file)
                setProgress({ current: i + 1, total: photoFiles.length })
            }

            // Create album — cover is auto-set to first image by backend
            await createAlbum(token, {
                albumId,
                title,
                description,
                coverImageUrl: `${s3Prefix}${photoFiles[0]?.name || ''}`,
                s3Prefix,
                createdAt: new Date(albumDate + 'T12:00:00').toISOString(),
                visibility,
                ownerEmail: visibility === 'private' ? ownerEmail : '',
            })

            setSuccess(true)
            setTitle('')
            setDescription('')
            setPhotoFiles([])
            setOwnerEmail('')
            setAlbumDate(new Date().toISOString().split('T')[0])
            // Reset file input so browser clears the selection display
            if (fileInputRef.current) fileInputRef.current.value = ''
        } catch (err) {
            setError(err.message || 'Upload failed.')
        } finally {
            setUploading(false)
        }
    }

    return (
        <div className="max-w-3xl mx-auto px-6 py-12">
            <div className="animate-slide-up">
                {/* Back link */}
                <Link to="/admin" className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Dashboard
                </Link>

                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Upload Photos</h1>
                    <p className="mt-2 text-warm-gray">Create a new album and upload photos.</p>
                </div>

                {/* Success */}
                {success && (
                    <div className="mb-8 p-5 rounded-2xl bg-green-50 border border-green-200 text-green-800 animate-scale-in">
                        <p className="font-medium">Album created successfully!</p>
                    </div>
                )}

                {/* Error */}
                {error && (
                    <div className="mb-8 p-5 rounded-2xl bg-red-50 border border-red-200 text-red-700 animate-scale-in">
                        <p>{error}</p>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="bg-white rounded-2xl p-8 shadow-warm-lg border border-warm-border">
                    {/* Visibility toggle */}
                    <div className="mb-6">
                        <label className="block text-sm font-medium text-charcoal mb-3">Upload To</label>
                        <div className="flex rounded-xl overflow-hidden border border-warm-border">
                            <button
                                type="button"
                                onClick={() => handleVisibilityChange('public')}
                                className={`flex-1 py-3 text-sm font-medium transition-all duration-200 cursor-pointer ${visibility === 'public'
                                    ? 'bg-amber text-white'
                                    : 'bg-cream text-warm-gray hover:bg-cream-dark'
                                    }`}
                            >
                                Main Gallery
                            </button>
                            <button
                                type="button"
                                onClick={() => handleVisibilityChange('private')}
                                className={`flex-1 py-3 text-sm font-medium transition-all duration-200 cursor-pointer ${visibility === 'private'
                                    ? 'bg-amber text-white'
                                    : 'bg-cream text-warm-gray hover:bg-cream-dark'
                                    }`}
                            >
                                Specific User
                            </button>
                        </div>
                    </div>

                    {/* User email (shown only for private) */}
                    {visibility === 'private' && (
                        <div className="mb-6 animate-fade-in">
                            <label htmlFor="ownerEmail" className="block text-sm font-medium text-charcoal mb-2">
                                User Email *
                            </label>
                            <select
                                id="ownerEmail"
                                value={ownerEmail}
                                onChange={(e) => setOwnerEmail(e.target.value)}
                                required
                                className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                            >
                                <option value="">Select a user...</option>
                                {users.map((u) => (
                                    <option key={u.email} value={u.email}>{u.email}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {/* Album title */}
                    <div className="mb-6">
                        <label htmlFor="title" className="block text-sm font-medium text-charcoal mb-2">Album Title *</label>
                        <input
                            id="title"
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            required
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal placeholder-warm-gray/50 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                            placeholder="e.g. Summer Solstice 2026"
                        />
                    </div>

                    {/* Album date */}
                    <div className="mb-6">
                        <label htmlFor="albumDate" className="block text-sm font-medium text-charcoal mb-2">Album Date</label>
                        <input
                            id="albumDate"
                            type="date"
                            value={albumDate}
                            onChange={(e) => setAlbumDate(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                        />
                    </div>

                    {/* Description */}
                    <div className="mb-6">
                        <label htmlFor="description" className="block text-sm font-medium text-charcoal mb-2">Description</label>
                        <textarea
                            id="description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal placeholder-warm-gray/50 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200 resize-none"
                            placeholder="A brief description of this album…"
                        />
                    </div>

                    {/* Photos */}
                    <div className="mb-8">
                        <label className="block text-sm font-medium text-charcoal mb-2">Photos *</label>
                        <div className="border-2 border-dashed border-warm-border rounded-2xl p-8 text-center hover:border-amber/40 transition-colors duration-300">
                            <svg className="w-10 h-10 mx-auto text-warm-gray/50 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                multiple
                                onChange={(e) => setPhotoFiles(Array.from(e.target.files))}
                                required
                                className="w-full file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-amber/10 file:text-amber-dark file:font-medium file:cursor-pointer hover:file:bg-amber/20 text-sm text-warm-gray cursor-pointer"
                            />
                            {photoFiles.length > 0 && (
                                <p className="mt-3 text-sm text-warm-gray">
                                    {photoFiles.length} photo{photoFiles.length !== 1 ? 's' : ''} selected
                                    — first photo will be the cover
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Progress */}
                    {uploading && (
                        <div className="mb-6 animate-fade-in">
                            <div className="flex justify-between text-sm text-warm-gray mb-2">
                                <span>Uploading…</span>
                                <span>{progress.current} / {progress.total}</span>
                            </div>
                            <div className="w-full h-2 bg-cream-dark rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-amber to-amber-dark rounded-full transition-all duration-500"
                                    style={{ width: `${(progress.current / progress.total) * 100}%` }}
                                />
                            </div>
                        </div>
                    )}

                    {/* Submit */}
                    <button
                        type="submit"
                        disabled={uploading}
                        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-amber to-amber-dark text-white font-semibold hover:from-amber-dark hover:to-amber-dark transition-all duration-300 shadow-warm hover:shadow-warm-lg disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                    >
                        {uploading ? (
                            <span className="flex items-center justify-center gap-2">
                                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                Uploading…
                            </span>
                        ) : (
                            'Create Album'
                        )}
                    </button>
                </form>
            </div>
        </div>
    )
}

export default Upload
