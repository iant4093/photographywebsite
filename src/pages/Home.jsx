import { useState, useEffect } from 'react'
import AlbumCard from '../components/AlbumCard'
import { fetchAlbums } from '../utils/api'

// Placeholder albums used when the backend isn't connected yet
const PLACEHOLDER_ALBUMS = [
    {
        albumId: 'demo-1',
        title: 'Summer Solstice',
        description: 'Golden light dancing across the meadows at dusk.',
        coverImageUrl: 'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?w=800&q=80',
        createdAt: '2026-01-15T18:30:00Z',
    },
    {
        albumId: 'demo-2',
        title: 'Coastal Dreams',
        description: 'Pacific sunsets painting the sky in amber and coral.',
        coverImageUrl: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&q=80',
        createdAt: '2026-02-01T17:00:00Z',
    },
    {
        albumId: 'demo-3',
        title: 'Mountain Glow',
        description: 'Alpine peaks bathed in the last rays of sunlight.',
        coverImageUrl: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&q=80',
        createdAt: '2026-02-10T19:00:00Z',
    },
    {
        albumId: 'demo-4',
        title: 'Desert Bloom',
        description: 'Warm hues sweeping over the arid landscape.',
        coverImageUrl: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=800&q=80',
        createdAt: '2026-02-14T17:45:00Z',
    },
    {
        albumId: 'demo-5',
        title: 'Urban Twilight',
        description: 'City lights meeting the golden afterglow.',
        coverImageUrl: 'https://images.unsplash.com/photo-1514565131-fce0801e5785?w=800&q=80',
        createdAt: '2026-02-20T18:15:00Z',
    },
    {
        albumId: 'demo-6',
        title: 'Forest Light',
        description: 'Sunbeams filtering through the canopy.',
        coverImageUrl: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=800&q=80',
        createdAt: '2026-02-24T16:00:00Z',
    },
]

// Home page with hero section and album grid
function Home() {
    const [albums, setAlbums] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    // Fetch albums on mount — falls back to placeholder data if API is unavailable
    useEffect(() => {
        fetchAlbums()
            .then((data) => setAlbums(data))
            .catch(() => {
                setAlbums(PLACEHOLDER_ALBUMS)
                setError(null) // silently use placeholders
            })
            .finally(() => setLoading(false))
    }, [])

    return (
        <div>
            {/* Hero section */}
            <section className="relative overflow-hidden">
                {/* Background image with warm overlay */}
                <div className="absolute inset-0">
                    <img
                        src="https://d1twwtwfz1yeo4.cloudfront.net/main-image/mainimage.jpeg"
                        alt="Golden hour landscape"
                        className="w-full h-full object-cover"
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
                        <a
                            href="#albums"
                            className="inline-flex items-center gap-2 mt-8 px-6 py-3 rounded-xl bg-amber text-white font-medium hover:bg-amber-dark transition-all duration-300 shadow-warm hover:shadow-warm-lg"
                        >
                            Explore Albums
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                        </a>
                    </div>
                </div>
            </section>

            {/* Albums grid */}
            <section id="albums" className="max-w-7xl mx-auto px-6 py-16 md:py-24">
                <div className="text-center mb-12 animate-slide-up">
                    <h2 className="font-serif text-3xl md:text-4xl font-semibold text-charcoal">
                        Albums
                    </h2>

                </div>

                {/* Loading state */}
                {loading && (
                    <div className="flex justify-center py-20">
                        <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                    </div>
                )}

                {/* Error state */}
                {error && (
                    <div className="text-center py-12 text-warm-gray">
                        <p>{error}</p>
                    </div>
                )}

                {/* Albums grid */}
                {!loading && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
                        {albums.map((album) => (
                            <AlbumCard key={album.albumId} album={album} />
                        ))}
                    </div>
                )}
            </section>
        </div>
    )
}

export default Home
