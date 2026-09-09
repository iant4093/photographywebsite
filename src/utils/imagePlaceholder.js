import { decode } from 'blurhash'

const placeholders = new Map()
const MAX_PLACEHOLDERS = 128
const SIZE = 24

// Keep only tiny encoded bitmaps, never canvases or full decoded photographs.
// The background remains when a distant full image is released, avoiding an
// empty card and repeated BlurHash decoding on every scroll reversal.
export function imagePlaceholder(hash) {
    if (!hash) return ''
    if (placeholders.has(hash)) {
        const value = placeholders.get(hash)
        placeholders.delete(hash)
        placeholders.set(hash, value)
        return value
    }
    let value = ''
    try {
        const pixels = decode(hash, SIZE, SIZE)
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = SIZE
        const context = canvas.getContext('2d')
        if (context) {
            const data = context.createImageData(SIZE, SIZE)
            data.data.set(pixels)
            context.putImageData(data, 0, 0)
            value = canvas.toDataURL()
        }
    } catch {
        // A missing/invalid placeholder never prevents the photograph loading.
    }
    placeholders.set(hash, value)
    if (placeholders.size > MAX_PLACEHOLDERS) placeholders.delete(placeholders.keys().next().value)
    return value
}
