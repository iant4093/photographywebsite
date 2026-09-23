// Loaded when signing in or configuring MFA, alongside the lazy Cognito SDK.
function safeLoginError(status) {
    if (status === 429) return 'Too many login attempts. Please wait and try again.'
    if (status === 401) return 'Incorrect email or password.'
    if (status === 403) return 'The security check expired. Please try again.'
    return 'Sign in is temporarily unavailable. Please try again.'
}

export async function requestAuthentication(kind, input, { timeoutMs = 20_000 } = {}) {
    const { email, turnstileToken, challengeSession } = input
    const login = kind === 'login'
    const body = login ? { email, password: input.password, turnstileToken }
        : kind === 'password' ? { email, newPassword: input.newPassword, session: challengeSession, turnstileToken }
            : { email, challengeName: 'SOFTWARE_TOKEN_MFA', code: input.code, session: challengeSession, turnstileToken }
    const apiBase = import.meta.env.VITE_API_BASE_URL || '/api'
    const controller = new AbortController()
    const cancel = () => controller.abort(new DOMException('Sign in cancelled.', 'AbortError'))
    if (input.signal?.aborted) cancel()
    else input.signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => controller.abort(new Error(safeLoginError(503))), timeoutMs)
    // Keep the deadline around body consumption as well as receiving headers.
    const wait = promise => new Promise((resolve, reject) => {
        const stop = () => reject(controller.signal.reason)
        if (controller.signal.aborted) stop()
        else controller.signal.addEventListener('abort', stop, { once: true })
        Promise.resolve(promise).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', stop))
    })
    let response, data
    try {
        controller.signal.throwIfAborted()
        response = await wait(fetch(`${apiBase}/login${login ? '' : '/challenge'}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            signal: controller.signal,
        }))
        data = await wait(response.json().catch(() => ({})))
        controller.signal.throwIfAborted()
    } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', cancel)
        controller.abort()
    }
    if (!response.ok) {
        if (login) {
            const error = new Error(safeLoginError(response.status))
            error.code = response.status === 401 ? 'NotAuthorizedException' : 'LoginFailed'
            throw error
        }
        if (kind === 'password') {
            throw new Error(response.status === 400
                ? 'Choose a stronger password and try again.'
                : 'Password setup is temporarily unavailable. Please try again.')
        }
        throw new Error(response.status === 401 || response.status === 400
            ? 'That verification code was not accepted. Try a fresh code.'
            : 'Verification is temporarily unavailable. Please try again.')
    }
    const challenge = kind === 'password' ? data.ChallengeName
        : login && ['NEW_PASSWORD_REQUIRED', 'SOFTWARE_TOKEN_MFA'].includes(data.ChallengeName)
    if (challenge) return data
    if (!data.AuthenticationResult) throw new Error('The sign-in response was incomplete.')
    return { AuthenticationResult: data.AuthenticationResult }
}

async function validateSession(user, assertCurrent) {
    await new Promise((resolve, reject) => {
        user.getSession((error, session) => {
            if (error || !session?.isValid()) reject(new Error('Your session has expired. Please sign in again.'))
            else resolve()
        })
    })
    assertCurrent()
}

export async function beginMfaSetup(user, assertCurrent) {
    await validateSession(user, assertCurrent)
    const secret = await new Promise((resolve, reject) => {
        user.associateSoftwareToken({
            associateSecretCode: resolve,
            onFailure: () => reject(new Error('Authenticator setup could not be started. Please try again.')),
        })
    })
    assertCurrent()
    return secret
}

export async function completeMfaSetup(user, code, assertCurrent) {
    if (!/^[0-9]{6}$/.test(code || '')) throw new Error('Enter the 6-digit code from your authenticator app.')
    await validateSession(user, assertCurrent)
    await new Promise((resolve, reject) => {
        user.verifySoftwareToken(code, 'Ian Truong Photography admin', {
            onSuccess: resolve,
            onFailure: () => reject(new Error('That verification code was not accepted. Try a fresh code.')),
        })
    })
    assertCurrent()
    await new Promise((resolve, reject) => {
        user.setUserMfaPreference(null, { Enabled: true, PreferredMfa: true }, (error) => {
            if (error) reject(new Error('Two-factor authentication could not be activated. Please try again.'))
            else resolve()
        })
    })
    assertCurrent()
    let globallySignedOut = true
    await new Promise((resolve) => {
        user.globalSignOut({
            onSuccess: resolve,
            onFailure: () => {
                globallySignedOut = false
                // Do not let a late failure clear a different browser session.
                try { assertCurrent(); user.signOut() } catch { /* Session already changed. */ }
                resolve()
            },
        })
    })
    assertCurrent()
    return { globallySignedOut }
}
