import { Link } from 'react-router-dom'
import ProgressiveImage from './ProgressiveImage'

// Album card displaying cover image, title, and a subtle hover effect
function AlbumCard({ album }) {
    return (
        <Link
            to={`/album/${album.albumId}`}
            className="group block rounded-2xl overflow-hidden shadow-warm hover:shadow-warm-lg transition-all duration-500 bg-white animate-scale-in"
        >
            {/* Cover image with warm overlay on hover */}
            <div className="relative aspect-[4/3] overflow-hidden bg-cream-dark">
                {album.coverImageUrl ? (
                    <ProgressiveImage
                        src={album.coverThumbKey ? `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${album.coverThumbKey}` : album.coverImageUrl}
                        blurhash={album.coverBlurhash}
                        alt={album.title}
                        className="w-full h-full group-hover:scale-105 transition-transform duration-700 ease-out"
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center">
                        <svg className="w-12 h-12 text-warm-gray/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                    </div>
                )}
                {/* Golden gradient overlay on hover */}
                <div className="absolute inset-0 bg-gradient-to-t from-amber-dark/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 z-20 pointer-events-none" />
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
