import * as THREE from 'three'

export const BENCH_PALETTES = [
    { base: '#342126', cushion: '#75464f', rugOuter: '#3e282c', rugInner: '#5b3940', rugBorder: '#8a744f', rugCenter: '#48292f' },
    { base: '#252c31', cushion: '#4f6570', rugOuter: '#273137', rugInner: '#3f535d', rugBorder: '#9a8257', rugCenter: '#30444e' },
    { base: '#352d22', cushion: '#70604b', rugOuter: '#393128', rugInner: '#5b4e3d', rugBorder: '#a28958', rugCenter: '#493d30' },
]

export function createMuseumRugAtlas() {
    const canvas = document.createElement('canvas')
    const tile = 256
    canvas.width = tile
    canvas.height = tile * BENCH_PALETTES.length
    const context = canvas.getContext('2d')
    BENCH_PALETTES.forEach((palette, index) => {
        context.save()
        context.translate(0, index * tile)
        context.fillStyle = palette.rugOuter
        context.fillRect(0, 0, tile, tile)
        context.fillStyle = palette.rugInner
        context.fillRect(10, 10, 236, 236)
        context.strokeStyle = palette.rugBorder
        context.lineWidth = 3
        context.strokeRect(16, 16, 224, 224)
        context.lineWidth = 1
        context.strokeRect(25, 25, 206, 206)
        context.fillStyle = palette.rugCenter
        context.fillRect(30, 30, 196, 196)
        // Woven geometry gives each reading area a quieter, finer pattern
        // than four stacked slabs. One small atlas serves every salon.
        for (let y = 48; y < 224; y += 32) {
            for (let x = 48; x < 224; x += 32) {
                context.beginPath()
                context.moveTo(x, y - 5)
                context.lineTo(x + 4, y)
                context.lineTo(x, y + 5)
                context.lineTo(x - 4, y)
                context.closePath()
                context.stroke()
            }
        }
        context.globalAlpha = 0.1
        context.strokeStyle = '#eadbc1'
        for (let line = 2; line < tile; line += 3) {
            context.beginPath()
            context.moveTo(1, line)
            context.lineTo(tile - 1, line)
            context.stroke()
        }
        context.restore()
    })
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    return texture
}
