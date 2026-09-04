import { ExtrudeGeometry, Shape } from 'three'
import { MUSEUM_DIMENSIONS, MUSEUM_PORTAL } from './museumLayout'

export function createMuseumArchBand(innerOffset, outerOffset, depth) {
    const radius = MUSEUM_DIMENSIONS.doorwayWidth / 2
    const shape = new Shape()
    const point = (angle, offset) => [
        Math.cos(angle) * (radius + offset),
        MUSEUM_PORTAL.springHeight + Math.sin(angle) * (MUSEUM_PORTAL.rise + offset),
    ]
    shape.moveTo(...point(Math.PI, innerOffset))
    for (let index = 1; index <= 48; index += 1) {
        shape.lineTo(...point(Math.PI * (1 - index / 48), innerOffset))
    }
    for (let index = 0; index <= 48; index += 1) {
        shape.lineTo(...point(Math.PI * index / 48, outerOffset))
    }
    shape.closePath()
    const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 48 })
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
}
