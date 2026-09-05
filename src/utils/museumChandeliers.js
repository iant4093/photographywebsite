import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export const MUSEUM_CHANDELIER = Object.freeze({
    armCount: 6,
    armRadius: 0.92,
    shadeRadius: 0.225,
    shadeDrop: 1.47,
    lightDrop: 1.36,
    bottomDrop: 1.91,
    mountRadius: 0.25,
})

// Shared with baked illumination: the emitting bowls sit below the suspension,
// not at the former ceiling puck's location. No dynamic lights are necessary.
export function museumChandelierLightCenters(positions, ceilingY) {
    return positions.map(([x, z]) => [x, ceilingY - MUSEUM_CHANDELIER.lightDrop, z])
}

function lathe(points, segments = 8) {
    return new THREE.LatheGeometry(points.map(([radius, y]) => new THREE.Vector2(radius, y)), segments)
}

function mergeParts(parts) {
    const geometry = mergeGeometries(parts, false)
    parts.forEach(part => part.dispose())
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
}

export function createMuseumChandelierGeometry() {
    const brass = []
    const opal = []
    const light = []
    // A shallow canopy seats into the curved ceiling by five millimetres.
    // The central rod, hub and arms form a continuous physical assembly.
    brass.push(lathe([
        [0, 0.005], [0.25, 0.005], [0.25, -0.035], [0.065, -0.095], [0.023, -0.095],
    ]))
    brass.push(new THREE.CylinderGeometry(0.018, 0.024, 1.16, 8).translate(0, -0.66, 0))
    brass.push(lathe([
        [0.024, -1.205], [0.065, -1.24], [0.13, -1.35],
        [0.14, -1.49], [0.06, -1.64], [0.035, -1.79], [0, -1.91],
    ]))

    for (let index = 0; index < MUSEUM_CHANDELIER.armCount; index += 1) {
        const angle = index * Math.PI * 2 / MUSEUM_CHANDELIER.armCount + Math.PI / 6
        const shadeY = -MUSEUM_CHANDELIER.shadeDrop
        const radius = MUSEUM_CHANDELIER.armRadius
        const x = Math.cos(angle) * radius
        const z = Math.sin(angle) * radius
        const curve = new THREE.CubicBezierCurve3(
            new THREE.Vector3(0.1, -1.44, 0),
            new THREE.Vector3(0.4, -1.91, 0),
            new THREE.Vector3(0.92, -1.82, 0),
            new THREE.Vector3(radius, shadeY - 0.075, 0),
        )
        brass.push(new THREE.TubeGeometry(curve, 5, 0.027, 4, false).rotateY(-angle))
        brass.push(new THREE.CylinderGeometry(0.075, 0.042, 0.065, 8)
            .translate(x, shadeY - 0.0875, z))
        // Turned opaline bowls have actual thickness and a recessed warm
        // interior. They remain opaque: no refraction, blending or sorting.
        opal.push(lathe([
            [0, -0.082], [0.105, -0.063], [0.198, 0.018],
            [0.225, 0.155], [0.207, 0.192],
        ], 12).translate(x, shadeY, z))
        brass.push(lathe([
            [0.205, 0.19], [0.218, 0.199], [0.227, 0.18],
        ], 12).translate(x, shadeY, z))
        light.push(lathe([[0.207, 0.192], [0.17, 0.1], [0, 0.077]], 12)
            .translate(x, shadeY, z))
    }

    return { brass: mergeParts(brass), opal: mergeParts(opal), light: mergeParts(light) }
}
