import { Link } from 'react-router-dom'
import { useAuth } from '../context/authContext'

// Navigation bar with role-based links
function Navbar() {
    const { user, isAdmin, logout } = useAuth()

    return (
        <nav className="sticky top-0 z-50 bg-cream/80 backdrop-blur-md border-b border-warm-border">
            <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
                {/* Brand */}
                <Link to="/" className="flex items-center gap-3 group">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber to-amber-dark flex items-center justify-center shadow-warm-sm group-hover:shadow-warm transition-shadow duration-300">
                        <span className="text-cream font-serif font-bold text-sm tracking-tight">IT</span>
                    </div>
                    <span className="font-serif text-xl font-semibold text-charcoal tracking-tight">
                        Ian Truong
                    </span>
                </Link>

                {/* Navigation links */}
                <div className="flex items-center gap-6">
                    <Link to="/" className="text-sm font-medium text-charcoal-light hover:text-amber transition-colors duration-200">
                        Gallery
                    </Link>

                    {user ? (
                        <>
                            <Link
                                to={isAdmin ? '/admin' : '/dashboard'}
                                className="text-sm font-medium text-charcoal-light hover:text-amber transition-colors duration-200"
                            >
                                Dashboard
                            </Link>
                            <button
                                onClick={logout}
                                className="text-sm font-medium px-4 py-2 rounded-lg bg-charcoal text-cream hover:bg-charcoal-light transition-colors duration-200 cursor-pointer"
                            >
                                Log Out
                            </button>
                        </>
                    ) : (
                        <Link
                            to="/login"
                            className="text-sm font-medium px-4 py-2 rounded-lg bg-amber text-cream hover:bg-amber-dark transition-colors duration-200 shadow-warm-sm hover:shadow-warm"
                        >
                            Log In
                        </Link>
                    )}
                </div>
            </div>
        </nav>
    )
}

export default Navbar
