const DEAD_ZONE = 0.16
let trackedCard
let pointerX
let pointerY
let frame

function softenCenter(value) {
    const magnitude = Math.abs(value)
    if (magnitude <= DEAD_ZONE) return 0
    const progress = Math.min(1, (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE))
    const eased = progress * progress * (3 - 2 * progress)
    return Math.sign(value) * eased
}

function paint(card, clientX, clientY) {
    const bounds = card.getBoundingClientRect()
    const x = ((clientX - bounds.left) / bounds.width - 0.5) * 2
    const y = ((clientY - bounds.top) / bounds.height - 0.5) * 2
    card.style.setProperty('--glow', `${((x + 1) * 50).toFixed(1)}% ${((y + 1) * 50).toFixed(1)}%`)
    card.style.setProperty('--album-tilt-x', `${(-softenCenter(y) * 2.1).toFixed(2)}deg`)
    card.style.setProperty('--album-tilt-y', `${(softenCenter(x) * 2.64).toFixed(2)}deg`)
}

function followMovingCard() {
    frame = undefined
    if (!trackedCard) return
    if (!trackedCard.matches(':hover')) {
        reset(trackedCard)
        return
    }
    paint(trackedCard, pointerX, pointerY)
    frame = requestAnimationFrame(followMovingCard)
}

export function update(card, clientX, clientY) {
    paint(card, clientX, clientY)
    if (!card.classList.contains('floating-print-card')) return
    trackedCard = card
    pointerX = clientX
    pointerY = clientY
    frame ||= requestAnimationFrame(followMovingCard)
}

export function reset(card) {
    if (trackedCard === card) {
        trackedCard = undefined
        cancelAnimationFrame(frame)
        frame = undefined
    }
    card.style.removeProperty('--album-tilt-x')
    card.style.removeProperty('--album-tilt-y')
}
