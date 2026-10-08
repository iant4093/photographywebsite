import { describe, expect, it } from 'vitest'
import { buildMuseumCatalog, buildMuseumLayout, isMuseumPositionWalkable, moveMuseumPosition } from './museumLayout'
import { createMuseumWheelchairs, focusedMuseumWheelchair, MUSEUM_WHEELCHAIR, museumWheelchairCollisionLayout, museumWheelchairExitPosition, museumWheelchairPathClear } from './museumWheelchairs'

function gallery() {
    return buildMuseumLayout(buildMuseumCatalog([
        { albumId: 'a', category: 'Photos', title: 'Photos', type: 'photo', visibility: 'public', coverImageUrl: '/test.jpg' },
    ]))
}

describe('museum wheelchairs', () => {
    it('parks the two center chairs behind reception with clearance for their full collision footprint', () => {
        const layout = gallery()
        const chairs = createMuseumWheelchairs(layout)
        expect(chairs).toHaveLength(2)
        expect(chairs.map(chair => chair.position[0])).toEqual([-0.95, 0.95])
        expect(new Set(chairs.map(chair => chair.id)).size).toBe(2)
        for (const chair of chairs) {
            expect(chair.position[2]).toBeLessThan(layout.desk.position[2] - layout.desk.size[2])
            expect(isMuseumPositionWalkable(museumWheelchairCollisionLayout(layout, chairs, chair.id),
                chair.position[0], chair.position[2], MUSEUM_WHEELCHAIR.radius)).toBe(true)
            const exit = museumWheelchairExitPosition(layout, chairs, chair)
            expect(exit).not.toBeNull()
            expect(isMuseumPositionWalkable(museumWheelchairCollisionLayout(layout, chairs), exit.x, exit.z)).toBe(true)
        }
    })

    it('targets only nearby chairs in front of the visitor', () => {
        const chairs = createMuseumWheelchairs(gallery())
        const position = { x: chairs[0].position[0], z: chairs[0].position[2] + 1.5 }
        expect(focusedMuseumWheelchair(chairs, position, { x: 0, z: -1 })).toBe(chairs[0])
        expect(focusedMuseumWheelchair(chairs, position, { x: 0, z: 1 })).toBeNull()
        expect(focusedMuseumWheelchair(chairs, { x: 0, z: 11 }, { x: 0, z: -1 })).toBeNull()
    })

    it('collides with parked chairs and excludes the occupied chair', () => {
        const layout = gallery(), chairs = createMuseumWheelchairs(layout), chair = chairs[0]
        expect(isMuseumPositionWalkable(museumWheelchairCollisionLayout(layout, chairs), chair.position[0], chair.position[2])).toBe(false)
        expect(isMuseumPositionWalkable(museumWheelchairCollisionLayout(layout, chairs, chair.id), chair.position[0], chair.position[2], MUSEUM_WHEELCHAIR.radius)).toBe(true)
    })

    it('keeps parked collision aligned with an arbitrarily rotated chair', () => {
        const layout = gallery(), chairs = createMuseumWheelchairs(layout), chair = chairs[0]
        chair.rotationY = Math.PI / 4
        const world = (x, z) => ({
            x: chair.position[0] + x * Math.cos(chair.rotationY) + z * Math.sin(chair.rotationY),
            z: chair.position[2] - x * Math.sin(chair.rotationY) + z * Math.cos(chair.rotationY),
        })
        const collision = museumWheelchairCollisionLayout(layout, chairs)
        const inside = world(0.3, 0.65), outside = world(0.65, 0.3)
        expect(isMuseumPositionWalkable(collision, inside.x, inside.z, 0)).toBe(false)
        expect(isMuseumPositionWalkable(collision, outside.x, outside.z, 0)).toBe(true)
    })

    it('cannot tunnel through reception, thin furniture, walls or a closed room gate at turbo speed', () => {
        const layout = gallery()
        const stopped = moveMuseumPosition(layout, { x: 0, z: 3.7 }, { x: 0, z: 8 }, MUSEUM_WHEELCHAIR.radius)
        expect(stopped.z).toBeLessThan(layout.desk.position[2] - layout.desk.size[2] / 2 - MUSEUM_WHEELCHAIR.radius)
        const thin = { ...layout, obstacles: [{ position: [0, 0, 2], size: [8, 1, 0.05] }] }
        expect(moveMuseumPosition(thin, { x: 0, z: 0 }, { x: 0, z: 4 }, MUSEUM_WHEELCHAIR.radius).z).toBeLessThan(1.1)
        expect(moveMuseumPosition(layout, { x: 3.5, z: 8 }, { x: 20, z: 0 }, MUSEUM_WHEELCHAIR.radius).x).toBeLessThanOrEqual(3.9)
        const room = layout.rooms[0]
        const start = { x: 0, z: room.centerZ }
        const delta = { x: room.innerX + room.side * 3, z: 0 }
        const blocked = moveMuseumPosition(layout, start, delta, MUSEUM_WHEELCHAIR.radius, new Set())
        expect((blocked.x - room.innerX) * room.side).toBeLessThan(0)
        const open = moveMuseumPosition(layout, start, delta, MUSEUM_WHEELCHAIR.radius, new Set([room.id]))
        expect((open.x - room.innerX) * room.side).toBeGreaterThan(1)
    })

    it('rejects boarding across furniture and exits across a wall or into a blocked area', () => {
        const layout = gallery(), chairs = createMuseumWheelchairs(layout), chair = chairs[0]
        const barrier = { position: [chair.position[0], 0, chair.position[2] + 0.8], size: [1.5, 1, 0.05] }
        expect(museumWheelchairPathClear({ ...layout, obstacles: [...layout.obstacles, barrier] }, chairs, chair,
            { x: chair.position[0], z: chair.position[2] + 1.5 }, { x: chair.position[0], z: chair.position[2] })).toBe(false)
        const sealed = { ...layout, obstacles: [{ position: [0, 0, 3.7], size: [20, 1, 20] }] }
        expect(museumWheelchairExitPosition(sealed, chairs, chair)).toBeNull()
    })
})
