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
    portalGateDepth: 0.25,
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
        // Keep the far wall reserved for the category title. Every album hangs
        // on one of the two long walls in a consistent alternating rhythm.
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
            scale: [1, 1, 1],
        }
    })
}

function makeBenches(room) {
    if (!room.albums.length) return []
    // Short galleries use one focal bench. Archive-scale galleries are split
    // into evenly spaced viewing salons so a 70-album room does not read as an
    // empty hundred-metre tunnel with one seat at the vanishing point. Every
    // bench stays exactly on the room axis and follows the same rhythm; there
    // are no random offsets to make the procedural layout feel accidental.
    // Give long archive rooms a readable cadence roughly every 24 metres.
    // The six-salon cap keeps the shared instanced furniture and architectural
    // dressing bounded even when one category contains hundreds of albums.
    const benchCount = Math.min(6, Math.max(1, Math.ceil(room.depth / 24)))
    return Array.from({ length: benchCount }, (_, index) => {
        const depthRatio = (index + 1) / (benchCount + 1)
        return {
            id: `${room.id}-bench-${index + 1}`,
            position: [
                room.innerX + (room.side * room.depth * depthRatio),
                0.42,
                room.centerZ,
            ],
            size: [1.86, 0.42, 3.2],
            // The artwork faces inward from the two transverse walls. Turning
            // the long axis across the room creates a deliberate viewing axis.
            rotationY: Math.PI / 2,
        }
    })
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
    }
    const obstacles = [
        {
            position: [0, 0.69, 6.4],
            size: [4.3, 1.38, 1.3],
        },
        ...dressing.lobbyPlants,
        ...dressing.hallPlants,
        ...rooms.flatMap(room => [
            ...room.benches,
            ...room.plants,
        ]),
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
    const rotation = Number(obstacle.rotationY) || 0
    const cosine = Math.cos(rotation)
    const sine = Math.sin(rotation)
    const dx = x - ox
    const dz = z - oz
    // Test the visitor capsule in the prop's local axes. This keeps collision
    // aligned with rendered benches and authored furniture after rotation,
    // rather than leaving an invisible axis-aligned box around the old pose.
    const localX = (dx * cosine) + (dz * sine)
    const localZ = (-dx * sine) + (dz * cosine)
    return Math.abs(localX) < (width / 2) + radius
        && Math.abs(localZ) < (depth / 2) + radius
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
        ...layout.rooms.flatMap(room => [...room.benches, ...room.plants].filter(Boolean)),
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

function crossesMuseumRoomBoundary(layout, current, proposed, passableRoomIds, radius) {
    return layout.rooms.some((room) => {
        const previousDepth = (current.x - room.innerX) * room.side
        const proposedDepth = (proposed.x - room.innerX) * room.side
        const transverseDistance = Math.abs(proposed.z - room.centerZ)
        if (transverseDistance > (room.width / 2) + radius) return false
        const insideDoorway = transverseDistance
            <= (MUSEUM_DIMENSIONS.doorwayWidth / 2) - radius
        if (!insideDoorway) {
            // A large diagonal step must not jump directly from the hall into
            // room bounds through the solid wall beside the portal.
            const wallStopDepth = -radius
            return previousDepth <= wallStopDepth && proposedDepth > wallStopDepth
        }
        if (!passableRoomIds || passableRoomIds.has(room.id)) return false
        // Collision follows the actual curtain plane. Entry is blocked until
        // the animated panels report a safely open aperture, while movement
        // from the room back into the hall is intentionally never trapped.
        const stopDepth = MUSEUM_DIMENSIONS.portalGateDepth - radius
        return previousDepth <= stopDepth && proposedDepth > stopDepth
    })
}

export function moveMuseumPosition(layout, current, delta, radius = 0.35, passableRoomIds = null) {
    const next = { x: current.x, z: current.z }
    const proposedX = current.x + delta.x
    if (
        isMuseumPositionWalkable(layout, proposedX, current.z, radius)
        && !crossesMuseumRoomBoundary(
            layout,
            current,
            { x: proposedX, z: current.z },
            passableRoomIds,
            radius,
        )
    ) next.x = proposedX
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

export function museumFloorSurface(layout, position) {
    const x = Number(position?.x)
    const z = Number(position?.z)
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 'carpet'

    // `nearestMuseumRoom` intentionally activates a gallery a few metres
    // before its threshold so streaming can finish behind the physical gate.
    // That proximity signal must not drive footsteps: the corridor remains
    // carpeted until the visitor's capsule has actually crossed the room's
    // inner structural face. The small inset keeps a foot planted directly on
    // the brass threshold from rapidly alternating surfaces due to float
    // precision while the other foot is still in the hall.
    const inGallery = layout.rooms.some((room) => {
        const depth = (x - room.innerX) * room.side
        return depth > 0.08
            && insideRect(x, z, room.bounds, 0)
    })
    return inGallery ? 'wood' : 'carpet'
}

export function museumArtworkLightIndex(paintingCount, slot, requestedSlots) {
    const count = Math.max(0, Math.floor(Number(paintingCount) || 0))
    const slotCount = Math.max(0, Math.floor(Number(requestedSlots) || 0))
    const activeSlotCount = Math.min(count, slotCount)
    if (slot < 0 || slot >= activeSlotCount) return -1
    if (activeSlotCount === 1) return 0
    // Spread the resident fixture budget over the complete wall run. For a
    // small two- or three-work room this deliberately resolves to every work;
    // larger collections receive evenly distributed localized light pools.
    return Math.round((slot * (count - 1)) / (activeSlotCount - 1))
}

export function museumRoomCeilingFixtureXs(room = {}, requestedFixtures = 4) {
    const rowXs = [...new Set((room.paintings || [])
        .map(painting => Number(painting?.position?.[0]))
        .filter(Number.isFinite))]
    const fixtureCount = Math.min(
        rowXs.length,
        Math.max(0, Math.floor(Number(requestedFixtures) || 0)),
    )
    return Array.from({ length: fixtureCount }, (_, slot) => (
        rowXs[museumArtworkLightIndex(rowXs.length, slot, fixtureCount)]
    ))
}

function transformMuseumPaintingPoint(painting, [localX, localY, localZ]) {
    const [x = 0, y = 0, z = 0] = painting?.position || []
    const [scaleX = 1, scaleY = 1, scaleZ = 1] = painting?.scale || []
    const rotationY = Number(painting?.rotationY) || 0
    const scaledX = localX * scaleX
    const scaledZ = localZ * scaleZ
    const cosine = Math.cos(rotationY)
    const sine = Math.sin(rotationY)
    return [
        x + (scaledX * cosine) + (scaledZ * sine),
        y + (localY * scaleY),
        z - (scaledX * sine) + (scaledZ * cosine),
    ]
}

export function museumPictureLightPose(painting) {
    return {
        // These are the same authored local coordinates used by
        // InstancedPictureLights for the diffuser and artwork face.
        source: transformMuseumPaintingPoint(painting, [0, 1.245, 0.52]),
        target: transformMuseumPaintingPoint(painting, [0, 0, 0.04]),
    }
}

export function museumCeilingLightPose(x, z, fixtureCeilingY) {
    return {
        // InstancedCeilingFixtures places its lens 0.142 m below this datum.
        source: [Number(x) || 0, (Number(fixtureCeilingY) || 0) - 0.142, Number(z) || 0],
        target: [Number(x) || 0, 0.12, Number(z) || 0],
    }
}

export function retainMuseumRoomPresentation(active, gateClosed) {
    // Retirement is delayed only for the physical closing interval. A room
    // prepares immediately when active, remains furnished behind a closing
    // curtain, and can release its batched presentation once fully concealed.
    return Boolean(active) || !gateClosed
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
    // Keep both rooms at the current bay warm. Architecture is permanently
    // resident, while this list only controls real cover promotion and lights.
    return nearby.slice(0, 2).map(room => room.id)
}

export function initialMuseumRoomIds(layout, position, preloadDistance = 25, fallbackCount = 2) {
    const nearby = nearbyMuseumRoomIds(layout, position, preloadDistance)
    if (nearby.length) return nearby
    return layout.rooms.slice(0, Math.max(0, fallbackCount)).map(room => room.id)
}

export function prioritizeMuseumPreloadRooms(rooms = [], currentRoomId, limit = 3) {
    if (!rooms.length || limit <= 0) return []
    const current = rooms.find(room => room.id === currentRoomId) || rooms[0]
    const distanceFromCurrent = room => Math.hypot(
        Number(room.innerX ?? room.centerX ?? 0) - Number(current.innerX ?? current.centerX ?? 0),
        Number(room.centerZ ?? 0) - Number(current.centerZ ?? 0),
    )
    const nearby = rooms
        .filter(room => room.id !== current.id)
        .sort((left, right) => (
            distanceFromCurrent(left) - distanceFromCurrent(right)
            || String(left.id).localeCompare(String(right.id))
        ))
    return [current, ...nearby].slice(0, Math.min(limit, rooms.length))
}
