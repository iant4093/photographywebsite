import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clearApiCache } from '../utils/api'
import { clearCatalogSnapshots } from '../utils/catalogState'
import { AuthContext } from './auth'
import { persistentStorage, tabStorage, rawStorage } from '../utils/browserStorage'

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
const sessionChangeKey = `ian:auth-session:${POOL_DATA.ClientId}`
let cognitoModulePromise
let userPoolPromise
let loadedUserPool

function cognitoStorageKeys(storage) {
    if (!storage) return []
    return storage.keys().filter((key) => key.startsWith(storagePrefix))
}

function clearCognitoCredentials(storage) {
    cognitoStorageKeys(storage).forEach((key) => storage.removeItem(key))
}

function migrateTabSessionToPersistentStorage() {
    if (typeof window === 'undefined') return
    const sessionKeys = cognitoStorageKeys(tabStorage)
    sessionKeys.forEach((key) => {
        if (persistentStorage.getItem(key) === null) {
            persistentStorage.setItem(key, tabStorage.getItem(key))
        }
    })
    clearCognitoCredentials(tabStorage)
}

function loadCognitoModule() {
    if (!cognitoModulePromise) {
        cognitoModulePromise = import('amazon-cognito-identity-js')
    }
    return cognitoModulePromise
}

async function getUserPool() {
    if (!isCognitoConfigured || typeof window === 'undefined') return null
    if (!userPoolPromise) {
        userPoolPromise = loadCognitoModule().then(({ CognitoUserPool }) => {
            loadedUserPool = new CognitoUserPool({ ...POOL_DATA, Storage: persistentStorage })
            return loadedUserPool
        })
    }
    return userPoolPromise
}

function hasPersistentCredentials() {
    if (typeof window === 'undefined') return false
    return cognitoStorageKeys(persistentStorage).length > 0
}

