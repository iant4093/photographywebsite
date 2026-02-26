import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/authContext'
import { listUsers, editUser } from '../utils/api'

// Edit User page — list users with search, change email and password
function EditUser() {
    const { getIdToken } = useAuth()

    const [users, setUsers] = useState([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState('')

    // Editing state
    const [editingUser, setEditingUser] = useState(null)
    const [newEmail, setNewEmail] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const [success, setSuccess] = useState('')

    // Load users on mount
    useEffect(() => {
        loadUsers()
    }, [])

    async function loadUsers() {
        try {
            const token = await getIdToken()
            const data = await listUsers(token)
            setUsers(data.filter((u) => u.email !== 'iant4093@gmail.com'))
        } catch (err) {
            console.error('Failed to load users:', err)
        } finally {
            setLoading(false)
        }
    }

    // Start editing a user
    function startEdit(user) {
        setEditingUser(user)
        setNewEmail(user.email)
        setNewPassword('')
        setError('')
        setSuccess('')
    }

    // Save edits
    async function handleSave() {
        if (!newEmail) return
        setSaving(true)
        setError('')
        try {
            const token = await getIdToken()
            await editUser(token, editingUser.email, {
                email: newEmail,
                password: newPassword || undefined,
            })
            setSuccess(`User updated successfully! ${newEmail !== editingUser.email ? 'Albums have been migrated to the new email.' : ''}`)
            setEditingUser(null)
            loadUsers()
            setTimeout(() => setSuccess(''), 5000)
        } catch (err) {
            setError(err.message || 'Failed to update user.')
        } finally {
            setSaving(false)
        }
    }

    // Filter users
    const filteredUsers = users.filter((u) =>
        u.email.toLowerCase().includes(search.toLowerCase())
    )

    return (
        <div className="max-w-3xl mx-auto px-6 py-12">
            <div className="animate-slide-up">
                {/* Back link */}
                <Link to="/admin/users" className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Manage Users
                </Link>

                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Edit User</h1>
                    <p className="mt-2 text-warm-gray">
                        Update a user's email or password. Changing the email will automatically migrate their albums.
                    </p>
                </div>

                {/* Alerts */}
                {success && (
                    <div className="mb-6 p-4 rounded-xl bg-green-50 border border-green-200 text-green-800 text-sm animate-fade-in">{success}</div>
                )}
                {error && (
                    <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm animate-fade-in">{error}</div>
                )}

                {/* Edit modal */}
                {editingUser && (
                    <div className="fixed inset-0 z-[100] bg-charcoal/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
                        <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-warm-xl animate-scale-in">
                            <h3 className="font-serif text-xl font-semibold text-charcoal mb-1">
                                Edit User
                            </h3>
                            <p className="text-sm text-warm-gray mb-6">
                                Editing: {editingUser.email}
                            </p>

                            {/* New email */}
                            <div className="mb-5">
                                <label className="block text-sm font-medium text-charcoal mb-2">Email</label>
                                <input
                                    type="email"
                                    value={newEmail}
                                    onChange={(e) => setNewEmail(e.target.value)}
                                    required
                                    className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                                />
                                {newEmail !== editingUser.email && (
                                    <p className="mt-1 text-xs text-amber-dark">
                                        ⚠ Changing the email will migrate all albums to the new address.
                                    </p>
                                )}
                            </div>

                            {/* New password */}
                            <div className="mb-8">
                                <label className="block text-sm font-medium text-charcoal mb-2">
                                    New Password <span className="text-warm-gray font-normal">(leave blank to keep current)</span>
                                </label>
                                <input
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    placeholder="Enter new password…"
                                    className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal placeholder-warm-gray/50 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                                />
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setEditingUser(null)}
                                    className="flex-1 py-3 rounded-xl bg-cream text-warm-gray font-medium hover:bg-cream-dark transition-colors cursor-pointer"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={!newEmail || saving}
                                    className="flex-1 py-3 rounded-xl bg-gradient-to-r from-amber to-amber-dark text-white font-semibold hover:from-amber-dark hover:to-amber-dark transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                                >
                                    {saving ? (
                                        <span className="flex items-center justify-center gap-2">
                                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                            Saving…
                                        </span>
                                    ) : (
                                        'Save Changes'
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Search */}
                <div className="mb-6">
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search users by email…"
                        className="w-full px-4 py-3 rounded-xl border border-warm-border bg-white text-charcoal placeholder-warm-gray/50 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200 shadow-warm-sm"
                    />
                </div>

                {/* Users list */}
                {loading ? (
                    <div className="flex justify-center py-20">
                        <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : filteredUsers.length === 0 ? (
                    <div className="text-center py-12 text-warm-gray">
                        <p>No users found.</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredUsers.map((user) => (
                            <div key={user.email} className="bg-white rounded-xl p-5 shadow-warm-sm border border-warm-border flex items-center justify-between">
                                <div>
                                    <p className="font-medium text-charcoal">{user.email}</p>
                                    <p className="text-xs text-warm-gray mt-0.5">
                                        Status: {user.status || 'Active'} · Created: {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}
                                    </p>
                                </div>
                                <button
                                    onClick={() => startEdit(user)}
                                    className="px-4 py-2 rounded-lg bg-amber/10 text-amber-dark text-sm font-medium cursor-pointer hover:bg-amber/20 transition-colors"
                                >
                                    Edit
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export default EditUser
