import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import DashboardBackLink from '../components/DashboardBackLink'
import QRCode from 'qrcode'
import { useAuth } from '../context/auth'

const ISSUER = 'Ian Truong Photography'

function authenticatorUri(secret, email) {
    const label = encodeURIComponent(`${ISSUER}:${email}`)
    const issuer = encodeURIComponent(ISSUER)
    return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`
}

function AdminSecurity() {
    const navigate = useNavigate()
    const {
        adminMfaStatus,
        userEmail,
        refreshAdminMfaStatus,
        beginAdminMfaSetup,
        completeAdminMfaSetup,
        logout,
    } = useAuth()
    const [secret, setSecret] = useState('')
    const [qrCode, setQrCode] = useState('')
    const [code, setCode] = useState('')
    const [error, setError] = useState('')
    const [starting, setStarting] = useState(false)
    const [verifying, setVerifying] = useState(false)
    const [copied, setCopied] = useState(false)

    const formattedSecret = useMemo(
        () => secret.match(/.{1,4}/g)?.join(' ') || secret,
        [secret],
    )

    async function startSetup() {
        setError('')
        setStarting(true)
        try {
            const nextSecret = await beginAdminMfaSetup()
            const dataUrl = await QRCode.toDataURL(authenticatorUri(nextSecret, userEmail), {
                width: 320,
                margin: 2,
                errorCorrectionLevel: 'M',
                color: { dark: '#29251f', light: '#ffffff' },
            })
            setSecret(nextSecret)
            setQrCode(dataUrl)
        } catch (setupError) {
            setSecret('')
            setQrCode('')
            setError(setupError.message || 'Authenticator setup could not be started. Please try again.')
        } finally {
            setStarting(false)
        }
    }

    async function copySecret() {
        try {
            await navigator.clipboard.writeText(secret)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
        } catch {
            setError('The setup key could not be copied. Select and copy it manually.')
        }
    }

    async function verifyCode(event) {
        event.preventDefault()
        setError('')
        if (!/^[0-9]{6}$/.test(code)) {
            setError('Enter the 6-digit code from your authenticator app.')
            return
        }

        setVerifying(true)
        try {
            const result = await completeAdminMfaSetup(code)
            navigate('/login', {
                replace: true,
                state: {
                    mfaEnabled: true,
                    globalSignOutSucceeded: result.globallySignedOut,
                },
            })
        } catch (verificationError) {
            setError(verificationError.message || 'Two-factor authentication could not be enabled. Please try again.')
            setCode('')
        } finally {
            setVerifying(false)
        }
    }

    if (!adminMfaStatus || ['checking', 'not-required'].includes(adminMfaStatus)) {
        return (
            <div className="flex min-h-[60vh] items-center justify-center pt-[88px]" role="status" aria-live="polite">
                <span className="sr-only">Checking two-factor authentication</span>
                <div className="h-10 w-10 animate-spin rounded-full border-3 border-amber border-t-transparent" />
            </div>
        )
    }

    if (adminMfaStatus === 'error') {
        return (
            <div className="min-h-[70vh] flex items-center justify-center px-6 pt-[88px]">
                <div className="w-full max-w-md rounded-2xl border border-warm-border bg-white p-8 text-center shadow-warm-lg">
                    <h1 className="font-serif text-3xl font-semibold text-charcoal">Security Check Unavailable</h1>
                    <p className="mt-3 text-sm leading-relaxed text-warm-gray">
                        Admin tools remain locked because your two-factor authentication status could not be verified.
                    </p>
                    <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
                        <button type="button" onClick={() => refreshAdminMfaStatus().catch(() => {})} className="rounded-xl bg-amber px-5 py-3 font-semibold text-white hover:bg-amber-dark">
                            Try Again
                        </button>
                        <button type="button" onClick={logout} className="rounded-xl border border-warm-border px-5 py-3 font-semibold text-charcoal hover:border-amber">
                            Sign Out
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    if (adminMfaStatus === 'enabled') {
        return (
            <div className="linen-admin-page mx-auto max-w-3xl px-6 py-12 pt-[88px] md:pt-[104px]">
                <DashboardBackLink className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-warm-gray transition-colors hover:text-amber">
                    <span aria-hidden="true">←</span> Back to Admin Dashboard
                </DashboardBackLink>
                <div className="rounded-2xl border border-warm-border bg-white p-8 shadow-warm-lg md:p-10">
                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-green-700" aria-hidden="true">
                        <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                    <p className="mt-6 text-xs font-semibold uppercase tracking-[0.2em] text-warm-gray">Admin security</p>
                    <h1 className="mt-2 font-serif text-4xl font-semibold text-charcoal">Two-factor authentication is enabled</h1>
                    <p className="mt-4 leading-relaxed text-warm-gray">
                        Fresh admin sign-ins require both your password and a current code from your authenticator app.
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className="linen-admin-page mx-auto max-w-3xl px-6 py-12 pt-[88px] md:pt-[104px]">
            <div className="rounded-2xl border border-warm-border bg-white p-8 shadow-warm-lg md:p-10">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-dark">Required admin security</p>
                <h1 className="mt-3 font-serif text-4xl font-semibold text-charcoal">Set up two-factor authentication</h1>
                <p className="mt-4 leading-relaxed text-warm-gray">
                    Admin tools are locked until an authenticator app is connected. Viewer accounts are not affected.
                </p>

                {error && (
                    <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
                        {error}
                    </div>
                )}

                {!secret ? (
                    <div className="mt-8">
                        <ol className="space-y-3 text-sm leading-relaxed text-charcoal">
                            <li><strong>1.</strong> Open Google Authenticator, Microsoft Authenticator, 1Password, Authy, or another TOTP app.</li>
                            <li><strong>2.</strong> Select the option to add an account by QR code.</li>
                            <li><strong>3.</strong> Start setup below, scan the QR code, then confirm the six-digit code.</li>
                        </ol>
                        <button type="button" onClick={startSetup} disabled={starting} className="mt-7 w-full rounded-xl bg-amber px-5 py-3 font-semibold text-white shadow-warm transition-colors hover:bg-amber-dark disabled:cursor-not-allowed disabled:opacity-60">
                            {starting ? 'Preparing Authenticator…' : 'Set Up Authenticator'}
                        </button>
                    </div>
                ) : (
                    <div className="mt-8">
                        <div className="mx-auto max-w-sm rounded-2xl border border-warm-border bg-white p-4">
                            <img src={qrCode} alt="Authenticator setup QR code" className="aspect-square w-full" />
                        </div>
                        <p className="mt-5 text-center text-sm text-warm-gray">Can’t scan it? Enter this setup key manually:</p>
                        <div className="mt-3 flex flex-col items-center justify-between gap-3 rounded-xl border border-warm-border bg-cream/60 p-4 sm:flex-row">
                            <code className="break-all text-center text-sm font-semibold tracking-[0.15em] text-charcoal sm:text-left">{formattedSecret}</code>
                            <button type="button" onClick={copySecret} className="shrink-0 rounded-lg border border-warm-border bg-white px-3 py-2 text-sm font-semibold text-charcoal hover:border-amber">
                                {copied ? 'Copied' : 'Copy Key'}
                            </button>
                        </div>

                        <form onSubmit={verifyCode} className="mt-7">
                            <label htmlFor="adminMfaCode" className="block text-sm font-medium text-charcoal">Authenticator code</label>
                            <input
                                id="adminMfaCode"
                                type="text"
                                value={code}
                                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                                required
                                inputMode="numeric"
                                pattern="[0-9]{6}"
                                autoComplete="one-time-code"
                                maxLength={6}
                                autoFocus
                                className="mt-2 w-full rounded-xl border border-warm-border bg-cream/50 px-4 py-3 text-center text-2xl tracking-[0.4em] text-charcoal focus:border-amber focus:outline-none focus:ring-2 focus:ring-amber/40"
                            />
                            <button type="submit" disabled={verifying} className="mt-4 w-full rounded-xl bg-amber px-5 py-3 font-semibold text-white shadow-warm transition-colors hover:bg-amber-dark disabled:cursor-not-allowed disabled:opacity-60">
                                {verifying ? 'Verifying…' : 'Enable Two-Factor Authentication'}
                            </button>
                            <p className="mt-4 text-center text-xs leading-relaxed text-warm-gray">
                                After verification, all existing sessions are signed out and you’ll sign in again using your new code.
                            </p>
                        </form>
                    </div>
                )}
            </div>
        </div>
    )
}

export default AdminSecurity
