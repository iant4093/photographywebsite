import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../context/auth'

// Navigation bar with role-based links
function Navbar() {
    const { user, isAdmin, logout } = useAuth()

    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const [isVisible, setIsVisible] = useState(true)
    const lastScrollY = useRef(0)
    const visibleRef = useRef(true)

    // Smart Navbar scroll logic
    useEffect(() => {
        let frame = null
        const update = () => {
            frame = null
            const currentScrollY = window.scrollY
            const nextVisible = currentScrollY < 10 || currentScrollY < lastScrollY.current
                ? true
                : !(currentScrollY > 50 && currentScrollY > lastScrollY.current)
            if (nextVisible !== visibleRef.current) {
                visibleRef.current = nextVisible
                setIsVisible(nextVisible)
            }
            lastScrollY.current = currentScrollY
        }
        const handleScroll = () => {
            if (frame === null) frame = window.requestAnimationFrame(update)
        }
        window.addEventListener('scroll', handleScroll, { passive: true })
        return () => {
            window.removeEventListener('scroll', handleScroll)
            if (frame !== null) window.cancelAnimationFrame(frame)
        }
    }, [])

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
            <nav className={`linen-nav fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${isVisible ? 'translate-y-0' : '-translate-y-full'} ${isMenuOpen ? 'menu-is-open bg-transparent border-transparent' : 'bg-cream/80 backdrop-blur-md border-b border-warm-border'}`}>
                <div className="linen-nav-inner max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
                    {/* Brand */}
                    <Link to="/" onClick={() => setIsMenuOpen(false)} className="linen-brand flex items-center gap-3 group z-50 relative">
                        <div className="linen-logo-tile w-10 h-10 rounded-xl bg-gradient-to-br from-amber to-amber-dark flex items-center justify-center shadow-warm-sm group-hover:shadow-warm transition-shadow duration-300">
                            <span className="text-cream font-serif font-bold text-sm tracking-tight">IT</span>
                        </div>
                        <span className="font-serif text-xl font-semibold text-charcoal tracking-tight">
                            Ian Truong
                        </span>
                    </Link>

                    {/* Navigation Container */}
                    <div className="flex items-center gap-6 relative z-50">
                        <div className="linen-desktop-links hidden" aria-label="Primary navigation">
                            <Link to="/" aria-label="Photographs — primary navigation">Photographs</Link>
                            <Link to="/videos" aria-label="Videos — primary navigation">Videos</Link>
                            <Link to="/sharedalbum" aria-label="Find Album — primary navigation">Find Album</Link>
                            <Link to="/contact" aria-label="Enquiries — primary navigation">Enquiries</Link>
                            {user ? (
                                <Link to={isAdmin ? '/admin' : '/dashboard'} aria-label="Studio — primary navigation">Studio</Link>
                            ) : (
                                <Link to="/login" aria-label="Sign in — primary navigation">Sign in</Link>
                            )}
                        </div>

                        {/* Hamburger Toggle */}
                        <button
                            onClick={() => setIsMenuOpen(!isMenuOpen)}
                            className="linen-menu-toggle w-10 h-10 rounded-xl bg-cream/50 hover:bg-cream border border-warm-border flex flex-col justify-center items-center gap-1.5 transition-colors duration-300 cursor-pointer"
                            aria-label="Toggle menu"
                        >
                            <span className={`w-5 h-0.5 bg-charcoal rounded-full transition-all duration-300 ${isMenuOpen ? 'rotate-45 translate-y-2' : ''}`} />
                            <span className={`w-5 h-0.5 bg-charcoal rounded-full transition-all duration-300 ${isMenuOpen ? 'opacity-0' : ''}`} />
                            <span className={`w-5 h-0.5 bg-charcoal rounded-full transition-all duration-300 ${isMenuOpen ? '-rotate-45 -translate-y-2' : ''}`} />
                        </button>
                    </div>
                </div>
            </nav>

            {/* Fullscreen Overlay Menu */}
            <div className={`linen-menu fixed inset-0 z-40 bg-cream/95 backdrop-blur-xl transition-all duration-500 ease-in-out flex flex-col items-center justify-center ${isMenuOpen ? 'opacity-100 visible' : 'opacity-0 invisible pointer-events-none'}`}>
                <div className={`linen-menu-list flex flex-col items-center gap-8 md:gap-12 transition-all duration-500 delay-100 ${isMenuOpen ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'}`}>

                    <Link to="/" onClick={() => setIsMenuOpen(false)} className="font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300">
                        Gallery
                    </Link>

                    <Link to="/videos" onClick={() => setIsMenuOpen(false)} className="font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300">
                        Videos
                    </Link>

                    <Link to="/sharedalbum" onClick={() => setIsMenuOpen(false)} className="font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300">
                        Find Album
                    </Link>

                    <Link to="/contact" onClick={() => setIsMenuOpen(false)} className="font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300">
                        Contact Me
                    </Link>

                    {user ? (
                        <>
                            <Link
                                to={isAdmin ? '/admin' : '/dashboard'}
                                onClick={() => setIsMenuOpen(false)}
                                className="font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300"
                            >
                                Dashboard
                            </Link>
                            <button
                                onClick={() => { logout(); setIsMenuOpen(false); }}
                                className="linen-menu-action mt-8 font-sans text-lg font-medium px-8 py-3 rounded-xl bg-charcoal text-cream hover:bg-charcoal-light transition-colors duration-300 cursor-pointer"
                            >
                                Log Out
                            </button>
                        </>
                    ) : (
                        <Link
                            to="/login"
                            onClick={() => setIsMenuOpen(false)}
                            className="linen-menu-action mt-8 font-sans text-lg font-medium px-8 py-3 rounded-xl bg-amber text-cream hover:bg-amber-dark transition-colors duration-300 shadow-warm-sm hover:shadow-warm"
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
