import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Link, useNavigationType } from 'react-router-dom'
import { motion } from 'framer-motion'
import AlbumCard from '../components/AlbumCard'
import ScrollRow from '../components/ScrollRow'
import { fetchAlbums } from '../utils/api'
import SkeletonGrid from '../components/SkeletonGrid'
import { useAuth } from '../context/authContext'
import { useScrollRestoration, isRevealed, markAsRevealed } from '../utils/scroll'
import { useLocation } from 'react-router-dom'

// Home page with hero section and album grid
function Home() {
    const { publicAlbums, setPublicAlbums } = useAuth()
    const navType = useNavigationType()
    const location = useLocation()

    // Manage scroll memory for this page
    useScrollRestoration(location.pathname, navType === 'POP')

    const [albums, setAlbums] = useState(publicAlbums || [])
    const [loading, setLoading] = useState(publicAlbums.length === 0)
    const [error, setError] = useState(null)
    const heroRef = useRef(null)
    const sectionRefs = useRef([])

    // Fetch albums on mount
    useEffect(() => {
        // If we have cached albums, we can still fetch in the background to refresh
        fetchAlbums()
            .then((data) => {
                setAlbums(data)
                setPublicAlbums(data)
            })
            .catch((err) => {
                console.error("Failed to load albums:", err);
                if (albums.length === 0) setError("Failed to load albums.")
            })
            .finally(() => setLoading(false))
    }, [setPublicAlbums])

    // Hero parallax on scroll
    useEffect(() => {
        const handleScroll = () => {
            if (heroRef.current) {
                // Prevent negative scroll value during macOS overscroll bounce
                const scrollY = Math.max(0, window.scrollY)
                // Limit shift to keep within the 10% extra image height (e.g. ~60-80px)
                const maxShift = 60
                const shift = Math.min(scrollY * 0.15, maxShift)
                heroRef.current.style.transform = `translateY(${shift}px)`
            }
        }
        window.addEventListener('scroll', handleScroll, { passive: true })
        return () => window.removeEventListener('scroll', handleScroll)
    }, [])

    // Scroll-triggered animations via Intersection Observer
    const observeRef = useCallback((el) => {
        if (!el) return
        if (!sectionRefs.current.includes(el)) sectionRefs.current.push(el)
    }, [])

    useEffect(() => {
        // Handle elements already revealed in the session
        sectionRefs.current.forEach((el) => {
            if (el && isRevealed(el.id)) {
                el.classList.add('is-visible')
            }
        })

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('is-visible')
                        markAsRevealed(entry.target.id)
                        observer.unobserve(entry.target)
                    }
                })
            },
            { rootMargin: '0px 0px -60px 0px', threshold: 0.1 }
        )

        sectionRefs.current.forEach((el) => {
            if (el && !isRevealed(el.id)) {
                observer.observe(el)
            }
        })
        return () => observer.disconnect()
    }, [loading, albums])

    const photoAlbums = albums.filter(a => a.type !== 'video');

    // Group albums by category and sort categories, memoized
    const { groupedPhotoAlbums, photoCategories } = useMemo(() => {
        const grouped = photoAlbums.reduce((acc, album) => {
            const cat = album.category || 'Uncategorized';
            if (!acc[cat]) acc[cat] = [];
            acc[cat].push(album);
            return acc;
        }, {});

        const sorted = Object.keys(grouped).sort((a, b) => {
            if (a === 'Uncategorized') return 1;
            if (b === 'Uncategorized') return -1;
            return a.localeCompare(b);
        });

        return { groupedPhotoAlbums: grouped, photoCategories: sorted };
    }, [photoAlbums]);

    // Page transition animation variants
    const pageVariants = {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0.4, ease: "easeOut" } },
        exit: { opacity: 0, transition: { duration: 0.3, ease: "easeIn" } }
    }

    const renderLoading = () => (
        <div className="max-w-7xl mx-auto px-6 py-12">
            <div className="mb-8">
                <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4">Latest Work</h1>
                <p className="text-lg text-warm-gray max-w-2xl">
                    A collection of my recent photography sessions and personal projects.
                </p>
            </div>
            <SkeletonGrid count={6} type="photo" />
        </div>
    )

    return (
        <motion.div
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
        >
            {/* Hero section with parallax */}
            <section className="relative overflow-hidden">
                {/* Background image with warm overlay */}
                <div className="absolute inset-0 overflow-hidden">
                    <img
                        ref={heroRef}
                        src="https://d1twwtwfz1yeo4.cloudfront.net/main-image/mainimage.jpeg"
                        alt="Golden hour landscape"
                        className="w-full h-[110%] object-cover object-[center_30%] parallax-hero"
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-charcoal/40 via-charcoal/20 to-cream" />
                </div>

                {/* Hero content */}
                <div className="relative max-w-7xl mx-auto px-6 py-32 md:py-48">
                    <div className="max-w-2xl animate-fade-in">
                        <h1 className="font-serif text-5xl md:text-7xl font-semibold text-white leading-tight tracking-tight">
                            Ian Truong
                        </h1>
                        <p className="mt-6 text-lg md:text-xl text-white/90 font-light leading-relaxed">
                            Hi, I'm Ian — welcome to my photography portfolio.
                            I shoot wildlife, portraits, sports, and general photography
                            as a hobby. Take a look around!
                        </p>
                        <div className="flex flex-wrap items-center gap-4 mt-8">
                            <a
                                href="#albums"
                                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-amber text-white font-medium hover:bg-amber-dark transition-all duration-300 shadow-warm hover:shadow-warm-lg hover:scale-105 active:scale-95"
                            >
                                Explore Photos
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                            </a>
                            <Link
                                to="/videos"
                                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white/10 hover:bg-white/20 backdrop-blur-md text-white border border-white/20 font-medium transition-all duration-300 shadow-warm hover:shadow-warm-lg hover:scale-105 active:scale-95"
                            >
                                Explore Videos
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                            </Link>
                        </div>
                    </div>
                </div>
            </section>

            {/* Albums grid */}
            <section id="albums" className="max-w-7xl mx-auto px-6 py-16 md:py-24">
                <div className="text-center mb-12 animate-slide-up">
                    <h2 className="font-serif text-3xl md:text-4xl font-semibold text-charcoal inline-block">
                        Photo Albums
                    </h2>
                </div>

                {error && (
                    <div className="text-center py-12 text-warm-gray">
                        <p>{error}</p>
                    </div>
                )}

                {!loading && photoAlbums.length > 0 && photoCategories.map((cat, catIndex) => (
                    <div
                        key={`photo-${cat}`}
                        id={`photo-cat-${cat.toLowerCase().replace(/\s+/g, '-')}`}
                        ref={observeRef}
                        className="mb-16 scroll-animate"
                        style={{ transitionDelay: `${catIndex * 100}ms` }}
                    >
                        <div className="flex items-center gap-4 mb-8">
                            <h3 className="font-serif text-2xl font-medium text-charcoal w-fit">{cat}</h3>
                            <div className="h-px bg-warm-border flex-1"></div>
                        </div>
                        <ScrollRow>
                            {groupedPhotoAlbums[cat].map((album) => (
                                <div key={album.albumId} className="shrink-0 w-[280px] sm:w-[320px] md:w-[360px] snap-start stagger-child">
                                    <AlbumCard album={album} />
                                </div>
                            ))}
                        </ScrollRow>
                    </div>
                ))}

                {!loading && photoAlbums.length === 0 && (
                    <div className="text-center py-12 text-warm-gray"><p>No photo albums found.</p></div>
                )}
            </section>

        </motion.div>
    )
}

export default Home
