import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, PlaneGeometry, Vector3 } from 'three'
import museumRendererSource from '../pages/ImmersiveGalleryDesktop.jsx?raw'
import { MUSEUM_ARTWORK_SURFACES, MUSEUM_DIMENSIONS } from './museumLayout'

function projectToWindow(point, camera, width, height) {
    const projected = point.clone().project(camera)
    return new Vector3(
        (projected.x + 1) * width / 2,
        (projected.y + 1) * height / 2,
        (projected.z + 1) / 2,
    )
}

function wallpaperDepthSlope(geometry, camera, width, height) {
    const vertices = geometry.getAttribute('position')
    const [a, b, c] = [0, 1, 2].map(index => projectToWindow(
        new Vector3().fromBufferAttribute(vertices, index), camera, width, height,
    ))
    const determinant = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
    const horizontal = ((b.z - a.z) * (c.y - a.y) - (c.z - a.z) * (b.y - a.y)) / determinant
    const vertical = ((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / determinant
    return Math.max(Math.abs(horizontal), Math.abs(vertical))
}

function samplePlaqueDepths(normal, dpr) {
    const width = 1280 * dpr
    const height = 720 * dpr
    const wallpaperInset = MUSEUM_DIMENSIONS.roomWallThickness / 2 + MUSEUM_DIMENSIONS.wallSurfaceGap
    const plaqueInset = MUSEUM_DIMENSIONS.artworkWallOffset + MUSEUM_ARTWORK_SURFACES.plaque
    const wallpaperZ = normal * wallpaperInset
    const camera = new PerspectiveCamera(68, width / height, 0.08, 220)
    camera.position.set(0, 1.75, wallpaperZ + normal * 2)
    camera.lookAt(20, 1.75, wallpaperZ)
    camera.updateMatrixWorld(true)

    const wallpaper = new PlaneGeometry(100, MUSEUM_DIMENSIONS.roomCeilingY)
    wallpaper.rotateY(normal < 0 ? Math.PI : 0)
    wallpaper.translate(40, MUSEUM_DIMENSIONS.roomCeilingY / 2, wallpaperZ)
    const slope = wallpaperDepthSlope(wallpaper, camera, width, height)
    const samples = [5, 8, 15, 30, 75].map(distance => {
        const plaque = new PlaneGeometry(1.72, 0.38)
        plaque.rotateY(normal < 0 ? Math.PI : 0)
        plaque.translate(distance, 2.65 + MUSEUM_ARTWORK_SURFACES.plaqueY, normal * plaqueInset)
        const vertices = plaque.getAttribute('position')
        const depthClearances = Array.from({ length: vertices.count }, (_, index) => {
            const face = new Vector3().fromBufferAttribute(vertices, index)
            const ray = face.clone().sub(camera.position)
            // Compare the label and wallpaper at the same raster location.
            // Comparing their world-space centers misses the grazing-angle bug.
            const wall = ray.clone()
                .multiplyScalar((wallpaperZ - camera.position.z) / ray.z)
                .add(camera.position)
            return projectToWindow(wall, camera, width, height).z
                - projectToWindow(face, camera, width, height).z
        })
        plaque.dispose()
        return { distance, depthClearances }
    })
    wallpaper.dispose()
    return { slope, samples }
}

describe('museum plaque visibility at oblique angles', () => {
    it.each([
        { normal: 1, dpr: 0.8 },
        { normal: -1, dpr: 0.8 },
        { normal: 1, dpr: 0.68 },
        { normal: -1, dpr: 0.68 },
    ])('keeps every plaque corner ahead of the wall for normal=$normal and dpr=$dpr', ({ normal, dpr }) => {
        const { slope, samples } = samplePlaqueDepths(normal, dpr)
        const depthResolution = 1 / ((2 ** 24) - 1)
        for (const { depthClearances } of samples) {
            // Even the distant caption clears multiple depth-buffer steps.
            expect(Math.min(...depthClearances)).toBeGreaterThan(2 * depthResolution)
        }
        // Reproduce the original symptom: factor=-1 pulled the wall over the
        // second plaque, while the nearby plaque still appeared fully drawn.
        expect(Math.min(...samples[0].depthClearances) - slope).toBeGreaterThan(0)
        expect(Math.max(...samples[1].depthClearances) - slope).toBeLessThan(0)
    })

    it('renders physically separated wallpaper without a slope-dependent depth offset', () => {
        // This narrow renderer guard connects the numerical regression above
        // to its material; WebGL components themselves are verified in-browser.
        const material = museumRendererSource.match(
            /function WallpaperMaterial\b[\s\S]*?(?=\nfunction BakedWallpaperSurface\b)/,
        )?.[0]
        expect(material).toBeTruthy()
        expect(material).not.toMatch(/^\s*polygonOffset(?:Factor|Units)?(?:\s|=|\/?>)/m)
    })
})
