import { useCallback, useEffect, useMemo, useState } from 'react'
import { clearApiCache } from '../utils/api'
import { clearCatalogSnapshots } from '../utils/catalogState'
import { AuthContext } from './auth'

const POOL_DATA = {
    UserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
    ClientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
}

const isCognitoConfigured = Boolean(
    POOL_DATA.UserPoolId
    && POOL_DATA.ClientId
    && !POOL_DATA.UserPoolId.includes('PLACEHOLDER')
    && !POOL_DATA.ClientId.includes('PLACEHOLDER')
)

const storagePrefix = `CognitoIdentityServiceProvider.${POOL_DATA.ClientId}`
let cognitoModulePromise
let userPoolPromise

function loadCognitoModule() {
    if (!cognitoModulePromise) {
        cognitoModulePromise = import('amazon-cognito-identity-js')
    }
    return cognitoModulePromise
}

async function getUserPool() {
    if (!isCognitoConfigured || typeof window === 'undefined') return null
    if (!userPoolPromise) {
        userPoolPromise = loadCognitoModule().then(({ CognitoUserPool }) => (
            new CognitoUserPool({ ...POOL_DATA, Storage: window.sessionStorage })
        ))
    }
    return userPoolPromise
}

function hasSessionCredentials() {
    if (typeof window === 'undefined') return false
    return Object.keys(window.sessionStorage).some((key) => key.startsWith(storagePrefix))
}

function removeLegacyPersistentCredentials() {
    if (typeof window === 'undefined') return
    Object.keys(window.localStorage)
        .filter((key) => key.startsWith(storagePrefix))
        .forEach((key) => window.localStorage.removeItem(key))
}

function decodeJwt(token) {
    try {
        const encoded = token.split('.')[1]
        const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
        return JSON.parse(window.atob(padded))
    } catch {
        return {}
    }
}

