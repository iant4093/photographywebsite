import { useState, useEffect } from 'react'
import AlbumCard from '../components/AlbumCard'
import { fetchAlbums } from '../utils/api'

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
    const [albums, setAlbums] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    useEffect(() => {
        fetchAlbums()
            .then((data) => setAlbums(data))
            .catch(() => {
                setAlbums(PLACEHOLDER_VIDEOS)
                setError(null)
            })
            .finally(() => setLoading(false))
    }, [])

    const groupAlbums = (albumList) => albumList.reduce((acc, album) => {
        const cat = album.category || 'Uncategorized';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(album);
        return acc;
    }, {});

    const videoAlbums = albums.filter(a => a.type === 'video');
    const groupedVideoAlbums = groupAlbums(videoAlbums);

    const videoCategories = Object.keys(groupedVideoAlbums).sort((a, b) => {
        if (a === 'Uncategorized') return 1;
        if (b === 'Uncategorized') return -1;
        return a.localeCompare(b);
    });

    return (
        <div>
            {/* Hero section */}
            <section className="relative overflow-hidden">
                <div className="absolute inset-0">
                    <img
                        src="https://d1twwtwfz1yeo4.cloudfront.net/main-image/video.jpeg"
                        alt="Cinematography"
                        className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-charcoal/60 via-charcoal/40 to-cream" />
                </div>

                <div className="relative max-w-7xl mx-auto px-6 py-32 md:py-48">
                    <div className="max-w-2xl animate-fade-in">
                        <h1 className="font-serif text-5xl md:text-7xl font-semibold text-white leading-tight tracking-tight">
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

                    {!loading && videoAlbums.length > 0 && videoCategories.map((cat) => (
                        <div key={`video-${cat}`} className="mb-16">
                            <div className="flex items-center gap-4 mb-8">
                                <h3 className="font-serif text-2xl font-medium text-charcoal">{cat}</h3>
                                <div className="h-px bg-warm-border flex-1"></div>
                            </div>
                            <div className="flex overflow-x-auto gap-6 pb-8 snap-x snap-mandatory scrollbar-hide">
                                {groupedVideoAlbums[cat].map((album) => (
                                    <div key={album.albumId} className="shrink-0 w-[280px] sm:w-[320px] md:w-[360px] snap-start">
                                        <AlbumCard album={album} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}

                    {!loading && videoAlbums.length === 0 && (
                        <div className="text-center py-12 text-warm-gray"><p>No video projects found.</p></div>
                    )}
                </div>
            </section>
        </div>
    )
}

export default Videos
