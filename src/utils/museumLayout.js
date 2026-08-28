import { sortGalleryAlbums, sortGalleryCategories } from './galleryOrder'

export const MUSEUM_DIMENSIONS = Object.freeze({
    hallHalfWidth: 4.8,
    hallHeight: 7.4,
    doorwayWidth: 4.6,
    lobbyFrontZ: 14,
    firstBayZ: -7,
    baySpacing: 16.5,
    roomSpan: 12.5,
    paintingSpacing: 5.6,
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
    const wallOffset = (room.width / 2) - 0.12
    return room.albums.map((album, index) => {
        const row = Math.floor(index / 2)
        const onNearWall = index % 2 === 0
        const z = room.centerZ + (onNearWall ? -wallOffset : wallOffset)
        const x = room.side * (
            MUSEUM_DIMENSIONS.hallHalfWidth
            + 4.15
            + (row * MUSEUM_DIMENSIONS.paintingSpacing)
        )
        return {
            id: album.albumId,
            album,
            position: [x, 2.65, z],
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
            + 4.15
            + ((row - 0.5) * MUSEUM_DIMENSIONS.paintingSpacing)
        )
        benches.push({
            id: `${room.id}-bench-${row}`,
            position: [x, 0.42, room.centerZ],
            size: [1.7, 0.42, 3.15],
        })
    }
    return benches
}

function makeRoomPlants(room) {
    const insetX = room.outerX - (room.side * 0.72)
    const insetZ = (room.width / 2) - 0.78
    return [-1, 1].map(direction => ({
        id: `${room.id}-plant-${direction}`,
        position: [insetX, 0, room.centerZ + (direction * insetZ)],
        size: [0.9, 1.75, 0.9],
        rotationY: direction * 0.34,
    }))
}

export function buildMuseumLayout(categories = []) {
    const rooms = categories.map((category, index) => {
        const side = index % 2 === 0 ? -1 : 1
        const bay = Math.floor(index / 2)
        const rows = Math.max(1, Math.ceil(category.albums.length / 2))
        const width = category.albums.length <= 2
            ? 9.4
            : category.albums.length <= 6
                ? 10.8
                : MUSEUM_DIMENSIONS.roomSpan
        const depth = 9.2 + ((rows - 1) * MUSEUM_DIMENSIONS.paintingSpacing)
        const centerZ = MUSEUM_DIMENSIONS.firstBayZ - (bay * MUSEUM_DIMENSIONS.baySpacing)
        const innerX = side * MUSEUM_DIMENSIONS.hallHalfWidth
        const outerX = side * (MUSEUM_DIMENSIONS.hallHalfWidth + depth)
        const room = {
            ...category,
            side,
            bay,
            centerZ,
            depth,
            width,
            innerX,
            outerX,
            centerX: (innerX + outerX) / 2,
            entrance: [side * MUSEUM_DIMENSIONS.hallHalfWidth, 0, centerZ],
            bounds: {
                minX: Math.min(innerX, outerX),
                maxX: Math.max(innerX, outerX),
                minZ: centerZ - (width / 2),
                maxZ: centerZ + (width / 2),
            },
        }
        room.paintings = makePaintings(room)
        room.benches = makeBenches(room)
        room.plants = makeRoomPlants(room)
        return room
    })

    const bayCount = Math.max(1, Math.ceil(categories.length / 2))
    const hallBackZ = MUSEUM_DIMENSIONS.firstBayZ
        - ((bayCount - 1) * MUSEUM_DIMENSIONS.baySpacing)
        - 11

    const lobbyPlants = [-1, 1].map(side => ({
        id: `lobby-plant-${side}`,
        position: [side * 4.02, 0, 11.12],
        size: [0.94, 1.9, 0.94],
        rotationY: side * 0.28,
    }))
    // Keep the welcome ropes tucked alongside the desk rather than projecting
    // into the route visitors use to enter the main hall.
    const stanchions = [-1, 1].flatMap(side => [
        {
            id: `stanchion-${side}-front`,
            position: [side * 2.68, 0, 6.96],
            size: [0.34, 1.08, 0.34],
        },
        {
            id: `stanchion-${side}-back`,
            position: [side * 2.68, 0, 5.48],
            size: [0.34, 1.08, 0.34],
        },
    ])
    const terminalSculpture = {
        id: 'terminal-sculpture',
        position: [0, 0, hallBackZ + 2.05],
        size: [1.75, 2.9, 1.75],
    }
    const hallPlants = Array.from({ length: bayCount }, (_, bay) => {
        const side = bay % 2 === 0 ? -1 : 1
        return {
            id: `hall-plant-${bay}`,
            position: [side * 4.02, 0, MUSEUM_DIMENSIONS.firstBayZ - (bay * MUSEUM_DIMENSIONS.baySpacing) + 5.3],
            size: [0.86, 1.7, 0.86],
            rotationY: side * 0.42,
        }
    })

    const dressing = {
        lobbyPlants,
        hallPlants,
        stanchions,
        terminalSculpture,
    }
    const obstacles = [
        {
            position: [0, 0.69, 6.4],
            size: [4.3, 1.38, 1.3],
        },
        ...dressing.lobbyPlants,
        ...dressing.hallPlants,
        ...dressing.stanchions,
        dressing.terminalSculpture,
        ...rooms.flatMap(room => [...room.benches, ...room.plants]),
    ]

    return {
        rooms,
        hallBackZ,
        hallLength: MUSEUM_DIMENSIONS.lobbyFrontZ - hallBackZ,
        spawn: [0, 1.7, 11.25],
        desk: {
            position: [0, 0.69, 6.4],
            size: [4.3, 1.38, 1.3],
        },
        dressing,
        obstacles,
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
    const inDoorway = layout.rooms.some((room) => (
        Math.abs(z - room.centerZ) <= (MUSEUM_DIMENSIONS.doorwayWidth / 2) - radius
        && x >= room.innerX - radius
        && x <= room.innerX + radius
    ))
    if (!inHall && !inRoom && !inDoorway) return false

    const obstacles = layout.obstacles || [
        layout.desk,
        ...layout.dressing.lobbyPlants,
        ...layout.dressing.hallPlants,
        ...layout.dressing.stanchions,
        layout.dressing.terminalSculpture,
        ...layout.rooms.flatMap(room => [...room.benches, ...room.plants]),
    ]
    return !obstacles.some(obstacle => intersectsObstacle(x, z, obstacle, radius))
}

export function museumPlanarAxes(forwardX, forwardZ) {
    const length = Math.hypot(forwardX, forwardZ) || 1
    const forward = { x: forwardX / length, z: forwardZ / length }
    return {
        forward,
        right: { x: -forward.z, z: forward.x },
    }
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
    const contained = layout.rooms.find(room => insideRect(position.x, position.z, room.bounds, 0))
    if (contained) return contained.id

    let nearest = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const room of layout.rooms) {
        const [entranceX, , entranceZ] = room.entrance
        const distance = Math.hypot(position.x - entranceX, position.z - entranceZ)
        if (distance <= preloadDistance && distance < nearestDistance) {
            nearest = room.id
            nearestDistance = distance
        }
    }
    return nearest
}

export function nearbyMuseumRoomIds(layout, position, preloadDistance = 25) {
    const nearby = layout.rooms
        .map((room) => {
            const [entranceX, , entranceZ] = room.entrance
            return {
                id: room.id,
                contained: insideRect(position.x, position.z, room.bounds, 0),
                distance: Math.hypot(position.x - entranceX, position.z - entranceZ),
            }
        })
        .filter(room => room.contained || room.distance <= preloadDistance)
        .sort((left, right) => Number(right.contained) - Number(left.contained) || left.distance - right.distance)
    // Keep one complete hall bay live at a time. Distant rooms retain their
    // lightweight framed placeholders, while the next bay becomes the nearer
    // pair early enough to stream before the visitor reaches its arches.
    return nearby.slice(0, 2).map(room => room.id)
}
