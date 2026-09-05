import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { buildMuseumLayout } from './museumLayout'
import { museumGalleryDisplayParts, museumGalleryDisplays, museumReadingProps } from './museumDecor'
import { createMuseumDisplayPartGeometry } from './museumDisplayGeometry'

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

function footprint(display) {
    const yaw = display.rotationY || 0
    const radiusX = (Math.abs(Math.cos(yaw)) * display.size[0] + Math.abs(Math.sin(yaw)) * display.size[2]) / 2
    const radiusZ = (Math.abs(Math.sin(yaw)) * display.size[0] + Math.abs(Math.cos(yaw)) * display.size[2]) / 2
    return { x: display.position[0], z: display.position[2], radiusX, radiusZ }
}

function overlaps(left, right) {
    const a = footprint(left)
    const b = footprint(right)
    return Math.abs(a.x - b.x) < a.radiusX + b.radiusX - 0.001
        && Math.abs(a.z - b.z) < a.radiusZ + b.radiusZ - 0.001
}

describe('distributed gallery displays', () => {
    it('connects the sculpture base through both rings with a visible structural spacer', () => {
        const sculptures = museumGalleryDisplays(layoutFor([6, 6, 6, 6])).filter(display => display.kind === 'sculpture')
        for (const display of sculptures) {
            const parts = museumGalleryDisplayParts(display)
            const support = parts.find(part => part.surface === 'brass' && part.shape === 'box')
            const supportGeometry = createMuseumDisplayPartGeometry(support)
            supportGeometry.computeBoundingBox()
            const supportBounds = supportGeometry.boundingBox
            const base = parts.find(part => part.surface === 'wood' && part.size[1] === 0.08)
            const baseGeometry = createMuseumDisplayPartGeometry(base)
            baseGeometry.computeBoundingBox()
            expect(supportBounds.min.y).toBeLessThan(baseGeometry.boundingBox.max.y)
            const ray = new THREE.Raycaster(new THREE.Vector3(display.position[0], 1.2, display.position[2]), new THREE.Vector3(0, 1, 0))
            for (const ring of parts.filter(part => part.shape === 'ring')) {
                const geometry = createMuseumDisplayPartGeometry(ring)
                const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
                const mesh = new THREE.Mesh(geometry, material)
                mesh.updateMatrixWorld()
                const contact = ray.intersectObject(mesh)[0]
                expect(contact).toBeDefined()
                // Penetration into the lower tube survives polygonal silhouette
                // changes and oblique views; a single vertex touch is too weak.
                expect(supportBounds.max.y).toBeGreaterThan(contact.point.y + 0.015)
                expect(supportBounds.min.y).toBeLessThan(contact.point.y)
                geometry.dispose()
                material.dispose()
            }
            baseGeometry.dispose()
            supportGeometry.dispose()
        }
    })

    it('keeps rendered vertices inside the complete collision footprint and above the floor', () => {
        const layout = layoutFor([1, 6, 26, 70])
        const point = new THREE.Vector3()
        for (const display of museumGalleryDisplays(layout)) {
            const yaw = display.rotationY || 0
            for (const part of museumGalleryDisplayParts(display)) {
                const geometry = createMuseumDisplayPartGeometry(part)
                const vertices = geometry.getAttribute('position')
                for (let index = 0; index < vertices.count; index += 1) {
                    point.fromBufferAttribute(vertices, index)
                    const dx = point.x - display.position[0]
                    const dz = point.z - display.position[2]
                    expect(Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw))).toBeLessThanOrEqual(display.size[0] / 2 + 1e-5)
                    expect(Math.abs(dx * Math.sin(yaw) + dz * Math.cos(yaw))).toBeLessThanOrEqual(display.size[2] / 2 + 1e-5)
                    expect(point.y).toBeGreaterThanOrEqual(display.position[1] - 1e-5)
                    expect(point.y).toBeLessThanOrEqual(display.position[1] + display.size[1] + 1e-5)
                }
                geometry.dispose()
            }
        }
    })

    it('clears wall trim, plants, benches and every doorway across small and archive rooms', () => {
        for (const counts of [[1], [26, 10, 6, 9, 7, 4, 2, 4, 6], [70, 70, 70]]) {
            const layout = layoutFor(counts)
            const displays = museumGalleryDisplays(layout)
            const displayIds = new Set(displays.map(display => display.id))
            const existing = layout.obstacles.filter(obstacle => !displayIds.has(obstacle.id))
            for (const display of displays) {
                expect(existing.some(obstacle => overlaps(display, obstacle)), display.id).toBe(false)
                expect(displays.some(other => other !== display && overlaps(display, other)), display.id).toBe(false)
                const bounds = footprint(display)
                if (!display.roomId) {
                    expect(Math.abs(bounds.x) - bounds.radiusX).toBeGreaterThan(3.7)
                    expect(Math.abs(bounds.x) + bounds.radiusX).toBeLessThan(4.49)
                    for (const room of layout.rooms) {
                        expect(Math.abs(bounds.z - room.centerZ) - bounds.radiusZ).toBeGreaterThan(3.3)
                    }
                } else {
                    const room = layout.rooms.find(item => item.id === display.roomId)
                    expect(bounds.x - bounds.radiusX).toBeGreaterThan(room.bounds.minX + 0.13)
                    expect(bounds.x + bounds.radiusX).toBeLessThan(room.bounds.maxX - 0.13)
                    expect(bounds.z - bounds.radiusZ).toBeGreaterThan(room.bounds.minZ + 0.44)
                    expect(bounds.z + bounds.radiusZ).toBeLessThan(room.bounds.maxZ - 0.44)
                }
            }
        }
    })

    it('furnishes the full corridor and long room while bounding the geometry to three material draws', () => {
        const layout = layoutFor([26, 10, 6, 9, 7, 4, 2, 4, 6])
        const displays = museumGalleryDisplays(layout)
        expect(displays.filter(display => !display.roomId)).toHaveLength(10)
        expect(displays.filter(display => display.roomId === 'room-0' && display.kind === 'reading-stand')).toHaveLength(4)
        const surfaces = new Set()
        let triangles = 0
        for (const display of displays) {
            for (const part of museumGalleryDisplayParts(display)) {
                surfaces.add(part.surface)
                const geometry = createMuseumDisplayPartGeometry(part)
                triangles += geometry.getAttribute('position').count / 3
                for (const name of ['position', 'normal', 'uv', 'museumRoughness', 'museumMetalness']) {
                    const attribute = geometry.getAttribute(name)
                    expect(attribute.count).toBe(geometry.getAttribute('position').count)
                    expect(attribute.array.every(Number.isFinite)).toBe(true)
                }
                const normals = geometry.getAttribute('normal')
                expect(Array.from({ length: normals.count }, (_, index) => (
                    Math.abs(normals.getX(index) ** 2 + normals.getY(index) ** 2 + normals.getZ(index) ** 2 - 1) < 1e-5
                )).every(Boolean)).toBe(true)
                if (part.objectId || part.detail?.startsWith('catalog-')) {
                    // A printed catalog should never inherit furniture grain,
                    // even though it remains inside the same three batches.
                    expect(part.surface).toBe('ceramic')
                    expect(part.roughness).toBeGreaterThanOrEqual(0.86)
                    expect(part.metalness).toBe(0)
                }
                geometry.dispose()
            }
        }
        expect(surfaces.size).toBe(3)
        expect(triangles).toBeLessThan(30_000)
        const enormous = layoutFor([1000])
        expect(museumGalleryDisplays(enormous).filter(display => display.kind === 'reading-stand')).toHaveLength(4)
    })

    it('uses a closed 44-triangle bevel with outward normals', () => {
        const geometry = createMuseumDisplayPartGeometry({ shape: 'chamfer', position: [0, 0, 0], size: [1, 1, 1], rotation: [0, 0, 0], color: '#ffffff' })
        const positions = geometry.getAttribute('position')
        const normals = geometry.getAttribute('normal')
        expect(positions.count / 3).toBe(44)
        const edges = new Map()
        for (let index = 0; index < positions.count; index += 3) {
            const vertices = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, index + offset))
            for (let offset = 0; offset < 3; offset += 1) {
                const key = [vertices[offset], vertices[(offset + 1) % 3]].map(vertex => vertex.toArray().map(value => value.toFixed(5)).join(',')).sort().join('|')
                edges.set(key, (edges.get(key) || 0) + 1)
            }
            expect(vertices[0].dot(new THREE.Vector3().fromBufferAttribute(normals, index))).toBeGreaterThan(0)
        }
        expect([...edges.values()].every(count => count === 2)).toBe(true)
        geometry.dispose()
    })

    it('gives the open catalogs a clear binding gutter and keeps them on their sloped lecterns', () => {
        const stands = museumGalleryDisplays(layoutFor([26, 26])).filter(display => display.kind === 'reading-stand')
        expect(new Set(stands.map(display => display.rotationY)).size).toBe(2)
        const point = new THREE.Vector3()
        for (const stand of stands) {
            const parts = museumGalleryDisplayParts(stand)
            const pageBounds = []
            for (const part of parts.filter(item => item.detail?.startsWith('catalog-'))) {
                const geometry = createMuseumDisplayPartGeometry(part)
                const inverseFrame = new THREE.Matrix4()
                    .makeRotationY(stand.rotationY).setPosition(...stand.position).invert()
                geometry.applyMatrix4(inverseFrame)
                geometry.translate(0, -1.18, 0)
                geometry.rotateX(-0.34)
                geometry.computeBoundingBox()
                const bounds = geometry.boundingBox.clone()
                if (part.detail === 'catalog-page') {
                    // The low page edges rest on the cloth cover; their raised
                    // outer edges form a shallow open-book profile.
                    expect(bounds.min.y).toBeGreaterThanOrEqual(0.0405)
                    expect(bounds.min.y).toBeLessThan(0.041)
                    expect(bounds.max.y).toBeGreaterThan(0.062)
                    pageBounds.push(bounds)
                }
                for (let index = 0; index < geometry.getAttribute('position').count; index += 1) {
                    point.fromBufferAttribute(geometry.getAttribute('position'), index)
                    expect(Math.abs(point.x)).toBeLessThan(0.295)
                    expect(Math.abs(point.z)).toBeLessThan(0.222)
                }
                geometry.dispose()
            }
            expect(pageBounds).toHaveLength(2)
            pageBounds.sort((a, b) => a.min.x - b.min.x)
            expect(pageBounds[0].max.x).toBeLessThan(-0.007)
            expect(pageBounds[1].min.x).toBeGreaterThan(0.007)
        }
    })

    it('keeps paper blocks between their covers when book stacks are rotated', () => {
        const consoles = museumGalleryDisplays(layoutFor([6, 6])).filter(display => display.kind === 'console')
        for (const console of consoles) {
            const parts = museumGalleryDisplayParts(console)
            for (const paper of parts.filter(part => part.detail === 'book-paper')) {
                const covers = parts.filter(part => part.objectId === paper.objectId && part.detail === 'book-cover')
                expect(covers).toHaveLength(2)
                expect(paper.size[0]).toBeLessThan(covers[0].size[0])
                expect(paper.size[2]).toBeLessThan(covers[0].size[2])
                const bounds = [paper, ...covers].map(part => {
                    const geometry = createMuseumDisplayPartGeometry(part)
                    geometry.computeBoundingBox()
                    const box = geometry.boundingBox.clone()
                    geometry.dispose()
                    return box
                })
                expect(bounds[0].min.y).toBeCloseTo(bounds[1].max.y, 6)
                expect(bounds[0].max.y).toBeCloseTo(bounds[2].min.y, 6)
            }
        }
    })

    it('projects metre-scale grain before transforming display casework', () => {
        for (const shape of ['box', 'chamfer']) {
            const part = { shape, position: [0, 0, 0], size: [1.8, 0.1, 0.6], rotation: [0, 0, 0], color: '#ffffff' }
            const local = createMuseumDisplayPartGeometry(part)
            const moved = createMuseumDisplayPartGeometry({ ...part, position: [15, 0, -20], rotation: [0, Math.PI / 2, 0] })
            expect([...local.getAttribute('uv').array]).toEqual([...moved.getAttribute('uv').array])
            const uvs = local.getAttribute('uv')
            const u = Array.from({ length: uvs.count }, (_, index) => uvs.getX(index))
            const v = Array.from({ length: uvs.count }, (_, index) => uvs.getY(index))
            expect(Math.max(...u) - Math.min(...u)).toBeCloseTo(1.8, 5)
            expect(Math.max(...v) - Math.min(...v)).toBeCloseTo(0.6, 5)
            local.dispose()
            moved.dispose()
        }
    })

    it('retains matte paper and fabric alongside glazed ceramic and metal in the existing batches', () => {
        for (const [surface, overrides, roughness, metalness] of [
            ['wood', {}, 0.96, 0], ['brass', {}, 0.34, 0.8], ['ceramic', {}, 0.4, 0],
            ['wood', { roughness: 0.9, metalness: 0 }, 0.9, 0],
            ['wood', { roughness: 0.86, metalness: 0 }, 0.86, 0],
        ]) {
            const geometry = createMuseumDisplayPartGeometry({ surface, ...overrides, shape: 'box', position: [0, 0, 0], size: [1, 1, 1], rotation: [0, 0, 0], color: '#ffffff' })
            for (const [name, value] of [['museumRoughness', roughness], ['museumMetalness', metalness]]) {
                const attribute = geometry.getAttribute(name)
                expect(attribute.count).toBe(geometry.getAttribute('position').count)
                expect([...attribute.array].every(item => Math.abs(item - value) < 1e-6)).toBe(true)
            }
            geometry.dispose()
        }
    })

    it('closes both vessel interiors with a solid foot and an open, thick rim', () => {
        for (const shape of ['vase', 'bud-vase']) {
            const geometry = createMuseumDisplayPartGeometry({ shape, position: [0, 0, 0], size: [1, 1, 1], rotation: [0, 0, 0], color: '#ffffff', surface: 'ceramic' })
            const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
            const mesh = new THREE.Mesh(geometry, material)
            mesh.updateMatrixWorld()
            const downward = new THREE.Raycaster(new THREE.Vector3(0.01, 2, 0.01), new THREE.Vector3(0, -1, 0)).intersectObject(mesh)
            const upward = new THREE.Raycaster(new THREE.Vector3(0.01, -1, 0.01), new THREE.Vector3(0, 1, 0)).intersectObject(mesh)
            expect(downward[0].point.y).toBeGreaterThan(0.10)
            expect(downward[0].point.y).toBeLessThan(0.13)
            expect(upward[0].point.y).toBeCloseTo(0, 6)
            geometry.dispose()
            material.dispose()
        }
    })
})
