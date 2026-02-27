import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
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

    // Group albums by category helper
    const groupAlbums = (albumList) => albumList.reduce((acc, album) => {
        const cat = album.category || 'Uncategorized';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(album);
        return acc;
    }, {});

    const photoAlbums = albums.filter(a => a.type !== 'video');
    const groupedPhotoAlbums = groupAlbums(photoAlbums);

    // Sort categories alphabetically, but put "Uncategorized" at the end
    const photoCategories = Object.keys(groupedPhotoAlbums).sort((a, b) => {
        if (a === 'Uncategorized') return 1;
        if (b === 'Uncategorized') return -1;
        return a.localeCompare(b);
    });

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
                        <div className="flex flex-wrap items-center gap-4 mt-8">
                            <a
                                href="#albums"
                                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-amber text-white font-medium hover:bg-amber-dark transition-all duration-300 shadow-warm hover:shadow-warm-lg"
                            >
                                Explore Photos
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                            </a>
                            <Link
                                to="/videos"
                                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white/10 hover:bg-white/20 backdrop-blur-md text-white border border-white/20 font-medium transition-all duration-300 shadow-warm hover:shadow-warm-lg"
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
                    <h2 className="font-serif text-3xl md:text-4xl font-semibold text-charcoal">
                        Photo Albums
                    </h2>
                </div>

                {loading && (
                    <div className="flex justify-center py-20">
                        <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                    </div>
                )}

                {error && (
                    <div className="text-center py-12 text-warm-gray">
                        <p>{error}</p>
                    </div>
                )}

                {!loading && photoAlbums.length > 0 && photoCategories.map((cat) => (
                    <div key={`photo-${cat}`} className="mb-16">
                        <div className="flex items-center gap-4 mb-8">
                            <h3 className="font-serif text-2xl font-medium text-charcoal">{cat}</h3>
                            <div className="h-px bg-warm-border flex-1"></div>
                        </div>
                        <div className="flex overflow-x-auto gap-6 pb-8 snap-x snap-mandatory scrollbar-hide">
                            {groupedPhotoAlbums[cat].map((album) => (
                                <div key={album.albumId} className="shrink-0 w-[280px] sm:w-[320px] md:w-[360px] snap-start">
                                    <AlbumCard album={album} />
                                </div>
                            ))}
                        </div>
                    </div>
                ))}

                {!loading && photoAlbums.length === 0 && (
                    <div className="text-center py-12 text-warm-gray"><p>No photo albums found.</p></div>
                )}
            </section>

        </div>
    )
}

export default Home
