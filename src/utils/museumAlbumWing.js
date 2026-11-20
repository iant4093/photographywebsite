import { MUSEUM_DIMENSIONS, intersectsObstacle } from './museumLayout'
import { museumPlantFoliageRadius } from './museumPlants'

// A stable seed keeps a collection recognizable when a visitor jumps back in.
function albumRandom(id) {
    let state = 2166136261
    for (const char of String(id)) state = Math.imul(state ^ char.charCodeAt(0), 16777619)
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 4294967296
    }
}

const PAINTS = [
    ['#465b54', '#59645a'], ['#62413b', '#69564b'],
    ['#46535f', '#586066'], ['#5c5140', '#69604f'],
]

export const ALBUM_DOOR_HALF_WIDTH = 1.65
export const ALBUM_ARCH_DEPTH = 0.36
export const ALBUM_HANG_HEIGHT = 2.38

export function albumPrintWidth(aspect) {
    return Math.min(2.55, 1.88 * aspect)
}

export const RETURN_PRINT_ASPECT = 1200 / 780
export const ALBUM_FRAME_BORDER = 0.34

function exitRoom(front) {
    const length = 6.8
    return { front, back: front - length, width: 6.4, length, prints: [], benches: [], plants: [] }
}

export function buildMuseumAlbumWing(album, images) {
    const random = albumRandom(album.albumId)
    const palette = PAINTS[Math.floor(random() * PAINTS.length)]
    const height = 5.85 + random() * 0.7
    const bays = [exitRoom(0)]
    let front = bays[0].back
    for (let index = 0; index < images.length; index += 6) {
        const room = bays.length - 1
        const count = Math.min(6, images.length - index)
        const width = 8.6 + random() * 1.4
        const firstSide = random() < 0.5 ? 1 : -1
        const gap = 1.25
        const prints = images.slice(index, index + count).map((image, slot) => {
            const side = slot % 2 ? -firstSide : firstSide
            const aspect = image?.width > 0 && image?.height > 0 ? image.width / image.height : 1.5
            const frameWidth = albumPrintWidth(aspect) + ALBUM_FRAME_BORDER
            return { index: index + slot, image, frameWidth,
                position: [side * (width / 2 - 0.055), ALBUM_HANG_HEIGHT, 0], rotationY: -side * Math.PI / 2 }
        })
        const walls = [-1, 1].map(side => prints.filter(print => print.position[0] * side > 0))
        const spans = walls.map(wall => wall.reduce((sum, print) => sum + print.frameWidth, 0)
            + Math.max(0, wall.length - 1) * gap)
        const length = Math.max(...spans) + 3.8
        walls.forEach((wall, sideIndex) => {
            let edge = front - (length - spans[sideIndex]) / 2
            for (const print of wall) {
                print.position[2] = edge - print.frameWidth / 2
                edge -= print.frameWidth + gap
            }
        })
        const back = front - length
        const benches = walls.flatMap((wall, sideIndex) => wall.slice(1).map((print, i) => {
            const previousEdge = wall[i].position[2] - wall[i].frameWidth / 2
            const nextEdge = print.position[2] + print.frameWidth / 2
            return { position: [(sideIndex ? 1 : -1) * width * 0.235, 0.42, (previousEdge + nextEdge) / 2],
                size: [0.78, 0.42, 1.85] }
        }))
        if (!benches.length) {
            benches.push({ position: [firstSide * width * 0.235, 0.42, (front + back) / 2], size: [0.78, 0.42, 1.85] })
        }
        const plants = [-1, 1].map(side => {
            const renderVariant = (room + (side === 1 ? 1 : 0)) % 2
            const radius = museumPlantFoliageRadius(0.92, renderVariant)
            const inset = radius + 0.25
            return { position: [side * (width / 2 - inset), 0, side === firstSide ? front - inset : back + inset],
                renderScale: 0.92, renderVariant, size: [2 * radius, 1.8, 2 * radius] }
        })
        bays.push({ front, back, width, length, prints, benches, plants, benchVariant: room })
        front = back
    }

    const farRoom = exitRoom(front)
    bays.push(farRoom)
    const portals = [
        { id: 'album-exit-near', isExit: true, position: [0, ALBUM_HANG_HEIGHT, -0.1], rotationY: Math.PI, normal: [0, 0, -1] },
        { id: 'album-exit-far', isExit: true, position: [0, ALBUM_HANG_HEIGHT, farRoom.back + 0.1], rotationY: 0, normal: [0, 0, 1] },
    ]
    return { album, count: images.length, height, bays, palette, portals, spawn: [0, MUSEUM_DIMENSIONS.eyeHeight, bays[0].back + 2.5] }
}

export function albumBayAt(bays, z) {
    let low = 0
    let high = bays.length - 1
    while (low < high) {
        const mid = (low + high) >>> 1
        if (z < bays[mid].back) low = mid + 1
        else high = mid
    }
    return low
}

export function isAlbumPositionWalkable(wing, x, z, radius = 0.35) {
    const { bays } = wing
    const i = albumBayAt(bays, z)
    const bay = bays[i]
    if (z > bays[0].front - radius || z < bays.at(-1).back + radius || Math.abs(x) > bay.width / 2 - radius) return false
    const clearance = radius + ALBUM_ARCH_DEPTH / 2
    if (((i > 0 && z > bay.front - clearance) || (i < bays.length - 1 && z < bay.back + clearance))
        && Math.abs(x) > ALBUM_DOOR_HALF_WIDTH - radius) return false
    return !bay.benches.some(prop => intersectsObstacle(x, z, prop, radius))
        && !bay.plants.some(prop => intersectsObstacle(x, z, prop, radius))
        && !wing.obstacles?.some(prop => intersectsObstacle(x, z, prop, radius))
}

export function moveInAlbumWing(wing, position, delta, radius = 0.35) {
    const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.z) / 0.12))
    const dx = delta.x / steps
    const dz = delta.z / steps
    let { x, z } = position
    for (let i = 0; i < steps; i++) {
        if (isAlbumPositionWalkable(wing, x + dx, z, radius)) x += dx
        const nextZ = Math.min(-radius, Math.max(wing.bays.at(-1).back + radius, z + dz))
        if (isAlbumPositionWalkable(wing, x, nextZ, radius)) z = nextZ
    }
    return { x, z }
}
