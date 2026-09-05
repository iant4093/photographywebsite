import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildMuseumLayout, isMuseumPositionWalkable } from './museumLayout'
import { createMuseumReceptionDesk } from './museumReceptionDesk'
import { createMuseumReceptionFacadeGeometry } from './museumReceptionDeskGeometry'
import { museumReadingProps } from './museumDecor'
import { createMuseumReadingPartGeometry } from './museumDisplayGeometry'

describe('reception desk proportions', () => {
    it('uses a 1.05m counter and the same desk object for collision and furnishing', () => {
        const layout = buildMuseumLayout([])
        const desk = layout.desk
        expect(desk.surfaceY).toBeCloseTo(1.05, 6)
        expect(desk.position[1] - desk.size[1] / 2).toBe(0)
        expect(desk.size[0]).toBe(4.3)
        expect(desk.size[2]).toBe(1.3)
        expect(desk.countertop.size).toEqual([4.48, 0.10, 1.42])
        expect(layout.obstacles).toContain(desk)
        expect(isMuseumPositionWalkable(layout, desk.position[0], desk.position[2])).toBe(false)
    })

    it('joins the shortened facade to its floor plinth and countertop without burying either', () => {
        const desk = createMuseumReceptionDesk()
        const facade = createMuseumReceptionFacadeGeometry(desk)
        facade.computeBoundingBox()
        const floor = desk.position[1] + desk.base.position[1] - desk.base.size[1] / 2
        const plinthTop = desk.base.position[1] + desk.base.size[1] / 2
        const counterBottom = desk.countertop.position[1] - desk.countertop.size[1] / 2
        expect(floor).toBeCloseTo(0, 6)
        expect(facade.boundingBox.min.y).toBeCloseTo(plinthTop, 5)
        expect(facade.boundingBox.max.y).toBeCloseTo(counterBottom, 5)
        expect(desk.position[1] + facade.boundingBox.min.y).toBeGreaterThan(0)
        expect(desk.label.position[1] - desk.label.size[1] / 2).toBeGreaterThan(desk.insert.position[1] - desk.insert.size[1] / 2)
        expect(desk.label.position[1] + desk.label.size[1] / 2).toBeLessThan(desk.insert.position[1] + desk.insert.size[1] / 2)
        const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
        const mesh = new THREE.Mesh(facade, material)
        mesh.updateMatrixWorld()
        for (const x of desk.flutes.xs) {
            for (const y of [desk.flutes.y - desk.flutes.height / 2, desk.flutes.y + desk.flutes.height / 2]) {
                const ray = new THREE.Raycaster(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1))
                expect(ray.intersectObject(mesh).length).toBeGreaterThan(0)
            }
        }
        facade.dispose()
        material.dispose()
    })

    it('moves every reception accessory with the counter while preserving all local contact heights', () => {
        const layout = buildMuseumLayout([])
        const props = museumReadingProps(layout).filter(part => part.support.id === 'reception')
        const shifted = museumReadingProps({ ...layout, desk: { ...layout.desk, surfaceY: layout.desk.surfaceY + 0.13 } })
            .filter(part => part.support.id === 'reception')
        expect(shifted).toHaveLength(props.length)
        let lowest = Infinity
        let highest = -Infinity
        for (const [index, prop] of props.entries()) {
            expect(prop.support.position[1]).toBe(layout.desk.surfaceY)
            expect(shifted[index].position[1] - prop.position[1]).toBeCloseTo(0.13, 6)
            const geometry = createMuseumReadingPartGeometry(prop)
            geometry.computeBoundingBox()
            lowest = Math.min(lowest, geometry.boundingBox.min.y)
            highest = Math.max(highest, geometry.boundingBox.max.y)
            expect(geometry.boundingBox.min.y).toBeGreaterThanOrEqual(layout.desk.surfaceY - 1e-6)
            geometry.dispose()
        }
        expect(lowest).toBeCloseTo(layout.desk.surfaceY, 5)
        expect(highest).toBeLessThan(1.43)
        expect(props.some(part => part.detail === 'reception-camera')).toBe(true)
        expect(props.some(part => part.detail === 'contact-sheet')).toBe(true)
        expect(props.some(part => part.detail === 'camera-strap')).toBe(true)
    })
})
