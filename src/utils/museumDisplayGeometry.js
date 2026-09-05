import * as THREE from 'three'

const prototypes = new Map()

function contactPatch(round) {
    const positions = []
    const triangle = (a, b, c) => positions.push(a[0], 0, a[1], b[0], 0, b[1], c[0], 0, c[1])
    if (round) {
        for (let index = 0; index < 12; index += 1) {
            const a = index / 12 * Math.PI * 2
            const b = (index + 1) / 12 * Math.PI * 2
            triangle([0, 0], [Math.sin(a) * 0.5, Math.cos(a) * 0.5], [Math.sin(b) * 0.5, Math.cos(b) * 0.5])
        }
    } else {
        const outer = [[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]]
        const inner = outer.map(point => point.map(value => value * 0.64))
        triangle(inner[0], inner[1], inner[2])
        triangle(inner[0], inner[2], inner[3])
        for (let index = 0; index < 4; index += 1) {
            const next = (index + 1) % 4
            triangle(outer[index], outer[next], inner[index])
            triangle(inner[index], outer[next], inner[next])
        }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2))
    geometry.computeVertexNormals()
    return geometry
}

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
    else if (shape === 'contact-rectangle' || shape === 'contact-circle') geometry = contactPatch(shape === 'contact-circle')
    else if (shape === 'page-block') geometry = new THREE.BoxGeometry(1, 1, 1, 1, 2, 1)
    else if (shape === 'cylinder') geometry = new THREE.CylinderGeometry(1, 1, 1, 10)
    else if (shape === 'reading-cylinder') geometry = new THREE.CylinderGeometry(1, 1, 1, 12)
    else if (shape === 'lens-ring') geometry = new THREE.TorusGeometry(1, 0.065, 4, 24)
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

function createPartGeometry(part) {
    const source = primitive(part.shape)
    const geometry = source.clone()
    const positions = source.getAttribute('position')
    const normals = source.getAttribute('normal')
    const color = new THREE.Color(part.color)
    const colors = new Float32Array(positions.count * 3)
    for (let index = 0; index < positions.count; index += 1) {
        const y = positions.getY(index)
        const ny = normals.getY(index)
        let shade = 1
        if (part.shape === 'contact-rectangle' || part.shape === 'contact-circle') {
            const distance = part.shape === 'contact-circle'
                ? Math.hypot(positions.getX(index), positions.getZ(index)) * 2
                : Math.max(0, (Math.max(Math.abs(positions.getX(index)), Math.abs(positions.getZ(index))) - 0.32) / 0.18)
            shade = 0.60 + Math.min(1, distance) * 0.40
        } else if (part.shape === 'vase' || part.shape === 'bud-vase') {
            // The lathe profile folds inward after the lip (profile row 7).
            // Bake the occluded cavity into existing vertices; bright light
            // cannot turn the hollow vessel into an apparently solid cylinder.
            const inside = source.getAttribute('uv').getY(index) > 0.54
            shade = inside ? 0.40 + Math.min(1, y) * 0.53 : 0.85 + Math.min(1, y / 0.18) * 0.15
        } else if (part.fineShade === 'paper-edge' && Math.abs(ny) < 0.5) {
            shade = 1 - 0.25 * Math.abs(y * 2) ** 2
        } else if (part.fineShade === 'joint') {
            // A short darkened upper joint and underface ground the slim
            // furniture members without a separate shadow decal or mesh.
            shade = ny < -0.5 ? 0.72 : 1 - 0.18 * Math.max(0, y * 2)
        } else if (part.fineShade === 'underface') {
            shade = ny < -0.5 ? 0.65 : 1
        } else if (part.fineShade === 'lens') {
            shade = 0.80 + Math.max(0, normals.getZ(index)) * 0.20
        }
        colors[index * 3] = color.r * shade
        colors[index * 3 + 1] = color.g * shade
        colors[index * 3 + 2] = color.b * shade
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.scale(...part.size)
    if (!part.shape || part.shape === 'box' || part.shape === 'chamfer' || part.shape === 'page-block') {
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
    if (part.uvFrame) {
        // Opaque contact patches must sample the exact supporting wood grain.
        // Their outside vertices return to the support's unshaded tint, so the
        // patch edge disappears instead of revealing a separate rectangle.
        const positions = geometry.getAttribute('position')
        const uv = geometry.getAttribute('uv')
        const { origin, yaw } = part.uvFrame
        for (let index = 0; index < positions.count; index += 1) {
            const x = positions.getX(index) - origin[0]
            const z = positions.getZ(index) - origin[2]
            uv.setXY(index, x * Math.cos(yaw) - z * Math.sin(yaw), x * Math.sin(yaw) + z * Math.cos(yaw))
        }
    }
    return geometry
}

// Reuse the existing single instanced plane. Its edge fades optically, while
// the inner few centimetres remain dark enough to seat the frame on the wall.
export function applyMuseumFrameContactShadow(shader) {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `
        #include <common>
        varying vec2 vMuseumFrameShadowUv;
    `).replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vMuseumFrameShadowUv = uv;
    `)
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
        #include <common>
        varying vec2 vMuseumFrameShadowUv;
    `).replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 edgeDistance = min(vMuseumFrameShadowUv, 1.0 - vMuseumFrameShadowUv);
        float edge = min(edgeDistance.x * 3.54, edgeDistance.y * 2.64);
        float penumbra = smoothstep(0.0, 0.095, edge);
        float contact = smoothstep(0.055, 0.115, edge);
        diffuseColor.a *= penumbra * (0.50 + contact * 0.50);
    `)
}

export function createMuseumReadingPartGeometry(part) {
    return createMuseumDisplayPartGeometry({
        surface: 'ceramic', roughness: 0.85, metalness: 0,
        ...part, shape: part.shape === 'cylinder' ? 'reading-cylinder' : part.shape,
    })
}

export function createMuseumDisplayPartGeometry(part) {
    const geometry = createPartGeometry(part)
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
