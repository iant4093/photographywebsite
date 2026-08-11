import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiCache = vi.hoisted(() => ({ clearApiCache: vi.fn(), clearCatalogSnapshots: vi.fn() }))
const cognito = vi.hoisted(() => ({
  currentUser: null,
  pools: [],
  users: [],
  sessions: [],
  userData: { UserMFASettingList: [] },
  secret: 'ABCDEF234567',
  userDataError: null,
  associateError: null,
  verifyError: null,
  preferenceError: null,
  globalSignOutError: null,
}))

vi.mock('../utils/api', () => ({ clearApiCache: apiCache.clearApiCache }))
vi.mock('../utils/catalogState', () => ({ clearCatalogSnapshots: apiCache.clearCatalogSnapshots }))
vi.mock('amazon-cognito-identity-js', () => {
  class Token {
    constructor(value) { this.value = Object.values(value)[0] }
    getJwtToken() { return this.value }
  }
  class CognitoUserSession {
    constructor(tokens) { this.tokens = tokens; cognito.sessions.push(this) }
    getIdToken() { return this.tokens.IdToken }
    getAccessToken() { return this.tokens.AccessToken }
    isValid() { return true }
  }
  class CognitoUserPool {
    constructor(options) { this.options = options; cognito.pools.push(this) }
    getCurrentUser() { return cognito.currentUser }
  }
  class CognitoUser {
    constructor(options) {
      this.options = options
      this.setSignInUserSession = vi.fn((session) => { this.session = session })
      this.getSession = vi.fn((callback) => callback(null, this.session))
      this.getUserData = vi.fn((callback) => callback(cognito.userDataError, cognito.userData))
      this.associateSoftwareToken = vi.fn((callbacks) => (
        cognito.associateError ? callbacks.onFailure(cognito.associateError) : callbacks.associateSecretCode(cognito.secret)
      ))
      this.verifySoftwareToken = vi.fn((code, name, callbacks) => (
        cognito.verifyError ? callbacks.onFailure(cognito.verifyError) : callbacks.onSuccess({ Status: 'SUCCESS' })
      ))
      this.setUserMfaPreference = vi.fn((sms, software, callback) => callback(cognito.preferenceError, cognito.preferenceError ? null : 'SUCCESS'))
      this.globalSignOut = vi.fn((callbacks) => (
        cognito.globalSignOutError ? callbacks.onFailure(cognito.globalSignOutError) : callbacks.onSuccess('SUCCESS')
      ))
      this.signOut = vi.fn()
      cognito.users.push(this)
    }
  }
  return {
    CognitoIdToken: Token,
    CognitoAccessToken: Token,
    CognitoRefreshToken: Token,
    CognitoUserSession,
    CognitoUserPool,
    CognitoUser,
  }
})

import { useState } from 'react'
import { useAuth } from './auth'
import { AuthProvider } from './authContext'

