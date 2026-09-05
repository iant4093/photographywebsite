export const MUSEUM_JUMP = Object.freeze({
    height: 0.48,
    gravity: 9.81,
    landingDuration: 0.26,
    landingCompression: 0.035,
})

const TAKEOFF_SPEED = Math.sqrt(2 * MUSEUM_JUMP.gravity * MUSEUM_JUMP.height)
const KEYBOARD_CONTROL_SELECTOR = [
    'button', 'a', 'input', 'select', 'textarea', 'summary',
    'audio[controls]', 'video[controls]',
    '[contenteditable]:not([contenteditable="false" i])',
    ...[
        'button', 'link', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
        'combobox', 'textbox', 'searchbox', 'listbox', 'option', 'menuitem',
        'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'gridcell', 'scrollbar',
    ].map(role => `[role~="${role}"]`),
].join(',')

export function museumKeyboardTargetsControl(event) {
    // Native and assistive controls keep their own Space, arrows and letters.
    // The composed path also covers controls nested in an open shadow root.
    const path = event.composedPath?.()
    return (path?.length ? path : [event.target]).some((target) => {
        const element = target?.closest ? target : target?.parentElement
        return Boolean(element?.closest?.(KEYBOARD_CONTROL_SELECTOR))
    })
}

export function createMuseumJumpState() {
    return {
        height: 0,
        velocity: 0,
        grounded: true,
        pressed: false,
        requested: false,
        landingTime: MUSEUM_JUMP.landingDuration,
        tookOff: false,
        landed: false,
    }
}

export function resetMuseumJump(state) {
    Object.assign(state, createMuseumJumpState())
}

export function pressMuseumJump(state) {
    if (state.pressed) return
    state.pressed = true
    // An airborne press is consumed immediately, never buffered into an
    // unwanted second jump on landing. A held key also needs a fresh release.
    if (state.grounded) state.requested = true
}

export function releaseMuseumJump(state) {
    state.pressed = false
}

// Mutates one persistent controller state; no allocations or physics loop are
// needed in the render path. Exact ballistic integration keeps the arc equal
// at 30, 60 and 144 Hz, including the time left after contact with the floor.
export function advanceMuseumJump(state, delta) {
    state.tookOff = false
    state.landed = false
    if (!Number.isFinite(delta) || delta <= 0) return
    state.landingTime = Math.min(MUSEUM_JUMP.landingDuration, state.landingTime + delta)
    if (state.requested) {
        state.requested = false
        if (state.grounded) {
            state.grounded = false
            state.velocity = TAKEOFF_SPEED
            state.landingTime = MUSEUM_JUMP.landingDuration
            state.tookOff = true
        }
    }
    if (state.grounded) return
    const nextHeight = state.height + (state.velocity * delta) - (0.5 * MUSEUM_JUMP.gravity * delta * delta)
    if (nextHeight > 0) {
        state.height = nextHeight
        state.velocity -= MUSEUM_JUMP.gravity * delta
        return
    }
    const impactTime = (state.velocity + Math.sqrt(
        (state.velocity * state.velocity) + (2 * MUSEUM_JUMP.gravity * state.height),
    )) / MUSEUM_JUMP.gravity
    state.height = 0
    state.velocity = 0
    state.grounded = true
    state.landed = true
    state.landingTime = Math.min(MUSEUM_JUMP.landingDuration, Math.max(0, delta - impactTime))
}

export function museumLandingOffset(state, motionStrength = 1) {
    if (!state.grounded || motionStrength <= 0) return 0
    const progress = Math.min(1, state.landingTime / MUSEUM_JUMP.landingDuration)
    return -MUSEUM_JUMP.landingCompression * Math.sin(progress * Math.PI) * (1 - progress) * motionStrength
}