function hasRestorableCredentials() {
    if (typeof window === 'undefined') return false
    return hasPersistentCredentials() || cognitoStorageKeys(tabStorage).length > 0
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

function persistentIdentity() {
    if (typeof window === 'undefined') return ''
    const username = persistentStorage.getItem(`${storagePrefix}.LastAuthUser`)
    if (!username) return ''
    const token = persistentStorage.getItem(`${storagePrefix}.${username}.idToken`)
    if (!token) return ''
    const claims = decodeJwt(token)
    return JSON.stringify([username, claims.iss, claims.sub])
}

function publishSessionChange() {
    // Only a notification nonce is shared; credentials stay in Cognito storage.
    const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
    try { persistentStorage.setItem(sessionChangeKey, nonce); return nonce } catch { return null }
}


function getFreshUserData(cognitoUser) {
    return new Promise((resolve, reject) => {
        cognitoUser.getUserData((error, data) => {
            if (error) reject(error)
            else resolve(data || {})
        }, { bypassCache: true })
    })
}

function ensureValidSession(cognitoUser) {
    return new Promise((resolve, reject) => {
        cognitoUser.getSession((error, session) => {
            if (error || !session?.isValid()) {
                reject(new Error('Your session has expired. Please sign in again.'))
                return
            }
            resolve(session)
        })
    })
}

function hasSoftwareTokenMfa(data) {
    return (data?.UserMFASettingList || []).includes('SOFTWARE_TOKEN_MFA')
}

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null)
    const [loading, setLoading] = useState(() => isCognitoConfigured && hasRestorableCredentials())
    const [isAdmin, setIsAdmin] = useState(false)
    const [userEmail, setUserEmail] = useState('')
    const [adminMfaStatus, setAdminMfaStatus] = useState('not-required')
    const sessionGeneration = useRef(0)
    const sessionIdentity = useRef('')
    const sessionNonce = useRef(persistentStorage.getItem(sessionChangeKey))

    const assertCurrentSession = useCallback((generation) => {
        if (generation !== sessionGeneration.current || sessionNonce.current !== persistentStorage.getItem(sessionChangeKey)) {
            throw new Error('Your session changed. Please try again.')
        }
    }, [])

    const clearSessionState = useCallback(() => {
        sessionGeneration.current += 1
        setUser(null)
        setIsAdmin(false)
        setUserEmail('')
        setAdminMfaStatus('not-required')
        setLoading(false)
        clearApiCache({ sessionChanged: true })
        clearCatalogSnapshots()
        return sessionGeneration.current
    }, [])

    const extractUserInfo = useCallback((session) => {
        const claims = decodeJwt(session.getIdToken().getJwtToken())
        const admin = (claims['cognito:groups'] || []).includes('Admins')
        setIsAdmin(admin)
        setUserEmail(claims.email || '')
        return { admin, email: claims.email || '' }
    }, [])

    useEffect(() => {
        let active = true
        try { migrateTabSessionToPersistentStorage() } catch { /* Public browsing does not require storage. */ }
        sessionIdentity.current = persistentIdentity()
        sessionNonce.current = persistentStorage.getItem(sessionChangeKey)

        const restore = async (generation) => {
            const identity = sessionIdentity.current
            const current = () => active && generation === sessionGeneration.current
                && identity === persistentIdentity() && sessionNonce.current === persistentStorage.getItem(sessionChangeKey)
            try {
                if (!isCognitoConfigured || !hasPersistentCredentials()) return
                const pool = await getUserPool()
                if (!current()) return
                const cognitoUser = pool?.getCurrentUser()
                if (!cognitoUser) return
                const session = await ensureValidSession(cognitoUser)
                if (!current()) return
                setUser(cognitoUser)
                const { admin } = extractUserInfo(session)
                setAdminMfaStatus(admin ? 'checking' : 'not-required')
                if (admin) {
                    try {
                        const data = await getFreshUserData(cognitoUser)
                        if (current()) setAdminMfaStatus(hasSoftwareTokenMfa(data) ? 'enabled' : 'required')
                    } catch {
                        if (current()) setAdminMfaStatus('error')
                    }
                }
            } catch {
                // Treat unreadable/expired browser state as signed out.
            } finally {
                if (current()) setLoading(false)
            }
        }

        const synchronize = (event) => {
            if (event.storageArea !== rawStorage('localStorage')) return
            if (event.key !== null && event.key !== sessionChangeKey && !event.key.startsWith(`${storagePrefix}.`)) return
            const nextIdentity = persistentIdentity()
            const nextNonce = persistentStorage.getItem(sessionChangeKey)
            if (event.key !== null && nextIdentity === sessionIdentity.current && nextNonce === sessionNonce.current) return
            sessionIdentity.current = nextIdentity
            sessionNonce.current = nextNonce
            const generation = clearSessionState()
            clearCognitoCredentials(tabStorage)
            if (nextIdentity) {
                setLoading(true)
                void restore(generation)
            }
        }
        window.addEventListener('storage', synchronize)
        void restore(sessionGeneration.current)
        return () => {
            active = false
            sessionGeneration.current += 1
            window.removeEventListener('storage', synchronize)
        }
    }, [clearSessionState, extractUserInfo])

    const refreshAdminMfaStatus = useCallback(async () => {
        const generation = sessionGeneration.current
        if (!user || !isAdmin) {
            setAdminMfaStatus('not-required')
            return 'not-required'
        }

        await Promise.resolve()
        assertCurrentSession(generation)
        setAdminMfaStatus('checking')
        try {
            await ensureValidSession(user)
            assertCurrentSession(generation)
            const data = await getFreshUserData(user)
            assertCurrentSession(generation)
            const status = hasSoftwareTokenMfa(data) ? 'enabled' : 'required'
            setAdminMfaStatus(status)
            return status
        } catch (error) {
            if (generation === sessionGeneration.current) setAdminMfaStatus('error')
            throw error
        }
    }, [assertCurrentSession, isAdmin, user])

    const beginAdminMfaSetup = useCallback(async () => {
        const generation = sessionGeneration.current
        if (!user || !isAdmin) throw new Error('Administrator access is required.')
        const { beginMfaSetup } = await import('../utils/authActions')
        assertCurrentSession(generation)
        return beginMfaSetup(user, () => assertCurrentSession(generation))
    }, [assertCurrentSession, isAdmin, user])

    const completeAdminMfaSetup = useCallback(async (code) => {
        const generation = sessionGeneration.current
        if (!user || !isAdmin) throw new Error('Administrator access is required.')
        const { completeMfaSetup } = await import('../utils/authActions')
        assertCurrentSession(generation)
        const result = await completeMfaSetup(user, code, () => assertCurrentSession(generation))
        assertCurrentSession(generation)
        clearSessionState()
        clearCognitoCredentials(persistentStorage)
        clearCognitoCredentials(tabStorage)
        sessionIdentity.current = ''
        sessionNonce.current = publishSessionChange()
        return result
    }, [assertCurrentSession, clearSessionState, isAdmin, user])

    const establishSession = useCallback(async (email, authResult, generation) => {
        const [pool, cognito] = await Promise.all([getUserPool(), loadCognitoModule()])
        assertCurrentSession(generation)
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
            Storage: persistentStorage,
        })

        clearApiCache({ sessionChanged: true })
        clearCatalogSnapshots()
        cognitoUser.setSignInUserSession(session)
        sessionIdentity.current = persistentIdentity()
        sessionNonce.current = publishSessionChange()
        const { admin } = extractUserInfo(session)
        setAdminMfaStatus(admin ? 'checking' : 'not-required')
        setUser(cognitoUser)
        if (admin) {
            try {
                const data = await getFreshUserData(cognitoUser)
                assertCurrentSession(generation)
                setAdminMfaStatus(hasSoftwareTokenMfa(data) ? 'enabled' : 'required')
            } catch {
                if (generation === sessionGeneration.current) setAdminMfaStatus('error')
            }
        }
        assertCurrentSession(generation)
        setLoading(false)
        return session
    }, [assertCurrentSession, extractUserInfo])

    const authenticate = useCallback(async (kind, input) => {
        const generation = ++sessionGeneration.current
        setLoading(false)
        if (!isCognitoConfigured) throw new Error('Authentication is not configured.')
        const { requestAuthentication } = await import('../utils/authActions')
        assertCurrentSession(generation)
        const data = await requestAuthentication(kind, input)
        assertCurrentSession(generation)
        if (data.ChallengeName) {
            return {
                challengeName: data.ChallengeName,
                challengeSession: data.Session,
                challengeParameters: data.ChallengeParameters || {},
            }
        }
        return establishSession(input.email, data.AuthenticationResult, generation)
    }, [assertCurrentSession, establishSession])

    const login = useCallback((email, password, turnstileToken) => (
        authenticate('login', { email, password, turnstileToken })
    ), [authenticate])
    const completeNewPassword = useCallback((input) => authenticate('password', input), [authenticate])
    const completeMfa = useCallback((input) => authenticate('mfa', input), [authenticate])

    const logout = useCallback(() => {
        const currentUser = user || loadedUserPool?.getCurrentUser()
        currentUser?.signOut()
        clearSessionState()
        clearCognitoCredentials(persistentStorage)
        clearCognitoCredentials(tabStorage)
        sessionIdentity.current = ''
        sessionNonce.current = publishSessionChange()
    }, [clearSessionState, user])

    const getIdToken = useCallback(async () => {
        const generation = sessionGeneration.current
        const identity = persistentIdentity()
        if (!hasPersistentCredentials()) throw new Error('No active user session.')
        const pool = await getUserPool()
        assertCurrentSession(generation)
        const cognitoUser = pool?.getCurrentUser()
        if (!cognitoUser) throw new Error('No active user session.')
        if (user?.getUsername && cognitoUser.getUsername() !== user.getUsername()) {
            throw new Error('Your session changed. Please try again.')
        }
        const session = await ensureValidSession(cognitoUser)
        assertCurrentSession(generation)
        if (identity !== persistentIdentity()) throw new Error('Your session changed. Please try again.')
        return session.getIdToken().getJwtToken()
    }, [assertCurrentSession, user])

    const value = useMemo(() => ({
        user,
        loading,
        isAdmin,
        userEmail,
        adminMfaStatus,
        login,
        completeNewPassword,
        completeMfa,
        refreshAdminMfaStatus,
        beginAdminMfaSetup,
        completeAdminMfaSetup,
        logout,
        getIdToken,
    }), [
        adminMfaStatus,
        beginAdminMfaSetup,
        completeAdminMfaSetup,
        completeMfa,
        completeNewPassword,
        getIdToken,
        isAdmin,
        loading,
        login,
        logout,
        refreshAdminMfaStatus,
        user,
        userEmail,
    ])

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
