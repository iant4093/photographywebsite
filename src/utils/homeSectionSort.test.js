import { describe, expect, it } from 'vitest'
import {
    HOME_SECTION_SORT_OPTIONS,
    sortHomePhotoSections,
} from './homeSectionSort'
import { VIDEO_SECTION_SORT_OPTIONS, sortVideoSections } from './videoSectionSort'

const curated = ['Birding', 'Hikes', 'Portraits']
const grouped = {
    Birding: [
        { albumId: 'bird-one', uploadedAt: '2026-01-10T12:00:00Z' },
        { albumId: 'bird-two', uploadedAt: '2026-01-05T12:00:00Z' },
    ],
    Hikes: [{ albumId: 'hike-one', uploadedAt: '2026-03-10T12:00:00Z' }],
    Portraits: [
        { albumId: 'portrait-one', uploadedAt: '2026-02-10T12:00:00Z' },
        { albumId: 'portrait-two', uploadedAt: '2026-02-09T12:00:00Z' },
        { albumId: 'portrait-three', uploadedAt: '2026-02-08T12:00:00Z' },
    ],
}

describe('home photo section sorting', () => {
    it('preserves the configured category order by default', () => {
        expect(sortHomePhotoSections(curated, grouped, 0)).toEqual(curated)
        expect(sortHomePhotoSections(curated, grouped, 99)).toEqual(curated)
    })

    it('orders entire sections by their most recently uploaded album', () => {
        expect(sortHomePhotoSections(curated, grouped, 1))
            .toEqual(['Hikes', 'Portraits', 'Birding'])
        expect(sortHomePhotoSections(curated, grouped, 2))
            .toEqual(['Birding', 'Portraits', 'Hikes'])
    })

    it('orders sections by title without changing their album arrays', () => {
        const birdingAlbums = grouped.Birding
        expect(sortHomePhotoSections(curated, grouped, 3))
            .toEqual(['Birding', 'Hikes', 'Portraits'])
        expect(sortHomePhotoSections(curated, grouped, 4))
            .toEqual(['Portraits', 'Hikes', 'Birding'])
        expect(grouped.Birding).toBe(birdingAlbums)
    })

    it('orders sections by album count and uses curated order for ties', () => {
        expect(sortHomePhotoSections(curated, grouped, 5))
            .toEqual(['Portraits', 'Birding', 'Hikes'])
        expect(sortHomePhotoSections(curated, grouped, 6))
            .toEqual(['Hikes', 'Birding', 'Portraits'])
    })

    it('shares section sorting with video while keeping media-specific labels', () => {
        expect(sortVideoSections(curated, grouped, 1)).toEqual(['Hikes', 'Portraits', 'Birding'])
        expect(HOME_SECTION_SORT_OPTIONS[5]).toBe('Most photo albums')
        expect(VIDEO_SECTION_SORT_OPTIONS[5]).toBe('Most video albums')
        expect(VIDEO_SECTION_SORT_OPTIONS[6]).toBe('Fewest video albums')
    })

    it('keeps sections without usable upload dates after dated sections', () => {
        const categories = ['Unknown', 'Known']
        const albums = {
            Unknown: [{ createdAt: '' }],
            Known: [{ createdAt: '2026-04-01T12:00:00Z' }],
        }
        expect(sortHomePhotoSections(categories, albums, 1)).toEqual(['Known', 'Unknown'])
        expect(sortHomePhotoSections(categories, albums, 2)).toEqual(['Known', 'Unknown'])
    })
})
