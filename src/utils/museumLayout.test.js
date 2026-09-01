import { describe, expect, it } from 'vitest'
import {
    buildMuseumCatalog,
    buildMuseumLayout,
    isMuseumPositionWalkable,
    initialMuseumRoomIds,
    MUSEUM_DIMENSIONS,
    museumArtworkDetailWidth,
    museumArtworkLightIndex,
    museumCeilingLightPose,
    museumEndWallPlacardPose,
    museumFloorSurface,
    museumPlanarAxes,
    museumRoomGateOpen,
    museumRoomCeilingFixtureXs,
    moveMuseumPosition,
    nearbyMuseumRoomIds,
    nearestMuseumRoom,
    prioritizeMuseumPreloadRooms,
    retainMuseumRoomPresentation,
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

    it('keeps the central viewing axis free of decorative landmarks', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog(Array.from({ length: 30 }, (_, index) => (
            album(`album-${index}`, 'Hikes')
        ))))
        const room = layout.rooms[0]
        expect(room.landmark).toBeUndefined()
        expect(isMuseumPositionWalkable(layout, room.centerX, room.centerZ)).toBe(true)
    })

    it('blocks entry at a closed curtain, opens with the real gate, and always permits exit', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([album('a', 'Hikes')]))
        const room = layout.rooms[0]
        const start = {
            x: room.innerX - (room.side * 0.4),
            z: room.centerZ,
        }
        const closed = moveMuseumPosition(
            layout,
            start,
            { x: room.side * 1.2, z: 0 },
            0.35,
            new Set(),
        )
        expect((closed.x - room.innerX) * room.side).toBeLessThanOrEqual(
            MUSEUM_DIMENSIONS.portalGateDepth - 0.35,
        )

        const opened = moveMuseumPosition(
            layout,
            start,
            { x: room.side * 1.2, z: 0 },
            0.35,
            new Set([room.id]),
        )
        expect((opened.x - room.innerX) * room.side).toBeGreaterThan(0.29)

        const exited = moveMuseumPosition(
            layout,
            { x: room.innerX + (room.side * 0.8), z: room.centerZ },
            { x: room.side * -1.2, z: 0 },
            0.35,
            new Set(),
        )
        expect((exited.x - room.innerX) * room.side).toBeLessThan(0)
    })

    it('cannot tunnel through a closed curtain with a large diagonal step', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([album('a', 'Hikes')]))
        const room = layout.rooms[0]
        const result = moveMuseumPosition(
            layout,
            {
                x: room.innerX - (room.side * 0.7),
                z: room.centerZ - 0.25,
            },
            { x: room.side * 4.5, z: 0.4 },
            0.35,
            new Set(),
        )

        expect((result.x - room.innerX) * room.side).toBeLessThanOrEqual(
            MUSEUM_DIMENSIONS.portalGateDepth - 0.35,
        )
    })

    it('cannot use a large diagonal step to enter through the wall beside a portal', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([album('a', 'Hikes')]))
        const room = layout.rooms[0]
        const start = {
            x: room.innerX - (room.side * 0.7),
            z: room.centerZ + 2.05,
        }
        const result = moveMuseumPosition(
            layout,
            start,
            { x: room.side * 4.5, z: -2.05 },
            0.35,
            new Set([room.id]),
        )

        expect((result.x - room.innerX) * room.side).toBeLessThanOrEqual(-0.35)
        expect(result.z).toBeCloseTo(room.centerZ)
    })

    it('reserves the category end wall for its title', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('a', 'Hikes'), album('b', 'Hikes'), album('c', 'Hikes'),
        ]))
        const room = layout.rooms[0]
        expect(room.paintings.every(painting => (
            painting.rotationY === 0 || painting.rotationY === Math.PI
        ))).toBe(true)
        expect(room.paintings.every(painting => painting.position[0] !== room.outerX)).toBe(true)
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
        for (const room of layout.rooms) {
            const hallPosition = {
                x: room.innerX - (room.side * 0.24),
                z: room.centerZ,
            }
            const nearby = nearbyMuseumRoomIds(layout, hallPosition, 20)
            expect(nearby).toContain(room.id)

            let position = hallPosition
            for (let step = 0; step < 14; step += 1) {
                position = moveMuseumPosition(
                    layout,
                    position,
                    { x: room.side * 0.28, z: 0 },
                    0.35,
                )
            }
            expect((position.x - room.innerX) * room.side).toBeGreaterThan(2.5)
        }
    })

    it('does not retain stale passability through repeated curtain cycles', () => {
        const albums = Array.from({ length: 12 }, (_, index) => (
            album(`guarded-${index}`, `Gallery ${index}`)
        ))
        const layout = buildMuseumLayout(buildMuseumCatalog(albums))

        for (let circuit = 0; circuit < 5; circuit += 1) {
            for (const room of layout.rooms) {
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
                expect((closed.x - room.innerX) * room.side).toBeLessThanOrEqual(
                    MUSEUM_DIMENSIONS.portalGateDepth - 0.35,
                )
                const opened = moveMuseumPosition(
                    layout,
                    start,
                    { x: room.side * 1.2, z: 0 },
                    0.35,
                    new Set([room.id]),
                )
                expect((opened.x - room.innerX) * room.side).toBeGreaterThan(0.29)
            }
        }
    })

    it('keeps a retiring room furnished until its curtain is fully closed', () => {
        expect(retainMuseumRoomPresentation(true, true)).toBe(true)
        expect(retainMuseumRoomPresentation(false, false)).toBe(true)
        expect(retainMuseumRoomPresentation(false, true)).toBe(false)
        expect(retainMuseumRoomPresentation(true, false)).toBe(true)
    })

    it('anchors live ceiling light sources to their modeled fixtures', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('a', 'Hikes'), album('b', 'Hikes'), album('c', 'Hikes'), album('d', 'Hikes'),
            album('e', 'Hikes'), album('f', 'Hikes'), album('g', 'Hikes'), album('h', 'Hikes'),
            album('i', 'Hikes'), album('j', 'Hikes'),
        ]))
        const room = layout.rooms[0]
        const fixtureXs = museumRoomCeilingFixtureXs(room, 4)
        expect(fixtureXs).toHaveLength(4)
        expect(fixtureXs.every(x => room.paintings.some(painting => painting.position[0] === x))).toBe(true)

        const ceilingPose = museumCeilingLightPose(fixtureXs[1], room.centerZ, 6.09)
        expect(fixtureXs).toContain(ceilingPose.source[0])
        expect(ceilingPose.source[1]).toBeCloseTo(5.948)
        expect(ceilingPose.source[2]).toBe(room.centerZ)
        expect(ceilingPose.target).toEqual([fixtureXs[1], 0.12, room.centerZ])
    })

    it('centers the end-wall label on its backing without visible depth parallax', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([
            album('left', 'Hikes'),
            album('right', 'Portraits'),
        ]))
        for (const room of layout.rooms) {
            const pose = museumEndWallPlacardPose(room)
            expect(pose.backing[1]).toBe(3.08)
            expect(pose.label[1]).toBe(pose.backing[1])
            expect(pose.label[2]).toBe(pose.backing[2])
            expect(Math.abs(pose.label[0] - pose.backing[0])).toBeCloseTo(0.035)
            expect(pose.rotationY).toBe(room.side < 0 ? Math.PI / 2 : -Math.PI / 2)
        }
    })

    it('separates room preparation from the singular curtain request', () => {
        expect(museumRoomGateOpen({ active: true, requested: false, baseReady: true })).toBe(false)
        expect(museumRoomGateOpen({ active: true, requested: true, baseReady: false })).toBe(false)
        expect(museumRoomGateOpen({ active: false, requested: true, baseReady: true })).toBe(false)
        expect(museumRoomGateOpen({ active: true, requested: true, baseReady: true })).toBe(true)
    })

    it('uses a single close inspection tier without retaining it at room distance', () => {
        expect(museumArtworkDetailWidth(30)).toBe(0)
        expect(museumArtworkDetailWidth(17.9)).toBe(640)
        expect(museumArtworkDetailWidth(19, { currentWidth: 640 })).toBe(640)
        expect(museumArtworkDetailWidth(19)).toBe(0)
        expect(museumArtworkDetailWidth(3.1, { focused: true })).toBe(1440)
        expect(museumArtworkDetailWidth(3.1, { focused: true, inspectionWidth: 960 })).toBe(960)
        expect(museumArtworkDetailWidth(4.3, { focused: true })).toBe(640)
        expect(museumArtworkDetailWidth(12, { currentWidth: 1440 })).toBe(640)
        expect(museumArtworkDetailWidth(22, { currentWidth: 1440 })).toBe(0)
    })

    it('keeps the nearest doorway pair resident for a stable bay handoff', () => {
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
        const contained = nearbyMuseumRoomIds(layout, {
            x: layout.rooms[1].centerX,
            z: layout.rooms[1].centerZ,
        })
        expect(contained[0]).toBe(layout.rooms[1].id)
        expect(contained).toEqual([layout.rooms[1].id, layout.rooms[0].id])
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
