import * as THREE from 'three'
import { ALBUM_FRAME_BORDER } from './museumAlbumWing'

// Cross-section of the moulding, from the outside back to the edge of the print.
// Every strip shares its boundary with the next. The mat has an actual opening.
export function albumFrameGeometry(width, height) {
    const border = ALBUM_FRAME_BORDER / 2
    const profile = [
        [border, -0.04], [border, 0.055, '#422c20'], [border - 0.014, 0.086, '#a48047'],
        [border - 0.029, 0.086, '#d1ad68'], [border - 0.052, 0.060, '#64442b'],
        [0.101, 0.081, '#73502f'], [0.086, 0.086, '#c59953'], [0.076, 0.060, '#735432'],
        [0.008, 0.060, '#d4c5ac'], [0, 0.052, '#9c8568'],
    ]
    const positions = [], colors = []
    const corners = (margin, z) => [
        [-width / 2 - margin, -height / 2 - margin, z], [width / 2 + margin, -height / 2 - margin, z],
        [width / 2 + margin, height / 2 + margin, z], [-width / 2 - margin, height / 2 + margin, z],
    ]
    let outside = corners(...profile[0])
    for (const [margin, z, finish] of profile.slice(1)) {
        const inside = corners(margin, z)
        const color = new THREE.Color(finish)
        for (let edge = 0; edge < 4; edge++) {
            const next = (edge + 1) % 4
            for (const point of [outside[edge], outside[next], inside[next], outside[edge], inside[next], inside[edge]]) {
                positions.push(...point)
                colors.push(color.r, color.g, color.b)
            }
        }
        outside = inside
    }

    // The brass picture light and its warm underside share the frame draw.
    const lightY = height / 2 + 0.38
    for (const [size, center, finish] of [
        [[0.085, 0.08, 0.15], [0, lightY, 0.075], '#816541'],
        [[Math.min(width, 1.1), 0.07, 0.13], [0, lightY, 0.21], '#c69f60'],
        [[Math.min(width, 1.03), 0.015, 0.09], [0, lightY - 0.043, 0.21], '#ffe0aa'],
    ]) {
        const box = new THREE.BoxGeometry(...size)
        box.translate(...center)
        const points = box.attributes.position
        const color = new THREE.Color(finish)
        for (const i of box.index.array) {
            positions.push(points.getX(i), points.getY(i), points.getZ(i))
            colors.push(color.r, color.g, color.b)
        }
        box.dispose()
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geometry.computeVertexNormals()
    return geometry
}

export function albumPhotoPlaque(image) {
    const exif = image?.exif || {}
    return [exif.focalLength, exif.focalRatio, exif.shutterSpeed, exif.iso].filter(Boolean).join(' · ')
}
