import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/auth'
import { Turnstile } from '@marsidev/react-turnstile'
import { motion as Motion } from 'framer-motion'

// Login page — email + password only, no sign-up
function Login() {
    const { login, completeNewPassword, completeMfa, user, isAdmin } = useAuth()
    const navigate = useNavigate()
    const turnstileRef = useRef()

    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [mfaCode, setMfaCode] = useState('')
    const [challenge, setChallenge] = useState(null)
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
            setError('Please verify you are human before continuing.')
            return
        }

        if (challenge?.challengeName === 'NEW_PASSWORD_REQUIRED' && newPassword !== confirmPassword) {
            setError('The new passwords do not match.')
            return
        }
        if (challenge?.challengeName === 'NEW_PASSWORD_REQUIRED' && (
            newPassword.length < 12
            || newPassword.length > 128
            || !/[A-Z]/.test(newPassword)
            || !/[a-z]/.test(newPassword)
            || !/\d/.test(newPassword)
            || !/[^A-Za-z0-9]/.test(newPassword)
            || /\s/.test(newPassword)
        )) {
            setError('Use 12–128 characters with uppercase, lowercase, a number, and a symbol, with no spaces.')
            return
        }
        if (challenge?.challengeName === 'SOFTWARE_TOKEN_MFA' && !/^\d{6}$/.test(mfaCode)) {
            setError('Enter the 6-digit code from your authenticator app.')
            return
        }

        setSubmitting(true)

        try {
            if (challenge?.challengeName === 'NEW_PASSWORD_REQUIRED') {
                const result = await completeNewPassword({
                    email,
                    newPassword,
                    challengeSession: challenge.challengeSession,
                    turnstileToken,
                })
                if (result?.challengeName) {
                    setChallenge(result)
                    setNewPassword('')
                    setConfirmPassword('')
                    setTurnstileToken(null)
                    turnstileRef.current?.reset()
                }
            } else if (challenge?.challengeName === 'SOFTWARE_TOKEN_MFA') {
                await completeMfa({
                    email,
                    code: mfaCode,
                    challengeSession: challenge.challengeSession,
                    turnstileToken,
                })
            } else {
                const result = await login(email, password, turnstileToken)
                if (result?.challengeName) {
                    setChallenge(result)
                    setPassword('')
                    setMfaCode('')
                    setTurnstileToken(null)
                    turnstileRef.current?.reset()
                }
            }
        } catch (err) {
            if (err.code === 'NotAuthorizedException') {
                setError('Incorrect email or password.')
            } else {
                setError(err.message || 'Sign in could not be completed. Please try again.')
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
        <Motion.div
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
                        {challenge?.challengeName === 'NEW_PASSWORD_REQUIRED'
                            ? 'Choose a New Password'
                            : challenge?.challengeName === 'SOFTWARE_TOKEN_MFA'
                                ? 'Verify Your Sign-In'
                                : 'Welcome Back'}
                    </h1>
                    <p className="mt-2 text-warm-gray">
                        {challenge?.challengeName === 'NEW_PASSWORD_REQUIRED'
                            ? 'Finish setting up your account to continue.'
                            : challenge?.challengeName === 'SOFTWARE_TOKEN_MFA'
                                ? 'Enter the code from your authenticator app.'
                                : 'Sign in to access your account.'}
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
                            disabled={Boolean(challenge)}
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

                    {!challenge && <div className="relative mb-6">
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
                    </div>}

                    {challenge?.challengeName === 'NEW_PASSWORD_REQUIRED' && (
                        <div className="space-y-5 mb-6">
                            <div>
                                <label htmlFor="newPassword" className="block text-sm font-medium text-charcoal mb-2">New password</label>
                                <input
                                    id="newPassword"
                                    type="password"
                                    value={newPassword}
                                    onChange={(event) => setNewPassword(event.target.value)}
                                    required
                                    minLength={12}
                                    maxLength={128}
                                    autoComplete="new-password"
                                    className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber"
                                />
                            </div>
                            <div>
                                <label htmlFor="confirmPassword" className="block text-sm font-medium text-charcoal mb-2">Confirm new password</label>
                                <input
                                    id="confirmPassword"
                                    type="password"
                                    value={confirmPassword}
                                    onChange={(event) => setConfirmPassword(event.target.value)}
                                    required
                                    minLength={12}
                                    maxLength={128}
                                    autoComplete="new-password"
                                    className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber"
                                />
                                <p className="mt-2 text-xs text-warm-gray">Use 12–128 characters with uppercase, lowercase, a number, and a symbol. Spaces are not allowed.</p>
                            </div>
                        </div>
                    )}

                    {challenge?.challengeName === 'SOFTWARE_TOKEN_MFA' && (
                        <div className="mb-6">
                            <label htmlFor="mfaCode" className="block text-sm font-medium text-charcoal mb-2">
                                Authenticator code
                            </label>
                            <input
                                id="mfaCode"
                                type="text"
                                value={mfaCode}
                                onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                                required
                                inputMode="numeric"
                                pattern="[0-9]{6}"
                                autoComplete="one-time-code"
                                maxLength={6}
                                autoFocus
                                className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal text-center text-2xl tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber"
                            />
                        </div>
                    )}

                    <div className="mb-6 flex justify-center">
                        <Turnstile
                            ref={turnstileRef}
                            siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
                            onSuccess={(token) => setTurnstileToken(token)}
                            options={{ theme: 'light', action: 'login' }}
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
                                {challenge?.challengeName === 'NEW_PASSWORD_REQUIRED'
                                    ? 'Saving password…'
                                    : challenge?.challengeName === 'SOFTWARE_TOKEN_MFA'
                                        ? 'Verifying…'
                                        : 'Signing in…'}
                            </span>
                        ) : (
                            challenge?.challengeName === 'NEW_PASSWORD_REQUIRED'
                                ? 'Set Password and Continue'
                                : challenge?.challengeName === 'SOFTWARE_TOKEN_MFA'
                                    ? 'Verify and Continue'
                                    : 'Log In'
                        )}
                    </button>
                </form>
            </div>
        </Motion.div>
    )
}

export default Login
