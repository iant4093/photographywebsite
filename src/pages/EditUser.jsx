import { useState } from 'react'
import useAccountDirectory from '../hooks/useAccountDirectory'
import useDialogOperation from '../hooks/useDialogOperation'
import AccountDialog from '../components/AccountDialog'
import { Link } from 'react-router'
import { useAuth } from '../context/auth'
import { editUser } from '../utils/api'

// Edit User page — list users with search and change email
function EditUser() {
    const { getIdToken } = useAuth()

    const { users, loading, listError, loadUsers } = useAccountDirectory(getIdToken)
    const operation = useDialogOperation()
    const [search, setSearch] = useState('')

    // Editing state
    const [editingUser, setEditingUser] = useState(null)
    const [newEmail, setNewEmail] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const [success, setSuccess] = useState('')

    // Start editing a user
    function startEdit(user) {
        operation.cancel()
        setSaving(false)
        setEditingUser(user)
        setNewEmail(user.email)
        setError('')
        setSuccess('')
    }

    function closeDialog() { operation.cancel(); setEditingUser(null); setSaving(false); setError('') }

    // Save edits
    async function handleSave() {
        if (!newEmail || saving) return
        const request = operation.begin()
        setSaving(true)
        setError('')
        try {
            const token = await getIdToken()
            if (!request.current()) return
            await editUser(token, editingUser.email, { email: newEmail, userId: editingUser.sub }, { signal: request.signal })
            if (!request.current()) return
            setSuccess(`User updated successfully! ${newEmail !== editingUser.email ? 'Albums have been migrated to the new email.' : ''}`)
            setEditingUser(null)
            loadUsers()
        } catch (err) {
            if (!request.current()) return
            setError(err.message || 'Failed to update user.')
        } finally {
            if (request.current()) setSaving(false)
        }
    }

    // Filter users
    const filteredUsers = users.filter((u) =>
        u.email.toLowerCase().includes(search.toLowerCase())
    )

    return (
        <div className="max-w-3xl mx-auto px-6 py-12 pt-[88px] md:pt-[104px]">
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
                        Update a user's email. Changing it will automatically migrate their assigned albums. Passwords are set
                        and recovered by the user through Cognito, never by an administrator.
                    </p>
                </div>

                {/* Alerts */}
                {success && (
                    <div className="mb-6 p-4 rounded-xl bg-green-50 border border-green-200 text-green-800 text-sm animate-fade-in">{success}</div>
                )}
                {error && !editingUser && (
                    <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm animate-fade-in">{error}</div>
                )}

                {/* Edit modal */}
                {editingUser && (
                    <AccountDialog label="Edit User" onClose={closeDialog}>
                        <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-warm-xl animate-scale-in">
                            <h3 className="font-serif text-xl font-semibold text-charcoal mb-1">
                                Edit User
                            </h3>
                            <p className="text-sm text-warm-gray mb-6">
                                Editing: {editingUser.email}
                            </p>

                            {/* New email */}
                            <div className="mb-5">
                                <label htmlFor="edit-account-email" className="block text-sm font-medium text-charcoal mb-2">Email</label>
                                <input
                                    id="edit-account-email"
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

                            {error && <p role="alert">{error}</p>}
                            {saving && <p role="status">Closing this dialog does not cancel an accepted update.</p>}
                            <div className="flex gap-3 mt-8">
                                <button
                                    onClick={closeDialog}
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
                    </AccountDialog>
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

                {loading && <p role="status" className="text-sm text-warm-gray mb-4">Loading all accounts… Search results are still updating.</p>}
                {listError && <div role="alert" className="mb-4 text-red-700">{listError} <button onClick={loadUsers} className="underline">Retry</button></div>}
                {/* Users list */}
                {loading && users.length === 0 ? (
                    <div className="flex justify-center py-20">
                        <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : filteredUsers.length === 0 ? (
                    <div className="text-center py-12 text-warm-gray">
                        <p>{listError ? 'Accounts could not be fully loaded.' : loading ? 'Searching all accounts…' : 'No users found.'}</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredUsers.map((user) => (
                            <div key={user.sub || user.email} className="bg-white rounded-xl p-5 shadow-warm-sm border border-warm-border flex items-center justify-between">
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
