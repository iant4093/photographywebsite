import { createContext, useContext, useState, useEffect } from 'react'
import {
    CognitoUserPool,
    CognitoUser,
    AuthenticationDetails,
    CognitoIdToken,
    CognitoAccessToken,
    CognitoRefreshToken,
    CognitoUserSession,
} from 'amazon-cognito-identity-js'

// Cognito configuration
const POOL_DATA = {
    UserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
    ClientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
}

// Check if Cognito is configured
const isCognitoConfigured = Boolean(
    POOL_DATA.UserPoolId && POOL_DATA.ClientId
    && !POOL_DATA.UserPoolId.includes('PLACEHOLDER')
    && !POOL_DATA.ClientId.includes('PLACEHOLDER')
)

// Initialize User Pool
let userPool = null
if (isCognitoConfigured) {
    try {
        userPool = new CognitoUserPool(POOL_DATA)
    } catch (err) {
        console.warn('Failed to initialize Cognito:', err)
    }
}

// Helper to decode a JWT payload
function decodeJwt(token) {
    try {
        const payload = token.split('.')[1]
        return JSON.parse(atob(payload))
    } catch {
        return {}
    }
}

// Create auth context
const AuthContext = createContext(null)

// Custom hook for consuming auth state
export function useAuth() {
    const context = useContext(AuthContext)
    if (!context) throw new Error('useAuth must be used within an AuthProvider')
    return context
}

// Auth provider wrapping the app
export function AuthProvider({ children }) {
    const [user, setUser] = useState(null)
    const [loading, setLoading] = useState(true)
    const [isAdmin, setIsAdmin] = useState(false)
    const [userEmail, setUserEmail] = useState('')

    // Extract role and email from a Cognito session
    function extractUserInfo(session) {
        const idToken = session.getIdToken().getJwtToken()
        const claims = decodeJwt(idToken)
        const groups = claims['cognito:groups'] || []
        setIsAdmin(groups.includes('Admins'))
        setUserEmail(claims.email || '')
    }

    // On mount, check for existing session
    useEffect(() => {
        if (!userPool) {
            setLoading(false)
            return
        }
        try {
            const cognitoUser = userPool.getCurrentUser()
            if (cognitoUser) {
                cognitoUser.getSession((err, session) => {
                    if (!err && session?.isValid()) {
                        setUser(cognitoUser)
                        extractUserInfo(session)
                    }
                    setLoading(false)
                })
            } else {
                setLoading(false)
            }
        } catch {
            setLoading(false)
        }
    }, [])

    // Log in with email and password via custom secure proxy
    async function login(email, password, turnstileToken) {
        if (!userPool) {
            throw new Error('Cognito is not configured.')
        }

        const API_BASE = import.meta.env.VITE_API_BASE_URL
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, turnstileToken })
        })

        const data = await response.json()
        if (!response.ok) {
            throw new Error(data.error || 'Login failed')
        }

        // The response contains the Cognito AuthenticationResult
        if (data.ChallengeName) {
            // Handle challenges (like NEW_PASSWORD_REQUIRED) if needed
            if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
                const error = new Error('New password required')
                error.code = 'NewPasswordRequired'
                throw error
            }
            throw new Error(`Challenge ${data.ChallengeName} not implemented yet`)
        }

        const authResult = data.AuthenticationResult
        const idToken = new CognitoIdToken({ IdToken: authResult.IdToken })
        const accessToken = new CognitoAccessToken({ AccessToken: authResult.AccessToken })
        const refreshToken = new CognitoRefreshToken({ RefreshToken: authResult.RefreshToken })

        const session = new CognitoUserSession({
            IdToken: idToken,
            AccessToken: accessToken,
            RefreshToken: refreshToken,
        })

        const cognitoUser = new CognitoUser({ Username: email, Pool: userPool })

        // This is CRITICAL: it saves the session to local storage for the SDK
        cognitoUser.setSignInUserSession(session)

        setUser(cognitoUser)
        extractUserInfo(session)

        return session
    }

    // Log out
    function logout() {
        if (!userPool) return
        const cognitoUser = userPool.getCurrentUser()
        if (cognitoUser) cognitoUser.signOut()
        setUser(null)
        setIsAdmin(false)
        setUserEmail('')
    }

    // Get the current ID token for API calls
    function getIdToken() {
        return new Promise((resolve, reject) => {
            if (!userPool) return reject(new Error('Cognito not configured'))
            const cognitoUser = userPool.getCurrentUser()
            if (!cognitoUser) return reject(new Error('No user'))
            cognitoUser.getSession((err, session) => {
                if (err) return reject(err)
                resolve(session.getIdToken().getJwtToken())
            })
        })
    }

    const value = { user, loading, isAdmin, userEmail, login, logout, getIdToken }

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    )
}
