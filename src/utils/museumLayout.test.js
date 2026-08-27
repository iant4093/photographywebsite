import { describe, expect, it } from 'vitest'
import {
    buildMuseumCatalog,
    buildMuseumLayout,
    isMuseumPositionWalkable,
    moveMuseumPosition,
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

        const stopped = moveMuseumPosition(layout, { x: 4, z: 8 }, { x: 2, z: 0 })
        expect(stopped.x).toBe(4)
    })

    it('preloads a room near its entrance', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog([album('a', 'Hikes')]))
        const [x, , z] = layout.rooms[0].entrance
        expect(nearestMuseumRoom(layout, { x: x + 1, z })).toBe(layout.rooms[0].id)
        expect(nearestMuseumRoom(layout, { x: 0, z: 10 }, 1)).toBeNull()
    })
})
