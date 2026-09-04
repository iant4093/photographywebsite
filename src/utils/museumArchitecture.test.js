import { describe, expect, it } from 'vitest'
import { Matrix4, Vector3 } from 'three'
import { createMuseumArchBand } from './museumArchitecture'
import { MUSEUM_DIMENSIONS, MUSEUM_PORTAL, museumDoorAssemblyPose, buildMuseumCatalog, buildMuseumLayout, isMuseumPositionWalkable } from './museumLayout'

describe('museum doorway joinery', () => {
    it('meets the arch at the capital without crossing it or leaving vertical gaps', () => {
        const sections = MUSEUM_PORTAL.pierSections
        expect(sections[0].y - sections[0].height / 2).toBeCloseTo(0.035)
        for (let index = 1; index < sections.length; index += 1) {
            const previous = sections[index - 1]
            expect(sections[index].y - sections[index].height / 2).toBeCloseTo(previous.y + previous.height / 2)
        }
        const arch = createMuseumArchBand(0, MUSEUM_PORTAL.bandWidth, MUSEUM_PORTAL.depth)
        const cap = sections.at(-1)
        expect(arch.boundingBox.min.y).toBeCloseTo(cap.y + cap.height / 2)
        expect(arch.boundingBox.min.z).toBeCloseTo(0)
        expect(arch.boundingBox.max.z).toBeCloseTo(MUSEUM_PORTAL.depth)
        // The sign clears the crown instead of crossing its raised moulding.
        expect(MUSEUM_PORTAL.signHeight - 0.86 / 2 - arch.boundingBox.max.y).toBeGreaterThan(0.09)
        expect(arch.getAttribute('position').count / 3).toBeLessThan(450)
        arch.dispose()
    })

    it('keeps visitors clear of projecting piers without blocking either doorway', () => {
        const layout = buildMuseumLayout(buildMuseumCatalog(['Left', 'Right'].map(category => ({
            albumId: category, category, type: 'photo', coverImageUrl: '/fixture.jpg',
        }))))
        for (const room of layout.rooms) {
            for (const direction of [-1, 1]) {
                expect(isMuseumPositionWalkable(layout, room.side * 4.4, room.centerZ + direction * 2.28)).toBe(false)
            }
            for (const distance of [4, 4.4, 4.8, 5.2, 5.6]) {
                expect(isMuseumPositionWalkable(layout, room.side * distance, room.centerZ)).toBe(true)
            }
        }
    })

    it('seats both mirrored signs against the spandrel and faces them into the hall', () => {
        for (const side of [-1, 1]) {
            const pose = museumDoorAssemblyPose(side, -7)
            const rotation = new Matrix4().makeRotationY(pose.rotationY)
            const rear = new Vector3(0, 0, -0.09).applyMatrix4(rotation).add(new Vector3(...pose.sign))
            const spandrelFace = MUSEUM_DIMENSIONS.hallHalfWidth - MUSEUM_DIMENSIONS.hallWallThickness / 2 - 0.02
            expect(rear.x).toBeCloseTo(side * spandrelFace)
            expect(pose.trim[0]).toBeCloseTo(rear.x)
            expect(new Vector3(0, 0, 1).applyMatrix4(rotation).x).toBeCloseTo(-side)
        }
    })
})
