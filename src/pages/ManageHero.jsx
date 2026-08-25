import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../context/auth'
import { completeHeroUpload, requestHeroUploadUrl, uploadFileToS3 } from '../utils/api'
import { cdnUrl, heroCoverUrl } from '../utils/mediaUrls'
import { completeVideoHeroUpload, requestVideoHeroUploadUrl } from '../utils/videoHeroApi'

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
const MAX_BYTES = 50 * 1024 * 1024
const MIN_BYTES = 1024
const HERO_TABS = [
    { id: 'photo', label: 'Photo Gallery', description: 'photography homepage', fallback: '/images/heroes/photo-1280.jpg' },
    { id: 'video', label: 'Video Page', description: 'video page', fallback: '/images/heroes/video-1280.jpg' },
]

function formatMegabytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function validateFile(file) {
    if (!file || !ALLOWED_TYPES.has(file.type)) {
        return 'Choose a JPEG, PNG, WebP, or AVIF image.'
    }
    if (file.size < MIN_BYTES) return 'The selected image is too small.'
    if (file.size > MAX_BYTES) return 'The hero image must be 50 MB or smaller.'
    return ''
}

export default function ManageHero() {
    const { getIdToken } = useAuth()
    const [heroType, setHeroType] = useState('photo')
    const [file, setFile] = useState(null)
    const [dimensions, setDimensions] = useState(null)
    const [uploading, setUploading] = useState(false)
    const [status, setStatus] = useState('')
    const [error, setError] = useState('')
    const [success, setSuccess] = useState(false)
    const [currentFailed, setCurrentFailed] = useState(false)
    const fileInputRef = useRef(null)
    const requestRef = useRef(null)
    const activeTab = HERO_TABS.find(({ id }) => id === heroType) || HERO_TABS[0]
    const currentHero = heroType === 'video' ? cdnUrl('site/hero/video/home') : heroCoverUrl()
    const previewUrl = useMemo(() => file ? URL.createObjectURL(file) : '', [file])

    useEffect(() => () => {
        if (previewUrl) URL.revokeObjectURL(previewUrl)
    }, [previewUrl])

    useEffect(() => () => requestRef.current?.abort(), [])

    function selectHeroType(nextType) {
        if (uploading || nextType === heroType) return
        setHeroType(nextType)
        setFile(null)
        setDimensions(null)
        setStatus('')
        setError('')
        setSuccess(false)
        setCurrentFailed(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
    }

    function handleFileChange(event) {
        const selected = event.target.files?.[0] || null
        setError('')
        setSuccess(false)
        setDimensions(null)
        const validationError = validateFile(selected)
        if (validationError) {
            setFile(null)
            setError(validationError)
            event.target.value = ''
            return
        }
        setFile(selected)
    }

    async function handleSubmit(event) {
        event.preventDefault()
        const validationError = validateFile(file)
        if (validationError) {
            setError(validationError)
            return
        }

        const controller = new AbortController()
        requestRef.current = controller
        setUploading(true)
        setSuccess(false)
        setError('')
        try {
            setStatus('Preparing secure upload…')
            const token = await getIdToken()
            const authorization = heroType === 'video'
                ? await requestVideoHeroUploadUrl(token, file, { signal: controller.signal })
                : await requestHeroUploadUrl(token, file, { signal: controller.signal })

            setStatus('Uploading original image without compression…')
            const uploadResponse = await uploadFileToS3(
                authorization.uploadUrl,
                file,
                authorization.requiredHeaders,
                { signal: controller.signal, retries: 1 },
            )
            const etag = uploadResponse.headers.get('ETag')
            if (!etag) throw new Error('The upload finished without a receipt. Please try again.')

            setStatus('Creating responsive high-quality versions…')
            if (heroType === 'video') {
                await completeVideoHeroUpload(token, etag, { signal: controller.signal })
            } else {
                await completeHeroUpload(token, etag, { signal: controller.signal })
            }
            setSuccess(true)
            setStatus('')
            setFile(null)
            setDimensions(null)
            setCurrentFailed(false)
            if (fileInputRef.current) fileInputRef.current.value = ''
        } catch (uploadError) {
            if (uploadError?.name !== 'AbortError') {
                setError(uploadError?.message || 'The hero cover could not be updated.')
            }
        } finally {
            if (requestRef.current === controller) requestRef.current = null
            setUploading(false)
            setStatus('')
        }
    }

    const displayedImage = previewUrl || (!currentFailed ? currentHero : '') || activeTab.fallback

    return (
        <div className="max-w-4xl mx-auto px-6 py-12 pt-[88px] md:pt-[104px]">
            <div className="animate-slide-up">
                <Link to="/admin" className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Dashboard
                </Link>

                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Change Hero Cover</h1>
                    <p className="mt-2 text-warm-gray">Replace the large cover image on either public gallery page.</p>
                </div>

                <div className="mb-8 grid grid-cols-2 border border-warm-border" role="tablist" aria-label="Hero page">
                    {HERO_TABS.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={heroType === tab.id}
                            aria-controls="hero-cover-panel"
                            disabled={uploading}
                            onClick={() => selectHeroType(tab.id)}
                            className={`px-5 py-4 text-sm font-medium tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                                heroType === tab.id
                                    ? 'bg-charcoal text-cream'
                                    : 'bg-transparent text-charcoal hover:bg-cream-dark'
                            } ${tab.id === 'video' ? 'border-l border-warm-border' : ''}`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {success && (
                    <div className="mb-8 p-5 rounded-2xl bg-green-50 border border-green-200 text-green-800" role="status">
                        <p className="font-medium">{activeTab.label} hero processing started successfully.</p>
                        <p className="mt-1 text-sm">The original is preserved exactly while optimized display sizes are created. The new cover will appear automatically in about a minute.</p>
                    </div>
                )}
                {error && (
                    <div className="mb-8 p-5 rounded-2xl bg-red-50 border border-red-200 text-red-700" role="alert">
                        <p>{error}</p>
                    </div>
                )}

                <form id="hero-cover-panel" role="tabpanel" onSubmit={handleSubmit} className="bg-white rounded-2xl p-6 md:p-8 shadow-warm-lg border border-warm-border">
                    <div className="aspect-[3/2] overflow-hidden rounded-2xl bg-charcoal mb-7">
                        <img
                            key={displayedImage}
                            src={displayedImage}
                            alt={previewUrl ? 'Selected hero cover preview' : `Current ${activeTab.description} hero cover`}
                            className="h-full w-full object-cover object-[center_30%]"
                            onLoad={(event) => {
                                if (previewUrl) {
                                    setDimensions({
                                        width: event.currentTarget.naturalWidth,
                                        height: event.currentTarget.naturalHeight,
                                    })
                                }
                            }}
                            onError={() => {
                                if (!previewUrl && currentHero) setCurrentFailed(true)
                            }}
                        />
                    </div>

                    <div className="mb-7">
                        <label htmlFor="hero-file" className="block text-sm font-medium text-charcoal mb-2">New hero image</label>
                        <input
                            ref={fileInputRef}
                            id="hero-file"
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/avif,.jpg,.jpeg,.png,.webp,.avif"
                            onChange={handleFileChange}
                            disabled={uploading}
                            required
                            className="block w-full text-sm text-warm-gray file:mr-4 file:rounded-xl file:border-0 file:bg-amber file:px-5 file:py-3 file:font-medium file:text-white hover:file:bg-amber-dark disabled:opacity-60"
                        />
                        <p className="mt-3 text-sm text-warm-gray leading-relaxed">
                            JPEG, PNG, WebP, or AVIF; up to 50 MB. For a crisp result, use a landscape image at least 2560 pixels wide.
                            The exact selected file is retained as the unmodified master with no Google Drive backup. Responsive high-quality display versions are generated automatically for fast loading.
                        </p>
                        <p className="mt-2 text-sm font-medium text-charcoal">Updating: {activeTab.label}</p>
                        {file && (
                            <p className="mt-2 text-sm font-medium text-charcoal">
                                {file.name} · {formatMegabytes(file.size)}
                                {dimensions ? ` · ${dimensions.width} × ${dimensions.height}` : ''}
                            </p>
                        )}
                        {dimensions && dimensions.width < 2560 && (
                            <p className="mt-2 text-sm text-amber-dark">This image is under the recommended 2560-pixel width and may look soft on large displays.</p>
                        )}
                    </div>

                    {status && <p className="mb-4 text-sm text-warm-gray" role="status" aria-live="polite">{status}</p>}
                    <button
                        type="submit"
                        disabled={!file || uploading}
                        className="w-full rounded-xl bg-amber px-6 py-3 font-medium text-white shadow-warm transition-colors hover:bg-amber-dark disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {uploading ? 'Updating Cover…' : 'Upload and Change Cover'}
                    </button>
                </form>
            </div>
        </div>
    )
}
