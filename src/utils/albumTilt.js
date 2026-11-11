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

function edgeStability(x, y) {
    const edge = Math.max(Math.abs(x), Math.abs(y))
    if (edge <= 0.84) return 1
    const progress = Math.min(1, (edge - 0.84) / 0.16)
    return 1 - 0.65 * progress * progress * (3 - 2 * progress)
}

function paint(card, clientX, clientY) {
    const bounds = card.getBoundingClientRect()
    const width = card.offsetWidth || bounds.width
    const height = card.offsetHeight || bounds.height
    const x = Math.max(-1, Math.min(1, (clientX - bounds.left - bounds.width / 2) / width * 2))
    const y = Math.max(-1, Math.min(1, (clientY - bounds.top - bounds.height / 2) / height * 2))
    const stability = edgeStability(x, y)
    card.style.setProperty('--glow', `${((x + 1) * 50).toFixed(1)}% ${((y + 1) * 50).toFixed(1)}%`)
    card.style.setProperty('--album-tilt-x', `${(-softenCenter(y) * 2.1 * stability).toFixed(2)}deg`)
    card.style.setProperty('--album-tilt-y', `${(softenCenter(x) * 2.64 * stability).toFixed(2)}deg`)
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
