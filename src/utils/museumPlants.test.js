import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildMuseumLayout } from './museumLayout'
import { MUSEUM_PLANT_FORM, MUSEUM_PLANT_LEAF_MESH, museumPlantFoliageRadius, museumPlantLeaves, museumPlantLeafVertices } from './museumPlants'

describe('museum plants', () => {
    it('keeps leaf blades above the pot and in separate angular sectors', () => {
        for (const variant of [0, 1]) {
            const leaves = museumPlantLeaves(variant)
            for (const leaf of leaves) {
                for (const [x, y, z] of museumPlantLeafVertices(leaf)) {
                    expect(y).toBeGreaterThan(MUSEUM_PLANT_FORM.potHeight + 0.25)
                    // A convex 38-degree sector contains every triangle. The
                    // neighboring petioles are at least 40.9 degrees apart.
                    const offset = Math.atan2(Math.sin(Math.atan2(x, z) - leaf.angle), Math.cos(Math.atan2(x, z) - leaf.angle))
                    expect(Math.abs(offset)).toBeLessThan(19 * Math.PI / 180)
                }
                expect(leaf.stemStart[1]).toBeLessThan(MUSEUM_PLANT_FORM.soilY)
                expect(museumPlantLeafVertices(leaf)[0]).toEqual(leaf.position)
                const rootRadius = Math.hypot(leaf.position[0], leaf.position[2])
                expect(rootRadius).toBeGreaterThan(MUSEUM_PLANT_FORM.stemRadius * 8)
            }
        }
    })

    it('calculates its envelope from the same leaf pose used by Three.js', () => {
        for (const variant of [0, 1]) {
            for (const leaf of museumPlantLeaves(variant)) {
                const matrix = new THREE.Matrix4().compose(
                    new THREE.Vector3(...leaf.position),
                    new THREE.Quaternion().setFromEuler(new THREE.Euler(-leaf.lift, leaf.angle, 0, 'YXZ')),
                    new THREE.Vector3(leaf.width, leaf.length, leaf.length),
                )
                const vertices = museumPlantLeafVertices(leaf)
                for (let index = 0; index < vertices.length; index += 1) {
                    const point = new THREE.Vector3(...MUSEUM_PLANT_LEAF_MESH.positions.slice(index * 3, index * 3 + 3)).applyMatrix4(matrix)
                    expect(point.distanceTo(new THREE.Vector3(...vertices[index]))).toBeLessThan(1e-10)
                }
            }
        }
    })

    it('reserves a clear gap around scaled foliage at every hallway and room wall', () => {
        const layout = buildMuseumLayout(Array.from({ length: 9 }, (_, index) => ({
            id: `room-${index}`,
            name: `Room ${index}`,
            albums: Array.from({ length: index * 4 + 1 }, (_, albumIndex) => ({ albumId: `${index}-${albumIndex}` })),
        })))
        for (const room of layout.rooms) {
            for (const plant of room.plants) {
                const radius = museumPlantFoliageRadius(plant.renderScale, plant.renderVariant)
                const gapX = Math.abs(room.outerX - plant.position[0]) - radius - 0.3
                const gapZ = room.width / 2 - Math.abs(plant.position[2] - room.centerZ) - radius - 0.3
                expect(gapX).toBeGreaterThanOrEqual(MUSEUM_PLANT_FORM.wallClearance - 1e-10)
                expect(gapZ).toBeGreaterThanOrEqual(MUSEUM_PLANT_FORM.wallClearance - 1e-10)
                expect(plant.size[0]).toBeCloseTo(radius * 2)
                expect(plant.size[2]).toBeCloseTo(radius * 2)
            }
        }
        for (const plant of [...layout.dressing.lobbyPlants, ...layout.dressing.hallPlants]) {
            const radius = museumPlantFoliageRadius(plant.renderScale, plant.renderVariant)
            expect(4.56 - Math.abs(plant.position[0]) - radius).toBeCloseTo(MUSEUM_PLANT_FORM.wallClearance)
            expect(Math.abs(plant.position[0]) - radius).toBeGreaterThan(2.7)
        }
    })
})
