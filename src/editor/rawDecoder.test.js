import { describe, expect, it } from 'vitest'
import { isRawFile } from './rawDecoder'

describe('RAW file recognition', () => {
    it.each(['photo.CR3', 'photo.nef', 'photo.ARW', 'photo.dng', 'photo.raf'])('recognizes %s', (name) => {
        expect(isRawFile({ name })).toBe(true)
    })

    it('leaves standard images on the native browser decoder', () => {
        expect(isRawFile({ name: 'photo.jpg' })).toBe(false)
        expect(isRawFile({ name: 'photo.webp' })).toBe(false)
    })
})
