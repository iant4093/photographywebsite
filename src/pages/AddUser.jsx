import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/authContext'
import { createUser } from '../utils/api'

// Add user page — admin creates new viewer accounts
function AddUser() {
    const { getIdToken } = useAuth()

    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [success, setSuccess] = useState('')
    const [error, setError] = useState('')

    // Handle form submission
    async function handleSubmit(e) {
        e.preventDefault()
        setError('')
        setSuccess('')
        setSubmitting(true)

        try {
            const token = await getIdToken()
            await createUser(token, email, password)
            setSuccess(`User ${email} created successfully! They can now log in.`)
            setEmail('')
            setPassword('')
        } catch (err) {
            setError(err.message || 'Failed to create user.')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="max-w-xl mx-auto px-6 py-12">
            <div className="animate-slide-up">
                {/* Back link */}
                <Link to="/admin/users" className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Manage Users
                </Link>

                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Add User</h1>
                    <p className="mt-2 text-warm-gray">
                        Create a viewer account. New users can only view their assigned photos — they cannot upload or manage albums.
                    </p>
                </div>

                {/* Success */}
                {success && (
                    <div className="mb-8 p-5 rounded-2xl bg-green-50 border border-green-200 text-green-800 animate-scale-in">
                        <p className="font-medium">{success}</p>
                    </div>
                )}

                {/* Error */}
                {error && (
                    <div className="mb-8 p-5 rounded-2xl bg-red-50 border border-red-200 text-red-700 animate-scale-in">
                        <p>{error}</p>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="bg-white rounded-2xl p-8 shadow-warm-lg border border-warm-border">
                    {/* Email */}
                    <div className="mb-6">
                        <label htmlFor="userEmail" className="block text-sm font-medium text-charcoal mb-2">Email *</label>
                        <input
                            id="userEmail"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal placeholder-warm-gray/50 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                            placeholder="client@example.com"
                        />
                    </div>

                    {/* Password */}
                    <div className="mb-8">
                        <label htmlFor="userPassword" className="block text-sm font-medium text-charcoal mb-2">Password *</label>
                        <input
                            id="userPassword"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            minLength={8}
                            className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal placeholder-warm-gray/50 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                            placeholder="Min 8 chars, uppercase, lowercase, number"
                        />
                        <p className="mt-2 text-xs text-warm-gray">
                            Must be 8+ characters with uppercase, lowercase, and a number.
                        </p>
                    </div>

                    <button
                        type="submit"
                        disabled={submitting}
                        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-amber to-amber-dark text-white font-semibold hover:from-amber-dark hover:to-amber-dark transition-all duration-300 shadow-warm hover:shadow-warm-lg disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                    >
                        {submitting ? (
                            <span className="flex items-center justify-center gap-2">
                                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                Creating…
                            </span>
                        ) : (
                            'Create User'
                        )}
                    </button>
                </form>
            </div>
        </div>
    )
}

export default AddUser
