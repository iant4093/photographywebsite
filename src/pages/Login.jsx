import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/authContext'
import { Turnstile } from '@marsidev/react-turnstile'
import { motion } from 'framer-motion'

// Login page — email + password only, no sign-up
function Login() {
    const { login, user, isAdmin } = useAuth()
    const navigate = useNavigate()
    const turnstileRef = useRef()

    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [turnstileToken, setTurnstileToken] = useState(null)

    // Redirect if already logged in — admin goes to /admin, user goes to /dashboard
    useEffect(() => {
        if (user) navigate(isAdmin ? '/admin' : '/dashboard', { replace: true })
    }, [user, isAdmin, navigate])

    // Handle form submission
    async function handleSubmit(e) {
        e.preventDefault()
        setError('')

        if (!turnstileToken) {
            setError('Please verify you are human before logging in.')
            return
        }

        setSubmitting(true)

        try {
            await login(email, password, turnstileToken)
            // useEffect will handle role-based redirect
        } catch (err) {
            if (err.code === 'NewPasswordRequired') {
                setError('A new password is required. Please contact the administrator.')
            } else if (err.code === 'NotAuthorizedException') {
                setError('Incorrect email or password.')
            } else if (err.code === 'UserNotFoundException') {
                setError('No account found with that email.')
            } else {
                setError(err.message || 'An error occurred. Please try again.')
            }
            // Reset Turnstile on error so a new token can be generated
            turnstileRef.current?.reset()
            setTurnstileToken(null)
        } finally {
            setSubmitting(false)
        }
    }

    const pageVariants = {
        initial: { opacity: 0, y: 15 },
        animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
        exit: { opacity: 0, y: -15, transition: { duration: 0.3, ease: "easeIn" } }
    }

    return (
        <motion.div
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="min-h-[80vh] flex items-center justify-center px-6 py-12 pt-[88px] md:pt-[104px]"
        >
            <div className="w-full max-w-md">
                {/* Header */}
                <div className="text-center mb-8">
                    <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-amber to-amber-dark flex items-center justify-center shadow-warm-lg mb-6">
                        <svg className="w-8 h-8 text-cream" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                    </div>
                    <h1 className="font-serif text-3xl font-semibold text-charcoal">
                        Welcome Back
                    </h1>
                    <p className="mt-2 text-warm-gray">
                        Sign in to access your account.
                    </p>
                </div>

                {/* Login form */}
                <form
                    onSubmit={handleSubmit}
                    className="bg-white rounded-2xl p-8 shadow-warm-lg border border-warm-border"
                >
                    {/* Error message */}
                    {error && (
                        <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
                            {error}
                        </div>
                    )}

                    {/* Email field */}
                    <div className="relative mb-5">
                        <input
                            id="email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            autoComplete="email"
                            className="peer w-full px-4 pt-6 pb-2 mt-1 rounded-xl border border-warm-border bg-cream/50 text-charcoal placeholder-transparent focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                            placeholder="Email"
                        />
                        <label
                            htmlFor="email"
                            className="absolute left-4 top-1.5 text-xs font-medium text-warm-gray transition-all peer-placeholder-shown:top-4 peer-placeholder-shown:text-base peer-placeholder-shown:text-warm-gray/50 peer-focus:top-1.5 peer-focus:text-xs peer-focus:text-amber cursor-text pointer-events-none"
                        >
                            Email
                        </label>
                    </div>

                    {/* Password field */}
                    <div className="relative mb-6">
                        <input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            autoComplete="current-password"
                            className="peer w-full px-4 pt-6 pb-2 mt-1 rounded-xl border border-warm-border bg-cream/50 text-charcoal placeholder-transparent focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                            placeholder="Password"
                        />
                        <label
                            htmlFor="password"
                            className="absolute left-4 top-1.5 text-xs font-medium text-warm-gray transition-all peer-placeholder-shown:top-4 peer-placeholder-shown:text-base peer-placeholder-shown:text-warm-gray/50 peer-focus:top-1.5 peer-focus:text-xs peer-focus:text-amber cursor-text pointer-events-none"
                        >
                            Password
                        </label>
                    </div>

                    <div className="mb-6 flex justify-center">
                        <Turnstile
                            ref={turnstileRef}
                            siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
                            onSuccess={(token) => setTurnstileToken(token)}
                            options={{ theme: 'light' }}
                        />
                    </div>

                    {/* Submit button */}
                    <button
                        type="submit"
                        disabled={submitting}
                        className="w-full py-3 rounded-xl bg-gradient-to-r from-amber to-amber-dark text-white font-semibold hover:from-amber-dark hover:to-amber-dark transition-all duration-300 shadow-warm hover:shadow-warm-lg disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                    >
                        {submitting ? (
                            <span className="flex items-center justify-center gap-2">
                                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                Signing in…
                            </span>
                        ) : (
                            'Log In'
                        )}
                    </button>
                </form>
            </div>
        </motion.div>
    )
}

export default Login
