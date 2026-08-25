import { useRef, useState } from 'react'
import { Turnstile } from '@marsidev/react-turnstile'
import { Link } from 'react-router'
import { sendContactMessage } from '../utils/api'
import { trackContactSubmission } from '../utils/analytics'

export default function Contact() {
    const turnstileRef = useRef(null)
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [message, setMessage] = useState('')
    const [turnstileToken, setTurnstileToken] = useState(null)
    const [status, setStatus] = useState({ type: '', message: '' })
    const [submitting, setSubmitting] = useState(false)

    const resetSecurityCheck = () => {
        setTurnstileToken(null)
        turnstileRef.current?.reset()
    }

    const handleSubmit = async (e) => {
        e.preventDefault()

        if (!turnstileToken) {
            setStatus({ type: 'error', message: 'Please complete the security check.' })
            return
        }

        setSubmitting(true)
        setStatus({ type: '', message: '' })

        try {
            await sendContactMessage({ name, email, message, turnstileToken })
            trackContactSubmission()
            setStatus({ type: 'success', message: 'Thanks—your message was sent.' })
            setName('')
            setEmail('')
            setMessage('')
        } catch (err) {
            setStatus({ type: 'error', message: err.message || 'Your message could not be sent. Please try again.' })
        } finally {
            resetSecurityCheck()
            setSubmitting(false)
        }
    }

    return (
        <div className="max-w-3xl mx-auto px-6 py-20 pt-[88px] md:pt-[104px] flex-1 w-full animate-fade-in">
            <div className="text-center mb-16">
                <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4">Get In Touch</h1>
                <p className="text-warm-gray text-lg max-w-xl mx-auto">
                    Interested in booking a session, or just want to say hello? Fill out the form below and I'll get back to you as soon as possible.
                </p>
            </div>

            <form onSubmit={handleSubmit} className="bg-white rounded-3xl p-8 md:p-12 shadow-warm-lg border border-warm-border">
                {status.message && (
                    <div className={`mb-8 p-4 rounded-xl border text-sm ${status.type === 'error' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
                        {status.message}
                    </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    <div>
                        <label htmlFor="name" className="block mb-2 text-sm font-medium text-charcoal">
                            Name
                        </label>
                        <input
                            id="name"
                            type="text"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-charcoal/5 text-charcoal focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all"
                            autoComplete="name"
                        />
                    </div>
                    <div>
                        <label htmlFor="email" className="block mb-2 text-sm font-medium text-charcoal">
                            Email
                        </label>
                        <input
                            id="email"
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-charcoal/5 text-charcoal focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all"
                            autoComplete="email"
                        />
                    </div>
                </div>

                <div className="mb-6">
                    <label htmlFor="message" className="block mb-2 text-sm font-medium text-charcoal">
                        Message
                    </label>
                    <textarea
                        id="message"
                        required
                        rows={6}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-warm-border bg-charcoal/5 text-charcoal focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all resize-none"
                    />
                </div>

                <div className="mb-8 flex justify-center">
                    <Turnstile
                        ref={turnstileRef}
                        siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
                        onSuccess={(token) => setTurnstileToken(token)}
                        onExpire={() => {
                            setTurnstileToken(null)
                            setStatus({ type: 'error', message: 'The security check expired. Please complete it again.' })
                        }}
                        onError={() => {
                            setTurnstileToken(null)
                            setStatus({ type: 'error', message: 'The security check could not be loaded. Please try again.' })
                        }}
                        options={{ theme: 'auto', action: 'contact' }}
                    />
                </div>

                <p className="mb-6 text-xs leading-relaxed text-warm-gray">
                    Your name, email, and message are used only to respond to this inquiry and operate the site. Turnstile also
                    processes limited device and network information to prevent abuse. See the <Link to="/privacy" className="underline underline-offset-2 hover:text-amber-dark">privacy notice</Link>.
                </p>

                <button
                    type="submit"
                    disabled={submitting || !turnstileToken}
                    className="contact-submit w-full py-4 rounded-xl border border-charcoal bg-charcoal text-white font-medium hover:bg-charcoal-light transition-colors duration-300 shadow-warm disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                >
                    {submitting ? 'Sending...' : 'Send Message'}
                </button>
            </form>
        </div>
    )
}
