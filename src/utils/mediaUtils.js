import { encode } from 'blurhash'

const THUMBNAIL_MAX_SIZE = 800
const THUMBNAIL_MIME_TYPE = 'image/jpeg'
const THUMBNAIL_QUALITY = 0.85
const BLURHASH_SIZE = 32
const VIDEO_DECODE_TIMEOUT_MS = 30_000

export const VIDEO_DECODE_ERROR_MESSAGE = 'This video codec cannot be decoded by your browser. Export the video as H.264 MP4 and try again.'

function scaledDimensions(sourceWidth, sourceHeight) {
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
        throw new Error('Media has no usable dimensions')
    }

    const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(sourceWidth, sourceHeight))
    return {
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale)),
    }
}

function canvasContext(canvas) {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas rendering is unavailable')
    return context
}

function renderThumbnailCanvas(source, sourceWidth, sourceHeight) {
    const { width, height } = scaledDimensions(sourceWidth, sourceHeight)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvasContext(canvas).drawImage(source, 0, 0, width, height)
    return canvas
}

function blurhashFromCanvas(canvas) {
    const hashCanvas = document.createElement('canvas')
    hashCanvas.width = BLURHASH_SIZE
    hashCanvas.height = Math.max(1, Math.round(BLURHASH_SIZE * (canvas.height / canvas.width)))
    const hashContext = canvasContext(hashCanvas)
    hashContext.drawImage(canvas, 0, 0, hashCanvas.width, hashCanvas.height)
    const imageData = hashContext.getImageData(0, 0, hashCanvas.width, hashCanvas.height)
    const componentX = 4
    const componentY = Math.max(1, Math.min(4, Math.round(componentX * (canvas.height / canvas.width))))
    return encode(imageData.data, imageData.width, imageData.height, componentX, componentY)
}

function jpegBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob)
            else reject(new Error('Thumbnail encoding failed'))
        }, THUMBNAIL_MIME_TYPE, THUMBNAIL_QUALITY)
    })
}

async function renderThumbnail(source, sourceWidth, sourceHeight, { tolerateBlurhashFailure = false } = {}) {
    const canvas = renderThumbnailCanvas(source, sourceWidth, sourceHeight)
    let blurhash = null
    try {
        blurhash = blurhashFromCanvas(canvas)
    } catch (error) {
        if (!tolerateBlurhashFailure) throw error
        console.warn('Blurhash extraction failed (tainted canvas), using existing')
    }
    return { thumbnail: await jpegBlob(canvas), blurhash }
}

// Generate the legacy 800px JPEG fallback and blurhash. Responsive WebP
// previews are produced server-side so upload compatibility remains unchanged.
export async function processImage(file) {
    return new Promise((resolve, reject) => {
        const image = new Image()
        const objectUrl = URL.createObjectURL(file)
        const cleanup = () => URL.revokeObjectURL(objectUrl)

        image.onload = async () => {
            try {
                const result = await renderThumbnail(image, image.width, image.height)
                resolve({ ...result, width: image.width, height: image.height })
            } catch (error) {
                reject(error)
            } finally {
                cleanup()
            }
        }
        image.onerror = () => {
            cleanup()
            reject(new Error('Failed to load image for processing'))
        }
        image.src = objectUrl
    })
}

// Generate a legacy video poster and blurhash from a selected frame.
export async function processVideo(file, time) {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video')
        video.muted = true
        video.playsInline = true
        video.preload = 'auto'

        // Browsers may not decode frames for display:none video elements.
        video.style.position = 'fixed'
        video.style.top = '-9999px'
        video.style.left = '-9999px'
        video.style.width = '1px'
        video.style.height = '1px'
        video.style.opacity = '0'
        video.style.pointerEvents = 'none'
        document.body.appendChild(video)

        const objectUrl = URL.createObjectURL(file)
        let initialized = false
        let settled = false
        const decodeTimeout = window.setTimeout(() => {
            fail(new Error(VIDEO_DECODE_ERROR_MESSAGE))
        }, VIDEO_DECODE_TIMEOUT_MS)

        const cleanup = () => {
            window.clearTimeout(decodeTimeout)
            video.oncanplay = null
            video.onseeked = null
            video.onerror = null
            URL.revokeObjectURL(objectUrl)
            if (document.body.contains(video)) document.body.removeChild(video)
        }
        const fail = (error) => {
            if (settled) return
            settled = true
            cleanup()
            reject(error instanceof Error ? error : new Error('Video processing failed'))
        }

        video.oncanplay = () => {
            if (initialized) return
            initialized = true
            video.currentTime = Math.max(0.1, Number(time) || 0)
        }

        video.onseeked = () => {
            // A short delay after seeked is more reliable than
            // requestVideoFrameCallback for off-screen video elements.
            setTimeout(async () => {
                if (settled) return
                try {
                    const sourceWidth = video.videoWidth
                    const sourceHeight = video.videoHeight
                    const result = await renderThumbnail(video, sourceWidth, sourceHeight)
                    settled = true
                    cleanup()
                    resolve({ ...result, width: sourceWidth, height: sourceHeight })
                } catch (error) {
                    fail(error)
                }
            }, 300)
        }

        video.onerror = () => fail(new Error(VIDEO_DECODE_ERROR_MESSAGE))
        video.src = objectUrl
    })
}

// Extract a thumbnail + blurhash from an already-loaded <video> element.
export async function extractFrameFromVideoElement(video) {
    return renderThumbnail(video, video.videoWidth, video.videoHeight, { tolerateBlurhashFailure: true })
}
