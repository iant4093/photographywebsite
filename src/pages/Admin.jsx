import { useState, useRef } from 'react'
import { motion } from 'framer-motion'
import { v4 as uuidv4 } from 'uuid'
import { Link } from 'react-router'
import { useAuth } from '../context/auth'
import { requestUploadUrl, uploadFileToS3, createAlbum, listUsers, fetchAlbums } from '../utils/api'
import { mapWithConcurrency } from '../utils/concurrency'
import { processImage } from '../utils/mediaUtils'
import { currentLocalDateInputValue } from '../utils/date'

// Upload page — create album for main gallery or specific user
function Upload() {
    const { getIdToken } = useAuth()

    // Form state
    const [title, setTitle] = useState('')
    const [description, setDescription] = useState('')
    const [backupToGoogleDrive, setBackupToGoogleDrive] = useState(false)
    const [photoFiles, setPhotoFiles] = useState([])
    const [visibility, setVisibility] = useState('public')
    const [ownerEmail, setOwnerEmail] = useState('')
    const [albumDate, setAlbumDate] = useState(currentLocalDateInputValue)
    const [category, setCategory] = useState('')
    const [users, setUsers] = useState([])
    const [usersLoaded, setUsersLoaded] = useState(false)
    const [existingCategories, setExistingCategories] = useState([])

    // File input ref to clear after upload
    const fileInputRef = useRef(null)

    // Upload progress
    const [uploading, setUploading] = useState(false)
    const [progress, setProgress] = useState({ current: 0, total: 0 })
    const [success, setSuccess] = useState(false)
    const [error, setError] = useState('')

    // Load users and existing albums
    async function loadInitialData() {
        if (!usersLoaded) {
            try {
                const token = await getIdToken()
                const data = await listUsers(token)
                setUsers(data.filter((u) => u.email !== 'iant4093@gmail.com'))
                setUsersLoaded(true)
            } catch (err) {
                console.error('Failed to load users:', err)
            }
        }

        try {
            // Also fetch public albums to extract categories for the datalist
            const albums = await fetchAlbums()
            const uniqueCategories = [...new Set(albums.map(a => a.category).filter(Boolean))]
            setExistingCategories(uniqueCategories)
        } catch (err) {
            console.error('Failed to load categories', err)
        }
    }

    // Toggle handler
    function handleVisibilityChange(newVisibility) {
        setVisibility(newVisibility)
        if (newVisibility === 'private') loadInitialData()
        if (newVisibility === 'public' || newVisibility === 'unlisted') {
            setOwnerEmail('')
            loadInitialData() // Make sure categories load even if public/unlisted
        }
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

            let coverImageUrlPublic = ''
            let coverThumbUrlPublic = ''
            let coverBlurhash = ''

            let completedUploads = 0
            const finalImages = await mapWithConcurrency(photoFiles, 2, async (file, i) => {

                // 1. Process local thumbnail/hash
                const { thumbnail, blurhash, width, height } = await processImage(file)
                const isCover = i === 0

                // 2. Request both Pre-signed URLs
                const legacyRawKey = `${s3Prefix}${file.name}`
                const legacyThumbKey = `${s3Prefix}thumb_${file.name}`

                const [rawUpload, thumbUpload] = await Promise.all([
                    requestUploadUrl(token, albumId, legacyRawKey, file.type, file.size, 'original'),
                    requestUploadUrl(token, albumId, legacyThumbKey, 'image/jpeg', thumbnail.size, 'thumbnail'),
                ])

                // 3. Upload both to S3
                await Promise.all([
                    uploadFileToS3(rawUpload.uploadUrl, file, rawUpload.requiredHeaders),
                    uploadFileToS3(thumbUpload.uploadUrl, thumbnail, thumbUpload.requiredHeaders)
                ])

                const rawKey = rawUpload.key || legacyRawKey
                const thumbKey = thumbUpload.key || legacyThumbKey

                if (isCover) {
                    coverImageUrlPublic = rawKey
                    coverThumbUrlPublic = thumbKey
                    coverBlurhash = blurhash
                }

                completedUploads += 1
                setProgress({ current: completedUploads, total: photoFiles.length })
                return { rawKey, thumbKey, blurhash, width, height }
            })

            // Create album — cover is auto-set to first image by backend
            const createdAlbum = await createAlbum(token, {
                albumId,
                title,
                description,
                category: category || 'Uncategorized',
                coverImageUrl: coverImageUrlPublic,
                coverThumbKey: coverThumbUrlPublic,
                coverBlurhash: coverBlurhash,
                images: finalImages, // Persist specific processed manifest
                s3Prefix,
                createdAt: new Date(albumDate + 'T12:00:00').toISOString(),
                visibility,
                ownerEmail: visibility === 'private' ? ownerEmail : '',
                isShared: visibility === 'unlisted',
                backupToGoogleDrive,
            })

            if (visibility === 'unlisted' && createdAlbum && createdAlbum.shareCode) {
                setSuccess(`${window.location.origin}/sharedalbum/${createdAlbum.shareCode}`)
            } else {
                setSuccess(true)
            }
            setTitle('')
            setCategory('')
            setDescription('')
            setPhotoFiles([])
            setOwnerEmail('')
            setAlbumDate(currentLocalDateInputValue())
            // Reset file input so browser clears the selection display
            if (fileInputRef.current) fileInputRef.current.value = ''
        } catch (err) {
            setError(err.message || 'Upload failed.')
        } finally {
            setUploading(false)
        }
    }

    // Page transition animation variants
    const pageVariants = {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0.4, ease: "easeOut" } },
        exit: { opacity: 0, transition: { duration: 0.3, ease: "easeIn" } }
    }

    return (
        <motion.div
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="max-w-3xl mx-auto px-6 py-12 pt-[88px] md:pt-[104px]"
        >
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
                        {typeof success === 'string' ? (
                            <div>
                                <p className="font-medium mb-1">Link Only album created successfully!</p>
                                <p className="text-sm">Link: <code className="font-mono bg-green-100/50 px-2 py-0.5 rounded border border-green-200 select-all">{success}</code></p>
                            </div>
                        ) : (
                            <p className="font-medium">Album created successfully!</p>
                        )}
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
                        <div className="flex flex-col sm:flex-row rounded-xl overflow-hidden border border-warm-border">
                            <button
                                type="button"
                                onClick={() => handleVisibilityChange('public')}
                                className={`admin-upload-choice flex-1 py-3 px-2 text-sm font-medium transition-all duration-200 cursor-pointer ${visibility === 'public'
                                    ? 'bg-amber text-white'
                                    : 'bg-cream text-warm-gray hover:bg-cream-dark'
                                    }`}
                            >
                                Main Gallery
                            </button>
                            <button
                                type="button"
                                onClick={() => handleVisibilityChange('private')}
                                className={`admin-upload-choice flex-1 py-3 px-2 text-sm border-t sm:border-t-0 sm:border-l border-warm-border font-medium transition-all duration-200 cursor-pointer ${visibility === 'private'
                                    ? 'bg-amber text-white'
                                    : 'bg-cream text-warm-gray hover:bg-cream-dark'
                                    }`}
                            >
                                Specific User
                            </button>
                            <button
                                type="button"
                                onClick={() => handleVisibilityChange('unlisted')}
                                className={`admin-upload-choice flex-1 py-3 px-2 text-sm border-t sm:border-t-0 sm:border-l border-warm-border font-medium transition-all duration-200 cursor-pointer ${visibility === 'unlisted'
                                    ? 'bg-amber text-white'
                                    : 'bg-cream text-warm-gray hover:bg-cream-dark'
                                    }`}
                            >
                                Link Only
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

                    {/* Category input */}
                    <div className="mb-6">
                        <label htmlFor="category" className="block text-sm font-medium text-charcoal mb-2">Category</label>
                        <input
                            id="category"
                            type="text"
                            list="categoriesList"
                            value={category}
                            onChange={(e) => setCategory(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal placeholder-warm-gray/50 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                            placeholder="e.g. Wildlife, Sports, or type a new one..."
                        />
                        <datalist id="categoriesList">
                            {existingCategories.map(cat => (
                                <option key={cat} value={cat} />
                            ))}
                        </datalist>
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

                    {/* Google Drive Backup Checkbox */}
                    <div className="mb-8 flex items-center gap-3">
                        <input
                            id="driveBackup"
                            type="checkbox"
                            checked={backupToGoogleDrive}
                            onChange={(e) => setBackupToGoogleDrive(e.target.checked)}
                            className="w-5 h-5 text-amber border-warm-border rounded focus:ring-amber/40 cursor-pointer"
                        />
                        <label htmlFor="driveBackup" className="text-sm font-medium text-charcoal cursor-pointer">
                            Backup original files to Google Drive
                        </label>
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
                        className="admin-upload-submit w-full py-3.5 rounded-xl bg-gradient-to-r from-amber to-amber-dark text-white font-semibold hover:from-amber-dark hover:to-amber-dark transition-all duration-300 shadow-warm hover:shadow-warm-lg disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
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
        </motion.div>
    )
}

export default Upload
