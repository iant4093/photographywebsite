import { describe, expect, it } from 'vitest'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
    createMuseumThresholdFloorGeometry,
    MUSEUM_FLOOR_TILE_METRES,
    MUSEUM_TEXTILE_TILE_METRES,
    museumFloorTextureTransform,
    museumSurfaceTextureTransform,
} from './museumMaterialMapping'

const sample = (transform, uv) => uv.map((value, axis) => value * transform.repeat[axis] + transform.offset[axis])
const closeVector = (actual, expected, precision = 8) => actual.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], precision))

describe('museum floor PBR mapping', () => {
    it('maps the real rounded threshold top and bevels onto the same world grid without adding geometry', () => {
        const source = new RoundedBoxGeometry(1, 1, 1, 2, 0.045)
        const originalUvs = Array.from(source.getAttribute('uv').array)
        const threshold = createMuseumThresholdFloorGeometry(source)
        const positions = threshold.getAttribute('position')
        const normals = threshold.getAttribute('normal')
        const uvs = threshold.getAttribute('uv')
        expect(Array.from(source.getAttribute('uv').array)).toEqual(originalUvs)
        expect(Array.from(positions.array)).toEqual(Array.from(source.getAttribute('position').array))
        expect(Array.from(normals.array)).toEqual(Array.from(source.getAttribute('normal').array))
        expect(uvs.count).toBe(source.getAttribute('uv').count)
        for (const centerX of [-5, 5]) {
            const width = 0.74
            const depth = 4.22
            const centerZ = -23.5
            const transform = museumFloorTextureTransform({ width, depth, centerX, centerZ })
            for (let index = 0; index < positions.count; index += 1) {
                if (normals.getY(index) <= 0) continue
                closeVector(sample(transform, [uvs.getX(index), uvs.getY(index)]), [
                    (centerX + positions.getX(index) * width) / MUSEUM_FLOOR_TILE_METRES,
                    (centerZ + positions.getZ(index) * depth) / MUSEUM_FLOOR_TILE_METRES,
                ], 6)
            }
        }
        expect(Array.from(uvs.array).every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true)
        threshold.dispose()
        source.dispose()
    })

    it('keeps physical board density at shared hallway and mirrored room thresholds', () => {
        const hall = { width: 10, depth: 108, centerX: 0, centerZ: -36 }
        const hallMap = museumFloorTextureTransform(hall)
        for (const side of [-1, 1]) {
            for (const depth of [10, 13.5]) {
                for (const roomWidth of [15, 47]) {
                    const room = { width: roomWidth, depth, centerX: side * (5 + roomWidth / 2), centerZ: -7 }
                    const roomMap = museumFloorTextureTransform(room)
                    // Sample the same three physical points on the shared edge.
                    for (const z of [-9, -7, -5]) {
                        const x = side * 5
                        const hallUv = [(x - hall.centerX) / hall.width + 0.5, (z - hall.centerZ) / hall.depth + 0.5]
                        const roomUv = [(x - room.centerX) / room.width + 0.5, (z - room.centerZ) / room.depth + 0.5]
                        closeVector(sample(hallMap, hallUv), sample(roomMap, roomUv))
                        closeVector(sample(roomMap, roomUv), [x / MUSEUM_FLOOR_TILE_METRES, z / MUSEUM_FLOOR_TILE_METRES])
                    }
                    // A metre of walking crosses the same texture distance in
                    // a short or long gallery, on both physical axes.
                    closeVector([
                        roomMap.repeat[0] / room.width,
                        roomMap.repeat[1] / room.depth,
                    ], [1 / MUSEUM_FLOOR_TILE_METRES, 1 / MUSEUM_FLOOR_TILE_METRES])
                }
            }
        }
    })

    it('uses finite positive density for malformed dimensions without shifting valid world coordinates', () => {
        const transform = museumFloorTextureTransform({ width: -8, depth: -12, centerX: -37, centerZ: 19, tileSize: 2 })
        closeVector(sample(transform, [0.5, 0.5]), [-18.5, 9.5])
        for (const value of [NaN, Infinity, undefined, 0]) {
            const fallback = museumFloorTextureTransform({ width: value, depth: value, centerX: value, centerZ: value, tileSize: value })
            expect([...fallback.repeat, ...fallback.offset].every(Number.isFinite)).toBe(true)
            expect(fallback.repeat.every(density => density > 0)).toBe(true)
        }
    })
})

describe('museum textile PBR mapping', () => {
    it('matches opposite-facing planes and metre-authored spandrels at the same wall point', () => {
        for (const reverseU of [false, true]) {
            const center = -23.5
            const width = 5.6
            const height = 8.8
            const phase = 0.27
            const direction = reverseU ? -1 : 1
            const plane = museumSurfaceTextureTransform({ center, width, height, reverseU, phase })
            const shape = museumSurfaceTextureTransform({ center, width, height, reverseU, phase, shapeUv: true })
            for (const localX of [-2.1, 0, 1.7]) {
                for (const y of [0.6, 4.1, 8.2]) {
                    const planeSample = sample(plane, [localX / width + 0.5, y / height])
                    closeVector(planeSample, sample(shape, [localX, y]))
                    closeVector(planeSample, [
                        (center + direction * localX) / MUSEUM_TEXTILE_TILE_METRES + phase,
                        y / MUSEUM_TEXTILE_TILE_METRES + phase * 0.37,
                    ])
                }
            }
        }
    })

    it('preserves weave scale and phase between narrow and long adjacent wall panels', () => {
        for (const reverseU of [false, true]) {
            const direction = reverseU ? -1 : 1
            const panels = [
                { width: 3, height: 8, center: -1.5 },
                { width: 21, height: 8, center: 10.5 },
            ]
            const [left, right] = panels.map(panel => {
                const map = museumSurfaceTextureTransform({ ...panel, reverseU, bottomY: 0.2 })
                const localX = (0 - panel.center) / direction
                return sample(map, [localX / panel.width + 0.5, 0.5])
            })
            closeVector(left, right)
            closeVector(left, [0, 4.2 / MUSEUM_TEXTILE_TILE_METRES])
        }
    })

    it('allows a chosen physical tile size and finite fallback values on either UV convention', () => {
        closeVector(museumSurfaceTextureTransform({ width: 6, height: 4, tileSize: 2 }).repeat, [3, 2])
        for (const shapeUv of [false, true]) {
            const map = museumSurfaceTextureTransform({ width: Infinity, height: NaN, center: Infinity, bottomY: NaN, phase: Infinity, tileSize: NaN, shapeUv, reverseU: true })
            expect([...map.repeat, ...map.offset].every(Number.isFinite)).toBe(true)
            expect(map.repeat[0]).toBeLessThan(0)
            expect(map.repeat[1]).toBeGreaterThan(0)
        }
    })
})
