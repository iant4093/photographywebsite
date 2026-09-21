const ZIP_JOB_LIFETIME_MS = 15 * 60_000
const DEFAULT_INTERVALS_MS = [1_000, 2_000, 3_000, 5_000, 10_000, 15_000]

export class ZipJobError extends Error {
    constructor(message, { code = 'ZIP_FAILED', terminal = false } = {}) {
        super(message)
        this.name = 'ZipJobError'
        this.code = code
        this.terminal = terminal
    }
}

function safeStorage(storage) {
    try {
        return storage || (typeof window !== 'undefined' ? window.sessionStorage : null)
    } catch {
        return null
    }
}

function readStartedAt(storage, jobKey, now) {
    try {
        const value = JSON.parse(storage?.getItem(jobKey) || 'null')
        if (Number.isFinite(value?.startedAt) && now - value.startedAt < ZIP_JOB_LIFETIME_MS) {
            return value.startedAt
        }
    } catch {
        // Ignore unavailable or malformed session state.
    }
    return now
}

function remember(storage, jobKey, startedAt, status) {
    try {
        storage?.setItem(jobKey, JSON.stringify({ startedAt, status }))
    } catch {
        // ZIP polling still works when browser storage is unavailable.
    }
}

function forget(storage, jobKey) {
    try {
        storage?.removeItem(jobKey)
    } catch {
        // Nothing else to recover.
    }
}

function defaultSleep(delayMs, signal) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now()
        let timer
        const page = typeof document === 'undefined' ? null : document
        const cleanup = () => {
            window.clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
            page?.removeEventListener('visibilitychange', schedule)
        }
        const finish = () => {
            cleanup()
            resolve()
        }
        const abort = () => {
            cleanup()
            reject(new DOMException('Request aborted', 'AbortError'))
        }
        const schedule = () => {
            window.clearTimeout(timer)
            // Returning to the tab resumes promptly, but never before the
            // normal backoff/server cooldown would have allowed another poll.
            const interval = page?.visibilityState === 'hidden' ? Math.max(delayMs, 60_000) : delayMs
            timer = window.setTimeout(finish, Math.max(0, startedAt + interval - Date.now()))
        }
        if (signal?.aborted) abort()
        else {
            signal?.addEventListener('abort', abort, { once: true })
            page?.addEventListener('visibilitychange', schedule)
            schedule()
        }
    })
}

function responseDelay(response, attempt, intervals) {
    const backoff = intervals[Math.min(attempt, intervals.length - 1)]
    const suggestedSeconds = Number(response?.retryAfterSeconds)
    if (Number.isFinite(suggestedSeconds) && suggestedSeconds > 0) {
        return Math.min(Math.max(suggestedSeconds * 1000, 1_000, backoff), 60_000)
    }
    return backoff
}

export async function pollZipJob({
    jobKey,
    request,
    onStatus = () => {},
    signal,
    storage,
    now = () => Date.now(),
    sleep = defaultSleep,
    maxDurationMs = ZIP_JOB_LIFETIME_MS,
    intervals = DEFAULT_INTERVALS_MS,
}) {
    const selectedStorage = safeStorage(storage)
    const storageKey = `photography.zip.${jobKey}`
    const startedAt = readStartedAt(selectedStorage, storageKey, now())
    remember(selectedStorage, storageKey, startedAt, 'processing')

    let attempt = 0
    while (now() - startedAt < maxDurationMs) {
        if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError')

        let response
        try {
            response = await request({ signal })
        } catch (error) {
            if (error?.name === 'AbortError') throw error
            if (error?.status === 429) {
                const delay = Math.min(Math.max(error.retryAfterMs || 30_000, 10_000), 60_000)
                onStatus('rate_limited')
                await sleep(delay, signal)
                continue
            }
            forget(selectedStorage, storageKey)
            throw error
        }

        const status = response?.status
        if (status === 'ready' && response.url) {
            forget(selectedStorage, storageKey)
            onStatus('ready')
            return response.url
        }
        if (status === 'failed' || status === 'error') {
            forget(selectedStorage, storageKey)
            throw new ZipJobError(
                response.message || 'The ZIP could not be generated.',
                { code: response.code || 'ZIP_FAILED', terminal: true },
            )
        }
        if (status !== 'processing') {
            forget(selectedStorage, storageKey)
            throw new ZipJobError('The server returned an unexpected ZIP status.', { code: 'BAD_ZIP_STATUS', terminal: true })
        }

        remember(selectedStorage, storageKey, startedAt, 'processing')
        onStatus('processing')
        await sleep(responseDelay(response, attempt, intervals), signal)
        attempt += 1
    }

    forget(selectedStorage, storageKey)
    throw new ZipJobError(
        'ZIP generation did not finish within 15 minutes. Please try again later.',
        { code: 'ZIP_TIMEOUT', terminal: true },
    )
}
