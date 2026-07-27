import { Link } from 'react-router'
import ProgressiveImage from './ProgressiveImage'
import { albumCoverUrl } from '../utils/mediaUrls'

// Shared album card used by public, video, and signed-in catalogs.
function AlbumCard({ album, onOpen, onImageError, onMouseEnter }) {
    // Determine the route: jump directly to video player if only 1 video
    const isSingleVideo = album.type === 'video' && album.imageCount === 1
    const targetRoute = isSingleVideo
        ? `/video/${album.albumId}?play=1`
        : `/${album.type === 'video' ? 'video' : 'album'}/${album.albumId}`

    const content = (
        <>
            {/* Cover image with warm overlay on hover */}
            <div className="album-card-image relative aspect-[4/3] overflow-hidden bg-cream-dark">
                {albumCoverUrl(album) ? (
                    <ProgressiveImage
                        src={albumCoverUrl(album)}
                        blurhash={album.coverBlurhash}
                        alt={album.title}
                        width={album.coverWidth || 4}
                        height={album.coverHeight || 3}
                        onError={onImageError}
                        sizes="(min-width: 768px) 360px, (min-width: 640px) 320px, 280px"
                        className="w-full h-full"
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center">
                        <svg className="w-12 h-12 text-warm-gray/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                    </div>
                )}
                {album.type === 'video' && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="album-play w-12 h-12 flex items-center justify-center text-white relative">
                            {album.imageCount > 1 && (
                                <div className="absolute -top-1 -right-1 bg-amber text-xs font-bold w-5 h-5 flex items-center justify-center border border-cream">
                                    {album.imageCount}
                                </div>
                            )}
                            {album.imageCount > 1 ? (
                                <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z" />
                                </svg>
                            ) : (
                                <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                            )}
                        </div>
                    </div>
                )}
                {/* Golden gradient overlay on hover */}
                <div className="album-card-wash absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 z-20 pointer-events-none" />
            </div>

            {/* Card info */}
            <div className="album-card-copy py-4 flex-1 flex flex-col">
                <h3 className="font-serif text-xl font-normal text-charcoal group-hover:text-amber-dark transition-colors duration-300">
                    {album.title}
                </h3>
                {album.description && (
                    <p className="mt-1 text-sm text-warm-gray line-clamp-2">
                        {album.description}
                    </p>
                )}
                {album.createdAt && (
                    <p className="mt-auto pt-4 text-xs text-warm-gray/70">
                        {new Date(album.createdAt).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                        })}
                    </p>
                )}
            </div>
        </>
    )

    const className = 'album-card group flex w-full flex-col h-full overflow-hidden transition-all duration-500 text-left cursor-pointer'

    if (onOpen) {
        return (
            <button type="button" onClick={onOpen} onMouseEnter={onMouseEnter} className={className} aria-label={`Open ${album.title}`}>
                {content}
            </button>
        )
    }

    return (
        <Link to={targetRoute} onMouseEnter={onMouseEnter} className={className}>
            {content}
        </Link>
    )
}

export default AlbumCard
