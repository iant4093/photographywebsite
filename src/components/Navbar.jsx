import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/authContext'

// Navigation bar with role-based links
function Navbar() {
    const { user, isAdmin, logout } = useAuth()

    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const location = useLocation()

    // Close menu when route changes
    useEffect(() => {
        setIsMenuOpen(false)
    }, [location])

    // Lock body scroll when menu is open
    useEffect(() => {
        if (isMenuOpen) {
            document.body.style.overflow = 'hidden'
        } else {
            document.body.style.overflow = 'unset'
        }
        return () => { document.body.style.overflow = 'unset' }
    }, [isMenuOpen])

    return (
        <>
            {/* Top Navigation Bar */}
            <nav className={`sticky top-0 z-50 transition-all duration-300 ${isMenuOpen ? 'bg-transparent border-transparent' : 'bg-cream/80 backdrop-blur-md border-b border-warm-border'}`}>
                <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
                    {/* Brand */}
                    <Link to="/" className="flex items-center gap-3 group z-50 relative">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber to-amber-dark flex items-center justify-center shadow-warm-sm group-hover:shadow-warm transition-shadow duration-300">
                            <span className="text-cream font-serif font-bold text-sm tracking-tight">IT</span>
                        </div>
                        <span className="font-serif text-xl font-semibold text-charcoal tracking-tight">
                            Ian Truong
                        </span>
                    </Link>

                    {/* Hamburger Toggle */}
                    <button
                        onClick={() => setIsMenuOpen(!isMenuOpen)}
                        className="relative z-50 w-10 h-10 rounded-xl bg-cream/50 hover:bg-cream border border-warm-border flex flex-col justify-center items-center gap-1.5 transition-colors duration-300 cursor-pointer"
                        aria-label="Toggle menu"
                    >
                        <span className={`w-5 h-0.5 bg-charcoal rounded-full transition-all duration-300 ${isMenuOpen ? 'rotate-45 translate-y-2' : ''}`} />
                        <span className={`w-5 h-0.5 bg-charcoal rounded-full transition-all duration-300 ${isMenuOpen ? 'opacity-0' : ''}`} />
                        <span className={`w-5 h-0.5 bg-charcoal rounded-full transition-all duration-300 ${isMenuOpen ? '-rotate-45 -translate-y-2' : ''}`} />
                    </button>
                </div>
            </nav>

            {/* Fullscreen Overlay Menu */}
            <div className={`fixed inset-0 z-40 bg-cream/95 backdrop-blur-xl transition-all duration-500 ease-in-out flex flex-col items-center justify-center ${isMenuOpen ? 'opacity-100 visible' : 'opacity-0 invisible pointer-events-none'}`}>
                <div className={`flex flex-col items-center gap-8 md:gap-12 transition-all duration-500 delay-100 ${isMenuOpen ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'}`}>

                    <Link to="/" onClick={() => setIsMenuOpen(false)} className="font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300">
                        Gallery
                    </Link>

                    <Link to="/sharedalbum" onClick={() => setIsMenuOpen(false)} className="font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300">
                        Find Album
                    </Link>

                    {/* Future Tabs can go here seamlessly */}
                    {/* <Link to="/about" className="font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300">About</Link> */}
                    {/* <Link to="/contact" className="font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300">Contact</Link> */}

                    {user ? (
                        <>
                            <Link
                                to={isAdmin ? '/admin' : '/dashboard'}
                                className="font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300"
                            >
                                Dashboard
                            </Link>
                            <button
                                onClick={() => { logout(); setIsMenuOpen(false); }}
                                className="mt-8 font-sans text-lg font-medium px-8 py-3 rounded-xl bg-charcoal text-cream hover:bg-charcoal-light transition-colors duration-300 cursor-pointer"
                            >
                                Log Out
                            </button>
                        </>
                    ) : (
                        <Link
                            to="/login"
                            className="mt-8 font-sans text-lg font-medium px-8 py-3 rounded-xl bg-amber text-cream hover:bg-amber-dark transition-colors duration-300 shadow-warm-sm hover:shadow-warm"
                        >
                            Log In
                        </Link>
                    )}
                </div>
            </div>
        </>
    )
}

export default Navbar
