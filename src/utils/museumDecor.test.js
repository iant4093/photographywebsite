import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { buildMuseumLayout } from './museumLayout'
import { museumReadingProps } from './museumDecor'

function layoutFor(counts) {
    return buildMuseumLayout(counts.map((count, index) => ({
        id: `room-${index}`, name: `Room ${index}`,
        albums: Array.from({ length: count }, (_, albumIndex) => ({ albumId: `${index}-${albumIndex}` })),
    })))
}

describe('museum reading details', () => {
    it('keeps every prop on its existing furniture footprint, above its support', () => {
        const layout = layoutFor([1, 6, 26, 70])
        for (const part of museumReadingProps(layout)) {
            const geometry = part.shape === 'cylinder'
                ? new THREE.CylinderGeometry(1, 1, 1, 12)
                : new THREE.BoxGeometry(1, 1, 1)
            geometry.scale(...part.size)
            geometry.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...part.rotation)))
            geometry.translate(...part.position)
            const vertices = geometry.getAttribute('position')
            const point = new THREE.Vector3()
            const { support } = part
            for (let index = 0; index < vertices.count; index += 1) {
                point.fromBufferAttribute(vertices, index)
                expect(point.y).toBeGreaterThanOrEqual(support.position[1] - 1e-6)
                const x = point.x - support.position[0]
                const z = point.z - support.position[2]
                const localX = x * Math.cos(support.rotationY) - z * Math.sin(support.rotationY)
                const localZ = x * Math.sin(support.rotationY) + z * Math.cos(support.rotationY)
                expect(Math.abs(localX)).toBeLessThan(support.size[0] / 2)
                expect(Math.abs(localZ)).toBeLessThan(support.size[1] / 2)
                // Studs end at local |z|=.749; book stacks start beyond .85.
                if (support.id !== 'reception') expect(localZ).toBeGreaterThan(0.8)
            }
            geometry.dispose()
        }
    })

    it('funds the entire prop set from the geometry removed by flat rugs', () => {
        const originalRugLayer = new RoundedBoxGeometry(1, 1, 1, 2, 0.07)
        const oldTrianglesPerBench = originalRugLayer.getAttribute('position').count / 3 * 4
        for (const counts of [[1], [26, 10, 6, 9, 7, 4, 2, 4, 6], [70, 70, 70]]) {
            const layout = layoutFor(counts)
            const benchCount = layout.rooms.reduce((total, room) => total + room.benches.length, 0)
            const propTriangles = museumReadingProps(layout).reduce((total, part) => total + (part.shape === 'cylinder' ? 48 : 12), 0)
            const newTriangles = propTriangles + benchCount * 2
            expect(newTriangles).toBeLessThan(oldTrianglesPerBench * benchCount)
        }
        originalRugLayer.dispose()
    })
})
