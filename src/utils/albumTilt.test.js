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

        update(element, 210, 170)
        expect(element.style.getPropertyValue('--glow')).toBe('100.0% 50.0%')
        expect(element.style.getPropertyValue('--album-tilt-x')).toBe('0.00deg')
        expect(element.style.getPropertyValue('--album-tilt-y')).toBe('2.64deg')
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
            update(element, 210, 170)
            expect(element.style.getPropertyValue('--album-tilt-y')).toBe('2.64deg')

            left = 110
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
