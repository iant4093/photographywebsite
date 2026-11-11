let runtime

export function handlePointerTilt({ currentTarget: card, type, clientX, clientY }) {
    runtime ||= import('./albumTilt')
    runtime.then(({ update, reset }) => (
        // "pointermove" and "pointerleave" differ at this position.
        type[7] === 'm' && card.matches(':hover')
            ? update(card, clientX, clientY)
            : reset(card)
    ))
}
