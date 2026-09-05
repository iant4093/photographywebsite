import { useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import { createMuseumChandelierGeometry } from '../../utils/museumChandeliers'

// One reusable fixture geometry per surface, three draws for the whole hall.
// These module-owned geometries survive room visibility changes and are never
// rebuilt or uploaded while the visitor moves through the museum.
const GEOMETRY = createMuseumChandelierGeometry()

export default function MuseumChandeliers({ positions, ceilingY, materials }) {
    const brass = useRef(null)
    const opal = useRef(null)
    const light = useRef(null)

    useLayoutEffect(() => {
        const matrix = new THREE.Matrix4()
        positions.forEach(([x, z], index) => {
            matrix.makeTranslation(x, ceilingY, z)
            for (const mesh of [brass.current, opal.current, light.current]) mesh?.setMatrixAt(index, matrix)
        })
        for (const mesh of [brass.current, opal.current, light.current]) {
            if (!mesh) continue
            mesh.instanceMatrix.needsUpdate = true
            mesh.computeBoundingSphere()
        }
    }, [ceilingY, positions])

    if (!positions.length) return null
    return (
        <group>
            <instancedMesh ref={brass} args={[GEOMETRY.brass, undefined, positions.length]}>
                <meshStandardMaterial {...materials.brass} color="#ac8751" metalness={0.82} roughness={0.34} />
            </instancedMesh>
            <instancedMesh ref={opal} args={[GEOMETRY.opal, undefined, positions.length]}>
                <meshStandardMaterial {...materials.ceramic} color="#ece3d1" roughness={0.42} emissive="#ffe2b3" emissiveIntensity={0.84} />
            </instancedMesh>
            <instancedMesh ref={light} args={[GEOMETRY.light, undefined, positions.length]}>
                <meshStandardMaterial color="#fff2d5" roughness={0.55} emissive="#ffdc99" emissiveIntensity={1.5} side={THREE.DoubleSide} />
            </instancedMesh>
        </group>
    )
}
