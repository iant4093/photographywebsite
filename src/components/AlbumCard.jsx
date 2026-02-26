import { Link } from 'react-router-dom'

// Album card displaying cover image, title, and a subtle hover effect
function AlbumCard({ album }) {
    return (
        <Link
            to={`/album/${album.albumId}`}
            className="group block rounded-2xl overflow-hidden shadow-warm hover:shadow-warm-lg transition-all duration-500 bg-white animate-scale-in"
        >
            {/* Cover image with warm overlay on hover */}
            <div className="relative aspect-[4/3] overflow-hidden">
                <img
                    src={album.coverImageUrl}
                    alt={album.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out"
                />
                {/* Golden gradient overlay on hover */}
                <div className="absolute inset-0 bg-gradient-to-t from-amber-dark/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            </div>

            {/* Card info */}
            <div className="p-5">
                <h3 className="font-serif text-lg font-semibold text-charcoal group-hover:text-amber-dark transition-colors duration-300">
                    {album.title}
                </h3>
                {album.description && (
                    <p className="mt-1 text-sm text-warm-gray line-clamp-2">
                        {album.description}
                    </p>
                )}
                {album.createdAt && (
                    <p className="mt-2 text-xs text-warm-gray/70">
                        {new Date(album.createdAt).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                        })}
                    </p>
                )}
            </div>
        </Link>
    )
}

export default AlbumCard
