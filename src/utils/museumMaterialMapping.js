export const MUSEUM_FLOOR_TILE_METRES = 1.7
export const MUSEUM_TEXTILE_TILE_METRES = 0.3

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const span = value => Math.max(0.001, Math.abs(finite(value, 1)))
const tile = (value, fallback) => Math.max(0.001, Math.abs(finite(value, fallback)))

// Floor geometry keeps normalized primary UVs for its baked perimeter AO.
// Transform only the repeating PBR maps into the common world X/Z grid so
// generated room dimensions cannot change plank width or reset a doorway seam.
export function museumFloorTextureTransform({
    width = 1,
    depth = 1,
    centerX = 0,
    centerZ = 0,
    tileSize = MUSEUM_FLOOR_TILE_METRES,
} = {}) {
    const safeWidth = span(width)
    const safeDepth = span(depth)
    const safeTile = tile(tileSize, MUSEUM_FLOOR_TILE_METRES)
    return {
        repeat: [safeWidth / safeTile, safeDepth / safeTile],
        offset: [
            (finite(centerX) - safeWidth / 2) / safeTile,
            (finite(centerZ) - safeDepth / 2) / safeTile,
        ],
    }
}

// The shared architectural primitive is a unit rounded box. Its authored top
// UVs reverse Z and reserve a nonlinear band for each bevel, unlike the floor
// grid. Project its top and upper bevels without changing the mesh silhouette.
export function createMuseumThresholdFloorGeometry(source) {
    const geometry = source.clone()
    const positions = geometry.getAttribute('position')
    const normals = geometry.getAttribute('normal')
    const uvs = geometry.getAttribute('uv')
    for (let index = 0; index < positions.count; index += 1) {
        const x = positions.getX(index)
        const y = positions.getY(index)
        const z = positions.getZ(index)
        const normalX = normals.getX(index)
        const normalY = normals.getY(index)
        const normalZ = normals.getZ(index)
        if (normalY > 0 || Math.abs(normalY) >= Math.max(Math.abs(normalX), Math.abs(normalZ))) {
            uvs.setXY(index, x + 0.5, z + 0.5)
        } else if (Math.abs(normalX) > Math.abs(normalZ)) {
            uvs.setXY(index, z + 0.5, y + 0.5)
        } else {
            uvs.setXY(index, x + 0.5, y + 0.5)
        }
    }
    uvs.needsUpdate = true
    return geometry
}

// Plane UVs span 0..1; extruded spandrel UVs already measure local metres.
// Both receive the same world-sized weave, including surfaces facing the
// opposite direction. A mirrored U axis starts at the right edge of the panel.
export function museumSurfaceTextureTransform({
    width = 1,
    height = 1,
    center = 0,
    bottomY = 0,
    shapeUv = false,
    reverseU = false,
    tileSize = MUSEUM_TEXTILE_TILE_METRES,
    phase = 0,
} = {}) {
    const safeWidth = span(width)
    const safeHeight = span(height)
    const safeTile = tile(tileSize, MUSEUM_TEXTILE_TILE_METRES)
    const direction = reverseU ? -1 : 1
    const horizontalOrigin = finite(center) - (shapeUv ? 0 : direction * safeWidth / 2)
    const safePhase = finite(phase)
    return {
        repeat: [direction * (shapeUv ? 1 : safeWidth) / safeTile, (shapeUv ? 1 : safeHeight) / safeTile],
        offset: [horizontalOrigin / safeTile + safePhase, finite(bottomY) / safeTile + safePhase * 0.37],
    }
}
