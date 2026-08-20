import rawWorkerUrl from 'rawconvert-wasm/dist/worker.js?url'
import rawCoreUrl from 'rawconvert-wasm/dist/rawconvert-core.js?url'
import rawWasmUrl from 'rawconvert-wasm/dist/rawconvert-core.wasm?url'

const RAW_EXTENSIONS = new Set(['3fr', 'arw', 'cr2', 'cr3', 'dcr', 'dng', 'erf', 'fff', 'iiq', 'kdc', 'mef', 'mos', 'mrw', 'nef', 'nrw', 'orf', 'pef', 'raf', 'raw', 'rw2', 'rwl', 'srw', 'x3f'])

export function isRawFile(file) {
    const extension = file?.name?.split('.').pop()?.toLowerCase()
    return RAW_EXTENSIONS.has(extension)
}

export async function decodeRawFile(file, onProgress = () => {}) {
    onProgress('Loading RAW decoder')
    const [{ RawConvertWorker }, bytes, exifr] = await Promise.all([
        import('rawconvert-wasm/dist/worker-client.js'),
        file.arrayBuffer(),
        import('exifr'),
    ])
    const decoder = await RawConvertWorker.init({ workerUrl: rawWorkerUrl, coreUrl: rawCoreUrl, wasmUrl: rawWasmUrl })
    try {
        onProgress('Reading RAW data')
        const metadata = await decoder.load(bytes, file.name)
        onProgress('Developing RAW image')
        const decoded = await decoder.process({
            colorSpace: 'srgb',
            interpolation: 'ahd',
            outputBps: 8,
            halfSize: false,
            cameraWhiteBalance: true,
            highlightMode: 2,
        })
        if (!decoded?.data || !decoded.width || !decoded.height) throw new Error('The RAW file did not produce a usable image.')
        const source = decoded.data
        const rgba = new Uint8ClampedArray(decoded.width * decoded.height * 4)
        for (let sourceIndex = 0, targetIndex = 0; targetIndex < rgba.length; sourceIndex += 3, targetIndex += 4) {
            rgba[targetIndex] = source[sourceIndex]
            rgba[targetIndex + 1] = source[sourceIndex + 1]
            rgba[targetIndex + 2] = source[sourceIndex + 2]
            rgba[targetIndex + 3] = 255
        }
        const exif = await exifr.parse(file, { tiff: true, exif: true }).catch(() => null)
        return {
            pixels: rgba,
            width: decoded.width,
            height: decoded.height,
            metadata: {
                make: metadata?.cameraMake || exif?.Make,
                model: metadata?.cameraModel || exif?.Model,
                lens: metadata?.lensModel || exif?.LensModel,
                iso: metadata?.iso || exif?.ISO,
                exposure: metadata?.shutterSpeed || exif?.ExposureTime,
                aperture: metadata?.aperture || exif?.FNumber,
                focalLength: metadata?.focalLength || exif?.FocalLength,
                raw: true,
            },
        }
    } finally {
        decoder.dispose()
    }
}
