export function supportsImmersiveGallery() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false
    try {
        const canvas = document.createElement('canvas')
        // Three.js r163+ requires WebGL 2. Letting a WebGL-1-only browser
        // through this gate produces a renderer crash instead of the graceful
        // device message provided by the immersive-gallery route.
        return Boolean(canvas.getContext('webgl2'))
    } catch {
        return false
    }
}

export const DEFAULT_MUSEUM_PREFERENCES = Object.freeze({
    sensitivity: 1,
    bobStrength: 0.24,
    fov: 66,
    footstepVolume: 0.7,
})

export function normalizeMuseumPreferences(value = {}) {
    const numberOr = (candidate, fallback) => (
        Number.isFinite(Number(candidate)) ? Number(candidate) : fallback
    )
    return {
        sensitivity: Math.min(1.8, Math.max(0.45, numberOr(value.sensitivity, DEFAULT_MUSEUM_PREFERENCES.sensitivity))),
        bobStrength: Math.min(1, Math.max(0, numberOr(value.bobStrength, DEFAULT_MUSEUM_PREFERENCES.bobStrength))),
        fov: Math.min(82, Math.max(56, numberOr(value.fov, DEFAULT_MUSEUM_PREFERENCES.fov))),
        footstepVolume: Math.min(1, Math.max(0, numberOr(value.footstepVolume, DEFAULT_MUSEUM_PREFERENCES.footstepVolume))),
    }
}

export function readMuseumPreferences(storage, key) {
    try {
        return normalizeMuseumPreferences(JSON.parse(storage?.getItem(key) || '{}'))
    } catch {
        return { ...DEFAULT_MUSEUM_PREFERENCES }
    }
}

export function persistMuseumPreferences(storage, key, preferences) {
    try {
        storage?.setItem(key, JSON.stringify(normalizeMuseumPreferences(preferences)))
        return true
    } catch {
        return false
    }
}

export function sampleBakedWallIrradiance({
    horizontal = 0,
    vertical = 0,
    width = 1,
    height = 1,
    mode = 'room',
    phase = 0,
    fixtures = [],
} = {}) {
    const safeWidth = Math.max(0.001, Math.abs(width))
    const safeHeight = Math.max(0.001, Math.abs(height))
    const normalizedX = Math.min(1, Math.abs(horizontal) / (safeWidth / 2))
    const normalizedY = Math.min(1, Math.max(0, (vertical + (safeHeight / 2)) / safeHeight))
    const lowerBounce = 1 - Math.min(1, normalizedY / 0.58)
    const crownOcclusion = Math.max(0, (normalizedY - 0.72) / 0.28)
    const edgeOcclusion = Math.max(0, (normalizedX - 0.78) / 0.22)
    const fixtureSpacing = mode === 'hall' ? 7.9 : Math.max(3.6, safeWidth / 3.2)
    const fixtureWave = 0.5 + (Math.cos(((horizontal / fixtureSpacing) + phase) * Math.PI * 2) * 0.5)
    const analyticPool = Math.pow(fixtureWave, mode === 'hall' ? 3.1 : 2.45)
    const fixtureRadius = mode === 'hall' ? 3.3 : 2.65
    const measuredPool = fixtures.reduce((total, fixture) => {
        const distance = Math.abs(horizontal - Number(fixture || 0)) / fixtureRadius
        return total + Math.exp(-0.5 * distance * distance)
    }, 0)
    const fixturePool = (fixtures.length ? Math.min(1, measuredPool) : analyticPool)
        * Math.pow(Math.max(0, 1 - Math.abs(normalizedY - 0.64) / 0.58), 1.35)
    const centralLift = Math.max(0, 1 - (normalizedX * normalizedX))

    // Bake warm fixture pools against a slightly cooler interstitial bounce.
    // This is sampled only while building wall vertices, so the stronger
    // warm/cool separation adds no lights, textures, or fragment work.
    const base = 0.715
        + (lowerBounce * 0.075)
        + (fixturePool * (mode === 'hall' ? 0.20 : 0.17))
        + (centralLift * 0.035)
        - (crownOcclusion * 0.065)
        - (edgeOcclusion * 0.045)
    const warmth = lowerBounce * 0.052 + fixturePool * 0.085
    const coolBounce = (1 - fixturePool) * (1 - lowerBounce) * 0.03

    return [
        Math.min(1, Math.max(0.58, base + warmth)),
        Math.min(1, Math.max(0.58, base + (warmth * 0.48) + coolBounce * 0.45)),
        Math.min(1, Math.max(0.56, base - (warmth * 0.28) + coolBounce)),
    ]
}

