import { describe, expect, it } from 'vitest'
import {
    buildSettingsRound,
    hasCompleteSettings,
    matchingExposurePhotos,
    parseAperture,
    parseFocalLength,
    parseIso,
    parseShutterSeconds,
} from './exposure'

const image = {
    id: 'one',
    exif: { focalRatio: 'f/2.8', shutterSpeed: '1/500s', iso: 'ISO 400', focalLength: '56mm' },
}

describe('exposure exploration helpers', () => {
    it('normalizes common safe EXIF display values', () => {
        expect(parseAperture('f/1.8')).toBe(1.8)
        expect(parseIso('ISO 1,600')).toBe(1600)
        expect(parseFocalLength('400mm')).toBe(400)
        expect(parseShutterSeconds('1/250s')).toBeCloseTo(0.004)
        expect(parseShutterSeconds('0.5 sec')).toBe(0.5)
        expect(parseShutterSeconds('bulb')).toBe(0)
    })

    it('groups photographs without treating missing metadata as a match', () => {
        const images = [image, { id: 'two', exif: { focalRatio: 'f/11' } }, { id: 'missing' }]
        expect(matchingExposurePhotos(images, 'aperture', 'wide')).toEqual([image])
        expect(matchingExposurePhotos(images, 'aperture', 'deep')).toEqual([images[1]])
        expect(matchingExposurePhotos(images, 'unknown', 'wide')).toEqual([])
    })

    it('builds complete multiple-choice rounds and skips incomplete photographs', () => {
        expect(hasCompleteSettings(image)).toBe(true)
        expect(hasCompleteSettings({ exif: { iso: 'ISO 100' } })).toBe(false)
        const second = {
            id: 'two',
            exif: { focalRatio: 'f/8', shutterSpeed: '1/30s', iso: 'ISO 1600', focalLength: '17mm' },
        }
        const round = buildSettingsRound([image, second], '', () => 0)
        expect(round.image).toBe(image)
        expect(round.options).toContain(round.answer)
        expect(round.options).toHaveLength(4)
        expect(buildSettingsRound([{ id: 'bad' }])).toBeNull()
    })
})
