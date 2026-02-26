import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/authContext'
import { listUsers, deleteUser } from '../utils/api'

// Delete User page — select a user, type "confirm" to delete them + all their data
function DeleteUser() {
    const { getIdToken } = useAuth()

    const [users, setUsers] = useState([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState('')

    // Selected user for deletion
    const [selectedUser, setSelectedUser] = useState(null)
    const [confirmText, setConfirmText] = useState('')
    const [deleting, setDeleting] = useState(false)
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
            // Filter out admin users
            setUsers(data.filter((u) => u.email !== 'iant4093@gmail.com'))
        } catch (err) {
            console.error('Failed to load users:', err)
        } finally {
            setLoading(false)
        }
    }

    // Handle deletion
    async function handleDelete() {
        if (confirmText !== 'confirm') return
        setDeleting(true)
        setError('')
        try {
            const token = await getIdToken()
            const result = await deleteUser(token, selectedUser.email)
            setSuccess(`User ${selectedUser.email} deleted along with ${result.albumsDeleted} album(s).`)
            setSelectedUser(null)
            setConfirmText('')
            loadUsers()
        } catch (err) {
            setError(err.message || 'Failed to delete user.')
        } finally {
            setDeleting(false)
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
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Delete User</h1>
                    <p className="mt-2 text-warm-gray">
                        Permanently remove a user and <strong>all</strong> their albums and photos. This cannot be undone.
                    </p>
                </div>

                {/* Alerts */}
                {success && (
                    <div className="mb-6 p-4 rounded-xl bg-green-50 border border-green-200 text-green-800 text-sm animate-fade-in">{success}</div>
                )}
                {error && (
                    <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm animate-fade-in">{error}</div>
                )}

                {/* Confirmation modal overlay */}
                {selectedUser && (
                    <div className="fixed inset-0 z-[100] bg-charcoal/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
                        <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-warm-xl animate-scale-in">
                            {/* Warning */}
                            <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-red-500 to-red-600 flex items-center justify-center text-white mx-auto mb-5">
                                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                                </svg>
                            </div>

                            <h3 className="font-serif text-xl font-semibold text-charcoal text-center mb-2">
                                Delete {selectedUser.email}?
                            </h3>
                            <p className="text-sm text-warm-gray text-center mb-6">
                                This will permanently delete the user, <strong>all their albums</strong>, and <strong>all their photos</strong>. This action cannot be undone.
                            </p>

                            <div className="mb-6">
                                <label className="block text-sm font-medium text-charcoal mb-2">
                                    Type <span className="font-mono bg-red-50 text-red-600 px-2 py-0.5 rounded">confirm</span> to proceed
                                </label>
                                <input
                                    type="text"
                                    value={confirmText}
                                    onChange={(e) => setConfirmText(e.target.value)}
                                    placeholder="Type confirm..."
                                    className="w-full px-4 py-3 rounded-xl border border-red-200 bg-red-50/30 text-charcoal placeholder-warm-gray/50 focus:outline-none focus:ring-2 focus:ring-red-400/40 focus:border-red-400 transition-all duration-200"
                                    autoFocus
                                />
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={() => { setSelectedUser(null); setConfirmText('') }}
                                    className="flex-1 py-3 rounded-xl bg-cream text-warm-gray font-medium hover:bg-cream-dark transition-colors cursor-pointer"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleDelete}
                                    disabled={confirmText !== 'confirm' || deleting}
                                    className="flex-1 py-3 rounded-xl bg-gradient-to-r from-red-500 to-red-600 text-white font-semibold hover:from-red-600 hover:to-red-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                >
                                    {deleting ? (
                                        <span className="flex items-center justify-center gap-2">
                                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                            Deleting…
                                        </span>
                                    ) : (
                                        'Delete Permanently'
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
                                    onClick={() => setSelectedUser(user)}
                                    className="px-4 py-2 rounded-lg bg-red-50 text-red-600 text-sm font-medium cursor-pointer hover:bg-red-100 transition-colors"
                                >
                                    Delete
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export default DeleteUser
