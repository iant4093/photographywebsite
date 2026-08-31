import { describe, expect, it } from 'vitest'
import {
    buildMuseumCatalog,
    buildMuseumLayout,
    isMuseumPositionWalkable,
    initialMuseumRoomIds,
    MUSEUM_DIMENSIONS,
    museumArtworkLightIndex,
    museumFloorSurface,
    museumPlanarAxes,
    moveMuseumPosition,
    nearbyMuseumRoomIds,
    nearestMuseumRoom,
    prioritizeMuseumPreloadRooms,
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
        // The authored room-centre bench is real furniture, not decorative
        // ghost geometry; visitors route cleanly around either side of it.
        expect(isMuseumPositionWalkable(layout, layout.rooms[0].centerX, layout.rooms[0].centerZ)).toBe(false)
        expect(isMuseumPositionWalkable(layout, layout.rooms[0].centerX, layout.rooms[0].centerZ + 2.3)).toBe(true)
        // The bench is rotated 90 degrees, so its long rendered axis is world
        // X and its short axis is world Z. Collision follows that same pose.
        expect(isMuseumPositionWalkable(layout, layout.rooms[0].centerX + 1.45, layout.rooms[0].centerZ)).toBe(false)
        expect(isMuseumPositionWalkable(layout, layout.rooms[0].centerX, layout.rooms[0].centerZ + 1.4)).toBe(true)
        expect(isMuseumPositionWalkable(layout, layout.desk.position[0], layout.desk.position[2])).toBe(false)
        for (const prop of [
            ...layout.dressing.lobbyPlants,
            ...layout.dressing.hallPlants,
            layout.dressing.terminalSculpture,
            ...layout.rooms[0].plants,
        ]) {
            expect(isMuseumPositionWalkable(layout, prop.position[0], prop.position[2])).toBe(false)
        }
        // The welcome ropes are visual dressing beside the desk, not invisible
        // collision walls that can trap a visitor on the way into the hall.
        for (const stanchion of layout.dressing.stanchions) {
            expect(isMuseumPositionWalkable(layout, stanchion.position[0], stanchion.position[2])).toBe(true)
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

    it('uses the exact architectural threshold for carpet and wood footsteps', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([album('a', 'Hikes')]))
        const room = layout.rooms[0]
        const justInsideHall = {
            x: room.innerX - (room.side * 0.16),
            z: room.centerZ,
        }
        const onThreshold = {
            x: room.innerX + (room.side * 0.04),
            z: room.centerZ,
        }
        const insideGallery = {
            x: room.innerX + (room.side * 0.4),
            z: room.centerZ + 2.3,
        }

        // The streaming system activates the nearby room from the hall, but
        // footsteps do not switch to wood until the body crosses its floor.
        expect(nearestMuseumRoom(layout, justInsideHall)).toBe(room.id)
        expect(museumFloorSurface(layout, justInsideHall)).toBe('carpet')
        expect(museumFloorSurface(layout, onThreshold)).toBe('carpet')
        expect(museumFloorSurface(layout, insideGallery)).toBe('wood')
        expect(museumFloorSurface(layout, { x: Number.NaN, z: 0 })).toBe('carpet')
    })

    it('distributes picture-light slots across every small room and large wall run', () => {
        expect(Array.from({ length: 4 }, (_, slot) => (
            museumArtworkLightIndex(2, slot, 4)
        ))).toEqual([0, 1, -1, -1])
        expect(Array.from({ length: 4 }, (_, slot) => (
            museumArtworkLightIndex(3, slot, 4)
        ))).toEqual([0, 1, 2, -1])
        expect(Array.from({ length: 4 }, (_, slot) => (
            museumArtworkLightIndex(10, slot, 4)
        ))).toEqual([0, 3, 6, 9])
        expect(museumArtworkLightIndex(0, 0, 4)).toBe(-1)
    })

    it('gives adjacent paintings museum-scale breathing room', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('a', 'Hikes'), album('b', 'Hikes'), album('c', 'Hikes'), album('d', 'Hikes'),
        ]))
        const nearWall = layout.rooms[0].paintings.filter(painting => painting.rotationY === 0)
        expect(Math.abs(nearWall[1].position[0] - nearWall[0].position[0])).toBeGreaterThanOrEqual(5.5)
    })

    it('normalizes every frame to one consistent museum presentation size', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('a', 'Hikes'), album('b', 'Hikes'), album('c', 'Hikes'), album('d', 'Hikes'),
        ]))
        expect(layout.rooms[0].paintings.every(painting => (
            painting.position[1] === 2.65
            && painting.scale.join(',') === '1,1,1'
        ))).toBe(true)
    })

    it('centers museum benches on each room axis with consistent alignment', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog(Array.from({ length: 10 }, (_, index) => (
            album(`album-${index}`, 'Hikes')
        ))))
        const room = layout.rooms[0]
        expect(room.benches.length).toBeGreaterThan(0)
        expect(room.benches.every(bench => (
            bench.position[2] === room.centerZ && bench.rotationY === Math.PI / 2
        ))).toBe(true)
    })

    it('keeps the focal landmark physical while preserving routes around its backdrop', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog(Array.from({ length: 30 }, (_, index) => (
            album(`album-${index}`, 'Hikes')
        ))))
        const room = layout.rooms[0]
        const [landmarkX, , landmarkZ] = room.landmark.position

        expect(isMuseumPositionWalkable(layout, landmarkX, landmarkZ)).toBe(false)
        expect(isMuseumPositionWalkable(layout, landmarkX, landmarkZ - 3.2)).toBe(true)
        expect(isMuseumPositionWalkable(layout, landmarkX, landmarkZ + 3.2)).toBe(true)
        expect((landmarkX - room.innerX) * room.side).toBeLessThanOrEqual(18)
    })

    it('keeps a closed streaming portal solid and permits entry after it opens', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([album('a', 'Hikes')]))
        const room = layout.rooms[0]
        const start = {
            x: room.innerX - (room.side * 0.2),
            z: room.centerZ,
        }
        const closed = moveMuseumPosition(
            layout,
            start,
            { x: room.side * 1.2, z: 0 },
            0.35,
            new Set(),
        )
        expect((closed.x - room.innerX) * room.side).toBeLessThanOrEqual(0.29)

        const opened = moveMuseumPosition(
            layout,
            start,
            { x: room.side * 1.2, z: 0 },
            0.35,
            new Set([room.id]),
        )
        expect((opened.x - room.innerX) * room.side).toBeGreaterThan(0.29)
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

    it('continues activating and traversing every portal during a sustained tour', () => {
        const albums = Array.from({ length: 10 }, (_, index) => (
            album(`tour-${index}`, `Gallery ${index}`)
        ))
        const layout = buildMuseumLayout(buildMuseumCatalog(albums))
        const openPortals = new Set()

        for (const room of layout.rooms) {
            const hallPosition = {
                x: room.innerX - (room.side * 0.24),
                z: room.centerZ,
            }
            const nearby = nearbyMuseumRoomIds(layout, hallPosition, 20)
            expect(nearby).toContain(room.id)

            openPortals.clear()
            openPortals.add(room.id)
            let position = hallPosition
            for (let step = 0; step < 14; step += 1) {
                position = moveMuseumPosition(
                    layout,
                    position,
                    { x: room.side * 0.28, z: 0 },
                    0.35,
                    openPortals,
                )
            }
            expect((position.x - room.innerX) * room.side).toBeGreaterThan(2.5)
        }
    })

    it('preloads only the nearest room without mounting its hidden sibling', () => {
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
        ])
        expect(nearbyMuseumRoomIds(layout, {
            x: layout.rooms[1].centerX,
            z: layout.rooms[1].centerZ,
        })).toEqual([layout.rooms[1].id])
        expect(nearestMuseumRoom(layout, { x: 0, z: 10 }, 1)).toBeNull()
    })

    it('warms the first authored rooms when the lobby is outside every preload radius', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('a', 'Hikes'),
            album('b', 'Astro'),
            album('c', 'Portraits'),
        ]))
        expect(initialMuseumRoomIds(layout, { x: 0, z: 500 }, 1, 2)).toEqual([
            layout.rooms[0].id,
            layout.rooms[1].id,
        ])
        expect(initialMuseumRoomIds(layout, {
            x: layout.rooms[2].centerX,
            z: layout.rooms[2].centerZ,
        }, 20, 2)).toContain(layout.rooms[2].id)
    })

    it('places one centered bench in a compact room', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('a', 'Hikes'),
            album('b', 'Hikes'),
            album('c', 'Hikes'),
            album('d', 'Hikes'),
        ]))
        const [room] = layout.rooms
        expect(room.benches).toHaveLength(1)
        expect(room.benches[0].position).toEqual([room.centerX, 0.42, room.centerZ])
        expect(room.benches[0].rotationY).toBe(Math.PI / 2)
    })

    it('divides archive-scale rooms into evenly spaced viewing salons', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog(Array.from({ length: 74 }, (_, index) => (
            album(`large-room-${index}`, 'Archive')
        ))))
        const [room] = layout.rooms
        expect(room.benches).toHaveLength(6)
        expect(room.benches.every(bench => (
            bench.position[2] === room.centerZ
            && bench.rotationY === Math.PI / 2
        ))).toBe(true)
        const intervals = room.benches.map((bench, index) => (
            index === 0
                ? Math.abs(bench.position[0] - room.innerX)
                : Math.abs(bench.position[0] - room.benches[index - 1].position[0])
        ))
        expect(Math.max(...intervals) - Math.min(...intervals)).toBeLessThan(0.001)
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

    it('pins the current room first when preloading rooms in the same bay', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('left', 'Hikes'),
            album('right', 'Astro'),
            album('next-left', 'Portraits'),
            album('next-right', 'Sports'),
        ]))
        const rightRoom = layout.rooms[1]
        const prioritized = prioritizeMuseumPreloadRooms(layout.rooms, rightRoom.id, 3)

        expect(prioritized[0].id).toBe(rightRoom.id)
        expect(prioritized.map(room => room.id)).toHaveLength(3)
        expect(new Set(prioritized.map(room => room.id)).size).toBe(3)
    })
})
