import { Navigate } from 'react-router'
import { useAuth } from '../context/auth'

// Wraps routes that require authentication
// If adminOnly is true, also checks for Admins group membership
function ProtectedRoute({ children, adminOnly = false, allowMfaSetup = false }) {
    const {
        user,
        loading,
        isAdmin,
        adminMfaStatus,
        refreshAdminMfaStatus,
        logout,
    } = useAuth()

    if (loading) {
        return (
            <div className="flex justify-center items-center min-h-[60vh]">
                <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
            </div>
        )
    }

    if (!user) {
        return <Navigate to="/login" replace />
    }

    // If adminOnly route and user is not admin, redirect to user dashboard
    if (adminOnly && !isAdmin) {
        return <Navigate to="/dashboard" replace />
    }

    if (adminOnly && isAdmin && !allowMfaSetup) {
        if (!adminMfaStatus || adminMfaStatus === 'checking') {
            return (
                <div className="flex justify-center items-center min-h-[60vh]" role="status" aria-live="polite">
                    <span className="sr-only">Checking two-factor authentication</span>
                    <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                </div>
            )
        }
        if (adminMfaStatus === 'error') {
            return (
                <div className="min-h-[60vh] flex items-center justify-center px-6 pt-[88px]">
                    <div className="max-w-md rounded-2xl border border-warm-border bg-white p-8 text-center shadow-warm-lg">
                        <h1 className="font-serif text-2xl font-semibold text-charcoal">Security check unavailable</h1>
                        <p className="mt-3 text-sm leading-relaxed text-warm-gray">
                            Your two-factor authentication status could not be verified. Admin tools remain locked until the check succeeds.
                        </p>
                        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
                            <button type="button" onClick={() => refreshAdminMfaStatus?.().catch(() => {})} className="rounded-xl bg-amber px-5 py-3 font-semibold text-white hover:bg-amber-dark">
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
        if (adminMfaStatus !== 'enabled') {
            return <Navigate to="/admin/security" replace />
        }
    }

    return children
}

export default ProtectedRoute
