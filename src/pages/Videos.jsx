import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import AlbumCard from '../components/AlbumCard'
import ScrollRow from '../components/ScrollRow'
import SkeletonGrid from '../components/SkeletonGrid'
import { fetchAlbums } from '../utils/api'
import { useAuth } from '../context/authContext'

// Placeholder videos used when the backend isn't connected yet
const PLACEHOLDER_VIDEOS = [
    {
        albumId: 'demo-vid-1',
        type: 'video',
        title: 'Cinematic Wedding',
        description: 'A beautiful wedding day captured in 4K.',
        coverImageUrl: 'https://images.unsplash.com/photo-1519741497674-611481863552?w=800&q=80',
        createdAt: '2026-01-15T18:30:00Z',
    },
]

function Videos() {
    const { publicAlbums, setPublicAlbums } = useAuth()
    const [albums, setAlbums] = useState(publicAlbums || [])
    const [loading, setLoading] = useState(publicAlbums.length === 0)
    const [error, setError] = useState(null)
    const heroRef = useRef(null)
    const sectionRefs = useRef([])

    useEffect(() => {
        fetchAlbums()
            .then((data) => {
                setAlbums(data)
                setPublicAlbums(data)
            })
            .catch(() => {
                if (albums.length === 0) setAlbums(PLACEHOLDER_VIDEOS)
                setError(null)
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
        sectionRefs.current.push(el)
    }, [])

    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('is-visible')
                        observer.unobserve(entry.target)
                    }
                })
            },
            { rootMargin: '0px 0px -60px 0px', threshold: 0.1 }
        )

        sectionRefs.current.forEach((el) => observer.observe(el))
        return () => observer.disconnect()
    }, [loading, albums])

    const videoAlbums = albums.filter(a => a.type === 'video');

    // Group albums by category natively, memoized
    const { groupedVideoAlbums, videoCategories } = useMemo(() => {
        const grouped = videoAlbums.reduce((acc, album) => {
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

        return { groupedVideoAlbums: grouped, videoCategories: sorted };
    }, [videoAlbums]);

    // Page transition animation variants
    const pageVariants = {
        initial: { opacity: 0, y: 15 },
        animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
        exit: { opacity: 0, y: -15, transition: { duration: 0.3, ease: "easeIn" } }
    }

    const renderLoading = () => (
        <div className="max-w-7xl mx-auto px-6 py-12">
            <div className="mb-12">
                <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4 w-fit">Latest Videos</h1>
                <p className="text-lg text-warm-gray max-w-2xl">
                    A collection of my recent video work and visual stories.
                </p>
            </div>
            <SkeletonGrid count={6} type="video" />
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
                <div className="absolute inset-0 overflow-hidden">
                    <img
                        ref={heroRef}
                        src="https://d1twwtwfz1yeo4.cloudfront.net/main-image/video.jpeg"
                        alt="Cinematography"
                        className="w-full h-[110%] object-cover object-center parallax-hero"
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-charcoal/60 via-charcoal/40 to-cream" />
                </div>

                <div className="relative max-w-7xl mx-auto px-6 py-32 md:py-48">
                    <div className="max-w-2xl animate-fade-in">
                        <h1 className="font-serif text-5xl md:text-7xl font-semibold text-white leading-tight tracking-tight w-fit">
                            Videography
                        </h1>
                        <p className="mt-6 text-lg md:text-xl text-white/90 font-light leading-relaxed">
                            Explore some of my video work!
                        </p>
                    </div>
                </div>
            </section>

            {/* Videos grid */}
            <section className="bg-white">
                <div className="max-w-7xl mx-auto px-6 py-16 md:py-24">
                    <div className="text-center mb-12 animate-slide-up">
                        <h2 className="font-serif text-3xl md:text-4xl font-semibold text-charcoal flex items-center justify-center gap-3">
                            <svg className="w-8 h-8 md:w-10 md:h-10 text-amber" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                            Video Projects
                        </h2>
                    </div>

                    {error && (
                        <div className="text-center py-12 text-warm-gray">
                            <p>{error}</p>
                        </div>
                    )}

                    {!loading && videoAlbums.length > 0 && videoCategories.map((cat, catIndex) => (
                        <div
                            key={`video-${cat}`}
                            ref={observeRef}
                            className="mb-16 scroll-animate"
                            style={{ transitionDelay: `${catIndex * 100}ms` }}
                        >
                            <div className="flex items-center gap-4 mb-8">
                                <h3 className="font-serif text-2xl font-medium text-charcoal">{cat}</h3>
                                <div className="h-px bg-warm-border flex-1"></div>
                            </div>
                            <ScrollRow>
                                {groupedVideoAlbums[cat].map((album) => (
                                    <div key={album.albumId} className="shrink-0 w-[280px] sm:w-[320px] md:w-[360px] snap-start stagger-child">
                                        <AlbumCard album={album} />
                                    </div>
                                ))}
                            </ScrollRow>
                        </div>
                    ))}

                    {!loading && videoAlbums.length === 0 && (
                        <div className="text-center py-12 text-warm-gray"><p>No video projects found.</p></div>
                    )}
                </div>
            </section>
        </motion.div>
    )
}

export default Videos
