import { requestUploadUrls, uploadFileToS3 } from './api'
import { uploadOriginalFilename } from './mediaUrls'

// Probe four transfers, then keep the extra concurrency only when measured
// aggregate throughput improves. Slow/save-data connections stay at two.
export function createUploadConcurrency(connection = globalThis.navigator?.connection) {
    const conservative = connection?.saveData || /(^|-)2g$|^3g$/.test(connection?.effectiveType || '')
    let limit = 2
    let baseline = 0
    let measured = 0
    let settled = conservative
    return {
        get limit() { return limit },
        observe(bytes, milliseconds, count) {
            if (settled || count < limit || milliseconds < 1) return
            const rate = bytes / milliseconds
            if (limit === 2) {
                baseline += rate
                measured += 1
                if (measured === 2) { baseline /= 2; limit = 4 }
            } else {
                if (rate < baseline * 1.15) limit = 2
                settled = true
            }
        },
    }
}

async function settleAll(promises) {
    const results = await Promise.allSettled(promises)
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
    return results.map(result => result.value)
}

export const UPLOAD_RETRY_HINT = 'Keep this page open and retry with the same selection. Completed files will be reused.'

// Kept only in the mounted page: File identities prevent matching a different
// selection by name. No credentials, signed URLs or photo bytes are persisted.
export function createMediaUploadSession({ albumId, s3Prefix, entries, video = false }) {
    const states = entries.map(({ file, time = 0 }, index) => ({ file, time, index, parts: null, result: null }))
    let running = false
    let commitBody
    let controller

    async function run({ getIdToken, prepare, transfer }) {
        if (running) throw new Error('An upload is already running.')
        running = true
        try {
            for (const state of states) {
                for (const part of state.parts || []) {
                    if (part.done) transfer.restorePart(`${state.index}:${part.kind}`, part.file)
                }
                if (state.result) transfer.completeFile()
            }
            controller = new AbortController()
            const signal = controller.signal
            const concurrency = createUploadConcurrency()
            let authorizationQueue = []
            let authorizationTimer
            async function flushAuthorization() {
                authorizationTimer = null
                const queue = authorizationQueue
                authorizationQueue = []
                const parts = queue.flatMap(entry => entry.parts)
                try {
                    // getSession refreshes an expired Cognito token here.
                    const token = await getIdToken()
                    signal.throwIfAborted()
                    const { uploads } = await requestUploadUrls(token, albumId, parts.map(part => ({
                        filename: part.filename, contentType: part.kind === 'thumbnail' ? 'image/jpeg' : part.file.type,
                        size: part.file.size, kind: part.kind,
                    })), { signal })
                    if (!Array.isArray(uploads) || uploads.length !== parts.length ||
                        uploads.some(upload => !upload?.uploadUrl || !upload?.key)) {
                        throw new Error('The service returned incomplete upload permissions. Please retry.')
                    }
                    parts.forEach((part, index) => { part.upload = uploads[index] })
                    queue.forEach(entry => entry.resolve())
                } catch (error) {
                    queue.forEach(entry => entry.reject(error))
                }
            }
            function authorize(parts) {
                return new Promise((resolve, reject) => {
                    authorizationQueue.push({ parts, resolve, reject })
                    // Coalesce ready workers, without holding a small photo
                    // behind a large transfer or signing a long waiting queue.
                    authorizationTimer ??= setTimeout(flushAuthorization, 1)
                })
            }
            let preparing = 0
            const preparationWaiters = []
            async function prepareBounded(state) {
                if (preparing < 2) preparing += 1
                else await new Promise(resolve => preparationWaiters.push(resolve))
                try {
                    signal.throwIfAborted()
                    return await prepare(state.file, state.time, state.index, { signal })
                } finally {
                    if (preparationWaiters.length) preparationWaiters.shift()()
                    else preparing -= 1
                }
            }
            let totalSent = 0
            async function upload(state) {
                signal.throwIfAborted()
                if (!state.parts) {
                    const { thumbnail, blurhash, width, height } = await prepareBounded(state)
                    state.metadata = { blurhash, width, height, ...(video
                        ? { thumbnailTime: state.time }
                        : { originalFilename: uploadOriginalFilename(state.file.name) }) }
                    state.parts = [
                        { kind: 'original', file: state.file, filename: `${s3Prefix}${state.file.name}` },
                        { kind: 'thumbnail', file: thumbnail, filename: `${s3Prefix}thumb_${state.file.name}${video ? '.jpg' : ''}` },
                    ]
                }
                signal.throwIfAborted()
                const parts = state.parts.filter(part => !part.done)
                await authorize(parts)
                await settleAll(parts.map(async part => {
                    const publish = transfer.progressFor(`${state.index}:${part.kind}`, part.file)
                    let loaded = 0
                    const onProgress = event => {
                        totalSent += Math.max(0, event.loaded - loaded)
                        loaded = event.loaded
                        publish(event)
                    }
                    try {
                        await uploadFileToS3(part.upload.uploadUrl, part.file, part.upload.requiredHeaders, { onProgress, signal })
                    } catch (error) {
                        // A retry after a long interruption may need a fresh
                        // URL. S3 checks expiry at the start of each request.
                        if (error?.status !== 403) throw error
                        await authorize([part])
                        await uploadFileToS3(part.upload.uploadUrl, part.file, part.upload.requiredHeaders, { onProgress, signal })
                    }
                    part.key = part.upload.key
                    part.done = true
                    delete part.upload
                }))
                state.result = { rawKey: state.parts[0].key, thumbKey: state.parts[1].key, ...state.metadata }
                transfer.completeFile()
            }
            const pending = states.filter(state => !state.result)
            let next = 0
            let active = 0
            let failure
            let failed = false
            let windowStart = performance.now()
            let windowBytes = 0
            let windowCount = 0
            await new Promise((resolve, reject) => {
                function schedule() {
                    if (active === 0 && (failed || next === pending.length)) {
                        if (failed) reject(failure)
                        else resolve()
                        return
                    }
                    while (!failed && active < concurrency.limit && next < pending.length) {
                        const state = pending[next++]
                        active += 1
                        upload(state).catch(error => { if (!failed) { failure = error; failed = true } }).finally(() => {
                            active -= 1
                            windowCount += 1
                            if (windowCount >= concurrency.limit) {
                                const now = performance.now()
                                concurrency.observe(totalSent - windowBytes, now - windowStart, windowCount)
                                windowStart = now
                                windowBytes = totalSent
                                windowCount = 0
                            }
                            schedule()
                        })
                    }
                }
                schedule()
            })
            return states.map(state => state.result)
        } finally {
            // All in-flight work has settled before retry becomes possible.
            states.forEach(state => state.parts?.forEach(part => { delete part.upload }))
            running = false
        }
    }

    return {
        albumId, s3Prefix, run,
        cancel() { controller?.abort() },
        matches(next, nextAlbumId = albumId) {
            return nextAlbumId === albumId && next.length === states.length &&
                next.every(({ file, time = 0 }, index) => file === states[index].file && time === states[index].time)
        },
        // A retry after a lost save response must repeat the same request,
        // including its date and visibility, even if form fields were edited.
        commitBody(body) { commitBody ||= body; return commitBody },
        rejectCommit(error) {
            // A definitive validation rejection lets the user fix the form.
            // Ambiguous network/5xx failures must replay the original payload.
            // The backend still rejects changed requests if a record exists.
            if (error?.status === 400) commitBody = undefined
        },
    }
}
