import { sortGalleryAlbums, sortGalleryCategories } from './galleryOrder'

export const MUSEUM_DIMENSIONS = Object.freeze({
    hallHalfWidth: 4.4,
    hallHeight: 6.8,
    lobbyFrontZ: 12,
    firstBayZ: -7,
    baySpacing: 14,
    roomSpan: 10,
    paintingSpacing: 3.35,
})

function normalizedCategory(value) {
    const category = String(value || '').trim()
    return category || 'Uncategorized'
}

function isPublicPhotoAlbum(album) {
    return album?.type === 'photo'
        && album?.visibility !== 'link-only'
        && album?.visibility !== 'private'
        && Boolean(album?.albumId && (album?.coverThumbnailUrl || album?.coverImageUrl || album?.coverThumbKey))
}

export function buildMuseumCatalog(albums = []) {
    const unique = new Map()
    for (const album of albums) {
        if (!isPublicPhotoAlbum(album) || unique.has(album.albumId)) continue
        unique.set(album.albumId, { ...album, category: normalizedCategory(album.category) })
    }

    const grouped = {}
    for (const album of unique.values()) {
        grouped[album.category] ||= []
        grouped[album.category].push(album)
    }

    const categories = sortGalleryCategories(Object.keys(grouped), grouped)
    return categories.map((name) => ({
        id: `category-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'uncategorized'}`,
        name,
        albums: sortGalleryAlbums(grouped[name]),
    }))
}

function makePaintings(room) {
    const wallOffset = (MUSEUM_DIMENSIONS.roomSpan / 2) - 0.12
    return room.albums.map((album, index) => {
        const row = Math.floor(index / 2)
        const onNearWall = index % 2 === 0
        const z = room.centerZ + (onNearWall ? -wallOffset : wallOffset)
        const x = room.side * (
            MUSEUM_DIMENSIONS.hallHalfWidth
            + 2.7
            + (row * MUSEUM_DIMENSIONS.paintingSpacing)
        )
        return {
            id: album.albumId,
            album,
            position: [x, 2.45, z],
            rotationY: onNearWall ? 0 : Math.PI,
            normal: [0, 0, onNearWall ? 1 : -1],
        }
    })
}

function makeBenches(room) {
    const rows = Math.ceil(room.albums.length / 2)
    const benches = []
    for (let row = 1; row < rows; row += 3) {
        const x = room.side * (
            MUSEUM_DIMENSIONS.hallHalfWidth
            + 2.7
            + (row * MUSEUM_DIMENSIONS.paintingSpacing)
        )
        benches.push({
            id: `${room.id}-bench-${row}`,
            position: [x, 0.42, room.centerZ],
            size: [1.55, 0.48, 2.7],
        })
    }
    return benches
}

export function buildMuseumLayout(categories = []) {
    const rooms = categories.map((category, index) => {
        const side = index % 2 === 0 ? -1 : 1
        const bay = Math.floor(index / 2)
        const rows = Math.max(1, Math.ceil(category.albums.length / 2))
        const depth = 6.2 + (rows * MUSEUM_DIMENSIONS.paintingSpacing)
        const centerZ = MUSEUM_DIMENSIONS.firstBayZ - (bay * MUSEUM_DIMENSIONS.baySpacing)
        const innerX = side * MUSEUM_DIMENSIONS.hallHalfWidth
        const outerX = side * (MUSEUM_DIMENSIONS.hallHalfWidth + depth)
        const room = {
            ...category,
            side,
            bay,
            centerZ,
            depth,
            innerX,
            outerX,
            centerX: (innerX + outerX) / 2,
            entrance: [side * MUSEUM_DIMENSIONS.hallHalfWidth, 0, centerZ],
            bounds: {
                minX: Math.min(innerX, outerX),
                maxX: Math.max(innerX, outerX),
                minZ: centerZ - (MUSEUM_DIMENSIONS.roomSpan / 2),
                maxZ: centerZ + (MUSEUM_DIMENSIONS.roomSpan / 2),
            },
        }
        room.paintings = makePaintings(room)
        room.benches = makeBenches(room)
        return room
    })

    const bayCount = Math.max(1, Math.ceil(categories.length / 2))
    const hallBackZ = MUSEUM_DIMENSIONS.firstBayZ
        - ((bayCount - 1) * MUSEUM_DIMENSIONS.baySpacing)
        - 9

    return {
        rooms,
        hallBackZ,
        hallLength: MUSEUM_DIMENSIONS.lobbyFrontZ - hallBackZ,
        spawn: [0, 1.68, 9.5],
        desk: {
            position: [0, 0.72, 4.25],
            size: [3.8, 1.44, 1.15],
        },
    }
}

function insideRect(x, z, rect, radius = 0) {
    return x >= rect.minX + radius
        && x <= rect.maxX - radius
        && z >= rect.minZ + radius
        && z <= rect.maxZ - radius
}

function intersectsObstacle(x, z, obstacle, radius) {
    const [ox, , oz] = obstacle.position
    const [width, , depth] = obstacle.size
    return x > ox - (width / 2) - radius
        && x < ox + (width / 2) + radius
        && z > oz - (depth / 2) - radius
        && z < oz + (depth / 2) + radius
}

export function isMuseumPositionWalkable(layout, x, z, radius = 0.35) {
    const inHall = Math.abs(x) <= MUSEUM_DIMENSIONS.hallHalfWidth - radius
        && z <= MUSEUM_DIMENSIONS.lobbyFrontZ - radius
        && z >= layout.hallBackZ + radius
    const inRoom = layout.rooms.some(room => insideRect(x, z, room.bounds, radius))
    if (!inHall && !inRoom) return false

    const obstacles = [layout.desk, ...layout.rooms.flatMap(room => room.benches)]
    return !obstacles.some(obstacle => intersectsObstacle(x, z, obstacle, radius))
}

export function moveMuseumPosition(layout, current, delta, radius = 0.35) {
    const next = { x: current.x, z: current.z }
    const proposedX = current.x + delta.x
    if (isMuseumPositionWalkable(layout, proposedX, current.z, radius)) next.x = proposedX
    const proposedZ = current.z + delta.z
    if (isMuseumPositionWalkable(layout, next.x, proposedZ, radius)) next.z = proposedZ
    return next
}

export function nearestMuseumRoom(layout, position, preloadDistance = 4.5) {
    for (const room of layout.rooms) {
        if (insideRect(position.x, position.z, room.bounds, 0)) return room.id
        const [entranceX, , entranceZ] = room.entrance
        if (Math.hypot(position.x - entranceX, position.z - entranceZ) <= preloadDistance) return room.id
    }
    return null
}

