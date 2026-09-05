import { describe, expect, it } from 'vitest'
import { createMuseumChandelierGeometry, MUSEUM_CHANDELIER, museumChandelierLightCenters } from './museumChandeliers'
import { MUSEUM_DIMENSIONS, museumVaultHeightAt } from './museumLayout'

describe('museum chandeliers', () => {
    it('seats the canopy against the vault and keeps every other vertex below it', () => {
        const geometries = createMuseumChandelierGeometry()
        const ceilingY = museumVaultHeightAt(0)
        for (const geometry of Object.values(geometries)) {
            const positions = geometry.getAttribute('position')
            for (let index = 0; index < positions.count; index += 1) {
                const x = positions.getX(index)
                const y = positions.getY(index) + ceilingY
                expect(y).toBeLessThanOrEqual(museumVaultHeightAt(x) + 0.011)
                expect(y).toBeGreaterThanOrEqual(6.38)
                expect(Math.abs(x)).toBeLessThan(MUSEUM_DIMENSIONS.hallHalfWidth - 3)
            }
            geometry.dispose()
        }
        expect(ceilingY - MUSEUM_CHANDELIER.bottomDrop).toBeGreaterThan(6)
    })

    it('keeps the opaline bowls clear of one another with a bounded geometry cost', () => {
        const separation = 2 * MUSEUM_CHANDELIER.armRadius * Math.sin(Math.PI / MUSEUM_CHANDELIER.armCount)
        expect(separation - 2 * MUSEUM_CHANDELIER.shadeRadius).toBeGreaterThan(0.4)
        const geometries = createMuseumChandelierGeometry()
        const triangles = Object.values(geometries).reduce((count, geometry) => count + geometry.index.count / 3, 0)
        expect(Object.keys(geometries)).toHaveLength(3)
        expect(triangles).toBeLessThan(1800)
        Object.values(geometries).forEach(geometry => geometry.dispose())
    })

    it('locates baked light pools at the shade cluster rather than inside the roof', () => {
        expect(museumChandelierLightCenters([[0, 7], [0, -7]], 8.3)).toEqual([[0, 6.94, 7], [0, 6.94, -7]])
    })
})
