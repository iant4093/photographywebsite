export async function decodeStandardFile(file) {
    const [bitmap, exifr] = await Promise.all([
        createImageBitmap(file, { imageOrientation: 'from-image' }),
        import('exifr'),
    ])
    try {
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false })
        context.drawImage(bitmap, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const exif = await exifr.parse(file, { tiff: true, exif: true }).catch(() => null)
        return {
            pixels,
            width: canvas.width,
            height: canvas.height,
            metadata: {
                make: exif?.Make,
                model: exif?.Model,
                lens: exif?.LensModel,
                iso: exif?.ISO,
                exposure: exif?.ExposureTime,
                aperture: exif?.FNumber,
                focalLength: exif?.FocalLength,
                raw: false,
            },
        }
    } finally {
        bitmap.close()
    }
}

export function makePreviewSource(source, maxEdge = 1800) {
    const scale = Math.min(1, maxEdge / Math.max(source.width, source.height))
    if (scale === 1) return { ...source, pixels: new Uint8ClampedArray(source.pixels) }
    const input = document.createElement('canvas')
    input.width = source.width
    input.height = source.height
    input.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(source.pixels), source.width, source.height), 0, 0)
    const output = document.createElement('canvas')
    output.width = Math.max(1, Math.round(source.width * scale))
    output.height = Math.max(1, Math.round(source.height * scale))
    output.getContext('2d').drawImage(input, 0, 0, output.width, output.height)
    return {
        width: output.width,
        height: output.height,
        pixels: output.getContext('2d').getImageData(0, 0, output.width, output.height).data,
        metadata: source.metadata,
    }
}
