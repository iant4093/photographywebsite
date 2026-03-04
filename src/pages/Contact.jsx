import { useState } from 'react'
import { Turnstile } from '@marsidev/react-turnstile'
import { motion } from 'framer-motion'

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
            className="max-w-3xl mx-auto px-6 py-20 flex-1 w-full"
        >
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
                    <div className="relative">
                        <input
                            id="name"
                            type="text"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="peer w-full px-4 pt-6 pb-2 mt-1 rounded-xl border border-warm-border bg-charcoal/5 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all placeholder-transparent"
                            placeholder="Name"
                        />
                        <label
                            htmlFor="name"
                            className="absolute left-4 top-1.5 text-xs font-medium text-warm-gray transition-all peer-placeholder-shown:top-4 peer-placeholder-shown:text-base peer-placeholder-shown:text-warm-gray/70 peer-focus:top-1.5 peer-focus:text-xs peer-focus:text-amber cursor-text pointer-events-none"
                        >
                            Name
                        </label>
                    </div>
                    <div className="relative">
                        <input
                            id="email"
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="peer w-full px-4 pt-6 pb-2 mt-1 rounded-xl border border-warm-border bg-charcoal/5 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all placeholder-transparent"
                            placeholder="Email"
                        />
                        <label
                            htmlFor="email"
                            className="absolute left-4 top-1.5 text-xs font-medium text-warm-gray transition-all peer-placeholder-shown:top-4 peer-placeholder-shown:text-base peer-placeholder-shown:text-warm-gray/70 peer-focus:top-1.5 peer-focus:text-xs peer-focus:text-amber cursor-text pointer-events-none"
                        >
                            Email
                        </label>
                    </div>
                </div>

                <div className="relative mb-6">
                    <textarea
                        id="message"
                        required
                        rows={6}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        className="peer w-full px-4 pt-6 pb-2 mt-1 rounded-xl border border-warm-border bg-charcoal/5 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all resize-none placeholder-transparent"
                        placeholder="Message"
                    />
                    <label
                        htmlFor="message"
                        className="absolute left-4 top-1.5 text-xs font-medium text-warm-gray transition-all peer-placeholder-shown:top-4 peer-placeholder-shown:text-base peer-placeholder-shown:text-warm-gray/70 peer-focus:top-1.5 peer-focus:text-xs peer-focus:text-amber cursor-text pointer-events-none"
                    >
                        Message
                    </label>
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
        </motion.div>
    )
}
