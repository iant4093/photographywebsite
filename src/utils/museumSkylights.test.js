import { describe, expect, it } from 'vitest'
import { buildMuseumLayout, MUSEUM_DIMENSIONS, museumRoomRibXs, museumRoomShell } from './museumLayout'
import {
    MUSEUM_SKYLIGHT,
    museumRoomCofferBays,
    museumRoomCofferPanels,
    museumRoomSkylights,
    museumSkylightCeilingFixtureXs,
    sampleMuseumSkylightIrradiance,
} from './museumSkylights'
import { createMuseumSkylightGeometry } from './museumSkylightGeometry'

function roomsWithAlbums(count, roomCount = 9) {
    return buildMuseumLayout(Array.from({ length: roomCount }, (_, index) => ({
        id: `room-${index}`,
        name: `Room ${index}`,
        albums: Array.from({ length: count }, (_, albumIndex) => ({ albumId: `${index}-${albumIndex}` })),
    }))).rooms
}

function rectanglesOverlap(part, skylight) {
    return Math.abs(part.position[0] - skylight.position[0]) < (part.size[0] + skylight.size[0]) / 2 - 0.00001
        && Math.abs(part.position[2] - skylight.position[2]) < (part.size[2] + skylight.size[1]) / 2 - 0.00001
}

describe('gallery skylights', () => {
    it('selects alternating architectural rooms while bounding placement and keeping frames clear of ribs and center fixtures', () => {
        const rooms = roomsWithAlbums(6)
        expect(rooms.flatMap((room, index) => museumRoomSkylights(room).length ? [index] : [])).toEqual([0, 3, 4, 7, 8])
        for (const count of [1, 2, 3, 6, 26, 74, 240]) {
            for (const room of roomsWithAlbums(count)) {
                const skylights = museumRoomSkylights(room)
                expect(skylights.length).toBeLessThanOrEqual(MUSEUM_SKYLIGHT.maximumPerRoom)
                expect(new Set(skylights.map(skylight => skylight.cofferIndex)).size).toBe(skylights.length)
                const shell = museumRoomShell(room)
                for (const skylight of skylights) {
                    const halfX = skylight.size[0] / 2 + MUSEUM_SKYLIGHT.frameWidth
                    const halfZ = skylight.size[1] / 2 + MUSEUM_SKYLIGHT.frameWidth
                    expect(skylight.position[0] - halfX).toBeGreaterThan(room.bounds.minX + 0.4)
                    expect(skylight.position[0] + halfX).toBeLessThan(room.bounds.maxX - 0.4)
                    expect(Math.abs(skylight.position[2] - room.centerZ) + halfZ).toBeLessThan(room.width / 2 - 0.4)
                    expect(skylight.position[2]).toBe(room.centerZ)
                    expect(skylights.some(other => Math.abs(other.position[0] + skylight.position[0] - shell.centerX * 2) < 0.00001)).toBe(true)
                    for (const x of museumRoomRibXs(room)) expect(Math.abs(x - skylight.position[0]) - halfX).toBeGreaterThan(0.18)
                    for (const x of museumSkylightCeilingFixtureXs(room)) {
                        expect(Math.abs(x - skylight.position[0]) - halfX).toBeGreaterThan(0.425)
                    }
                }
            }
        }
    })

    it('cuts actual coffer openings without losing any surrounding ceiling surface', () => {
        for (const room of roomsWithAlbums(26)) {
            const skylights = museumRoomSkylights(room)
            const panels = museumRoomCofferPanels(room)
            const openingArea = skylights.reduce((total, skylight) => total + skylight.size[0] * skylight.size[1], 0)
            for (const [name, widthInset, depthInset] of [['surround', 0.22, 0.7], ['inset', 0.44, 1.02]]) {
                const expectedArea = museumRoomCofferBays(room).reduce((total, bay) => total + (bay.length - widthInset) * (room.width - depthInset), 0) - openingArea
                const actualArea = panels[name].reduce((total, part) => total + part.size[0] * part.size[2], 0)
                expect(actualArea).toBeCloseTo(expectedArea, 7)
                for (const part of panels[name]) {
                    expect(part.size.every(value => value > 0)).toBe(true)
                    for (const skylight of skylights) expect(rectanglesOverlap(part, skylight)).toBe(false)
                }
            }
        }
    })

    it('keeps the two opaque batches under the roof, clear of players, and below a small triangle budget', () => {
        for (const room of roomsWithAlbums(74)) {
            const skylights = museumRoomSkylights(room)
            const geometry = createMuseumSkylightGeometry(skylights)
            if (!skylights.length) {
                expect(geometry).toEqual({ frames: null, panes: null })
                continue
            }
            let triangles = 0
            for (const batch of Object.values(geometry)) {
                triangles += batch.index.count / 3
                expect(batch.boundingBox.min.y).toBeGreaterThan(5.9)
                expect(batch.boundingBox.max.y).toBeLessThan(MUSEUM_DIMENSIONS.roomCeilingY - 0.09)
                expect([...batch.attributes.position.array].every(Number.isFinite)).toBe(true)
            }
            const normals = geometry.panes.attributes.normal
            for (let index = 0; index < normals.count; index += 1) expect(normals.getY(index)).toBeCloseTo(-1)
            expect(triangles).toBeLessThanOrEqual(skylights.length * 140)
            Object.values(geometry).forEach(batch => batch.dispose())
        }
    })

    it('projects the same cool opening onto floor and wall heights with soft edges and no light above the roof', () => {
        const [skylight] = museumRoomSkylights(roomsWithAlbums(6)[0])
        const sample = (x, y, z) => sampleMuseumSkylightIrradiance({ skylights: [skylight], x, y, z })
        for (const y of [0, 1.5, 3, 5]) {
            const drop = skylight.position[1] - y
            const x = skylight.position[0] + skylight.slope[0] * drop
            const z = skylight.position[2] + skylight.slope[1] * drop
            const center = sample(x, y, z)
            const feather = sample(x + skylight.size[0] / 2 + 0.3, y, z)
            const outside = sample(x + skylight.size[0] / 2 + 1, y, z)
            expect(center[2]).toBeGreaterThan(center[1])
            expect(center[1]).toBeGreaterThan(center[0])
            expect(center[2]).toBeGreaterThan(0.22)
            expect(feather[2]).toBeGreaterThan(0)
            expect(feather[2]).toBeLessThan(center[2])
            expect(outside).toEqual([0, 0, 0])
        }
        expect(sample(skylight.position[0], 6.2, skylight.position[2])).toEqual([0, 0, 0])
        expect(sampleMuseumSkylightIrradiance()).toEqual([0, 0, 0])
    })
})
