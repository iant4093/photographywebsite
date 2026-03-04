import { encode } from 'blurhash'

// Generate thumbnail and blurhash from file (mirrors Admin.jsx)
export async function processImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image()
        const url = URL.createObjectURL(file)

        img.onload = () => {
            const MAX_SIZE = 800
            let width = img.width
            let height = img.height

            if (width > height && width > MAX_SIZE) {
                height *= MAX_SIZE / width
                width = MAX_SIZE
            } else if (height > width && height > MAX_SIZE) {
                width *= MAX_SIZE / height
                height = MAX_SIZE
            }

            width = Math.round(width)
            height = Math.round(height)

            const canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height
            const ctx = canvas.getContext('2d')

            ctx.drawImage(img, 0, 0, width, height)

            const hashCanvas = document.createElement('canvas')
            const hashSize = 32
            hashCanvas.width = hashSize
            hashCanvas.height = Math.round(hashSize * (height / width))
            const hashCtx = hashCanvas.getContext('2d')
            hashCtx.drawImage(img, 0, 0, hashCanvas.width, hashCanvas.height)
            const imageData = hashCtx.getImageData(0, 0, hashCanvas.width, hashCanvas.height)

            const componentX = 4
            const componentY = Math.max(1, Math.min(4, Math.round(componentX * (height / width))))
            const blurhash = encode(imageData.data, imageData.width, imageData.height, componentX, componentY)

            canvas.toBlob((blob) => {
                URL.revokeObjectURL(url)
                resolve({
                    thumbnail: blob,
                    blurhash,
                    width: img.width,
                    height: img.height
                })
            }, 'image/jpeg', 0.85)
        }
        img.onerror = () => reject(new Error('Failed to load image for processing'))
        img.src = url
    })
}

// Generate thumbnail and blurhash from video frame
export async function processVideo(file, time) {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video')
        video.muted = true
        video.playsInline = true
        video.preload = "auto"
        video.style.display = "none"
        document.body.appendChild(video)

        const url = URL.createObjectURL(file)

        const cleanup = () => {
            video.onloadedmetadata = null
            video.onseeked = null
            video.onerror = null
            if (document.body.contains(video)) {
                document.body.removeChild(video)
            }
        }

        video.onloadedmetadata = () => {
            video.currentTime = Math.max(0.1, time)
        }

        video.onseeked = () => {
            const extractFrame = () => {
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
                    cleanup()
                    resolve({ thumbnail: blob, blurhash, width: video.videoWidth, height: video.videoHeight })
                }, 'image/jpeg', 0.85)
            }

            // Wait a tiny bit for the browser to decode the frame after a seek, 
            // avoiding requestVideoFrameCallback which hangs on unattached DOM nodes in Chrome.
            setTimeout(extractFrame, 200);
        }

        video.onerror = (e) => {
            cleanup()
            reject(e)
        }
        video.src = url
    })
}

// Extract a thumbnail + blurhash from an already-loaded <video> element (no re-download needed)
export function extractFrameFromVideoElement(video) {
    return new Promise((resolve, reject) => {
        try {
            const canvas = document.createElement('canvas')
            const MAX_SIZE = 800
            let width = video.videoWidth
            let height = video.videoHeight

            if (!width || !height) {
                return reject(new Error('Video has no dimensions — is it loaded?'))
            }

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

            // Attempt blurhash (may fail on tainted canvas)
            let blurhash = null
            try {
                const hashCanvas = document.createElement('canvas')
                const hashSize = 32
                hashCanvas.width = hashSize
                hashCanvas.height = Math.round(hashSize * (height / width))
                const hashCtx = hashCanvas.getContext('2d')
                hashCtx.drawImage(canvas, 0, 0, hashCanvas.width, hashCanvas.height)
                const imageData = hashCtx.getImageData(0, 0, hashCanvas.width, hashCanvas.height)
                const componentX = 4
                const componentY = Math.max(1, Math.min(4, Math.round(componentX * (height / width))))
                blurhash = encode(imageData.data, imageData.width, imageData.height, componentX, componentY)
            } catch (e) {
                console.warn('Blurhash extraction failed (tainted canvas), using existing')
            }

            canvas.toBlob((blob) => {
                if (blob) {
                    resolve({ thumbnail: blob, blurhash })
                } else {
                    reject(new Error('canvas.toBlob returned null'))
                }
            }, 'image/jpeg', 0.85)
        } catch (err) {
            reject(err)
        }
    })
}
