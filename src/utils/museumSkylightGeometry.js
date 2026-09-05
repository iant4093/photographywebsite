import { BoxGeometry, Color, Float32BufferAttribute, PlaneGeometry } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MUSEUM_SKYLIGHT } from './museumSkylights'

function tint(geometry, color) {
    const value = new Color(color)
    const colors = []
    for (let index = 0; index < geometry.attributes.position.count; index += 1) colors.push(value.r, value.g, value.b)
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
    return geometry
}

function merge(parts) {
    if (!parts.length) return null
    const geometry = mergeGeometries(parts, false)
    parts.forEach(part => part.dispose())
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
}

export function createMuseumSkylightGeometry(skylights) {
    const frames = []
    const panes = []
    for (const skylight of skylights) {
        const [x, , z] = skylight.position
        const [width, depth] = skylight.size
        const trim = MUSEUM_SKYLIGHT.frameWidth
        const addBox = (size, center, color) => frames.push(tint(new BoxGeometry(...size).translate(...center), color))
        const faceHeight = 0.075
        const faceY = MUSEUM_SKYLIGHT.frameBottomY + faceHeight / 2
        // Side jambs run through the corners; cross pieces finish at their
        // inside edges. Adjacent parts share faces rather than crossing.
        for (const direction of [-1, 1]) {
            addBox([trim, faceHeight, depth + trim * 2], [x + direction * (width + trim) / 2, faceY, z], '#ddd7c8')
            addBox([width, faceHeight, trim], [x, faceY, z + direction * (depth + trim) / 2], '#e9e0cc')
        }
        const revealHeight = MUSEUM_SKYLIGHT.paneY - MUSEUM_SKYLIGHT.revealBottomY
        const revealY = MUSEUM_SKYLIGHT.revealBottomY + revealHeight / 2
        for (const direction of [-1, 1]) {
            addBox([0.025, revealHeight, depth], [x + direction * (width / 2 - 0.0125), revealY, z], '#a1afad')
            addBox([width - 0.05, revealHeight, 0.025], [x, revealY, z + direction * (depth / 2 - 0.0125)], '#b7c3bd')
        }
        // Fine glazing bars sit below the glass, safely inside the reveal.
        for (const direction of [-1, 1]) {
            addBox([0.048, 0.042, depth - 0.05], [x + direction * width / 6, MUSEUM_SKYLIGHT.paneY - 0.023, z], '#dce0d6')
        }
        const pane = new PlaneGeometry(width - 0.045, depth - 0.045, 3, 2)
            .rotateX(Math.PI / 2)
            .translate(x, MUSEUM_SKYLIGHT.paneY - 0.002, z)
        const colors = []
        for (let index = 0; index < pane.attributes.position.count; index += 1) {
            const offset = (pane.attributes.position.getZ(index) - z) / depth
            const color = new Color('#b9d2dc').lerp(new Color('#dae3df'), offset + 0.5)
            colors.push(color.r, color.g, color.b)
        }
        pane.setAttribute('color', new Float32BufferAttribute(colors, 3))
        panes.push(pane)
    }
    return { frames: merge(frames), panes: merge(panes) }
}
