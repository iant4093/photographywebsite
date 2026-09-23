import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cognitoOperation } from './cognitoOperation'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('bounds stalled callbacks, aborts transport, and drops late SDK storage/token changes', async () => {
    let providerReply, scoped
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() }
    const client = { fetchOptions: { mode: 'cors' }, request: vi.fn((_op, _args, done) => { providerReply = done }) }
    const user = { storage, client, getSession(done) { this.client.request('InitiateAuth', {}, (_error, value) => { this.storage.setItem('token', value); done(null, value) }) } }
    const result = cognitoOperation(user, (copy, done) => { scoped = copy; copy.getSession(done) }, { timeoutMs: 10 }).catch(error => error)
    expect(client.fetchOptions.signal).toBeUndefined()
    await vi.advanceTimersByTimeAsync(10)
    expect((await result).message).toMatch(/timed out/)
    expect(scoped.client.fetchOptions.signal.aborted).toBe(true)
    providerReply(null, 'stale-token')
    scoped.storage.removeItem('token'); scoped.storage.clear()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(storage.clear).not.toHaveBeenCalled()
})

it('allows current SDK reads/writes and bounds requestWithRetry on an isolated client', async () => {
    const storage = { setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() }
    const client = {
        request(_op, _params, callback) { callback(null, 'valid') },
        requestWithRetry(op, params, callback) { this.request(op, params, callback) },
    }
    const result = await cognitoOperation({ storage, client }, (scoped, done) => {
        scoped.client.requestWithRetry('GetUser', {}, (error, value) => {
            scoped.storage.setItem('token', value); scoped.storage.removeItem('old'); scoped.storage.clear()
            done(error, value)
        })
    })
    expect(result).toBe('valid')
    expect(storage.setItem).toHaveBeenCalledWith('token', 'valid')
    expect(storage.removeItem).toHaveBeenCalledWith('old')
    expect(storage.clear).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
})

it('rejects cancellation before/after starting without replaying the operation', async () => {
    const controller = new AbortController()
    const start = vi.fn()
    const first = cognitoOperation({}, start, { signal: controller.signal }).catch(error => error)
    controller.abort()
    expect((await first).name).toBe('AbortError')
    await expect(cognitoOperation({}, start, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(start).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
})

it('checks session generation before dispatch and before late provider mutations', async () => {
    let stale = false, callback
    const assertCurrent = () => { if (stale) throw new Error('Session changed') }
    const client = { request(_op, _params, done) { callback = done } }
    const touched = vi.fn()
    const result = cognitoOperation({ client }, (scoped, done) => scoped.client.request('GetUser', {}, (error, value) => { touched(); done(error, value) }), { assertCurrent }).catch(error => error)
    stale = true; callback(null, {})
    expect((await result).message).toBe('Session changed')
    expect(touched).not.toHaveBeenCalled()
    await expect(cognitoOperation({}, touched, { assertCurrent })).rejects.toThrow('Session changed')
    expect(touched).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
})

it('handles synchronous errors and provider failures without leaking deadlines', async () => {
    await expect(cognitoOperation({}, () => { throw new Error('broken') })).rejects.toThrow('broken')
    await expect(cognitoOperation({}, (_user, done) => done(new Error('provider')))).rejects.toThrow('provider')
    expect(vi.getTimerCount()).toBe(0)
})

it('bounds account read helpers and rejects an expired session', async () => {
    const { readAccount } = await import('./cognitoOperation')
    await expect(readAccount({ getSession: done => done(null, { isValid: () => false }) }, 'getSession')).rejects.toThrow('session has expired')
    await expect(readAccount({ getUserData: (done, options) => { expect(options.bypassCache).toBe(true); done(null, { current: true }) } }, 'getUserData')).resolves.toEqual({ current: true })
    const stalled = readAccount({ getUserData() {} }, 'getUserData').catch(error => error)
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await stalled).message).toMatch(/timed out/)
})
