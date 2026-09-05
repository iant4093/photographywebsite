import { MUSEUM_DIMENSIONS, museumRoomCeilingFixtureXs, museumRoomRibXs, museumRoomShell } from './museumLayout'

export const MUSEUM_SKYLIGHT = Object.freeze({
    paneY: 6.04,
    revealBottomY: 5.94,
    frameBottomY: 5.905,
    openingWidth: 2.35,
    openingDepth: 2.5,
    frameWidth: 0.11,
    maximumPerRoom: 3,
    feather: 0.65,
})

export function museumRoomCofferBays(room) {
    const shell = museumRoomShell(room)
    const count = Math.max(2, Math.min(16, Math.round(shell.depth / 6.4)))
    const length = (shell.depth - 0.8) / count
    return Array.from({ length: count }, (_, index) => ({
        index,
        x: shell.centerX - shell.depth / 2 + 0.4 + length * (index + 0.5),
        length,
    }))
}

// Alternating architectural bays keep some rooms intimate and lamplit. This
// depends on placement, never category names, dates or photograph content.
export function museumRoomSkylights(room) {
    if ((room.bay + (room.side > 0 ? 1 : 0)) % 2 !== 0) return []
    const ribs = museumRoomRibXs(room)
    const bays = museumRoomCofferBays(room)
    const clear = bay => (
        ribs.every(x => Math.abs(x - bay.x) > MUSEUM_SKYLIGHT.openingWidth / 2 + 0.3)
    )
    const shell = museumRoomShell(room)
    const desiredCount = Math.min(MUSEUM_SKYLIGHT.maximumPerRoom, Math.max(1, Math.ceil(room.depth / 48)))
    const center = bays.length % 2 === 1 ? bays[Math.floor(bays.length / 2)] : null
    // Choose the center coffer or a mirrored pair. Filtering each side
    // independently made long rooms look accidentally staggered.
    const pairs = bays.slice(0, Math.floor(bays.length / 2))
        .map(bay => [bay, bays[bays.length - 1 - bay.index]])
        .filter(pair => pair.every(clear))
    const targetOffset = desiredCount === 1 ? 0 : shell.depth * 0.25
    pairs.sort((a, b) => Math.abs(Math.abs(a[0].x - shell.centerX) - targetOffset)
        - Math.abs(Math.abs(b[0].x - shell.centerX) - targetOffset))
    const selected = center && clear(center) && desiredCount === 1
        ? [center]
        : [...(pairs[0] || []), ...(center && clear(center) && (desiredCount === 3 || !pairs.length) ? [center] : [])]
    return selected.sort((a, b) => a.x - b.x).map(bay => {
        return {
            id: `${room.id}-skylight-${bay.index}`,
            cofferIndex: bay.index,
            position: [bay.x, MUSEUM_SKYLIGHT.paneY, room.centerZ],
            size: [MUSEUM_SKYLIGHT.openingWidth, MUSEUM_SKYLIGHT.openingDepth],
            // An evening ray travels diagonally toward the outer side of the
            // room. Projecting the actual opening gives one continuous pool
            // across the floor and any wall it meets, without free-floating
            // transparent quads passing through paintings or furniture.
            slope: [room.side * 0.16, 0.68],
        }
    })
}

export function museumSkylightCeilingFixtureXs(room, requestedFixtures = 4) {
    const skylights = museumRoomSkylights(room)
    // A centered skylight replaces any small ceiling fitting beneath it.
    // Keep its housing clear of the full cream surround, not only the glass.
    return museumRoomCeilingFixtureXs(room, requestedFixtures).filter(x => skylights.every(skylight => (
        Math.abs(x - skylight.position[0]) > skylight.size[0] / 2 + MUSEUM_SKYLIGHT.frameWidth + 0.425
    )))
}

function splitPanel(panel, opening) {
    if (!opening) return [panel]
    const [x, y, z] = panel.position
    const [width, thickness, depth] = panel.size
    const minX = x - width / 2
    const maxX = x + width / 2
    const minZ = z - depth / 2
    const maxZ = z + depth / 2
    const holeMinX = opening.position[0] - opening.size[0] / 2
    const holeMaxX = opening.position[0] + opening.size[0] / 2
    const holeMinZ = opening.position[2] - opening.size[1] / 2
    const holeMaxZ = opening.position[2] + opening.size[1] / 2
    return [
        { position: [(minX + holeMinX) / 2, y, z], size: [holeMinX - minX, thickness, depth] },
        { position: [(holeMaxX + maxX) / 2, y, z], size: [maxX - holeMaxX, thickness, depth] },
        { position: [opening.position[0], y, (minZ + holeMinZ) / 2], size: [opening.size[0], thickness, holeMinZ - minZ] },
        { position: [opening.position[0], y, (holeMaxZ + maxZ) / 2], size: [opening.size[0], thickness, maxZ - holeMaxZ] },
    ].filter(part => part.size.every(value => value > 0.001))
}

export function museumRoomCofferPanels(room) {
    const skylights = museumRoomSkylights(room)
    const surround = []
    const inset = []
    for (const bay of museumRoomCofferBays(room)) {
        const opening = skylights.find(skylight => skylight.cofferIndex === bay.index)
        surround.push(...splitPanel({
            position: [bay.x, 6.035, room.centerZ],
            size: [bay.length - 0.22, 0.09, room.width - 0.7],
        }, opening))
        inset.push(...splitPanel({
            position: [bay.x, 5.98, room.centerZ],
            size: [bay.length - 0.44, 0.025, room.width - 1.02],
        }, opening))
    }
    return { surround, inset }
}

const smooth = value => {
    const t = Math.min(1, Math.max(0, value))
    return t * t * (3 - 2 * t)
}

// Call only while constructing existing surface vertex colors. The skylights
// add no live lights, shadow maps, texture lookups or per-frame calculations.
export function sampleMuseumSkylightIrradiance({ skylights = [], x = 0, y = 0, z = 0 } = {}) {
    let illumination = 0
    for (const skylight of skylights) {
        const drop = skylight.position[1] - y
        if (drop < 0 || drop > MUSEUM_DIMENSIONS.roomCeilingY + 0.3) continue
        const projectedX = x - skylight.slope[0] * drop - skylight.position[0]
        const projectedZ = z - skylight.slope[1] * drop - skylight.position[2]
        const feather = MUSEUM_SKYLIGHT.feather + drop * 0.035
        const across = smooth((skylight.size[0] / 2 + feather - Math.abs(projectedX)) / feather)
        const along = smooth((skylight.size[1] / 2 + feather - Math.abs(projectedZ)) / feather)
        illumination += across * along * (0.78 + 0.22 * smooth(drop / 3))
    }
    const strength = Math.min(1, illumination)
    return [strength * 0.095, strength * 0.18, strength * 0.29]
}
