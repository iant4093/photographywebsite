import { calculateHistogram, processImagePixels } from './adjustments'

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
        const { id, pixels, width, height, adjustments, clipping, reportProgress } = message
        try {
            const onProgress = reportProgress
                ? (progress) => self.postMessage({ id, progress })
                : undefined
            const output = processImagePixels(new Uint8ClampedArray(pixels), width, height, adjustments, { clipping, onProgress })
            const histogram = calculateHistogram(output)
            self.postMessage({ id, pixels: output.buffer, histogram }, [output.buffer])
        } catch (error) {
            self.postMessage({ id, error: error instanceof Error ? error.message : 'Image processing failed.' })
        }
    }
}
