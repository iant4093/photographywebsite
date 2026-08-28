import { describe, expect, it } from 'vitest'
import {
    buildMuseumCatalog,
    buildMuseumLayout,
    isMuseumPositionWalkable,
    MUSEUM_DIMENSIONS,
    museumPlanarAxes,
    moveMuseumPosition,
    nearbyMuseumRoomIds,
    nearestMuseumRoom,
} from './museumLayout'

const album = (albumId, category, extra = {}) => ({
    albumId,
    type: 'photo',
    visibility: 'public',
    title: albumId,
    category,
    coverImageUrl: `https://media.test/${albumId}.jpg`,
    createdAt: '2026-08-01',
    ...extra,
})

describe('museum layout', () => {
    it('builds a public, deduplicated, dynamically ordered photo catalog', () => {
        const catalog = buildMuseumCatalog([
            album('hike-2', 'Hikes', { galleryOrder: 1, galleryCategoryOrder: 0 }),
            album('hike-1', 'Hikes', { galleryOrder: 0, galleryCategoryOrder: 0 }),
            album('astro-1', 'Astro', { galleryCategoryOrder: 1 }),
            album('hidden', 'Hikes', { visibility: 'link-only' }),
            { ...album('video', 'Hikes'), type: 'video' },
            album('hike-1', 'Hikes'),
        ])

        expect(catalog.map(category => category.name)).toEqual(['Hikes', 'Astro'])
        expect(catalog[0].albums.map(item => item.albumId)).toEqual(['hike-1', 'hike-2'])
    })

    it('alternates category rooms and gives every album one painting', () => {
        const catalog = buildMuseumCatalog([
            album('a', 'Hikes'), album('b', 'Hikes'), album('c', 'Hikes'),
            album('d', 'Astro'),
        ])
        const layout = buildMuseumLayout(catalog)

        expect(layout.rooms).toHaveLength(2)
        expect(layout.rooms[0].side).toBe(-1)
        expect(layout.rooms[1].side).toBe(1)
        expect(layout.rooms.find(room => room.name === 'Hikes').paintings).toHaveLength(3)
        expect(layout.rooms.find(room => room.name === 'Astro').paintings).toHaveLength(1)
    })

    it('keeps the player in walkable halls and rooms while blocking furniture', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([album('a', 'Hikes')]))
        expect(isMuseumPositionWalkable(layout, 0, 8)).toBe(true)
        expect(isMuseumPositionWalkable(layout, 20, 8)).toBe(false)
        expect(isMuseumPositionWalkable(layout, layout.rooms[0].centerX, layout.rooms[0].centerZ)).toBe(true)
        expect(isMuseumPositionWalkable(layout, layout.desk.position[0], layout.desk.position[2])).toBe(false)
        for (const prop of [
            ...layout.dressing.lobbyPlants,
            ...layout.dressing.hallPlants,
            ...layout.dressing.stanchions,
            layout.dressing.terminalSculpture,
            ...layout.rooms[0].plants,
        ]) {
            expect(isMuseumPositionWalkable(layout, prop.position[0], prop.position[2])).toBe(false)
        }

        const stopped = moveMuseumPosition(layout, { x: 4, z: 8 }, { x: 2, z: 0 })
        expect(stopped.x).toBe(4)
    })

    it('keeps every doorway physically connected to its hallway and room', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('left-a', 'Hikes'),
            album('right-a', 'Astro'),
            album('left-b', 'Portraits'),
            album('right-b', 'Birding'),
        ]))

        for (const room of layout.rooms) {
            const hallwayX = room.side * (MUSEUM_DIMENSIONS.hallHalfWidth - 0.4)
            const portalX = room.innerX + (room.side * 0.1)
            const roomX = room.innerX + (room.side * 0.4)
            expect(isMuseumPositionWalkable(layout, hallwayX, room.centerZ)).toBe(true)
            expect(isMuseumPositionWalkable(layout, portalX, room.centerZ)).toBe(true)
            expect(isMuseumPositionWalkable(layout, roomX, room.centerZ)).toBe(true)
            expect(isMuseumPositionWalkable(
                layout,
                portalX,
                room.centerZ + (MUSEUM_DIMENSIONS.doorwayWidth / 2) + 0.2,
            )).toBe(false)
        }
    })

    it('lets the movement controller cross every doorway in both directions', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('left-a', 'Hikes'),
            album('right-a', 'Astro'),
            album('left-b', 'Portraits'),
            album('right-b', 'Birding'),
        ]))

        for (const room of layout.rooms) {
            let position = {
                x: room.side * (MUSEUM_DIMENSIONS.hallHalfWidth - 0.4),
                z: room.centerZ,
            }
            for (let step = 0; step < 8; step += 1) {
                position = moveMuseumPosition(layout, position, { x: room.side * 0.25, z: 0 })
            }
            expect(Math.abs(position.x)).toBeGreaterThan(MUSEUM_DIMENSIONS.hallHalfWidth + 0.5)

            for (let step = 0; step < 8; step += 1) {
                position = moveMuseumPosition(layout, position, { x: room.side * -0.25, z: 0 })
            }
            expect(Math.abs(position.x)).toBeLessThan(MUSEUM_DIMENSIONS.hallHalfWidth)
        }
    })

    it('maps D to camera-right and A to its inverse', () => {
        const axes = museumPlanarAxes(0, -1)
        expect(axes.forward).toEqual({ x: 0, z: -1 })
        expect(axes.right).toEqual({ x: 1, z: 0 })

        const facingEast = museumPlanarAxes(1, 0)
        expect(facingEast.right).toEqual({ x: -0, z: 1 })
    })

    it('gives adjacent paintings museum-scale breathing room', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('a', 'Hikes'), album('b', 'Hikes'), album('c', 'Hikes'), album('d', 'Hikes'),
        ]))
        const nearWall = layout.rooms[0].paintings.filter(painting => painting.rotationY === 0)
        expect(Math.abs(nearWall[1].position[0] - nearWall[0].position[0])).toBeGreaterThanOrEqual(5.5)
    })

    it('keeps every dynamically generated room entrance traversable at full catalog scale', () => {
        const categories = Array.from({ length: 12 }, (_, categoryIndex) => (
            Array.from({ length: (categoryIndex % 5) + 1 }, (_, albumIndex) => (
                album(`album-${categoryIndex}-${albumIndex}`, `Category ${categoryIndex}`, {
                    galleryCategoryOrder: categoryIndex,
                })
            ))
        )).flat()
        const layout = buildMuseumLayout(buildMuseumCatalog(categories))

        expect(layout.rooms).toHaveLength(12)
        for (const room of layout.rooms) {
            let position = {
                x: room.side * (MUSEUM_DIMENSIONS.hallHalfWidth - 0.45),
                z: room.centerZ,
            }
            for (let step = 0; step < 20; step += 1) {
                position = moveMuseumPosition(layout, position, { x: room.side * 0.3, z: 0 })
            }
            expect(Math.abs(position.x)).toBeGreaterThan(MUSEUM_DIMENSIONS.hallHalfWidth + 2)
        }
    })

    it('preloads the nearest pair of rooms without mounting distant galleries', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('a', 'Hikes'),
            album('b', 'Astro'),
            album('c', 'Portraits'),
            album('d', 'Sports'),
        ]))
        const [x, , z] = layout.rooms[0].entrance
        expect(nearestMuseumRoom(layout, { x: x + 1, z })).toBe(layout.rooms[0].id)
        expect(nearbyMuseumRoomIds(layout, { x: 0, z })).toEqual([
            layout.rooms[0].id,
            layout.rooms[1].id,
        ])
        expect(nearbyMuseumRoomIds(layout, {
            x: layout.rooms[1].centerX,
            z: layout.rooms[1].centerZ,
        })[0]).toBe(layout.rooms[1].id)
        expect(nearestMuseumRoom(layout, { x: 0, z: 10 }, 1)).toBeNull()
    })

    it('prioritizes the room containing the player over an earlier nearby room', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('left', 'Hikes'),
            album('right', 'Astro'),
        ]))
        const rightRoom = layout.rooms[1]
        expect(nearestMuseumRoom(layout, {
            x: rightRoom.innerX + 1,
            z: rightRoom.centerZ,
        }, 10)).toBe(rightRoom.id)
    })
})
