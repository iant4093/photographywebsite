import { useState, useRef, useEffect } from 'react'
import { encode } from 'blurhash'
import { v4 as uuidv4 } from 'uuid'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/authContext'
import { requestUploadUrl, uploadFileToS3, createAlbum, listUsers, fetchAlbums } from '../utils/api'

// Helper component for picking a thumbnail time for a video
function VideoThumbnailScrubber({ file, time, onTimeChange }) {
    const videoRef = useRef(null)
    const [duration, setDuration] = useState(0)
    const [url, setUrl] = useState('')

    useEffect(() => {
        const objectUrl = URL.createObjectURL(file)
        setUrl(objectUrl)
        return () => URL.revokeObjectURL(objectUrl)
    }, [file])

    const handleLoadedMetadata = () => {
        if (videoRef.current) {
            setDuration(videoRef.current.duration)
            videoRef.current.currentTime = time
        }
    }

    const handleChange = (e) => {
        const newTime = parseFloat(e.target.value)
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
                    <span className="text-xs text-warm-gray">{time.toFixed(1)}s</span>
                    <input
                        type="range"
                        min="0"
                        max={duration || 100}
                        step="0.1"
                        value={time}
                        onChange={handleChange}
                        className="flex-1 text-amber accent-amber"
                    />
                    <span className="text-xs text-warm-gray">{duration.toFixed(1)}s</span>
                </div>
            </div>
        </div>
    )
}

