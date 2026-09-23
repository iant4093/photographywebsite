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

async function runTransaction(mode, operation) {
    const database = await openDatabase()
    try {
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, mode)
            const store = transaction.objectStore(STORE_NAME)
            let result
            try { result = operation(store) } catch (error) { reject(error); return }
            transaction.oncomplete = () => resolve(result)
            transaction.onerror = () => reject(transaction.error || new Error('The local editor session could not be saved.'))
            transaction.onabort = () => reject(transaction.error || new Error('The local editor session save was cancelled.'))
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

export async function saveEditorSource(file) {
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
    })
    return sourceId
}

export async function saveEditorState(state, sourceId) {
    return runTransaction('readwrite', store => new Promise((resolve, reject) => {
        const request = store.get(SOURCE_KEY)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            if (!sourceId || request.result?.sourceId !== sourceId) { resolve(false); return }
            store.put({ schema: SESSION_SCHEMA, sourceId, state, savedAt: Date.now() }, STATE_KEY)
            resolve(true)
        }
    }))
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
            state: source.sourceId && state?.sourceId === source.sourceId && state?.schema === SESSION_SCHEMA && state.state && typeof state.state === 'object'
                ? state.state
                : null,
            savedAt: Math.max(source.savedAt || 0, state?.sourceId === source.sourceId ? state?.savedAt || 0 : 0),
        }
    } finally {
        database.close()
    }
}

export async function clearEditorSession(sourceId) {
    await runTransaction('readwrite', store => {
        const request = store.get(SOURCE_KEY)
        request.onsuccess = () => {
            if (sourceId !== undefined && request.result?.sourceId !== sourceId) return
            store.delete(SOURCE_KEY)
            store.delete(STATE_KEY)
        }
    })
}
