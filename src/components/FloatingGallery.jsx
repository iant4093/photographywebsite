import { useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router'
import { albumCoverUrl } from '../utils/mediaUrls'

const TILT_PATTERN = [-0.3, 0.14, 0.28, -0.12]
const LANE_COUNT = 3
const MAX_ALBUMS_PER_LANE = 10
const PAGE_RANDOM_SEED = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random()}`
const EDGE_FADE = 'linear-gradient(90deg,transparent,#000 3%,#000 97%,transparent)'
const EDGE_FADE_STYLE = {
    WebkitMaskImage: EDGE_FADE,
    maskImage: EDGE_FADE,
}

function hashString(value) {
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function galleryAlbumKey(album, index) {
    return String(
        album?.albumId
        || album?.coverThumbKey
        || album?.coverImageUrl
        || album?.title
        || index,
    )
}

function buildGalleryLanes(albums, seed = PAGE_RANDOM_SEED) {
    const seen = new Set()
    const randomizedAlbums = albums
        .map((album, index) => ({
            album,
            key: galleryAlbumKey(album, index),
            rank: hashString(`${seed}:${galleryAlbumKey(album, index)}`),
            index,
        }))
        .filter(({ album, key }) => {
            if (!albumCoverUrl(album) || seen.has(key)) return false
            seen.add(key)
            return true
        })
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .map(({ album }) => album)

    const laneLength = Math.min(MAX_ALBUMS_PER_LANE, randomizedAlbums.length)
    if (!laneLength) return []

    return Array.from({ length: LANE_COUNT }, (_, laneIndex) => {
        const start = (laneIndex * laneLength) % randomizedAlbums.length
        return Array.from(
            { length: laneLength },
            (_, albumIndex) => randomizedAlbums[(start + albumIndex) % randomizedAlbums.length],
        )
    })
}

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

function LoopGroup({ albums, copy = false, offset = 0 }) {
    return (
        <div className="floating-loop-group">
            {albums.map((album, index) => (
                <GalleryCard
                    key={`${copy ? 'copy' : 'source'}-${offset}-${album.albumId}`}
                    album={album}
                    position={index + offset}
                />
            ))}
        </div>
    )
}

function Lane({ albums, lane }) {
    return (
        <div
            className={`floating-lane floating-lane-${lane}`}
            style={EDGE_FADE_STYLE}
        >
            <div className="floating-loop-track">
                <LoopGroup albums={albums} offset={lane} />
                <LoopGroup albums={albums} copy offset={lane} />
            </div>
        </div>
    )
}

export default function FloatingGallery({ albums }) {
    const stageRef = useRef(null)
    const albumLanes = useMemo(
        () => buildGalleryLanes(albums),
        [albums],
    )

    useEffect(() => {
        if (!albumLanes.length) return undefined
        const stage = stageRef.current
        if (!stage) return undefined
        if (typeof IntersectionObserver === 'undefined') {
            stage.classList.add('is-floating-visible')
            return undefined
        }
        const observer = new IntersectionObserver(([entry]) => {
            stage.classList.toggle('is-floating-visible', entry.isIntersecting)
        }, { rootMargin: '25% 0px', threshold: 0 })
        observer.observe(stage)
        return () => observer.disconnect()
    }, [albumLanes.length])

    if (!albumLanes.length) return null

    return (
        <section ref={stageRef} className="floating-print-wall" aria-label="Featured photo albums">
            <div className="floating-stage">
                {albumLanes.map((laneAlbums, lane) => (
                    <Lane
                        key={lane}
                        albums={laneAlbums}
                        lane={lane}
                    />
                ))}
            </div>
        </section>
    )
}