export default function UploadVideo() {
    const { getIdToken } = useAuth()

    const [title, setTitle] = useState('')
    const [description, setDescription] = useState('')
    const [videoFiles, setVideoFiles] = useState([]) // [{ file, time }]
    const [visibility, setVisibility] = useState('public')
    const [ownerEmail, setOwnerEmail] = useState('')
    const [albumDate, setAlbumDate] = useState(() => new Date().toISOString().split('T')[0])
    const [category, setCategory] = useState('')
    const [users, setUsers] = useState([])
    const [usersLoaded, setUsersLoaded] = useState(false)
    const [existingCategories, setExistingCategories] = useState([])

    const fileInputRef = useRef(null)

    const [uploading, setUploading] = useState(false)
    const [progress, setProgress] = useState({ current: 0, total: 0, status: '' })
    const [success, setSuccess] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
        loadInitialData()
    }, [visibility])

    async function loadInitialData() {
        if (!usersLoaded && visibility === 'private') {
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
            const albums = await fetchAlbums()
            const uniqueCategories = [...new Set(albums.map(a => a.category).filter(Boolean))]
            setExistingCategories(uniqueCategories)
        } catch (err) { }
    }

    const handleFileChange = (e) => {
        const files = Array.from(e.target.files)
        setVideoFiles(files.map(file => ({ file, time: 0.0 })))
    }

    const handleTimeChange = (index, newTime) => {
        setVideoFiles(prev => {
            const copy = [...prev]
            copy[index].time = newTime
            return copy
        })
    }

    // Process video: extracts thumbnail frame to blob and calculates blurhash
    async function processVideo(file, time) {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video')
            video.muted = true
            video.playsInline = true
            video.crossOrigin = "anonymous"
            const url = URL.createObjectURL(file)

            video.onloadedmetadata = () => {
                video.currentTime = time
            }

            video.onseeked = () => {
                const canvas = document.createElement('canvas')
                const MAX_SIZE = 800
                let width = video.videoWidth
                let height = video.videoHeight

                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width
                    width = MAX_SIZE
                } else if (height > width && height > MAX_SIZE) {
                    width *= MAX_SIZE / height
                    height = MAX_SIZE
                }

                width = Math.round(width)
                height = Math.round(height)

                canvas.width = width
                canvas.height = height
                const ctx = canvas.getContext('2d')
                ctx.drawImage(video, 0, 0, width, height)

                // Blurhash computation
                const hashCanvas = document.createElement('canvas')
                const hashSize = 32
                hashCanvas.width = hashSize
                hashCanvas.height = Math.round(hashSize * (height / width))
                const hashCtx = hashCanvas.getContext('2d')
                hashCtx.drawImage(canvas, 0, 0, hashCanvas.width, hashCanvas.height)
                const imageData = hashCtx.getImageData(0, 0, hashCanvas.width, hashCanvas.height)

                const componentX = 4
                const componentY = Math.max(1, Math.min(4, Math.round(componentX * (height / width))))
                const blurhash = encode(imageData.data, imageData.width, imageData.height, componentX, componentY)

                canvas.toBlob((blob) => {
                    URL.revokeObjectURL(url)
                    resolve({ thumbnail: blob, blurhash, width: video.videoWidth, height: video.videoHeight })
                }, 'image/jpeg', 0.85)
            }

            video.onerror = (e) => reject(e)
            video.src = url
        })
    }

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

            setProgress({ current: 0, total: videoFiles.length, status: 'Processing thumbnails...' })

            const finalImages = []
            let coverThumbUrlPublic = ''
            let coverBlurhash = ''

            for (let i = 0; i < videoFiles.length; i++) {
                const { file, time } = videoFiles[i]

                // 1. Extract thumbnail
                setProgress({ current: i, total: videoFiles.length, status: `Processing ${file.name}...` })
                const { thumbnail, blurhash, width, height } = await processVideo(file, time)

                // 2. Request urls
                setProgress({ current: i, total: videoFiles.length, status: `Uploading ${file.name}...` })
                const rawKey = `${s3Prefix}${file.name}`
                const thumbKey = `${s3Prefix}thumb_${file.name}.jpg`

                const { uploadUrl: rawUploadUrl } = await requestUploadUrl(token, rawKey, file.type)
                const { uploadUrl: thumbUploadUrl } = await requestUploadUrl(token, thumbKey, 'image/jpeg')

                // 3. Upload raw video & thumbnail
                await Promise.all([
                    uploadFileToS3(rawUploadUrl, file),
                    uploadFileToS3(thumbUploadUrl, thumbnail)
                ])

                finalImages.push({
                    rawKey,
                    thumbKey,
                    blurhash,
                    width,
                    height,
                    thumbnailTime: time
                })

                if (i === 0) {
                    coverThumbUrlPublic = thumbKey
                    coverBlurhash = blurhash
                }

                setProgress({ current: i + 1, total: videoFiles.length, status: 'Uploaded' })
            }

            setProgress({ current: videoFiles.length, total: videoFiles.length, status: 'Creating Album Record & Kicking off Transcoding...' })

            const createdAlbum = await createAlbum(token, {
                albumId,
                type: 'video', // Indicates backend should kick off MediaConvert
                title,
                description,
                category: category || 'Uncategorized',
                coverImageUrl: coverThumbUrlPublic, // The poster image basically
                coverThumbKey: coverThumbUrlPublic,
                coverBlurhash: coverBlurhash,
                images: finalImages,
                s3Prefix,
                createdAt: new Date(albumDate + 'T12:00:00').toISOString(),
                visibility,
                ownerEmail: visibility === 'private' ? ownerEmail : '',
                isShared: visibility === 'unlisted',
            })

            if (visibility === 'unlisted' && createdAlbum && createdAlbum.shareCode) {
                setSuccess(`${window.location.origin}/sharedalbum/${createdAlbum.shareCode}`)
            } else {
                setSuccess(true)
            }

            setTitle('')
            setCategory('')
            setDescription('')
            setVideoFiles([])
            setOwnerEmail('')
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
                <Link to="/admin" className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Dashboard
                </Link>

                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal flex items-center gap-3">
                        <svg className="w-8 h-8 text-amber" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        Upload Video
                    </h1>
                    <p className="mt-2 text-warm-gray">Upload one or multiple videos. A 4K/1080p transcoded version will be automatically generated.</p>
                </div>

                {success && (
                    <div className="mb-8 p-5 rounded-2xl bg-green-50 border border-green-200 text-green-800">
                        {typeof success === 'string' ? (
                            <div>
                                <p className="font-medium mb-1">Link Only video album created successfully!</p>
                                <p className="text-sm">Link: <code className="font-mono bg-green-100/50 px-2 py-0.5 rounded select-all">{success}</code></p>
                            </div>
                        ) : (
                            <p className="font-medium">Video album created successfully! Transcoding may take a few minutes before the video is fully playable.</p>
                        )}
                    </div>
                )}
                {error && (
                    <div className="mb-8 p-5 rounded-2xl bg-red-50 border border-red-200 text-red-700">
                        <p>{error}</p>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="bg-white rounded-2xl p-8 shadow-warm-lg border border-warm-border">
                    <div className="mb-6">
                        <label className="block text-sm font-medium text-charcoal mb-3">Visibility</label>
                        <div className="flex flex-col sm:flex-row rounded-xl overflow-hidden border border-warm-border">
                            {['public', 'private', 'unlisted'].map(v => (
                                <button
                                    key={v}
                                    type="button"
                                    onClick={() => setVisibility(v)}
                                    className={`flex-1 py-3 px-2 text-sm font-medium capitalize transition-all duration-200 cursor-pointer ${visibility === v ? 'bg-amber text-white' : 'bg-cream text-warm-gray hover:bg-cream-dark'}`}
                                >
                                    {v === 'unlisted' ? 'Link Only' : v === 'public' ? 'Main Gallery' : 'Specific User'}
                                </button>
                            ))}
                        </div>
                    </div>

                    {visibility === 'private' && (
                        <div className="mb-6">
                            <label className="block text-sm font-medium text-charcoal mb-2">User Email *</label>
                            <select
                                value={ownerEmail}
                                onChange={(e) => setOwnerEmail(e.target.value)}
                                required
                                className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all"
                            >
                                <option value="">Select a user...</option>
                                {users.map((u) => <option key={u.email} value={u.email}>{u.email}</option>)}
                            </select>
                        </div>
                    )}

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-charcoal mb-2">Video Title *</label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            required
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all"
                            placeholder="e.g. Cinematic Wedding Highlight"
                        />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div>
                            <label className="block text-sm font-medium text-charcoal mb-2">Category</label>
                            <input
                                type="text"
                                list="categoriesList"
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                                className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all"
                                placeholder="e.g. Weddings, Commercial..."
                            />
                            <datalist id="categoriesList">
                                {existingCategories.map(cat => <option key={cat} value={cat} />)}
                            </datalist>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-charcoal mb-2">Date</label>
                            <input
                                type="date"
                                value={albumDate}
                                onChange={(e) => setAlbumDate(e.target.value)}
                                className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all"
                            />
                        </div>
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-charcoal mb-2">Description</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={2}
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all resize-none"
                            placeholder="Optional metadata or context..."
                        />
                    </div>

                    <div className="mb-8">
                        <label className="block text-sm font-medium text-charcoal mb-2">Raw Video Files *</label>
                        <div className="border-2 border-dashed border-warm-border rounded-2xl p-6 text-center hover:border-amber/40 transition-colors">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="video/*"
                                multiple
                                onChange={handleFileChange}
                                required
                                className="w-full file:mr-4 file:py-2 file:px-4 file:rounded-lg file:bg-amber/10 file:text-amber-dark file:border-0 hover:file:bg-amber/20 text-sm cursor-pointer"
                            />
                        </div>

                        {videoFiles.length > 0 && (
                            <div className="mt-4 space-y-3">
                                <p className="text-sm font-medium text-charcoal mb-2">Adjust Thumbnails (Optional):</p>
                                {videoFiles.map((vf, i) => (
                                    <VideoThumbnailScrubber
                                        key={i}
                                        file={vf.file}
                                        time={vf.time}
                                        onTimeChange={(val) => handleTimeChange(i, val)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    {uploading && (
                        <div className="mb-6">
                            <div className="flex justify-between text-sm text-warm-gray mb-2">
                                <span>{progress.status}</span>
                                <span>{progress.current} / {progress.total} Videos</span>
                            </div>
                            <div className="w-full h-2 bg-cream-dark rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-amber to-amber-dark rounded-full transition-all duration-500"
                                    style={{ width: `${Math.max(5, (progress.current / progress.total) * 100)}%` }}
                                />
                            </div>
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={uploading}
                        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-amber to-amber-dark text-white font-semibold hover:from-amber-dark transition-all disabled:opacity-60 cursor-pointer"
                    >
                        {uploading ? 'Processing & Uploading…' : 'Upload Video(s)'}
                    </button>
                </form>
            </div>
        </div>
    )
}
