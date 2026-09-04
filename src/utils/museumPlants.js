// Both plant variants share this small, folded leaf. Its narrow root, lifted
// midrib and pointed tip produce a clean silhouette without overlapping disks.
export const MUSEUM_PLANT_LEAF_MESH = Object.freeze({
    positions: [
        0, 0, 0,
        -0.08, 0.07, 0.23, 0, 0.1, 0.23, 0.08, 0.07, 0.23,
        -0.115, 0.11, 0.5, 0, 0.15, 0.5, 0.115, 0.11, 0.5,
        -0.075, 0.075, 0.77, 0, 0.105, 0.77, 0.075, 0.075, 0.77,
        0, -0.045, 1,
    ],
    indices: [
        0, 1, 2, 0, 2, 3,
        1, 4, 5, 1, 5, 2, 2, 5, 6, 2, 6, 3,
        4, 7, 8, 4, 8, 5, 5, 8, 9, 5, 9, 6,
        7, 10, 8, 8, 10, 9,
    ],
})

export const MUSEUM_PLANT_FORM = Object.freeze({
    potHeight: 0.6,
    potTopRadius: 0.34,
    potBottomRadius: 0.255,
    soilY: 0.558,
    soilRadius: 0.318,
    stemRadius: 0.012,
    leafCount: 8,
    wallClearance: 0.15,
})

const LEAF_LENGTHS = [0.64, 0.58, 0.67, 0.6, 0.65, 0.56, 0.62, 0.55]
const LEAF_HEIGHTS = [0.96, 1.25, 1.08, 1.46, 1.02, 1.35, 1.17, 1.56]

export function museumPlantLeaves(variant = 0) {
    return LEAF_LENGTHS.map((length, index) => {
        const angle = index * Math.PI / 4 + (index % 2 ? 0.035 : -0.035)
        const radius = 0.13
        return {
            angle,
            lift: variant === 1 ? 0.25 + (index % 3) * 0.06 : -0.035 + (index % 3) * 0.055,
            length: length * (variant === 1 ? 0.93 : 1),
            width: variant === 1 ? 0.86 : 1,
            position: [Math.sin(angle) * radius, LEAF_HEIGHTS[index], Math.cos(angle) * radius],
            stemStart: [Math.sin(angle) * 0.065, MUSEUM_PLANT_FORM.soilY - 0.01, Math.cos(angle) * 0.065],
        }
    })
}

// Use the exact rendered vertices for placement and clearance checks, including
// rotation and scale. Tall variants no longer silently outgrow their layout.
export function museumPlantLeafVertices(leaf) {
    const vertices = []
    const cosLift = Math.cos(leaf.lift)
    const sinLift = Math.sin(leaf.lift)
    const cosAngle = Math.cos(leaf.angle)
    const sinAngle = Math.sin(leaf.angle)
    for (let index = 0; index < MUSEUM_PLANT_LEAF_MESH.positions.length; index += 3) {
        const x = MUSEUM_PLANT_LEAF_MESH.positions[index] * leaf.width
        const y = MUSEUM_PLANT_LEAF_MESH.positions[index + 1] * leaf.length
        const z = MUSEUM_PLANT_LEAF_MESH.positions[index + 2] * leaf.length
        const liftedY = y * cosLift + z * sinLift
        const liftedZ = z * cosLift - y * sinLift
        vertices.push([
            leaf.position[0] + x * cosAngle + liftedZ * sinAngle,
            leaf.position[1] + liftedY,
            leaf.position[2] - x * sinAngle + liftedZ * cosAngle,
        ])
    }
    return vertices
}

export function museumPlantFoliageRadius(renderScale = 1, renderVariant = 0) {
    const radius = Math.max(MUSEUM_PLANT_FORM.potTopRadius, ...museumPlantLeaves(renderVariant)
        .flatMap(leaf => museumPlantLeafVertices(leaf).map(([x, , z]) => Math.hypot(x, z))))
    return radius * renderScale
}
