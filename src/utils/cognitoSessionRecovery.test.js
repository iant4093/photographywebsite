import { expect, it, vi } from 'vitest'
import { CognitoUserPool, CognitoUser, CognitoUserSession, CognitoIdToken, CognitoAccessToken, CognitoRefreshToken } from 'amazon-cognito-identity-js'
import { cognitoOperation, readAccount } from './cognitoOperation'
import { beginMfaSetup, completeMfaSetup } from './authActions'

function account(expired = false) {
    const values = new Map()
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), clear: () => values.clear() }
    const pool = new CognitoUserPool({ UserPoolId: 'us-west-2_test', ClientId: 'synthetic-client', Storage: storage })
    const token = stale => {
        const now = Math.floor(Date.now() / 1000)
        return [btoa('{"alg":"none"}'), btoa(JSON.stringify({ sub: 'synthetic', iat: now - 3600, exp: now + (stale ? -60 : 3600) })), 'synthetic'].join('.')
    }
    const user = new CognitoUser({ Username: 'synthetic@example.test', Pool: pool, Storage: storage })
    user.setSignInUserSession(new CognitoUserSession({ IdToken: new CognitoIdToken({ IdToken: token(expired) }), AccessToken: new CognitoAccessToken({ AccessToken: token(expired) }), RefreshToken: new CognitoRefreshToken({ RefreshToken: 'synthetic-refresh' }), ClockDrift: 0 }))
    return { user, restored: pool.getCurrentUser(), fresh: { AuthenticationResult: { IdToken: token(false), AccessToken: token(false) } }, values }
}

it.each([false, true])('keeps real SDK restored/refreshed session for subsequent account and MFA requests (expired=%s)', async expired => {
    const { restored, fresh } = account(expired)
    expect(restored.signInUserSession).toBeNull()
    restored.client.requestWithRetry = vi.fn((_op, _args, done) => done(null, fresh))
    restored.client.request = vi.fn((operation, args, done) => {
        expect(args.AccessToken).toBeTruthy()
        done(null, operation === 'GetUser' ? { UserMFASettingList: [] } : { SecretCode: 'synthetic-secret', Status: 'SUCCESS' })
    })
    const session = await readAccount(restored, 'getSession')
    expect(session.isValid()).toBe(true)
    expect(restored.signInUserSession).toBe(session)
    expect(restored.client.requestWithRetry).toHaveBeenCalledTimes(expired ? 1 : 0)
    await expect(readAccount(restored, 'getUserData')).resolves.toMatchObject({ UserMFASettingList: [] })
    await expect(beginMfaSetup(restored, () => {})).resolves.toBe('synthetic-secret')
    await expect(completeMfaSetup(restored, '123456', () => {})).resolves.toEqual({ globallySignedOut: true })
    restored.signOut()
    expect(restored.signInUserSession).toBeNull()
    expect(restored.client.request.mock.calls.map(call => call[0])).toEqual(['GetUser', 'GetUser', 'AssociateSoftwareToken', 'GetUser', 'VerifySoftwareToken', 'SetUserMFAPreference', 'GlobalSignOut'])
    // Bypassing cached account data also refreshes tokens in the real SDK.
    expect(restored.client.requestWithRetry).toHaveBeenCalledTimes(expired ? 3 : 2)
})

it('drops a real SDK refresh after logout/new-login generation changes', async () => {
    const { restored, fresh, values } = account(true)
    let reply, stale = false
    restored.client.requestWithRetry = (_op, _args, done) => { reply = done }
    const result = readAccount(restored, 'getSession', () => { if (stale) throw new Error('Session changed') })
    stale = true
    values.clear()
    reply(null, fresh)
    await expect(result).rejects.toThrow('Session changed')
    expect(restored.signInUserSession).toBeNull()
    expect(values.size).toBe(0)
})

it('never promotes failed or cancelled SDK state', async () => {
    const user = { signInUserSession: null }
    await expect(cognitoOperation(user, (scoped, done) => { scoped.signInUserSession = {}; done(new Error('failed')) })).rejects.toThrow('failed')
    const controller = new AbortController()
    let reply
    const result = cognitoOperation(user, (scoped, done) => { scoped.signInUserSession = {}; reply = done }, { signal: controller.signal })
    controller.abort()
    reply(null, {})
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(user.signInUserSession).toBeNull()
})
