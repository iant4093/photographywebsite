import { createContext, useContext, useState, useEffect } from 'react'
import {
    CognitoUserPool,
    CognitoUser,
    AuthenticationDetails,
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

    // Log in with email and password
    function login(email, password) {
        if (!userPool) {
            return Promise.reject(new Error('Cognito is not configured.'))
        }
        return new Promise((resolve, reject) => {
            const cognitoUser = new CognitoUser({ Username: email, Pool: userPool })
            const authDetails = new AuthenticationDetails({ Username: email, Password: password })

            cognitoUser.authenticateUser(authDetails, {
                onSuccess: (session) => {
                    setUser(cognitoUser)
                    extractUserInfo(session)
                    resolve(session)
                },
                onFailure: (err) => reject(err),
                newPasswordRequired: () => {
                    reject({ code: 'NewPasswordRequired', message: 'You must set a new password.' })
                },
            })
        })
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
