import * as THREE from 'three'

export function createMuseumReceptionFacadeGeometry(desk) {
    const { bottomY, topY, depth, bevel } = desk.facade
    const y = original => bottomY + (original + 0.67) / 1.36 * (topY - bottomY)
    const shape = new THREE.Shape()
    shape.moveTo(-1.72, y(-0.67))
    shape.quadraticCurveTo(-1.86, y(-0.65), -1.9, y(-0.48))
    shape.lineTo(-2.12, y(0.47))
    shape.quadraticCurveTo(-2.16, y(0.66), -1.94, y(0.69))
    shape.lineTo(1.94, y(0.69))
    shape.quadraticCurveTo(2.16, y(0.66), 2.12, y(0.47))
    shape.lineTo(1.9, y(-0.48))
    shape.quadraticCurveTo(1.86, y(-0.65), 1.72, y(-0.67))
    shape.closePath()
    const geometry = new THREE.ExtrudeGeometry(shape, {
        depth, bevelEnabled: true, bevelSegments: 3,
        bevelSize: bevel, bevelThickness: bevel, curveSegments: 16,
    })
    geometry.translate(0, 0, -depth / 2)
    geometry.computeVertexNormals()
    return geometry
}