function safeLoginError(status) {
    if (status === 429) return 'Too many login attempts. Please wait and try again.'
    if (status === 401) return 'Incorrect email or password.'
    if (status === 403) return 'The security check expired. Please try again.'
    return 'Sign in is temporarily unavailable. Please try again.'
}

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null)
    const [loading, setLoading] = useState(() => isCognitoConfigured && hasSessionCredentials())
    const [isAdmin, setIsAdmin] = useState(false)
    const [userEmail, setUserEmail] = useState('')

    const extractUserInfo = useCallback((session) => {
        const claims = decodeJwt(session.getIdToken().getJwtToken())
        setIsAdmin((claims['cognito:groups'] || []).includes('Admins'))
        setUserEmail(claims.email || '')
    }, [])

    useEffect(() => {
        let active = true
        removeLegacyPersistentCredentials()

        if (!isCognitoConfigured || !hasSessionCredentials()) {
            return () => { active = false }
        }

        getUserPool()
            .then((pool) => {
                const cognitoUser = pool?.getCurrentUser()
                if (!cognitoUser || !active) return null
                return new Promise((resolve) => {
                    cognitoUser.getSession((error, session) => {
                        if (active && !error && session?.isValid()) {
                            setUser(cognitoUser)
                            extractUserInfo(session)
                        }
                        resolve()
                    })
                })
            })
            .catch(() => {
                // Treat unreadable/expired browser state as signed out.
            })
            .finally(() => {
                if (active) setLoading(false)
            })

        return () => { active = false }
    }, [extractUserInfo])

    const establishSession = useCallback(async (email, authResult) => {
        const [pool, cognito] = await Promise.all([getUserPool(), loadCognitoModule()])
        if (!pool) throw new Error('Authentication is not configured.')

        const idToken = new cognito.CognitoIdToken({ IdToken: authResult.IdToken })
        const accessToken = new cognito.CognitoAccessToken({ AccessToken: authResult.AccessToken })
        const refreshToken = new cognito.CognitoRefreshToken({ RefreshToken: authResult.RefreshToken })
        const session = new cognito.CognitoUserSession({
            IdToken: idToken,
            AccessToken: accessToken,
            RefreshToken: refreshToken,
        })
        const cognitoUser = new cognito.CognitoUser({
            Username: email,
            Pool: pool,
            Storage: window.sessionStorage,
        })

        cognitoUser.setSignInUserSession(session)
        setUser(cognitoUser)
        extractUserInfo(session)
        return session
    }, [extractUserInfo])

    const login = useCallback(async (email, password, turnstileToken) => {
        if (!isCognitoConfigured) throw new Error('Authentication is not configured.')
        const apiBase = import.meta.env.VITE_API_BASE_URL || '/api'
        const response = await fetch(`${apiBase}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, turnstileToken }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
            const error = new Error(safeLoginError(response.status))
            error.code = response.status === 401 ? 'NotAuthorizedException' : 'LoginFailed'
            throw error
        }

        if (['NEW_PASSWORD_REQUIRED', 'SOFTWARE_TOKEN_MFA'].includes(data.ChallengeName)) {
            return {
                challengeName: data.ChallengeName,
                challengeSession: data.Session,
                challengeParameters: data.ChallengeParameters || {},
            }
        }
        if (!data.AuthenticationResult) throw new Error('The sign-in response was incomplete.')
        return establishSession(email, data.AuthenticationResult)
    }, [establishSession])

    const completeNewPassword = useCallback(async ({ email, newPassword, challengeSession, turnstileToken }) => {
        const apiBase = import.meta.env.VITE_API_BASE_URL || '/api'
        const response = await fetch(`${apiBase}/login/challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, newPassword, session: challengeSession, turnstileToken }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
            throw new Error(response.status === 400
                ? 'Choose a stronger password and try again.'
                : 'Password setup is temporarily unavailable. Please try again.')
        }
        if (data.ChallengeName) {
            return {
                challengeName: data.ChallengeName,
                challengeSession: data.Session,
                challengeParameters: data.ChallengeParameters || {},
            }
        }
        if (!data.AuthenticationResult) throw new Error('The sign-in response was incomplete.')
        return establishSession(email, data.AuthenticationResult)
    }, [establishSession])

    const completeMfa = useCallback(async ({ email, code, challengeSession, turnstileToken }) => {
        const apiBase = import.meta.env.VITE_API_BASE_URL || '/api'
        const response = await fetch(`${apiBase}/login/challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                challengeName: 'SOFTWARE_TOKEN_MFA',
                code,
                session: challengeSession,
                turnstileToken,
            }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
            throw new Error(response.status === 401 || response.status === 400
                ? 'That verification code was not accepted. Try a fresh code.'
                : 'Verification is temporarily unavailable. Please try again.')
        }
        if (!data.AuthenticationResult) throw new Error('The sign-in response was incomplete.')
        return establishSession(email, data.AuthenticationResult)
    }, [establishSession])

    const logout = useCallback(() => {
        setUser(null)
        setIsAdmin(false)
        setUserEmail('')
        clearApiCache()
        clearCatalogSnapshots()
        getUserPool()
            .then((pool) => pool?.getCurrentUser()?.signOut())
            .catch(() => {})
        if (typeof window !== 'undefined') {
            Object.keys(window.sessionStorage)
                .filter((key) => key.startsWith(storagePrefix))
                .forEach((key) => window.sessionStorage.removeItem(key))
        }
    }, [])

    const getIdToken = useCallback(async () => {
        if (!hasSessionCredentials()) throw new Error('No active user session.')
        const pool = await getUserPool()
        const cognitoUser = pool?.getCurrentUser()
        if (!cognitoUser) throw new Error('No active user session.')
        return new Promise((resolve, reject) => {
            cognitoUser.getSession((error, session) => {
                if (error || !session?.isValid()) {
                    reject(new Error('Your session has expired. Please sign in again.'))
                    return
                }
                resolve(session.getIdToken().getJwtToken())
            })
        })
    }, [])

    const value = useMemo(() => ({
        user,
        loading,
        isAdmin,
        userEmail,
        login,
        completeNewPassword,
        completeMfa,
        logout,
        getIdToken,
    }), [completeMfa, completeNewPassword, getIdToken, isAdmin, loading, login, logout, user, userEmail])

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
