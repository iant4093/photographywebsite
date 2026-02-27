import { useState } from 'react'
import { Turnstile } from '@marsidev/react-turnstile'

export default function Contact() {
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [message, setMessage] = useState('')
    const [turnstileToken, setTurnstileToken] = useState(null)
    const [status, setStatus] = useState({ type: '', message: '' })
    const [submitting, setSubmitting] = useState(false)

    const handleSubmit = async (e) => {
        e.preventDefault()

        if (!turnstileToken) {
            setStatus({ type: 'error', message: 'Please complete the security check.' })
            return
        }

        setSubmitting(true)
        setStatus({ type: '', message: '' })

        try {
            const API_BASE = import.meta.env.VITE_API_BASE_URL
            const response = await fetch(`${API_BASE}/contact`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, message, turnstileToken })
            })
            const data = await response.json()
            if (!response.ok) {
                throw new Error(data.error || 'Failed to send message.')
            }
            setStatus({ type: 'success', message: data.message })
            setName('')
            setEmail('')
            setMessage('')
        } catch (err) {
            setStatus({ type: 'error', message: err.message })
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="max-w-3xl mx-auto px-6 py-20 flex-1 w-full animate-fade-in">
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
                        <label htmlFor="name" className="block text-sm font-medium text-charcoal mb-2">Name</label>
                        <input
                            id="name"
                            type="text"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-charcoal/5 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all"
                            placeholder="Jane Doe"
                        />
                    </div>
                    <div>
                        <label htmlFor="email" className="block text-sm font-medium text-charcoal mb-2">Email</label>
                        <input
                            id="email"
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-charcoal/5 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all"
                            placeholder="jane@example.com"
                        />
                    </div>
                </div>

                <div className="mb-6">
                    <label htmlFor="message" className="block text-sm font-medium text-charcoal mb-2">Message</label>
                    <textarea
                        id="message"
                        required
                        rows={6}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-warm-border bg-charcoal/5 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all resize-none"
                        placeholder="How can I help you?"
                    />
                </div>

                <div className="mb-8 flex justify-center">
                    <Turnstile
                        siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
                        onSuccess={(token) => setTurnstileToken(token)}
                        options={{ theme: 'light' }}
                    />
                </div>

                <button
                    type="submit"
                    disabled={submitting || !turnstileToken}
                    className="w-full py-4 rounded-xl bg-charcoal text-white font-medium hover:bg-charcoal-light transition-colors duration-300 shadow-warm disabled:opacity-50 cursor-pointer"
                >
                    {submitting ? 'Sending...' : 'Send Message'}
                </button>
            </form>
        </div>
    )
}