export function sampleBakedFloorIrradiance({
    across = 0,
    along = 0,
    width = 1,
    depth = 1,
    mode = 'room',
    fixtures = [],
    occluders = [],
} = {}) {
    const halfWidth = Math.max(0.001, Math.abs(width) / 2)
    const halfDepth = Math.max(0.001, Math.abs(depth) / 2)
    const acrossRatio = Math.min(1, Math.abs(across) / halfWidth)
    const alongRatio = Math.min(1, Math.abs(along) / halfDepth)
    const edgeBounce = mode === 'hall'
        ? Math.max(0, (acrossRatio - 0.28) / 0.72)
        : Math.max(0, (alongRatio - 0.34) / 0.66)
    const fixtureAxis = mode === 'hall' ? along : across
    const fixtureRadius = mode === 'hall' ? 4.5 : 3.2
    const measuredPool = fixtures.reduce((total, fixture) => {
        const distance = Math.abs(fixtureAxis - Number(fixture || 0)) / fixtureRadius
        return total + Math.exp(-0.5 * distance * distance)
    }, 0)
    const fallbackWave = 0.5 + (Math.cos((fixtureAxis / (mode === 'hall' ? 8.25 : Math.max(2.8, width / 3))) * Math.PI) * 0.5)
    const fixturePool = fixtures.length ? Math.min(1, measuredPool) : fallbackWave
    const centerRatio = mode === 'hall' ? acrossRatio : Math.min(1, Math.abs(across) / halfWidth)
    const centralLift = Math.max(0, 1 - ((Math.max(0, centerRatio - 0.12)) / 0.8))
    const contactOcclusion = Math.min(0.19, occluders.reduce((total, occluder) => {
        const fallbackRadius = Math.max(0.18, Number(occluder?.radius) || 0.7)
        const radiusX = Math.max(0.18, Number(occluder?.radiusX) || fallbackRadius)
        const radiusZ = Math.max(0.18, Number(occluder?.radiusZ) || fallbackRadius)
        const rotation = Number(occluder?.rotationY) || 0
        const strength = Math.min(0.18, Math.max(0, Number(occluder?.strength) || 0.1))
        const dx = across - (Number(occluder?.across) || 0)
        const dz = along - (Number(occluder?.along) || 0)
        const cosine = Math.cos(rotation)
        const sine = Math.sin(rotation)
        const localX = (dx * cosine) + (dz * sine)
        const localZ = (-dx * sine) + (dz * cosine)
        const normalizedX = Math.abs(localX) / radiusX
        const normalizedZ = Math.abs(localZ) / radiusZ
        const outsideX = Math.max(0, Math.abs(localX) - radiusX)
        const outsideZ = Math.max(0, Math.abs(localZ) - radiusZ)
        const outsideDistance = Math.hypot(outsideX, outsideZ)
        const insideDistance = Math.min(1, Math.max(normalizedX, normalizedZ))
        const feather = Math.min(0.35, Math.max(0.2, Number(occluder?.feather) || 0.28))
        // An oriented rounded-rectangle footprint keeps the full underside of
        // a long bench or desk grounded, then feathers a fixed number of world
        // metres beyond its silhouette. Using normalized distance here made a
        // large desk cast a metre-wide baked halo while small plants faded in
        // only a few centimetres. Plants retain a near-circular footprint by
        // simply using equal radii.
        const footprint = outsideDistance > 0
            ? (() => {
                const remaining = Math.max(0, 1 - (outsideDistance / feather))
                return remaining * remaining * (3 - (2 * remaining))
            })()
            : 1 - (0.14 * Math.pow(insideDistance, 4))
        return total + (footprint * strength)
    }, 0))
    const base = 0.72
        + (edgeBounce * 0.13)
        + (fixturePool * 0.1)
        + (centralLift * 0.04)
        - contactOcclusion

    return [
        Math.min(1, base + (edgeBounce * 0.045)),
        Math.min(1, base + (edgeBounce * 0.018)),
        Math.min(1, base - (edgeBounce * 0.025)),
    ]
}

