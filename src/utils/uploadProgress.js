const RATE_WINDOW_MS = 8000

export function createUploadProgress(files, now = () => performance.now()) {
    const transfers = new Map(files.map((file, index) => [`${index}:original`, { size: file.size, loaded: 0 }]))
    const samples = []
    let sentBytes = 0
    let completedFiles = 0
    let phase = 'uploading'

    function progressFor(key, file) {
        if (!transfers.has(key)) transfers.set(key, { size: file.size, loaded: 0 })
        const transfer = transfers.get(key)
        return ({ loaded }) => {
            if (!samples.length) samples.push({ at: now(), bytes: sentBytes })
            const next = Math.max(0, Math.min(file.size, loaded))
            sentBytes += Math.max(0, next - transfer.loaded)
            transfer.loaded = next
        }
    }

    function snapshot() {
        const at = now()
        let bytesPerSecond = null
        if (samples.length) {
            samples.push({ at, bytes: sentBytes })
            while (samples.length > 1 && samples[1].at <= at - RATE_WINDOW_MS) samples.shift()
            const elapsed = (at - samples[0].at) / 1000
            if (elapsed >= 1) bytesPerSecond = (sentBytes - samples[0].bytes) / elapsed
        }
        const totalBytes = [...transfers.values()].reduce((sum, file) => sum + file.size, 0)
        const loadedBytes = [...transfers.values()].reduce((sum, file) => sum + file.loaded, 0)
        const remainingBytes = Math.max(0, totalBytes - loadedBytes)
        return {
            phase, completedFiles, totalFiles: files.length, loadedBytes, totalBytes,
            bytesPerSecond,
            remainingSeconds: remainingBytes > 0 && bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null,
        }
    }

    return {
        progressFor,
        snapshot,
        completeFile() { completedFiles += 1 },
        finalize() { phase = 'saving' },
    }
}

export function formatUploadBytes(bytes) {
    if (bytes < 1000) return `${Math.round(bytes)} B`
    if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`
    if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

export function formatUploadTime(seconds) {
    const rounded = Math.max(1, Math.ceil(seconds))
    if (rounded < 60) return `${rounded}s`
    const minutes = Math.ceil(rounded / 60)
    if (minutes < 60) return `${minutes} min`
    const hours = Math.floor(minutes / 60)
    return `${hours}h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}
