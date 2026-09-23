// Browser policies can throw even while accessing the Storage property.
export function rawStorage(name) {
    try { return window[name] } catch { return null }
}

function adapter(name) {
    return {
        keys() { try { return Object.keys(rawStorage(name) || {}) } catch { return [] } },
        getItem(key) { try { return rawStorage(name)?.getItem(key) ?? null } catch { return null } },
        removeItem(key) { try { rawStorage(name)?.removeItem(key) } catch { /* Already inaccessible. */ } },
        setItem(key, value) {
            try {
                const storage = rawStorage(name)
                if (!storage) throw new Error('unavailable')
                storage.setItem(key, value)
            } catch { throw new Error('Browser storage is unavailable. Allow site storage to sign in.') }
        },
    }
}

export const persistentStorage = adapter('localStorage')
export const tabStorage = adapter('sessionStorage')
