import { useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router'
import { albumCoverUrl } from '../utils/mediaUrls'

const TILT_PATTERN = [-0.3, 0.14, 0.28, -0.12]

function GalleryCard({ album, position }) {
    return (
        <Link
            to={`/album/${album.albumId}`}
            className="floating-print-card"
            aria-label={`View ${album.title}`}
            style={{ '--floating-tilt': `${TILT_PATTERN[position % TILT_PATTERN.length]}deg` }}
        >
            <span className="floating-frame-number">{String(position + 1).padStart(2, '0')}</span>
            <img src={albumCoverUrl(album)} alt="" loading="lazy" decoding="async" />
            <span className="floating-card-copy">
                <strong data-title={album.title} />
                <small data-category={album.category || 'Uncategorized'} />
            </span>
        </Link>
    )
}

function LoopGroup({ albums, hidden = false, offset = 0 }) {
    return (
        <div className="floating-loop-group" aria-hidden={hidden || undefined} inert={hidden || undefined}>
            {albums.map((album, index) => (
                <GalleryCard
                    key={`${hidden ? 'copy' : 'source'}-${offset}-${album.albumId}`}
                    album={album}
                    position={index + offset}
                />
            ))}
        </div>
    )
}

function Lane({ albums, lane, interactive = true }) {
    return (
        <div className={`floating-lane floating-lane-${lane}`}>
            <div className="floating-loop-track">
                <LoopGroup albums={albums} hidden={!interactive} offset={lane} />
                <LoopGroup albums={albums} hidden offset={lane} />
            </div>
        </div>
    )
}

export default function FloatingGallery({ albums }) {
    const stageRef = useRef(null)
    const featuredAlbums = useMemo(
        () => albums.filter((album) => Boolean(albumCoverUrl(album))).slice(0, 10),
        [albums],
    )

    useEffect(() => {
        const stage = stageRef.current
        if (!stage || typeof IntersectionObserver === 'undefined') return undefined
        const observer = new IntersectionObserver(([entry]) => {
            stage.classList.toggle('is-floating-visible', entry.isIntersecting)
        }, { rootMargin: '25% 0px', threshold: 0 })
        observer.observe(stage)
        return () => observer.disconnect()
    }, [])

    if (!featuredAlbums.length) return null

    return (
        <section ref={stageRef} className="floating-print-wall" aria-label="Featured photo albums">
            <div className="floating-stage">
                <Lane albums={featuredAlbums} lane={0} />
                <Lane albums={[...featuredAlbums.slice(1), featuredAlbums[0]]} lane={1} interactive={false} />
                <Lane albums={[...featuredAlbums.slice(2), ...featuredAlbums.slice(0, 2)]} lane={2} interactive={false} />
            </div>
        </section>
    )
}
