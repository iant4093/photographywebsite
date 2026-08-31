import { describe, expect, it } from 'vitest'
import {
    buildSettingsDeck,
    buildSettingsRound,
    buildSettingsRoundForImage,
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
        expect(parseShutterSeconds('1/0s')).toBe(0)
        expect(parseShutterSeconds('-1s')).toBe(0)
        expect(parseShutterSeconds('0s')).toBe(0)
        expect(parseAperture()).toBe(0)
    })

    it('groups photographs without treating missing metadata as a match', () => {
        const images = [image, { id: 'two', exif: { focalRatio: 'f/11' } }, { id: 'missing' }]
        expect(matchingExposurePhotos(images, 'aperture', 'wide')).toEqual([image])
        expect(matchingExposurePhotos(images, 'aperture', 'deep')).toEqual([images[1]])
        expect(matchingExposurePhotos(images, 'unknown', 'wide')).toEqual([])
        expect(matchingExposurePhotos(images, 'aperture', 'unknown')).toEqual([])
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
        expect(buildSettingsRound([image], image.id, () => 0)?.image).toBe(image)
    })

    it('uses another eligible photograph when advancing a game round', () => {
        const second = {
            mediaId: 'two',
            exif: { focalRatio: 'f/8', shutterSpeed: '1/30s', iso: 'ISO 1600', focalLength: '17mm' },
        }
        const round = buildSettingsRound([image, second], image.id, () => 0)
        expect(round.image).toBe(second)
        expect(round.options).toHaveLength(4)
    })

    it('builds a shuffled no-repeat deck and rounds for its chosen photograph', () => {
        const second = {
            id: 'two',
            exif: { focalRatio: 'f/8', shutterSpeed: '1/30s', iso: 'ISO 1600', focalLength: '17mm' },
        }
        const deck = buildSettingsDeck([image, { id: 'bad' }, second], () => 0)
        expect(deck).toEqual([second, image])
        expect(new Set(deck).size).toBe(2)
        expect(buildSettingsRoundForImage([image, second], second, () => 0)?.image).toBe(second)
        expect(buildSettingsRoundForImage([image], { id: 'bad' }, () => 0)).toBeNull()
    })

    it('covers each exposure band boundary', () => {
        const examples = [
            { exif: { focalRatio: 'f/5.6', shutterSpeed: '1/100s', iso: 'ISO 100', focalLength: '17mm' } },
            { exif: { focalRatio: 'f/11', shutterSpeed: '1/30s', iso: 'ISO 1600', focalLength: '400mm' } },
            { exif: { focalRatio: 'f/2', shutterSpeed: '1/1000s', iso: 'ISO 400', focalLength: '50mm' } },
        ]
        expect(matchingExposurePhotos(examples, 'aperture', 'middle')).toEqual([examples[0]])
        expect(matchingExposurePhotos(examples, 'shutter', 'motion')).toEqual([examples[1]])
        expect(matchingExposurePhotos(examples, 'shutter', 'handheld')).toEqual([examples[0]])
        expect(matchingExposurePhotos(examples, 'shutter', 'frozen')).toEqual([examples[2]])
        expect(matchingExposurePhotos(examples, 'iso', 'clean')).toEqual([examples[0]])
        expect(matchingExposurePhotos(examples, 'iso', 'available')).toEqual([examples[2]])
        expect(matchingExposurePhotos(examples, 'iso', 'low')).toEqual([examples[1]])
        expect(matchingExposurePhotos(examples, 'focal', 'wide')).toEqual([examples[0]])
        expect(matchingExposurePhotos(examples, 'focal', 'normal')).toEqual([examples[2]])
        expect(matchingExposurePhotos(examples, 'focal', 'telephoto')).toEqual([examples[1]])
    })
})
