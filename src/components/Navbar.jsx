import { useState, useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router'
import { useAuth } from '../context/auth'

// Navigation bar with role-based links
function Navbar({ theme = 'light', onToggleTheme = () => {}, showThemeToggle = true }) {
    const { user, isAdmin, logout } = useAuth()
    const { pathname } = useLocation()

    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const [isVisible, setIsVisible] = useState(true)
    const lastScrollY = useRef(0)
    const visibleRef = useRef(true)
    const menuToggleRef = useRef(null)
    const photoActive = pathname === '/' || pathname.startsWith('/album/')
    const videoActive = pathname === '/videos' || pathname.startsWith('/video/')
    const searchActive = pathname === '/search'
    const sharedActive = pathname.startsWith('/sharedalbum')
    const contactActive = pathname === '/contact'
    const accountActive = pathname === '/login' || pathname === '/dashboard' || pathname.startsWith('/admin')
    const activeAttributes = (active) => ({
        className: active ? 'is-active' : undefined,
        'aria-current': active ? 'page' : undefined,
    })
    const menuLinkClass = (active) => `font-serif text-4xl md:text-5xl lg:text-6xl text-charcoal hover:text-amber transition-colors duration-300${active ? ' is-active' : ''}`

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

    useEffect(() => {
        if (!isMenuOpen) return undefined
        const closeOnEscape = (event) => {
            if (event.key !== 'Escape') return
            setIsMenuOpen(false)
            menuToggleRef.current?.focus()
        }
        window.addEventListener('keydown', closeOnEscape)
        return () => window.removeEventListener('keydown', closeOnEscape)
    }, [isMenuOpen])

    return (
        <>
            {/* Top Navigation Bar */}
            <nav className={`linen-nav fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${isVisible ? 'translate-y-0' : '-translate-y-full'} ${isMenuOpen ? 'menu-is-open bg-transparent border-transparent' : 'bg-cream/80 backdrop-blur-md border-b border-warm-border'}`}>
                <div className="linen-nav-inner max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
                    {/* Brand */}
                    <div className="linen-brand-cluster flex items-center gap-3 z-50 relative">
                        <Link to="/" onClick={() => setIsMenuOpen(false)} className="linen-brand flex items-center gap-3 group relative">
                            <div className="linen-logo-tile w-10 h-10 rounded-xl bg-gradient-to-br from-amber to-amber-dark flex items-center justify-center shadow-warm-sm group-hover:shadow-warm transition-shadow duration-300">
                                <span className="text-cream font-serif font-bold text-sm tracking-tight">IT</span>
                            </div>
                            <span className="font-serif text-xl font-semibold text-charcoal tracking-tight">
                                Ian Truong
                            </span>
                        </Link>
                        {showThemeToggle && (
                            <button
                                type="button"
                                className="linen-theme-toggle"
                                onClick={onToggleTheme}
                                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                                aria-pressed={theme === 'dark'}
                                title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
                            >
                                {theme === 'dark' ? (
                                    <svg className="linen-theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                                        <circle cx="12" cy="12" r="3.5" />
                                        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                                    </svg>
                                ) : (
                                    <svg className="linen-theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                                        <path d="M20.4 15.5A8.5 8.5 0 0 1 8.5 3.6 8.5 8.5 0 1 0 20.4 15.5Z" />
                                    </svg>
                                )}
                            </button>
                        )}
                    </div>

                    {/* Navigation Container */}
                    <div className="flex items-center gap-6 relative z-50">
                        <div className="linen-desktop-links hidden" aria-label="Primary navigation">
                            <Link to="/" {...activeAttributes(photoActive)}>Photographs</Link>
                            <Link to="/videos" {...activeAttributes(videoActive)}>Videos</Link>
                            <Link to="/search" {...activeAttributes(searchActive)}>Search</Link>
                            <Link to="/sharedalbum" {...activeAttributes(sharedActive)}>Find Album</Link>
                            <Link to="/contact" {...activeAttributes(contactActive)}>Contact</Link>
                            {user ? (
                                <Link to={isAdmin ? '/admin' : '/dashboard'} {...activeAttributes(accountActive)}>Dashboard</Link>
                            ) : (
                                <Link to="/login" {...activeAttributes(accountActive)}>Sign In</Link>
                            )}
                        </div>

                        {/* Hamburger Toggle */}
                        <button
                            ref={menuToggleRef}
                            onClick={() => setIsMenuOpen(!isMenuOpen)}
                            className="linen-menu-toggle w-10 h-10 rounded-xl bg-cream/50 hover:bg-cream border border-warm-border flex flex-col justify-center items-center gap-1.5 transition-colors duration-300 cursor-pointer"
                            aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
                            aria-expanded={isMenuOpen}
                            aria-controls="site-menu"
                        >
                            <span className={`w-5 h-0.5 bg-charcoal rounded-full transition-all duration-300 ${isMenuOpen ? 'rotate-45 translate-y-2' : ''}`} />
                            <span className={`w-5 h-0.5 bg-charcoal rounded-full transition-all duration-300 ${isMenuOpen ? 'opacity-0' : ''}`} />
                            <span className={`w-5 h-0.5 bg-charcoal rounded-full transition-all duration-300 ${isMenuOpen ? '-rotate-45 -translate-y-2' : ''}`} />
                        </button>
                    </div>
                </div>
            </nav>

            {/* Fullscreen Overlay Menu */}
            <div
                id="site-menu"
                aria-hidden={!isMenuOpen}
                inert={isMenuOpen ? undefined : true}
                className={`linen-menu fixed inset-0 z-40 bg-cream/95 backdrop-blur-xl transition-all duration-500 ease-in-out flex flex-col items-center justify-center ${isMenuOpen ? 'opacity-100 visible' : 'opacity-0 invisible pointer-events-none'}`}
            >
                <div className={`linen-menu-list flex flex-col items-center gap-8 md:gap-12 transition-all duration-500 delay-100 ${isMenuOpen ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'}`}>

                    <Link to="/" onClick={() => setIsMenuOpen(false)} className={menuLinkClass(photoActive)} aria-current={photoActive ? 'page' : undefined}>
                        Photographs
                    </Link>

                    <Link to="/videos" onClick={() => setIsMenuOpen(false)} className={menuLinkClass(videoActive)} aria-current={videoActive ? 'page' : undefined}>
                        Videos
                    </Link>

                    <Link to="/search" onClick={() => setIsMenuOpen(false)} className={menuLinkClass(searchActive)} aria-current={searchActive ? 'page' : undefined}>
                        Search
                    </Link>

                    <Link to="/sharedalbum" onClick={() => setIsMenuOpen(false)} className={menuLinkClass(sharedActive)} aria-current={sharedActive ? 'page' : undefined}>
                        Find Album
                    </Link>

                    <Link to="/contact" onClick={() => setIsMenuOpen(false)} className={menuLinkClass(contactActive)} aria-current={contactActive ? 'page' : undefined}>
                        Contact
                    </Link>

                    {user ? (
                        <>
                            <Link
                                to={isAdmin ? '/admin' : '/dashboard'}
                                onClick={() => setIsMenuOpen(false)}
                                className={menuLinkClass(accountActive)}
                                aria-current={accountActive ? 'page' : undefined}
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
                            className={`linen-menu-action mt-8 font-sans text-lg font-medium px-8 py-3 rounded-xl bg-amber text-cream hover:bg-amber-dark transition-colors duration-300 shadow-warm-sm hover:shadow-warm${accountActive ? ' is-active' : ''}`}
                            aria-current={accountActive ? 'page' : undefined}
                        >
                            Sign In
                        </Link>
                    )}
                </div>
            </div>
        </>
    )
}

export default Navbar
