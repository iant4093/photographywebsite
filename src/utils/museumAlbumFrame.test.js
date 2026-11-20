import { describe, expect, it } from 'vitest'
import { Mesh, Raycaster, Vector3 } from 'three'
import { albumFrameGeometry, albumPhotoPlaque } from './museumAlbumFrame'

describe('album frames', () => {
    it('leaves the full photograph uncovered by the moulding', () => {
        const frame = new Mesh(albumFrameGeometry(2, 1.5))
        const ray = new Raycaster()
        const hits = (x, y) => {
            ray.set(new Vector3(x, y, 5), new Vector3(0, 0, -1))
            return ray.intersectObject(frame)
        }
        for (const x of [-0.999, 0, 0.999]) {
            for (const y of [-0.749, 0, 0.749]) expect(hits(x, y)).toHaveLength(0)
        }
        expect(hits(1.03, 0).length).toBeGreaterThan(0)
        frame.geometry.dispose()
        frame.material.dispose()
    })

    it('lists only available focal length, aperture, shutter speed and ISO on photo plaques', () => {
        const exif = { model: 'Canon EOS R7', focalLength: '12mm', focalRatio: 'f/4', shutterSpeed: '1/5s', iso: 'ISO 100' }
        expect(albumPhotoPlaque({ exif })).toBe('12mm · f/4 · 1/5s · ISO 100')
        expect(albumPhotoPlaque({ exif: { focalRatio: 'f/4' } })).toBe('f/4')
        expect(albumPhotoPlaque({ title: 'Waterfall', exif: { model: 'Canon EOS R7', lens: 'RF 35mm' } })).toBe('')
    })
})
