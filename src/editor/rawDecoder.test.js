import { describe, expect, it } from 'vitest'
import { isRawFile } from './rawDecoder'

describe('RAW file recognition', () => {
    it.each(['3fr', 'arw', 'cr2', 'cr3', 'dcr', 'dng', 'erf', 'fff', 'iiq', 'kdc', 'mef', 'mos', 'mrw', 'nef', 'nrw', 'orf', 'pef', 'raf', 'raw', 'rw2', 'rwl', 'srw', 'x3f'])('recognizes .%s RAW files', (extension) => {
        const name = `photo.${extension.toUpperCase()}`
        expect(isRawFile({ name })).toBe(true)
    })

    it('leaves standard images on the native browser decoder', () => {
        expect(isRawFile({ name: 'photo.jpg' })).toBe(false)
        expect(isRawFile({ name: 'photo.webp' })).toBe(false)
    })
})
