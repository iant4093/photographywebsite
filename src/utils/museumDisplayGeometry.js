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
        [0.56, 0.66], [0.78, 0.37], [0.59, 0.12], [0, 0.12],
    ].map(point => new THREE.Vector2(...point)), 12)
    else if (shape === 'bud-vase') geometry = new THREE.LatheGeometry([
        [0, 0], [0.57, 0], [0.86, 0.13], [1, 0.35], [0.84, 0.58],
        [0.30, 0.76], [0.29, 1], [0.20, 1], [0.20, 0.73],
        [0.74, 0.52], [0.85, 0.33], [0.50, 0.11], [0, 0.11],
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
    if (!part.shape || part.shape === 'box' || part.shape === 'chamfer') {
        // Project in local metres before rotation. This preserves timber grain
        // scale on slender legs and broad tops, including the bevel faces.
        const positions = geometry.getAttribute('position')
        const normals = geometry.getAttribute('normal')
        const uvs = geometry.getAttribute('uv')
        for (let index = 0; index < positions.count; index += 1) {
            const x = Math.abs(normals.getX(index))
            const y = Math.abs(normals.getY(index))
            const z = Math.abs(normals.getZ(index))
            const u = x > y && x > z ? positions.getZ(index) : positions.getX(index)
            const v = y >= x && y > z ? positions.getZ(index) : positions.getY(index)
            uvs.setXY(index, u, v)
        }
    }
    geometry.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...part.rotation)))
    geometry.translate(...part.position)
    const color = new THREE.Color(part.color)
    const colors = new Float32Array(geometry.getAttribute('position').count * 3)
    for (let index = 0; index < colors.length; index += 3) color.toArray(colors, index)
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const defaults = {
        // Walnut's absolute roughness map provides the final response (~.53);
        // this coefficient only leaves a little room for its satin finish.
        wood: { roughness: 0.96, metalness: 0 },
        brass: { roughness: 0.34, metalness: 0.8 },
        ceramic: { roughness: 0.4, metalness: 0 },
    }[part.surface || 'wood']
    const count = geometry.getAttribute('position').count
    geometry.setAttribute('museumRoughness', new THREE.Float32BufferAttribute(new Float32Array(count).fill(part.roughness ?? defaults.roughness), 1))
    geometry.setAttribute('museumMetalness', new THREE.Float32BufferAttribute(new Float32Array(count).fill(part.metalness ?? defaults.metalness), 1))
    return geometry
}
