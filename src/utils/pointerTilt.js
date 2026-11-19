let runtime
let loading
let pending

function apply({ card, moving, clientX, clientY }) {
    if (moving && card.matches(':hover')) runtime.update(card, clientX, clientY)
    else runtime.reset(card)
}

export function handlePointerTilt({ currentTarget: card, type, pointerType, clientX, clientY }) {
    if (pointerType === 'touch') return
    const input = { card, moving: type === 'pointermove', clientX, clientY }
    if (runtime) {
        apply(input)
        return
    }
    pending = input
    loading ||= import('./albumTilt').then(module => {
        runtime = module
        const latest = pending
        pending = undefined
        apply(latest)
    }).catch(() => {
        pending = undefined
        loading = undefined
    })
}