export const MAX_BAKED_FLOOR_GRID_VERTICES = 23_000
export const MAX_BAKED_FLOOR_GRID_INDICES = 138_000

export function buildBakedFloorGrid({
    width = 1,
    depth = 1,
    mode = 'room',
    fixtures = [],
    occluders = [],
} = {}) {
    const safeWidth = Math.max(0.001, Math.abs(Number(width) || 1))
    const safeDepth = Math.max(0.001, Math.abs(Number(depth) || 1))
    const halfWidth = safeWidth / 2
    const halfDepth = safeDepth / 2
    const axisSamples = (span, maximumStep, axis) => {
        const halfSpan = span / 2
        const segments = Math.max(2, Math.ceil(span / maximumStep))
        const regular = Array.from({ length: segments + 1 }, (_, index) => (
            -halfSpan + ((span * index) / segments)
        ))
        const critical = [-halfSpan, halfSpan]
        occluders.forEach((occluder) => {
            const center = Number(occluder?.[axis === 'x' ? 'across' : 'along']) || 0
            const radiusX = Math.max(0.18, Number(occluder?.radiusX) || Number(occluder?.radius) || 0.7)
            const radiusZ = Math.max(0.18, Number(occluder?.radiusZ) || Number(occluder?.radius) || 0.7)
            const rotation = Number(occluder?.rotationY) || 0
            const projectedRadius = axis === 'x'
                ? (Math.abs(Math.cos(rotation)) * radiusX) + (Math.abs(Math.sin(rotation)) * radiusZ)
                : (Math.abs(Math.sin(rotation)) * radiusX) + (Math.abs(Math.cos(rotation)) * radiusZ)
            const feather = Math.min(0.35, Math.max(0.2, Number(occluder?.feather) || 0.28))
            ;[
                center - projectedRadius - feather,
                center - projectedRadius,
                center,
                center + projectedRadius,
                center + projectedRadius + feather,
            ].forEach(value => {
                critical.push(Math.min(halfSpan, Math.max(-halfSpan, value)))
            })
        })
        const uniqueCritical = [...new Set(critical.map(value => Number(value.toFixed(4))))]
            .sort((left, right) => left - right)
        const criticalKeys = new Set(uniqueCritical)
        const optional = [...new Set(regular.map(value => Number(value.toFixed(4))))]
            .filter(value => !criticalKeys.has(value))
            .sort((left, right) => left - right)
        return {
            critical: uniqueCritical,
            optional,
            values: [...new Set([...uniqueCritical, ...optional])]
                .sort((left, right) => left - right),
        }
    }

    const selectAxisValues = (axis, targetCount) => {
        if (axis.values.length <= targetCount) return axis.values
        const remaining = Math.max(0, targetCount - axis.critical.length)
        if (!remaining) return axis.critical
        const selected = Array.from({ length: remaining }, (_, index) => {
            const ratio = remaining === 1 ? 0.5 : index / (remaining - 1)
            return axis.optional[Math.round(ratio * (axis.optional.length - 1))]
        }).filter(Number.isFinite)
        return [...new Set([...axis.critical, ...selected])]
            .sort((left, right) => left - right)
    }

    // Regular metre-scale samples describe broad bounce, while exact center,
    // silhouette, and fixed-feather coordinates preserve prop grounding. The
    // returned arrays are renderer-agnostic so their finiteness and budget can
    // be regression-tested without creating a WebGL context.
    const xAxis = axisSamples(safeWidth, mode === 'hall' ? 0.92 : 0.78, 'x')
    const zAxis = axisSamples(safeDepth, mode === 'hall' ? 1.28 : 0.92, 'z')
    let targetX = xAxis.values.length
    let targetZ = zAxis.values.length
    if (targetX * targetZ > MAX_BAKED_FLOOR_GRID_VERTICES) {
        // Preserve every prop silhouette/feather coordinate, then distribute
        // optional broad-bounce samples according to the floor aspect ratio.
        // This bounds the tensor grid for the public 100-album envelope
        // without dropping geometry-aligned contact samples.
        const aspectTargetX = Math.floor(Math.sqrt(
            MAX_BAKED_FLOOR_GRID_VERTICES * (safeWidth / safeDepth),
        ))
        targetX = Math.min(targetX, Math.max(xAxis.critical.length, aspectTargetX))
        targetZ = Math.min(targetZ, Math.max(
            zAxis.critical.length,
            Math.floor(MAX_BAKED_FLOOR_GRID_VERTICES / Math.max(1, targetX)),
        ))
        if (targetX * targetZ > MAX_BAKED_FLOOR_GRID_VERTICES) {
            targetX = Math.min(targetX, Math.max(
                xAxis.critical.length,
                Math.floor(MAX_BAKED_FLOOR_GRID_VERTICES / Math.max(1, targetZ)),
            ))
        }
    }
    const xs = selectAxisValues(xAxis, targetX)
    const zs = selectAxisValues(zAxis, targetZ)
    const positions = []
    const normals = []
    const uvs = []
    const colors = []
    const indices = []
    zs.forEach((along) => {
        xs.forEach((across) => {
            positions.push(across, 0.11, along)
            normals.push(0, 1, 0)
            uvs.push((across + halfWidth) / safeWidth, (along + halfDepth) / safeDepth)
            colors.push(...sampleBakedFloorIrradiance({
                across,
                along,
                width: safeWidth,
                depth: safeDepth,
                mode,
                fixtures,
                occluders,
            }))
        })
    })
    const rowLength = xs.length
    for (let zIndex = 0; zIndex < zs.length - 1; zIndex += 1) {
        for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
            const a = (zIndex * rowLength) + xIndex
            const b = a + 1
            const c = a + rowLength
            const d = c + 1
            indices.push(a, c, b, b, c, d)
        }
    }

    return {
        xs,
        zs,
        positions,
        normals,
        uvs,
        colors,
        indices,
        vertexCount: xs.length * zs.length,
        indexCount: indices.length,
    }
}

export function museumHallSconcePlacements(layout = {}) {
    const bayCount = Math.max(1, Math.ceil((layout.rooms?.length || 0) / 2))
    return Array.from({ length: bayCount }, (_, index) => Number((-7 - (index * 16.5) + 7.4).toFixed(3)))
        .flatMap(z => [-1, 1].map(side => ({ side, z })))
}

export function museumPracticalSconcePlacements(placements = []) {
    // Keep one real point source in every other bay, alternating walls across
    // those selected bays. The full row of visible sconces is preserved by
    // emissive lenses and fixture-aligned baked irradiance, while this compact
    // live subset adds genuine parallax/specular response without making each
    // fragment evaluate a light for every decorative fitting in the corridor.
    return placements.filter((_, index) => {
        const bay = Math.floor(index / 2)
        if (bay % 2 !== 0) return false
        const selectedBay = Math.floor(bay / 2)
        return index % 2 === selectedBay % 2
    })
}
