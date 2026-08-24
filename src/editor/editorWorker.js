import { calculateHistogram, prewarmSpatialCache, processImagePixels } from './adjustments'

const sources = new Map()

function rememberSource(sourceId, pixels, width, height) {
    const entry = {
        pixels: new Uint8ClampedArray(pixels),
        width,
        height,
        spatialCache: new Map(),
    }
    sources.set(sourceId, entry)
    while (sources.size > 4) sources.delete(sources.keys().next().value)
    return entry
}

function sourceForMessage({ sourceId, pixels, width, height }) {
    if (sourceId && pixels) return rememberSource(sourceId, pixels, width, height)
    if (sourceId && sources.has(sourceId)) return sources.get(sourceId)
    if (pixels) return { pixels: new Uint8ClampedArray(pixels), width, height, spatialCache: null }
    throw new Error('The preview source is no longer available.')
}

function bitmapResult(output, width, height) {
    if (typeof OffscreenCanvas === 'undefined' || typeof ImageData === 'undefined') return null
    try {
        const canvas = new OffscreenCanvas(width, height)
        const context = canvas.getContext('2d', { alpha: false })
        if (!context || typeof canvas.transferToImageBitmap !== 'function') return null
        context.putImageData(new ImageData(output, width, height), 0, 0)
        return canvas.transferToImageBitmap()
    } catch {
        return null
    }
}

if (typeof self !== 'undefined') {
    const warmupPixels = new Uint8ClampedArray(16 * 16 * 4).fill(128)
    processImagePixels(warmupPixels, 16, 16, {
        clarity: 1,
        dehaze: 1,
        saturation: 1,
        vignette: 1,
        grain: 1,
    })

    self.onmessage = ({ data: message }) => {
        const { id, adjustments, clipping, operation = 'render', radii, reportProgress, includeHistogram = true, outputType = 'pixels' } = message
        try {
            const source = sourceForMessage(message)
            if (operation === 'prewarm') {
                prewarmSpatialCache(source.pixels, source.width, source.height, radii, source.spatialCache)
                self.postMessage({ id, warmed: true })
                return
            }
            const onProgress = reportProgress
                ? (progress) => self.postMessage({ id, progress })
                : undefined
            const output = processImagePixels(source.pixels, source.width, source.height, adjustments, {
                clipping,
                onProgress,
                spatialCache: source.spatialCache,
            })
            const histogram = includeHistogram ? calculateHistogram(output) : null
            const bitmap = outputType === 'bitmap' ? bitmapResult(output, source.width, source.height) : null
            if (bitmap) {
                self.postMessage({ id, bitmap, width: source.width, height: source.height, histogram }, [bitmap])
            } else {
                self.postMessage({ id, pixels: output.buffer, width: source.width, height: source.height, histogram }, [output.buffer])
            }
        } catch (error) {
            self.postMessage({ id, error: error instanceof Error ? error.message : 'Image processing failed.' })
        }
    }
}
