import * as THREE from 'three'

const prototypes = new Map()

function chamferBox() {
    // A true bevel with 44 triangles, versus 108+ for a tessellated rounded box.
    // Broad flat faces and narrow bevels catch the existing gallery lighting.
    const positions = []
    const inset = 0.45
    const addFace = vertices => {
        const a = new THREE.Vector3(...vertices[0])
        const b = new THREE.Vector3(...vertices[1])
        const c = new THREE.Vector3(...vertices[2])
        const center = vertices.reduce((sum, point) => sum.add(new THREE.Vector3(...point)), new THREE.Vector3())
        if (new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).dot(center) < 0) vertices.reverse()
        for (let index = 1; index < vertices.length - 1; index += 1) positions.push(...vertices[0], ...vertices[index], ...vertices[index + 1])
    }
    for (let axis = 0; axis < 3; axis += 1) {
        for (const sign of [-1, 1]) {
            addFace([[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([u, v]) => {
                const point = [0, 0, 0]
                point[axis] = sign * 0.5
                point[(axis + 1) % 3] = u * inset
                point[(axis + 2) % 3] = v * inset
                return point
            }))
        }
    }
    for (let axis = 0; axis < 3; axis += 1) {
        const second = (axis + 1) % 3
        const third = (axis + 2) % 3
        for (const a of [-1, 1]) for (const b of [-1, 1]) {
            addFace([[0.5, inset, -inset], [0.5, inset, inset], [inset, 0.5, inset], [inset, 0.5, -inset]].map(([x, y, z]) => {
                const point = [0, 0, 0]
                point[axis] = a * x
                point[second] = b * y
                point[third] = z
                return point
            }))
        }
    }
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
        addFace([[x * 0.5, y * inset, z * inset], [x * inset, y * 0.5, z * inset], [x * inset, y * inset, z * 0.5]])
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2))
    geometry.computeVertexNormals()
    return geometry
}

function primitive(shape) {
    if (prototypes.has(shape)) return prototypes.get(shape)
    let geometry
    if (shape === 'chamfer') geometry = chamferBox()
    else if (shape === 'cylinder') geometry = new THREE.CylinderGeometry(1, 1, 1, 10)
    else if (shape === 'ring') geometry = new THREE.TorusGeometry(1, 0.18, 6, 20)
    else if (shape === 'vase') geometry = new THREE.LatheGeometry([
        [0, 0], [0.66, 0], [0.78, 0.10], [0.90, 0.37], [0.66, 0.70],
        [0.40, 0.84], [0.40, 1], [0.31, 1], [0.30, 0.82],
    ].map(point => new THREE.Vector2(...point)), 12)
    else geometry = new THREE.BoxGeometry(1, 1, 1)
    if (geometry.index) {
        const source = geometry
        geometry = geometry.toNonIndexed()
        source.dispose()
    }
    prototypes.set(shape, geometry)
    return geometry
}

export function createMuseumDisplayPartGeometry(part) {
    const geometry = primitive(part.shape).clone()
    geometry.scale(...part.size)
    geometry.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...part.rotation)))
    geometry.translate(...part.position)
    const color = new THREE.Color(part.color)
    const colors = new Float32Array(geometry.getAttribute('position').count * 3)
    for (let index = 0; index < colors.length; index += 3) color.toArray(colors, index)
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return geometry
}
