import { sortGalleryAlbums, sortGalleryCategories } from './galleryOrder'
import { MUSEUM_PLANT_FORM, museumPlantFoliageRadius } from './museumPlants'
import { museumGalleryDisplays } from './museumDecor'
import { createMuseumReceptionDesk } from './museumReceptionDesk'

export const MUSEUM_DIMENSIONS = Object.freeze({
    hallHalfWidth: 4.8,
    hallHeight: 8.5,
    hallWallThickness: 0.32,
    roomWallThickness: 0.24,
    roomCeilingY: 6.15,
    roomFixtureY: 5.91,
    // Four centimetres of structural overlap seals both mirrored wall joins.
    roomShellInset: 0.12,
    artworkWallOffset: 0.26,
    wallSurfaceGap: 0.018,
    doorwayWidth: 4.6,
    lobbyFrontZ: 14,
    firstBayZ: -7,
    baySpacing: 16.5,
    roomSpan: 12.5,
    paintingSpacing: 5.6,
    portalGateDepth: 0.25,
})

export const MUSEUM_VAULT = Object.freeze({
    radius: 6.35,
    centerY: 1.95,
    ribRadius: 0.075,
    corniceY: 6.08,
    fixtureY: 8.23,
})

export function museumVaultHeightAt(x) {
    return MUSEUM_VAULT.centerY + Math.sqrt(Math.max(0, MUSEUM_VAULT.radius ** 2 - x ** 2))
}

export const MUSEUM_PORTAL = Object.freeze({
    springHeight: 2.7,
    rise: 1.55,
    bandWidth: 0.4,
    depth: 0.26,
    signHeight: 5.3,
    signSurroundWidth: 3.6,
    signSurroundHeight: 1.12,
    signRear: -0.19,
    // Ordered from the floor to the spring line. Adjacent sections share a
    // face instead of putting the arch through an oversized capital.
    pierSections: [
        { name: 'foot', y: 0.0975, height: 0.125, width: 0.64, depth: 0.32, color: '#796449' },
        { name: 'base', y: 0.22, height: 0.12, width: 0.54, depth: 0.3, color: '#ad9c84' },
        { name: 'shaft', y: 1.38, height: 2.2, width: 0.4, depth: 0.26, color: '#b8aa96' },
        { name: 'capital', y: 2.54, height: 0.12, width: 0.52, depth: 0.3, color: '#ad9c84' },
        { name: 'abacus', y: 2.65, height: 0.1, width: 0.6, depth: 0.32, color: '#796449' },
    ],
})

export function museumDoorAssemblyPose(side, centerZ) {
    // The spandrel's bevel projects 2 cm into the hall. Seat the trim and the
    // sign's rear face on it, rather than retaining an arbitrary hover offset.
    const surface = MUSEUM_DIMENSIONS.hallHalfWidth - MUSEUM_DIMENSIONS.hallWallThickness / 2 - 0.02
    return {
        rotationY: side < 0 ? Math.PI / 2 : -Math.PI / 2,
        trim: [side * surface, 0, centerZ],
        sign: [side * (surface + MUSEUM_PORTAL.signRear), MUSEUM_PORTAL.signHeight, centerZ],
    }
}

