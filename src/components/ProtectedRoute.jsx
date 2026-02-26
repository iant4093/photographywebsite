import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/authContext'

// Wraps routes that require authentication
// If adminOnly is true, also checks for Admins group membership
function ProtectedRoute({ children, adminOnly = false }) {
    const { user, loading, isAdmin } = useAuth()

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

    return children
}

export default ProtectedRoute
