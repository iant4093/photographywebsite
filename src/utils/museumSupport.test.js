import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    buildBakedFloorGrid,
    DEFAULT_MUSEUM_PREFERENCES,
    MAX_BAKED_FLOOR_GRID_INDICES,
    MAX_BAKED_FLOOR_GRID_VERTICES,
    normalizeMuseumPreferences,
    museumHallSconcePlacements,
    museumPracticalSconcePlacements,
    persistMuseumPreferences,
    readMuseumPreferences,
    sampleBakedFloorIrradiance,
    sampleBakedWallIrradiance,
    supportsImmersiveGallery,
} from './museumSupport'

function configureBrowser({ webgl2 = true, webgl = true } = {}) {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) => (
        (kind === 'webgl2' && webgl2) || (kind === 'webgl' && webgl) ? {} : null
    ))
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('supportsImmersiveGallery', () => {
    it('allows any screen and pointer type when WebGL is available', () => {
        configureBrowser()
        expect(supportsImmersiveGallery()).toBe(true)
    })

    it('rejects browsers without WebGL', () => {
        configureBrowser({ webgl2: false, webgl: false })
        expect(supportsImmersiveGallery()).toBe(false)
    })

    it('rejects WebGL-1-only browsers because Three.js requires WebGL 2', () => {
        configureBrowser({ webgl2: false, webgl: true })
        expect(supportsImmersiveGallery()).toBe(false)
    })
})

describe('museum experience preferences', () => {
    it('clamps saved values to the supported experience range', () => {
        expect(normalizeMuseumPreferences({
            sensitivity: 99,
            bobStrength: -2,
            fov: 20,
            footstepVolume: 4,
        })).toEqual({
            sensitivity: 1.8,
            bobStrength: 0,
            fov: 56,
            footstepVolume: 1,
        })
    })

    it('falls back safely when reading corrupt or denied storage', () => {
        const corruptStorage = { getItem: () => '{not json' }
        const deniedStorage = { getItem: () => { throw new Error('denied') } }
        expect(readMuseumPreferences(corruptStorage, 'museum')).toEqual(DEFAULT_MUSEUM_PREFERENCES)
        expect(readMuseumPreferences(deniedStorage, 'museum')).toEqual(DEFAULT_MUSEUM_PREFERENCES)
    })

    it('does not throw when persistence is denied', () => {
        const deniedStorage = { setItem: () => { throw new Error('denied') } }
        expect(persistMuseumPreferences(deniedStorage, 'museum', DEFAULT_MUSEUM_PREFERENCES)).toBe(false)
    })
})