export const MUSEUM_ARTWORK_SURFACES = Object.freeze({
    backing: -0.08,
    backingDepth: 0.08,
    plaque: -0.105,
    plaqueY: -1.51,
    plaqueBacking: -0.114,
    plaqueBackingDepth: 0.016,
    lip: 0.154,
    lipDepth: 0.045,
    placeholder: 0.179,
    base: 0.181,
    detail: 0.185,
    glass: 0.19,
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
    const wallOffset = (room.width / 2) - MUSEUM_DIMENSIONS.artworkWallOffset
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

export function museumRoomShell(room) {
    const inset = MUSEUM_DIMENSIONS.roomShellInset
    return {
        depth: room.depth - inset,
        centerX: room.centerX + (room.side * inset / 2),
        innerX: room.innerX + (room.side * inset),
    }
}

export function museumRoomRibXs(room) {
    const rows = [...new Set(room.paintings.map(painting => painting.position[0]))]
    // Align piers to gaps between actual frames, never to furniture placement.
    // A bounded set of ribs gives long galleries a rhythm at constant cost.
    const gaps = rows.slice(0, -1).map((x, index) => (x + rows[index + 1]) / 2)
    const count = Math.min(6, Math.ceil(gaps.length / 3))
    return Array.from({ length: count }, (_, index) => (
        gaps[Math.min(gaps.length - 1, Math.floor((index + 0.5) * gaps.length / count))]
    ))
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

function makePlant({ renderScale, renderVariant, ...plant }) {
    const radius = museumPlantFoliageRadius(renderScale, renderVariant)
    return { ...plant, renderScale, renderVariant, size: [radius * 2, 1.95 * renderScale, radius * 2] }
}

function makeRoomPlants(room, roomIndex) {
    return [-1, 1].map((direction, plantIndex) => {
        const renderScale = [0.82, 0.94, 1.06][(roomIndex + plantIndex) % 3]
        const renderVariant = (roomIndex + plantIndex) % 2
        // Reserve the complete foliage envelope plus the deepest corner trim.
        const inset = museumPlantFoliageRadius(renderScale, renderVariant) + 0.3 + MUSEUM_PLANT_FORM.wallClearance
        return makePlant({
            id: `${room.id}-plant-${direction}`,
            position: [room.outerX - room.side * inset, 0, room.centerZ + direction * (room.width / 2 - inset)],
            rotationY: direction * 0.34 + ((roomIndex % 3) - 1) * 0.22,
            renderScale,
            renderVariant,
        })
    })
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
        room.plants = makeRoomPlants(room, index)
        return room
    })

    const bayCount = Math.max(1, Math.ceil(categories.length / 2))
    const hallBackZ = MUSEUM_DIMENSIONS.firstBayZ
        - ((bayCount - 1) * MUSEUM_DIMENSIONS.baySpacing)
        - 11

    const lobbyPlants = [-1, 1].map((side, index) => {
        const renderScale = 1.05
        const renderVariant = index % 2
        const inset = museumPlantFoliageRadius(renderScale, renderVariant) + MUSEUM_PLANT_FORM.wallClearance
        return makePlant({
            id: `lobby-plant-${side}`,
            position: [side * (4.56 - inset), 0, 11.12],
            rotationY: side * 0.28,
            renderScale,
            renderVariant,
        })
    })
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
        const renderScale = 0.9
        const renderVariant = (bay + 1) % 2
        const inset = museumPlantFoliageRadius(renderScale, renderVariant) + MUSEUM_PLANT_FORM.wallClearance
        return makePlant({
            id: `hall-plant-${bay}`,
            position: [side * (4.56 - inset), 0, MUSEUM_DIMENSIONS.firstBayZ - (bay * MUSEUM_DIMENSIONS.baySpacing) + 5.3],
            rotationY: side * 0.42,
            renderScale,
            renderVariant,
        })
    })

    const dressing = {
        lobbyPlants,
        hallPlants,
        stanchions,
    }
    dressing.displays = museumGalleryDisplays({ rooms, dressing })
    for (const room of rooms) room.displays = dressing.displays.filter(display => display.roomId === room.id)
    const roomByBayAndSide = new Map(rooms.map(room => [`${room.bay}:${room.side}`, room]))
    const archRadius = MUSEUM_DIMENSIONS.doorwayWidth / 2
    const halfBay = MUSEUM_DIMENSIONS.baySpacing / 2
    const doorPanelOffset = (archRadius + halfBay) / 2
    const doorPanelDepth = (halfBay - archRadius - 0.7) + 0.02
    const hallArchitectureObstacles = Array.from({ length: bayCount }, (_, bay) => {
        const centerZ = MUSEUM_DIMENSIONS.firstBayZ - (bay * MUSEUM_DIMENSIONS.baySpacing)
        return [-1, 1].flatMap((side) => {
            const room = roomByBayAndSide.get(`${bay}:${side}`)
            if (!room) {
                // FarDoorWall uses one shallow raised slab across an empty side
                // of an odd final bay. Its visible bounds are x 4.579–4.649 and
                // z 15.66m; model that exact projection in the planar solver.
                return [{
                    kind: 'hall-far-wall-panel',
                    position: [side * 4.614, 1.35, centerZ],
                    size: [0.07, 2.12, MUSEUM_DIMENSIONS.baySpacing - 0.84],
                }]
            }
            // DoorWall's nested panel layers occupy x 4.496–4.650. A single
            // collider around their union keeps the visitor capsule outside
            // the visible moulding while preserving the full arched doorway.
            return [-1, 1].flatMap(direction => [{
                kind: 'hall-door-wall-panel',
                position: [side * 4.573, 1.42, centerZ + (direction * doorPanelOffset)],
                size: [0.154, 2.84, doorPanelDepth],
            }, {
                kind: 'hall-door-pier',
                position: [
                    museumDoorAssemblyPose(side, centerZ).trim[0] - side * MUSEUM_PORTAL.depth / 2,
                    MUSEUM_PORTAL.springHeight / 2,
                    centerZ + direction * (archRadius + MUSEUM_PORTAL.bandWidth / 2),
                ],
                // Include the widest plinth so the camera cannot cut through
                // a projecting column while sliding along the hall wall.
                size: [
                    Math.max(...MUSEUM_PORTAL.pierSections.map(section => section.depth)),
                    MUSEUM_PORTAL.springHeight,
                    Math.max(...MUSEUM_PORTAL.pierSections.map(section => section.width)),
                ],
            }])
        })
    }).flat()
    const desk = createMuseumReceptionDesk()
    const obstacles = [
        desk,
        ...dressing.lobbyPlants,
        ...dressing.hallPlants,
        ...dressing.displays,
        ...hallArchitectureObstacles,
        ...rooms.flatMap(room => [
            ...room.benches,
            ...room.plants,
            // A smooth continuous stop follows the outermost artwork surface.
            // Without it a camera could enter the now correctly wall-mounted
            // frames; individual frame colliders would snag a wall-following walk.
            ...[-1, 1].map(direction => {
                const projection = MUSEUM_DIMENSIONS.artworkWallOffset + MUSEUM_ARTWORK_SURFACES.glass
                return {
                    kind: 'room-wall-presentation',
                    position: [room.centerX, 2.65, room.centerZ + direction * (room.width / 2 - projection / 2)],
                    size: [room.depth, 5.8, projection],
                }
            }),
        ]),
    ]

    return {
        rooms,
        hallBackZ,
        hallLength: MUSEUM_DIMENSIONS.lobbyFrontZ - hallBackZ,
        spawn: [0, 1.7, 11.25],
        desk,
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

export function museumEndWallPlacardPose(room = {}) {
    const side = Number(room.side) < 0 ? -1 : 1
    const outerX = Number(room.outerX) || 0
    const centerZ = Number(room.centerZ) || 0
    const centerY = 3.08
    return {
        backing: [outerX - (side * 0.145), centerY, centerZ],
        // The backing is 0.055 m deep. Keep the label only a few millimetres
        // proud of its gallery-facing surface so an oblique view cannot turn
        // that physical separation into visible parallax.
        label: [outerX - (side * 0.18), centerY, centerZ],
        rotationY: side < 0 ? Math.PI / 2 : -Math.PI / 2,
    }
}

export function museumRoomGateOpen({ active = false, requested = false } = {}) {
    // Artwork streaming is an I/O concern, not a physical lock. The room shell
    // and blurhash/colour placeholders are already resident, so the singular
    // approached curtain may animate immediately while compact covers finish.
    return Boolean(active && requested)
}

export function museumArtworkDetailWidth(distance, {
    focused = false,
    currentWidth = 0,
    inspectionWidth = 1440,
} = {}) {
    const numericDistance = Number(distance)
    if (!Number.isFinite(numericDistance) || numericDistance < 0) return 0
    if (focused && numericDistance <= 6.2) {
        return Number(inspectionWidth) >= 1440 ? 1440 : 960
    }
    // A three-metre release band prevents a painting at the boundary from
    // repeatedly mounting and cancelling its 640px upgrade while the camera
    // sways or the visitor takes a small step.
    const nearLimit = Number(currentWidth) >= 640 ? 27 : 24
    return numericDistance <= nearLimit ? 640 : 0
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
