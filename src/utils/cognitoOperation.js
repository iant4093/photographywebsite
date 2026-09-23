// One bounded SDK operation owns its client, abort signal and storage writes.
// The pool client is shared: changing it globally would cancel unrelated work.
export function cognitoOperation(user, start, { signal, assertCurrent = () => {}, timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController()
        let active = true
        let timer
        const finish = (error, value) => {
            if (!active) return
            active = false
            clearTimeout(timer)
            signal?.removeEventListener('abort', cancel)
            controller.abort()
            if (error) reject(error)
            else resolve(value)
        }
        const current = () => {
            if (!active) return false
            try { assertCurrent(); return true } catch (error) { finish(error); return false }
        }
        const done = (error, value) => { if (current()) finish(error, value) }
        const cancel = () => finish(new DOMException('Account request cancelled.', 'AbortError'))
        if (signal?.aborted) { cancel(); return }
        signal?.addEventListener('abort', cancel, { once: true })
        timer = setTimeout(() => finish(new Error('The account service timed out. Please try again.')), timeoutMs)
        const scoped = Object.create(user)
        if (user.storage) {
            scoped.storage = Object.create(user.storage)
            for (const name of ['setItem', 'removeItem', 'clear']) {
                if (typeof user.storage[name] === 'function') {
                    scoped.storage[name] = (...args) => current() ? user.storage[name](...args) : undefined
                }
            }
        }
        if (user.client) {
            scoped.client = Object.create(user.client)
            scoped.client.fetchOptions = { ...user.client.fetchOptions, signal: controller.signal }
            for (const name of ['request', 'requestWithRetry']) {
                if (typeof user.client[name] === 'function') {
                    scoped.client[name] = (operation, params, callback) => {
                        if (!current()) return
                        user.client[name].call(scoped.client, operation, params, (error, data) => {
                            // Drop a late response before the SDK can cache its
                            // tokens or clear the credentials of a newer login.
                            if (current()) callback(error, data)
                        })
                    }
                }
            }
        }
        try { if (current()) start(scoped, done) } catch (error) { finish(error) }
    })
}

export async function readAccount(user, method, assertCurrent) {
    const value = await cognitoOperation(user, (scoped, done) => {
        if (method === 'getSession') scoped.getSession(done)
        else scoped.getUserData(done, { bypassCache: true })
    }, { assertCurrent })
    if (method === 'getSession' && !value?.isValid()) throw new Error('Your session has expired. Please sign in again.')
    return value
}
