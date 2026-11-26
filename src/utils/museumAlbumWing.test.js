import { describe, expect, it } from 'vitest'
import { albumBayAt, buildMuseumAlbumWing, moveInAlbumWing } from './museumAlbumWing'

const album = { albumId: 'coast', title: 'Coast' }
const photos = Array.from({ length: 221 }, (_, i) => ({ id: 'print-' + i, width: i % 3 === 0 ? 800 : 1400, height: 1100 }))

describe('album wing generation', () => {
    it('hangs the full album in order, with a stable and album-specific floor plan', () => {
        const wing = buildMuseumAlbumWing(album, photos)
        expect(wing.bays.flatMap(bay => bay.prints.map(print => print.image))).toEqual(photos)
        expect(buildMuseumAlbumWing(album, photos)).toEqual(wing)
        expect(buildMuseumAlbumWing({ albumId: 'desert' }, photos).bays).not.toEqual(wing.bays)
        for (const bay of wing.bays.slice(1, -2)) {
            expect(bay.prints).toHaveLength(6)
            expect(bay.prints.filter(print => print.position[0] < 0)).toHaveLength(3)
        }
        expect(wing.bays.at(-2).prints).toHaveLength(photos.length % 6)
    })

    it.each([1, 3, 11, 221])('centers the hanging and reserves both exit rooms for %i prints', count => {
        const wing = buildMuseumAlbumWing(album, photos.slice(0, count))
        const exit = wing.bays.at(-1)
        expect(exit.prints).toEqual([])
        expect(wing.bays[0].prints).toEqual([])
        expect(wing.portals).toHaveLength(2)
        expect(wing.portals[0].position[2]).toBeGreaterThan(wing.bays[0].back + 6)
        expect(wing.portals[0].position[0]).toBe(wing.spawn[0])
        expect(wing.portals[1].position[2]).toBeLessThan(exit.front - 6)
        for (const bay of wing.bays.slice(0, -1)) {
            for (const side of [-1, 1]) {
                const prints = bay.prints.filter(print => Math.sign(print.position[0]) === side)
                if (!prints.length) continue
                expect(prints[0].position[0]).toBeCloseTo(side * (bay.width / 2 - 0.055))
                const rows = Math.ceil(bay.prints.length / 2)
                const middle = (bay.front + bay.back) / 2
                for (let i = 0; i < prints.length; i++) {
                    expect(prints[i].position[2]).toBeCloseTo(middle + ((rows - 1) / 2 - i) * 4.15)
                    if (!i) continue
                    const edgeGap = prints[i - 1].position[2] - prints[i].position[2]
                        - (prints[i - 1].frameWidth + prints[i].frameWidth) / 2
                    expect(edgeGap).toBeGreaterThan(1.25)
                }
                expect(prints.at(-1).position[2]).toBeGreaterThan(exit.front + 2)
            }
        }
    })

    it('keeps a continuous, bidirectional walking path through every arch and seals both end walls', () => {
        const wing = buildMuseumAlbumWing(album, photos)
        let position = { x: 0, z: wing.spawn[2] }
        const visited = new Set()
        const length = Math.ceil(-wing.bays.at(-1).back)
        for (const step of [-0.2, 0.2]) {
            for (let i = 0; i < (length + 2) / Math.abs(step); i++) {
                position = moveInAlbumWing(wing, position, { x: 0, z: step })
                visited.add(albumBayAt(wing.bays, position.z))
            }
            expect(position.z).toBeCloseTo(step < 0 ? wing.bays.at(-1).back + 0.35 : -0.35)
        }
        expect(visited.size).toBe(wing.bays.length)
    })

    it('keeps the aisle clear and gives the furnishings solid footprints', () => {
        const wing = buildMuseumAlbumWing(album, photos)
        const bay = wing.bays[1]
        expect(bay.benches).toHaveLength(4)
        for (const side of [-1, 1]) {
            const wall = bay.prints.filter(p => Math.sign(p.position[0]) === side)
            const seats = bay.benches.filter(b => Math.sign(b.position[0]) === side)
            expect(seats).toHaveLength(2)
            seats.forEach((bench, i) => {
                const gap = (wall[i].position[2] + wall[i + 1].position[2]) / 2
                expect(bench.position[2]).toBeCloseTo(gap)
            })
        }
        for (const prop of [...bay.plants, ...bay.benches]) {
            const [x, , z] = prop.position
            const start = { x: x - Math.sign(x) * (prop.size[0] / 2 + 0.4), z }
            expect(moveInAlbumWing(wing, start, { x: Math.sign(x) * 0.12, z: 0 })).toEqual(start)
        }
    })

    it.each([0.1, 2 / 3, 1.5])('leaves exposed floor between paired bench rugs at aspect %f', aspect => {
        const images = Array.from({ length: 11 }, () => ({ width: 1200 * aspect, height: 1200 }))
        const { bays } = buildMuseumAlbumWing(album, images)
        for (const bay of bays.slice(1, -1)) {
            for (const side of [-1, 1]) {
                const [a, b] = bay.benches.filter(bench => Math.sign(bench.position[0]) === side)
                if (!b) continue
                const clearance = Math.abs(a.position[2] - b.position[2]) - (a.rugLength + b.rugLength) / 2
                expect(clearance).toBeGreaterThanOrEqual(0.75 - 1e-8)
                expect(a.rugLength).toBeGreaterThan(a.size[2])
            }
        }
    })

    it('aligns both bench rows across the aisle in a mixed 23-photo album', () => {
        const images = Array.from({ length: 23 }, (_, i) => ({ width: i % 5 < 2 ? 600 : 1600, height: 1000 }))
        for (const bay of buildMuseumAlbumWing(album, images).bays.slice(1, -1)) {
            const left = bay.benches.filter(b => b.position[0] < 0)
            const right = bay.benches.filter(b => b.position[0] > 0)
            for (let i = 0; i < Math.min(left.length, right.length); i++) {
                expect(left[i].position[2]).toBe(right[i].position[2])
                expect(right[i].position[0]).toBe(-left[i].position[0])
            }
            for (const row of [left, right]) {
                if (row.length === 2) expect(row[0].position[2] - row[1].position[2] - row[0].rugLength).toBeCloseTo(1.9)
            }
        }
    })

    it('slides along the solid wall beside each doorway', () => {
        const wing = buildMuseumAlbumWing(album, photos)
        for (const bay of wing.bays.slice(0, -1)) {
            const start = { x: 2.0, z: bay.back + 0.6 }
            const next = moveInAlbumWing(wing, start, { x: -0.1, z: -1 })
            expect(next.x).toBeCloseTo(1.9)
            expect(next.z).toBeGreaterThan(bay.back + 0.35)
        }
    })

    it('creates a walkable gallery with both exits even before the first photograph is added', () => {
        const wing = buildMuseumAlbumWing(album, [])
        expect(wing.bays).toHaveLength(2)
        expect(wing.bays[0].prints).toHaveLength(0)
        expect(wing.portals.every(portal => portal.isExit)).toBe(true)
        expect(moveInAlbumWing(wing, { x: 0, z: wing.spawn[2] }, { x: 0, z: -1 }).z).toBeCloseTo(wing.spawn[2] - 1)
    })
})