function jwt(payload) {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${encoded}.signature`
}

function response(body, status = 200, brokenJson = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: brokenJson ? vi.fn().mockRejectedValue(new Error('bad json')) : vi.fn().mockResolvedValue(body),
  }
}

function Harness() {
  const auth = useAuth()
  const [result, setResult] = useState('')
  const invoke = (promise) => promise.then((value) => setResult(typeof value === 'string' ? value : value?.challengeName || 'ok')).catch((error) => setResult(`${error.code || ''}:${error.message}`))
  return <div>
    <span data-testid="state">{auth.loading ? 'loading' : 'ready'}|{auth.userEmail}|{auth.isAdmin ? 'admin' : 'viewer'}|{auth.user ? 'signed' : 'out'}|{auth.adminMfaStatus}</span>
    <span data-testid="result">{result}</span>
    <button onClick={() => invoke(auth.login('viewer@example.com', 'Password1!', 'turn'))}>login</button>
    <button onClick={() => invoke(auth.completeNewPassword({ email: 'viewer@example.com', newPassword: 'NewPassword1!', challengeSession: 'session', turnstileToken: 'turn' }))}>new-password</button>
    <button onClick={() => invoke(auth.completeMfa({ email: 'viewer@example.com', code: '123456', challengeSession: 'session', turnstileToken: 'turn' }))}>mfa</button>
    <button onClick={() => invoke(auth.beginAdminMfaSetup())}>begin-mfa-setup</button>
    <button onClick={() => invoke(auth.completeAdminMfaSetup('123456'))}>complete-mfa-setup</button>
    <button onClick={() => invoke(auth.refreshAdminMfaStatus())}>refresh-mfa-status</button>
    <button onClick={() => invoke(auth.getIdToken())}>token</button>
    <button onClick={auth.logout}>logout</button>
  </div>
}

function mount() {
  return render(<AuthProvider><Harness /></AuthProvider>)
}

const clientStorageKey = `CognitoIdentityServiceProvider.${import.meta.env.VITE_COGNITO_CLIENT_ID}.viewer`

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    localStorage.clear()
    cognito.currentUser = null
    cognito.users.length = 0
    cognito.sessions.length = 0
    cognito.userData = { UserMFASettingList: [] }
    cognito.secret = 'ABCDEF234567'
    cognito.userDataError = null
    cognito.associateError = null
    cognito.verifyError = null
    cognito.preferenceError = null
    cognito.globalSignOutError = null
    vi.stubGlobal('fetch', vi.fn())
  })

  it('migrates an open tab session to persistent storage', async () => {
    sessionStorage.setItem(clientStorageKey, 'open-tab-session')
    mount()
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready||viewer|out'))
    expect(localStorage.getItem(clientStorageKey)).toBe('open-tab-session')
    expect(sessionStorage.getItem(clientStorageKey)).toBeNull()
    expect(cognito.pools.at(-1).options.Storage).toBe(localStorage)
  })

  it('restores a valid browser session and ignores invalid/unavailable users', async () => {
    localStorage.setItem(clientStorageKey, 'present')
    cognito.currentUser = {
      getSession: (callback) => callback(null, {
        isValid: () => true,
        getIdToken: () => ({ getJwtToken: () => jwt({ email: 'admin@example.com', 'cognito:groups': ['Admins'] }) }),
      }),
    }
    const first = mount()
    expect(screen.getByTestId('state')).toHaveTextContent('loading')
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready|admin@example.com|admin|signed'))
    first.unmount()

    cognito.currentUser = { getSession: (callback) => callback(new Error('expired'), null) }
    mount()
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready||viewer|out'))
  })

  it.each([
    [429, 'Too many login attempts', 'LoginFailed'],
    [401, 'Incorrect email or password', 'NotAuthorizedException'],
    [403, 'security check expired', 'LoginFailed'],
    [500, 'temporarily unavailable', 'LoginFailed'],
  ])('maps login HTTP %i safely', async (status, message, code) => {
    fetch.mockResolvedValueOnce(response({}, status))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'login' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent(`${code}:`))
    expect(screen.getByTestId('result')).toHaveTextContent(message)
  })

  it('returns supported login challenges and rejects incomplete/broken responses', async () => {
    fetch
      .mockResolvedValueOnce(response({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's', ChallengeParameters: { required: true } }))
      .mockResolvedValueOnce(response({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'm' }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({}, 503, true))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'login' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('NEW_PASSWORD_REQUIRED'))
    fireEvent.click(screen.getByRole('button', { name: 'login' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('SOFTWARE_TOKEN_MFA'))
    fireEvent.click(screen.getByRole('button', { name: 'login' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('response was incomplete'))
    fireEvent.click(screen.getByRole('button', { name: 'login' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('temporarily unavailable'))
  })

  it('establishes a Cognito session, decodes claims, and handles malformed JWT claims', async () => {
    fetch
      .mockResolvedValueOnce(response({ AuthenticationResult: { IdToken: jwt({ email: 'viewer@example.com', 'cognito:groups': [] }), AccessToken: 'access', RefreshToken: 'refresh' } }))
      .mockResolvedValueOnce(response({ AuthenticationResult: { IdToken: 'invalid', AccessToken: 'access', RefreshToken: 'refresh' } }))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'login' }))
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('viewer@example.com|viewer|signed'))
    expect(cognito.users.at(-1).setSignInUserSession).toHaveBeenCalled()
    expect(cognito.users.at(-1).options.Storage).toBe(localStorage)
    fireEvent.click(screen.getByRole('button', { name: 'login' }))
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready||viewer|signed'))
  })

  it('handles new-password challenge, validation failures, and successful session establishment', async () => {
    fetch
      .mockResolvedValueOnce(response({}, 400))
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'next' }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ AuthenticationResult: { IdToken: jwt({ email: 'new@example.com' }), AccessToken: 'a', RefreshToken: 'r' } }))
    mount()
    for (const expected of ['stronger password', 'temporarily unavailable', 'SOFTWARE_TOKEN_MFA', 'response was incomplete', 'ok']) {
      fireEvent.click(screen.getByRole('button', { name: 'new-password' }))
      await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent(expected))
    }
    expect(screen.getByTestId('state')).toHaveTextContent('new@example.com|viewer|signed')
  })

  it('handles MFA errors, incomplete responses, and success', async () => {
    fetch
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ AuthenticationResult: { IdToken: jwt({ email: 'mfa@example.com', 'cognito:groups': ['Admins'] }), AccessToken: 'a', RefreshToken: 'r' } }))
    mount()
    for (const expected of ['verification code was not accepted', 'temporarily unavailable', 'response was incomplete', 'ok']) {
      fireEvent.click(screen.getByRole('button', { name: 'mfa' }))
      await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent(expected))
    }
    expect(screen.getByTestId('state')).toHaveTextContent('mfa@example.com|admin|signed')
  })

  it('requires and completes authenticator enrollment for an admin account', async () => {
    fetch.mockResolvedValueOnce(response({
      AuthenticationResult: {
        IdToken: jwt({ email: 'admin@example.com', 'cognito:groups': ['Admins'] }),
        AccessToken: 'access',
        RefreshToken: 'refresh',
      },
    }))
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'login' }))
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('admin@example.com|admin|signed|required'))

    fireEvent.click(screen.getByRole('button', { name: 'begin-mfa-setup' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('ABCDEF234567'))

    fireEvent.click(screen.getByRole('button', { name: 'complete-mfa-setup' }))
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready||viewer|out|not-required'))
    const adminUser = cognito.users.at(-1)
    expect(adminUser.verifySoftwareToken).toHaveBeenCalledWith('123456', 'Ian Truong Photography admin', expect.any(Object))
    expect(adminUser.setUserMfaPreference).toHaveBeenCalledWith(null, { Enabled: true, PreferredMfa: true }, expect.any(Function))
    expect(adminUser.globalSignOut).toHaveBeenCalled()
  })

  it('recognizes an existing software-token factor and fails closed on status errors', async () => {
    cognito.userData = { UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }
    fetch.mockResolvedValueOnce(response({
      AuthenticationResult: {
        IdToken: jwt({ email: 'admin@example.com', 'cognito:groups': ['Admins'] }),
        AccessToken: 'access',
        RefreshToken: 'refresh',
      },
    }))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'login' }))
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('admin@example.com|admin|signed|enabled'))

    cognito.userDataError = new Error('unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'refresh-mfa-status' }))
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('admin@example.com|admin|signed|error'))
  })

  it('rejects enrollment helpers for non-admin users', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'begin-mfa-setup' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('Administrator access is required'))
    fireEvent.click(screen.getByRole('button', { name: 'complete-mfa-setup' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('Administrator access is required'))
  })

  it('validates current sessions, returns a token, and logs out defensively', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'token' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('No active user session'))

    localStorage.setItem(clientStorageKey, 'present')
    cognito.currentUser = null
    fireEvent.click(screen.getByRole('button', { name: 'token' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('No active user session'))

    cognito.currentUser = { getSession: (callback) => callback(null, { isValid: () => false }) }
    fireEvent.click(screen.getByRole('button', { name: 'token' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('session has expired'))

    const signOut = vi.fn()
    cognito.currentUser = {
      getSession: (callback) => callback(null, { isValid: () => true, getIdToken: () => ({ getJwtToken: () => 'valid-token' }) }),
      signOut,
    }
    fireEvent.click(screen.getByRole('button', { name: 'token' }))
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('ok'))
    fireEvent.click(screen.getByRole('button', { name: 'logout' }))
    expect(apiCache.clearApiCache).toHaveBeenCalled()
    expect(apiCache.clearCatalogSnapshots).toHaveBeenCalled()
    expect(localStorage.getItem(clientStorageKey)).toBeNull()
    expect(sessionStorage.getItem(clientStorageKey)).toBeNull()
    await waitFor(() => expect(signOut).toHaveBeenCalled())
  })
})
