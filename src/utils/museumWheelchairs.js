import { isMuseumPositionWalkable, moveMuseumPosition } from './museumLayout'

export const MUSEUM_WHEELCHAIR = Object.freeze({
    eyeHeight: 1.12,
    radius: 0.9,
    speed: 28,
    boostSpeed: 42,
    interactionDistance: 1.85,
})

export function createMuseumWheelchairs(layout) {
    return [-2.85, -0.95, 0.95, 2.85].map((x, index) => ({
        id: `wheelchair-${index + 1}`,
        kind: 'wheelchair',
        position: [x, 0, layout.desk.position[2] - 2.7],
        size: [1.12, 1.15, 1.45],
        rotationY: 0,
        wheelAngle: 0,
    }))
}

export function museumWheelchairCollisionLayout(layout, chairs, riddenId = null) {
    return { ...layout, obstacles: [...layout.obstacles, ...chairs.filter(chair => chair.id !== riddenId).map(chair => ({
        ...chair,
        // The legacy obstacle helper rotates world offsets into local axes
        // with the opposite sign from Three.js's rendered Y rotation.
        rotationY: -chair.rotationY,
    }))] }
}

export function focusedMuseumWheelchair(chairs, position, forward) {
    let nearest = null
    let distance = MUSEUM_WHEELCHAIR.interactionDistance
    for (const chair of chairs) {
        const dx = chair.position[0] - position.x
        const dz = chair.position[2] - position.z
        const length = Math.hypot(dx, dz)
        if (length < distance && (length < 0.6 || (dx * forward.x + dz * forward.z) / length > 0.35)) {
            nearest = chair
            distance = length
        }
    }
    return nearest
}

export function museumWheelchairPathClear(layout, chairs, chair, from, to, passableRoomIds) {
    const reached = moveMuseumPosition(
        museumWheelchairCollisionLayout(layout, chairs, chair.id), from,
        { x: to.x - from.x, z: to.z - from.z }, 0.35, passableRoomIds,
    )
    return Math.hypot(reached.x - to.x, reached.z - to.z) < 0.01
}

export function museumWheelchairExitPosition(layout, chairs, chair, passableRoomIds = null) {
    const collisionLayout = museumWheelchairCollisionLayout(layout, chairs)
    // Try either side, then behind and ahead. Never stand inside furniture or
    // leave the visitor trapped between a chair and a wall.
    for (const [x, z] of [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5], [1.5, 1.5], [-1.5, 1.5], [1.5, -1.5], [-1.5, -1.5]]) {
        const cosine = Math.cos(chair.rotationY)
        const sine = Math.sin(chair.rotationY)
        const position = {
            x: chair.position[0] + x * cosine + z * sine,
            z: chair.position[2] - x * sine + z * cosine,
        }
        if (isMuseumPositionWalkable(collisionLayout, position.x, position.z, 0.35)
            && museumWheelchairPathClear(layout, chairs, chair,
                { x: chair.position[0], z: chair.position[2] }, position, passableRoomIds)) return position
    }
    return null
}
