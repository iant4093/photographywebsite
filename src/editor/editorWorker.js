import { calculateHistogram, processImagePixels } from './adjustments'

if (typeof self !== 'undefined') {
    self.onmessage = ({ data: message }) => {
        const { id, pixels, width, height, adjustments, clipping } = message
        try {
            const output = processImagePixels(new Uint8ClampedArray(pixels), width, height, adjustments, { clipping })
            const histogram = calculateHistogram(output)
            self.postMessage({ id, pixels: output.buffer, histogram }, [output.buffer])
        } catch (error) {
            self.postMessage({ id, error: error instanceof Error ? error.message : 'Image processing failed.' })
        }
    }
}
