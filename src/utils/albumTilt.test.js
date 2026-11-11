import { describe, expect, it, vi } from 'vitest'
import { reset, update } from './albumTilt'

function card() {
    const element = document.createElement('button')
    element.getBoundingClientRect = vi.fn(() => ({ left: 10, top: 20, width: 200, height: 300 }))
    return element
}

describe('album media pointer tilt', () => {
    it('keeps the center still and tilts toward the edges', () => {
        const element = card()

        update(element, 110, 170)
        expect(element.style.getPropertyValue('--glow')).toBe('50.0% 50.0%')
        expect(element.style.getPropertyValue('--album-tilt-x')).toBe('0.00deg')
        expect(element.style.getPropertyValue('--album-tilt-y')).toBe('0.00deg')

        update(element, 190, 170)
        const innerTilt = Number.parseFloat(element.style.getPropertyValue('--album-tilt-y'))
        expect(innerTilt).toBeGreaterThan(2)

        update(element, 210, 170)
        expect(element.style.getPropertyValue('--glow')).toBe('100.0% 50.0%')
        expect(element.style.getPropertyValue('--album-tilt-x')).toBe('0.00deg')
        expect(element.style.getPropertyValue('--album-tilt-y')).toBe('0.00deg')
        expect(Number.parseFloat(element.style.getPropertyValue('--album-tilt-y'))).toBeLessThan(innerTilt)
    })

    it('softens corners more than straight edges', () => {
        const element = card()

        update(element, 200, 170)
        const edgeTilt = Number.parseFloat(element.style.getPropertyValue('--album-tilt-y'))

        update(element, 200, 305)
        const cornerTilt = Math.hypot(
            Number.parseFloat(element.style.getPropertyValue('--album-tilt-x')),
            Number.parseFloat(element.style.getPropertyValue('--album-tilt-y')),
        )

        expect(cornerTilt).toBeLessThan(edgeTilt)

        update(element, 210, 320)
        expect(element.style.getPropertyValue('--album-tilt-x')).toBe('0.00deg')
        expect(element.style.getPropertyValue('--album-tilt-y')).toBe('0.00deg')
    })

    it('uses stable card dimensions while the transform changes its bounds', () => {
        const element = card()
        let bounds = { left: 10, top: 20, width: 200, height: 300 }
        Object.defineProperty(element, 'offsetWidth', { value: 200 })
        Object.defineProperty(element, 'offsetHeight', { value: 300 })
        element.getBoundingClientRect = () => bounds

        update(element, 190, 170)
        const firstTilt = element.style.getPropertyValue('--album-tilt-y')
        bounds = { left: 5, top: 15, width: 210, height: 310 }
        update(element, 190, 170)

        expect(element.style.getPropertyValue('--album-tilt-y')).toBe(firstTilt)
    })

    it('recalculates while a scrolling card moves under a still pointer', () => {
        let left = 10
        let nextFrame
        vi.stubGlobal('requestAnimationFrame', vi.fn(callback => {
            nextFrame = callback
            return 1
        }))
        vi.stubGlobal('cancelAnimationFrame', vi.fn())
        const element = card()
        element.classList.add('floating-print-card')
        element.matches = vi.fn(() => true)
        element.getBoundingClientRect = () => ({ left, top: 20, width: 200, height: 300 })

        try {
            update(element, 190, 170)
            expect(Number.parseFloat(element.style.getPropertyValue('--album-tilt-y'))).toBeGreaterThan(2)

            left = 90
            nextFrame()

            expect(element.style.getPropertyValue('--glow')).toBe('50.0% 50.0%')
            expect(element.style.getPropertyValue('--album-tilt-y')).toBe('0.00deg')
        } finally {
            reset(element)
            vi.unstubAllGlobals()
        }
    })

    it('clears both tilt axes when the pointer leaves', () => {
        const element = card()
        update(element, 210, 20)

        reset(element)

        expect(element.style.getPropertyValue('--album-tilt-x')).toBe('')
        expect(element.style.getPropertyValue('--album-tilt-y')).toBe('')
        expect(element.style.getPropertyValue('--glow')).toBe('100.0% 0.0%')
    })
})
