const DATABASE_NAME = 'ian-truong-photo-editor'
const DATABASE_VERSION = 1
const STORE_NAME = 'session'
const SOURCE_KEY = 'source'
const STATE_KEY = 'state'
const SESSION_SCHEMA = 'ian-truong-photo-editor/session-v1'

function openDatabase() {
    return new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error('Local session recovery is unavailable in this browser.'))
            return
        }
        const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
        request.onupgradeneeded = () => {
            const database = request.result
            if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error || new Error('The local editor database could not be opened.'))
        request.onblocked = () => reject(new Error('The local editor database is blocked by another tab.'))
    })
}

async function runTransaction(mode, operation, signal) {
    signal?.throwIfAborted()
    const database = await openDatabase()
    try {
        signal?.throwIfAborted()
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, mode)
            const store = transaction.objectStore(STORE_NAME)
            const abort = () => transaction.abort()
            const finish = (callback, value) => {
                signal?.removeEventListener('abort', abort)
                callback(value)
            }
            signal?.addEventListener('abort', abort, { once: true })
            let result
            try { result = operation(store); Promise.resolve(result).catch(() => {}) } catch (error) { transaction.abort(); finish(reject, error); return }
            transaction.oncomplete = () => finish(resolve, result)
            transaction.onerror = () => finish(reject, transaction.error || new Error('The local editor session could not be saved.'))
            transaction.onabort = () => finish(reject, signal?.reason || transaction.error || new Error('The local editor session save was cancelled.'))
        })
    } finally {
        database.close()
    }
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error || new Error('The local editor session could not be read.'))
    })
}

export async function saveEditorSource(file, { signal } = {}) {
    if (!(file instanceof Blob)) throw new Error('Only a local image file can be saved for recovery.')
    const sourceId = crypto.randomUUID()
    await runTransaction('readwrite', (store) => {
        store.put({
            sourceId,
            schema: SESSION_SCHEMA,
            blob: file,
            name: file.name || 'photo',
            type: file.type || '',
            lastModified: file.lastModified || Date.now(),
            savedAt: Date.now(),
        }, SOURCE_KEY)
        // State from a previously opened photo must never be applied to this source.
        store.delete(STATE_KEY)
    }, signal)
    return sourceId
}

export async function saveEditorState(state, sourceId, { expectedRevision = 0, signal } = {}) {
    return runTransaction('readwrite', store => new Promise((resolve, reject) => {
        const request = store.get(SOURCE_KEY)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            if (!sourceId || request.result?.sourceId !== sourceId) { resolve(false); return }
            const current = store.get(STATE_KEY)
            current.onerror = () => reject(current.error)
            current.onsuccess = () => {
                const saved = current.result?.sourceId === sourceId ? current.result : null
                const revision = saved?.revision || 0
                // A recovered tab's unchanged autosave must not claim a new
                // revision or invalidate the actively edited tab's snapshot.
                if (saved && JSON.stringify(saved.state) === JSON.stringify(state)) { resolve(revision); return }
                if (revision !== expectedRevision) { resolve(false); return }
                store.put({ schema: SESSION_SCHEMA, sourceId, state, revision: revision + 1, savedAt: Date.now() }, STATE_KEY)
                resolve(revision + 1)
            }
        }
    }), signal)
}

export async function loadEditorSession() {
    const database = await openDatabase()
    try {
        const transaction = database.transaction(STORE_NAME, 'readonly')
        const store = transaction.objectStore(STORE_NAME)
        const [source, state] = await Promise.all([
            requestResult(store.get(SOURCE_KEY)),
            requestResult(store.get(STATE_KEY)),
        ])
        if (source?.schema !== SESSION_SCHEMA || !(source.blob instanceof Blob)) return null
        const file = new File([source.blob], source.name || 'photo', {
            type: source.type || source.blob.type,
            lastModified: source.lastModified || Date.now(),
        })
        return {
            file,
            sourceId: source.sourceId,
            revision: state?.sourceId === source.sourceId ? state?.revision || 0 : 0,
            state: source.sourceId && state?.sourceId === source.sourceId && state?.schema === SESSION_SCHEMA && state.state && typeof state.state === 'object'
                ? state.state
                : null,
            savedAt: Math.max(source.savedAt || 0, state?.sourceId === source.sourceId ? state?.savedAt || 0 : 0),
        }
    } finally {
        database.close()
    }
}

export async function clearEditorSession(sourceId, expectedRevision) {
    await runTransaction('readwrite', store => {
        const request = store.get(SOURCE_KEY)
        request.onsuccess = () => {
            if (sourceId !== undefined && request.result?.sourceId !== sourceId) return
            const state = store.get(STATE_KEY)
            state.onsuccess = () => {
                if (expectedRevision !== undefined && (state.result?.revision || 0) !== expectedRevision) return
                store.delete(SOURCE_KEY)
                store.delete(STATE_KEY)
            }
        }
    })
}