describe('baked museum wall irradiance', () => {
    it('is deterministic, bounded, and warmer near the floor', () => {
        const lower = sampleBakedWallIrradiance({ horizontal: 0, vertical: -2, width: 12, height: 6 })
        const upper = sampleBakedWallIrradiance({ horizontal: 0, vertical: 2.8, width: 12, height: 6 })
        expect(sampleBakedWallIrradiance({ horizontal: 0, vertical: -2, width: 12, height: 6 })).toEqual(lower)
        expect(lower.every(value => value >= 0.56 && value <= 1)).toBe(true)
        expect(upper.every(value => value >= 0.56 && value <= 1)).toBe(true)
        expect(lower[0] - lower[2]).toBeGreaterThan(upper[0] - upper[2])
    })

    it('creates a visible fixture rhythm without exceeding display white', () => {
        const bright = sampleBakedWallIrradiance({
            horizontal: 0,
            vertical: 0.9,
            width: 24,
            height: 6,
            mode: 'hall',
            phase: 0,
        })
        const between = sampleBakedWallIrradiance({
            horizontal: 3.95,
            vertical: 0.9,
            width: 24,
            height: 6,
            mode: 'hall',
            phase: 0,
        })
        expect(bright[0]).toBeGreaterThan(between[0])
        expect(Math.max(...bright)).toBeLessThanOrEqual(1)
    })

    it('aligns wall and floor pools to real fixture coordinates', () => {
        const atWallFixture = sampleBakedWallIrradiance({
            horizontal: 2,
            vertical: 0.9,
            width: 24,
            height: 6,
            fixtures: [2],
        })
        const betweenWallFixtures = sampleBakedWallIrradiance({
            horizontal: 7,
            vertical: 0.9,
            width: 24,
            height: 6,
            fixtures: [2],
        })
        const atFloorFixture = sampleBakedFloorIrradiance({
            across: 0,
            along: 2,
            width: 10,
            depth: 30,
            mode: 'hall',
            fixtures: [2],
        })
        const awayFromFloorFixture = sampleBakedFloorIrradiance({
            across: 0,
            along: 11,
            width: 10,
            depth: 30,
            mode: 'hall',
            fixtures: [2],
        })
        expect(atWallFixture[0]).toBeGreaterThan(betweenWallFixtures[0])
        expect(atFloorFixture[0]).toBeGreaterThan(awayFromFloorFixture[0])
    })

    it('grounds static furniture with geometry-aligned floor occlusion', () => {
        const occluders = [{ across: 1.5, along: -2, radius: 1.2, strength: 0.14 }]
        const beneathBench = sampleBakedFloorIrradiance({
            across: 1.5,
            along: -2,
            width: 18,
            depth: 12,
            occluders,
        })
        const openFloor = sampleBakedFloorIrradiance({
            across: -5,
            along: 3.5,
            width: 18,
            depth: 12,
            occluders,
        })
        expect(beneathBench[0]).toBeLessThan(openFloor[0])
        expect(Math.min(...beneathBench)).toBeGreaterThanOrEqual(0.5)
    })

    it('rotates rectangular footprints instead of collapsing furniture to circles', () => {
        const occluders = [{
            across: 0,
            along: 0,
            radiusX: 2,
            radiusZ: 0.4,
            rotationY: Math.PI / 2,
            strength: 0.16,
        }]
        const alongOpen = sampleBakedFloorIrradiance({ across: 0, along: 1.5, width: 12, depth: 12 })
        const alongGrounded = sampleBakedFloorIrradiance({ across: 0, along: 1.5, width: 12, depth: 12, occluders })
        const acrossOpen = sampleBakedFloorIrradiance({ across: 1.5, along: 0, width: 12, depth: 12 })
        const acrossGrounded = sampleBakedFloorIrradiance({ across: 1.5, along: 0, width: 12, depth: 12, occluders })
        const longAxisOcclusion = alongOpen[0] - alongGrounded[0]
        const shortAxisOcclusion = acrossOpen[0] - acrossGrounded[0]

        expect(longAxisOcclusion).toBeGreaterThan(0.1)
        expect(shortAxisOcclusion).toBeLessThan(0.025)
        expect(longAxisOcclusion).toBeGreaterThan(shortAxisOcclusion + 0.08)
    })

    it('uses a fixed world-space contact feather for differently sized props', () => {
        const sampleOutside = (radiusX) => {
            const across = radiusX + 0.3
            const open = sampleBakedFloorIrradiance({ across, along: 0, width: 30, depth: 60 })[0]
            return open - sampleBakedFloorIrradiance({
                across,
                along: 0,
                width: 30,
                depth: 60,
                occluders: [{ across: 0, along: 0, radiusX, radiusZ: 0.5, strength: 0.16 }],
            })[0]
        }

        expect(sampleOutside(0.5)).toBeLessThan(0.001)
        expect(sampleOutside(4)).toBeLessThan(0.001)
    })

    it('keeps the largest current floor grids finite and within a static geometry budget', () => {
        const hallOccluders = Array.from({ length: 18 }, (_, index) => ({
            across: index % 2 === 0 ? -4.4 : 4.4,
            along: 27 - (index * 6.4),
            radiusX: index === 0 ? 2.8 : 0.55,
            radiusZ: index === 0 ? 1.05 : 0.55,
            rotationY: index % 3 === 0 ? Math.PI / 6 : 0,
            strength: 0.1,
        }))
        const roomOccluders = Array.from({ length: 8 }, (_, index) => ({
            across: -6 + (index * 1.7),
            along: index % 2 === 0 ? -2.4 : 2.4,
            radiusX: 1.5,
            radiusZ: 0.48,
            rotationY: index % 2 ? Math.PI / 2 : 0,
            strength: 0.12,
        }))
        const grids = [
            buildBakedFloorGrid({ width: 13, depth: 150, mode: 'hall', occluders: hallOccluders }),
            buildBakedFloorGrid({ width: 22, depth: 14, mode: 'room', occluders: roomOccluders }),
        ]

        grids.forEach((grid) => {
            expect(grid.vertexCount).toBeLessThanOrEqual(MAX_BAKED_FLOOR_GRID_VERTICES)
            expect(grid.indexCount).toBeLessThanOrEqual(MAX_BAKED_FLOOR_GRID_INDICES)
            expect(grid.positions.every(Number.isFinite)).toBe(true)
            expect(grid.normals.every(Number.isFinite)).toBe(true)
            expect(grid.uvs.every(Number.isFinite)).toBe(true)
            expect(grid.colors.every(Number.isFinite)).toBe(true)
            expect(grid.indices.every(Number.isFinite)).toBe(true)
        })
    })

    it('enforces the floor budget at the real 100-category public input envelope', () => {
        const bayCount = 50
        const hallBack = -7 - ((bayCount - 1) * 16.5) - 11
        const depth = 14 - hallBack
        const hallCenter = (14 + hallBack) / 2
        const itemToOccluder = (item, strength = 0.1) => ({
            across: item.position[0],
            along: item.position[2] - hallCenter,
            radiusX: Math.max(0.28, item.size[0] * 0.5),
            radiusZ: Math.max(0.28, item.size[2] * 0.5),
            rotationY: item.rotationY || 0,
            strength,
        })
        const occluders = [
            itemToOccluder({ position: [0, 0, 6.4], size: [4.3, 1.38, 1.3] }, 0.16),
            ...[-1, 1].map(side => itemToOccluder({
                position: [side * 4.02, 0, 11.12],
                size: [0.94, 1.9, 0.94],
                rotationY: side * 0.28,
            }, 0.075)),
            ...Array.from({ length: bayCount }, (_, bay) => {
                const side = bay % 2 === 0 ? -1 : 1
                return itemToOccluder({
                    position: [side * 4.02, 0, -7 - (bay * 16.5) + 5.3],
                    size: [0.86, 1.7, 0.86],
                    rotationY: side * 0.42,
                }, 0.075)
            }),
            itemToOccluder({
                position: [0, 0, hallBack + 2.05],
                size: [1.75, 2.9, 1.75],
            }, 0.15),
        ]
        const grid = buildBakedFloorGrid({
            width: 9.6,
            depth,
            mode: 'hall',
            occluders,
        })

        expect(depth).toBe(840.5)
        expect(occluders).toHaveLength(54)
        expect(grid.vertexCount).toBeLessThanOrEqual(MAX_BAKED_FLOOR_GRID_VERTICES)
        expect(grid.indexCount).toBeLessThanOrEqual(MAX_BAKED_FLOOR_GRID_INDICES)
        expect(grid.positions.every(Number.isFinite)).toBe(true)
        expect(grid.colors.every(Number.isFinite)).toBe(true)
    })

    it('derives the same hall sconce coordinates used by the dressing', () => {
        expect(museumHallSconcePlacements({ rooms: [{}, {}, {}] })).toEqual([
            { side: -1, z: 0.4 },
            { side: 1, z: 0.4 },
            { side: -1, z: -16.1 },
            { side: 1, z: -16.1 },
        ])
    })

    it('alternates the live practical lights across selected corridor bays', () => {
        const placements = museumHallSconcePlacements({ rooms: Array.from({ length: 10 }, () => ({})) })
        expect(museumPracticalSconcePlacements(placements)).toEqual([
            { side: -1, z: 0.4 },
            { side: 1, z: -32.6 },
            { side: -1, z: -65.6 },
        ])
    })
})
