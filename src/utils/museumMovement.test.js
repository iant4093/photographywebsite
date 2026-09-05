import { describe, expect, it } from 'vitest'
import {
    advanceMuseumJump,
    createMuseumJumpState,
    MUSEUM_JUMP,
    museumKeyboardTargetsControl,
    museumLandingOffset,
    pressMuseumJump,
    releaseMuseumJump,
    resetMuseumJump,
} from './museumMovement'
import { buildMuseumLayout, moveMuseumPosition } from './museumLayout'

function progressJump(state, duration, frame = 1 / 60) {
    let remaining = duration
    while (remaining > 1e-10) {
        const delta = Math.min(frame, remaining)
        advanceMuseumJump(state, delta)
        remaining -= delta
    }
}

describe('museum keyboard ownership', () => {
    it.each(['button', 'a', 'input', 'select', 'textarea', 'summary'])(
        'preserves native keyboard activation and editing on %s', (tagName) => {
            const target = document.createElement(tagName)
            expect(museumKeyboardTargetsControl({ target })).toBe(true)
        },
    )

    it('recognizes a nested icon or text inside the focused Pause button', () => {
        const button = document.createElement('button')
        const label = document.createElement('span')
        label.textContent = 'Pause'
        button.append(label)
        expect(museumKeyboardTargetsControl({ target: label })).toBe(true)
        expect(museumKeyboardTargetsControl({ target: label.firstChild })).toBe(true)
    })

    it.each(['button', 'link', 'slider', 'switch', 'textbox', 'combobox', 'menuitem', 'tab'])(
        'preserves keyboard behavior of an ARIA %s', (role) => {
            const target = document.createElement('div')
            target.setAttribute('role', role)
            expect(museumKeyboardTargetsControl({ target })).toBe(true)
        },
    )

    it('keeps inherited contenteditable keyboard input out of movement', () => {
        const editor = document.createElement('div')
        const child = document.createElement('span')
        editor.setAttribute('contenteditable', 'plaintext-only')
        editor.append(child)
        expect(museumKeyboardTargetsControl({ target: child })).toBe(true)
        editor.setAttribute('contenteditable', 'false')
        expect(museumKeyboardTargetsControl({ target: child })).toBe(false)
    })

    it('recognizes controls in the composed event path', () => {
        const host = document.createElement('div')
        const button = document.createElement('button')
        expect(museumKeyboardTargetsControl({
            target: host,
            composedPath: () => [button, host, document, window],
        })).toBe(true)
    })

    it('allows gameplay keyboard input from the canvas and document', () => {
        expect(museumKeyboardTargetsControl({ target: document.createElement('canvas') })).toBe(false)
        expect(museumKeyboardTargetsControl({ target: document.body })).toBe(false)
        expect(museumKeyboardTargetsControl({ target: window })).toBe(false)
    })
})

describe('museum jumping', () => {
    it('follows a modest ballistic arc and lands exactly on the floor', () => {
        const state = createMuseumJumpState()
        const apexTime = Math.sqrt(2 * MUSEUM_JUMP.height / MUSEUM_JUMP.gravity)
        pressMuseumJump(state)
        progressJump(state, apexTime)
        expect(state.height).toBeCloseTo(0.48, 10)
        expect(state.velocity).toBeCloseTo(0, 10)
        expect(state.grounded).toBe(false)
        progressJump(state, apexTime + 0.02)
        expect(state.height).toBe(0)
        expect(state.velocity).toBe(0)
        expect(state.grounded).toBe(true)
        expect(state.landingTime).toBeCloseTo(0.02, 10)
    })

    it.each([0.1, 0.28, 0.49, 0.7])('is frame-rate independent at %s seconds', (duration) => {
        const states = [30, 60, 144].map((hz) => {
            const state = createMuseumJumpState()
            pressMuseumJump(state)
            progressJump(state, duration, 1 / hz)
            return state
        })
        states.slice(1).forEach((state) => {
            expect(state.height).toBeCloseTo(states[0].height, 10)
            expect(state.velocity).toBeCloseTo(states[0].velocity, 10)
            expect(state.landingTime).toBeCloseTo(states[0].landingTime, 10)
            expect(state.grounded).toBe(states[0].grounded)
        })
    })

    it('requires a release before another jump and consumes airborne retries', () => {
        const state = createMuseumJumpState()
        pressMuseumJump(state)
        advanceMuseumJump(state, 0.1)
        releaseMuseumJump(state)
        pressMuseumJump(state)
        expect(state.requested).toBe(false)
        progressJump(state, 1)
        pressMuseumJump(state)
        advanceMuseumJump(state, 0.1)
        expect(state.grounded).toBe(true)
        releaseMuseumJump(state)
        pressMuseumJump(state)
        advanceMuseumJump(state, 0.1)
        expect(state.tookOff).toBe(true)
        expect(state.height).toBeGreaterThan(0)
    })

    it('retains a quick tap between render frames without repeating it', () => {
        const state = createMuseumJumpState()
        pressMuseumJump(state)
        releaseMuseumJump(state)
        advanceMuseumJump(state, 1 / 60)
        expect(state.tookOff).toBe(true)
        progressJump(state, 2)
        expect(state.grounded).toBe(true)
        expect(state.requested).toBe(false)
    })

    it('resets pending inputs and airborne motion when paused', () => {
        const state = createMuseumJumpState()
        pressMuseumJump(state)
        advanceMuseumJump(state, 0.15)
        resetMuseumJump(state)
        expect(state).toEqual(createMuseumJumpState())
        advanceMuseumJump(state, 0.1)
        expect(state.height).toBe(0)
        pressMuseumJump(state)
        expect(state.requested).toBe(true)
    })

    it('softens landing without adding motion when walking motion is disabled', () => {
        const state = createMuseumJumpState()
        pressMuseumJump(state)
        progressJump(state, 0.7)
        expect(museumLandingOffset(state)).toBeLessThan(0)
        expect(museumLandingOffset(state)).toBeGreaterThan(-0.035)
        expect(museumLandingOffset(state, 0)).toBe(0)
        progressJump(state, 0.3)
        expect(museumLandingOffset(state)).toBeCloseTo(0, 10)
    })

    it('keeps horizontal room and furniture collision authoritative during a jump', () => {
        const layout = buildMuseumLayout([])
        const state = createMuseumJumpState()
        pressMuseumJump(state)
        advanceMuseumJump(state, 0.2)
        // The camera's new eye height is deliberately absent from the existing
        // horizontal collider: jumping never grants permission to cross a prop.
        const desk = layout.desk
        const start = { x: desk.position[0], z: desk.position[2] + 2 }
        const moved = moveMuseumPosition(layout, start, { x: 0, z: -2 }, 0.35)
        expect(state.height).toBeGreaterThan(0)
        expect(moved.z).toBeGreaterThan(desk.position[2] + 0.35)
    })

    it('settles safely after a long frame and ignores invalid deltas', () => {
        const state = createMuseumJumpState()
        pressMuseumJump(state)
        advanceMuseumJump(state, Number.NaN)
        expect(state.requested).toBe(true)
        advanceMuseumJump(state, 5)
        expect(state.grounded).toBe(true)
        expect(state.height).toBe(0)
        expect(museumLandingOffset(state)).toBeCloseTo(0, 10)
    })
})
