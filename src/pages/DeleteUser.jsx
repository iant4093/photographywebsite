import { useState } from 'react'
import useAccountDirectory from '../hooks/useAccountDirectory'
import useDialogOperation from '../hooks/useDialogOperation'
import AccountDialog from '../components/AccountDialog'
import { Link } from 'react-router'
import { useAuth } from '../context/auth'
import { deleteUser } from '../utils/api'

// Delete User page — select a user, type "confirm" to delete them + all their data
function DeleteUser() {
    const { getIdToken } = useAuth()

    const { users, loading, listError, loadUsers } = useAccountDirectory(getIdToken)
    const operation = useDialogOperation()
    const [search, setSearch] = useState('')

    // Selected user for deletion
    const [selectedUser, setSelectedUser] = useState(null)
    const [confirmText, setConfirmText] = useState('')
    const [deleting, setDeleting] = useState(false)
    const [error, setError] = useState('')
    const [success, setSuccess] = useState('')

    function closeDialog() { operation.cancel(); setSelectedUser(null); setConfirmText(''); setDeleting(false); setError('') }
    function startDelete(user) { operation.cancel(); setSelectedUser(user); setConfirmText(''); setDeleting(false); setError(''); setSuccess('') }

    // Handle deletion
    async function handleDelete() {
        if (confirmText !== 'confirm' || deleting) return
        const request = operation.begin()
        setDeleting(true)
        setError('')
        try {
            const token = await getIdToken()
            if (!request.current()) return
            const result = await deleteUser(token, selectedUser.email, { userId: selectedUser.sub, signal: request.signal })
            if (!request.current()) return
            setSuccess(`User ${selectedUser.email} deleted along with ${result.albumsDeleted} album(s).`)
            setSelectedUser(null)
            setConfirmText('')
            loadUsers()
        } catch (err) {
            if (!request.current()) return
            setError(err.message || 'Failed to delete user.')
        } finally {
            if (request.current()) setDeleting(false)
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
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Delete User</h1>
                    <p className="mt-2 text-warm-gray">
                        Permanently remove a website account and its owned galleries. Google Drive backups, separate archives, emails, and print-provider records require separate review for a privacy deletion request.
                    </p>
                </div>

                {/* Alerts */}
                {success && (
                    <div className="mb-6 p-4 rounded-xl bg-green-50 border border-green-200 text-green-800 text-sm animate-fade-in">{success}</div>
                )}
                {error && !selectedUser && (
                    <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm animate-fade-in">{error}</div>
                )}

                {/* Confirmation modal overlay */}
                {selectedUser && (
                    <AccountDialog label="Delete User" onClose={closeDialog}>
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
                                This permanently deletes the website account and its owned gallery files. It does not erase Drive backups, separate archives, emails, or print-provider records. For a privacy request, inventory those records before deleting the account so you can locate every related copy. Website deletion cannot be undone here.
                            </p>

                            <div className="mb-6">
                                <label htmlFor="delete-account-confirm" className="block text-sm font-medium text-charcoal mb-2">
                                    Type <span className="font-mono bg-red-50 text-red-600 px-2 py-0.5 rounded">confirm</span> to proceed
                                </label>
                                <input
                                    id="delete-account-confirm"
                                    type="text"
                                    value={confirmText}
                                    onChange={(e) => setConfirmText(e.target.value)}
                                    placeholder="Type confirm..."
                                    className="w-full px-4 py-3 rounded-xl border border-red-200 bg-red-50/30 text-charcoal placeholder-warm-gray/50 focus:outline-none focus:ring-2 focus:ring-red-400/40 focus:border-red-400 transition-all duration-200"
                                />
                            </div>

                            {error && <p role="alert">{error}</p>}
                            {deleting && <p role="status">Closing this dialog does not cancel an accepted deletion.</p>}
                            <div className="flex gap-3">
                                <button
                                    onClick={closeDialog}
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
                                    onClick={() => startDelete(user)}
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
