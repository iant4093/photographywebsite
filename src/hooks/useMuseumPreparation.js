import { useEffect, useState } from 'react'
import { prioritizeMuseumPreloadRooms } from '../utils/museumLayout'

function initialState(rooms, initialIds) {
    const valid = new Set(rooms.map(room => room.id))
    const ids = [...new Set(initialIds || [])].filter(id => valid.has(id)).slice(0, 2)
    const initial = new Set(ids.length ? ids : rooms.slice(0, 2).map(room => room.id))
    return { rooms, constructed: initial, ready: initial, pending: null }
}

// Keep the first bay ready behind the entrance veil. Construct and upload one
// distant room per idle turn, retaining its opaque gate until preparation ends.
export default function useMuseumPreparation({ rooms, initialIds, nearbyIds, enabled, busy, prepare, onError }) {
    const [state, setState] = useState(() => initialState(rooms, initialIds))
    if (state.rooms !== rooms) setState(initialState(rooms, initialIds))

    useEffect(() => {
        if (!enabled || state.pending || state.constructed.size >= rooms.length) return
        let timer
        const advance = () => {
            const approaching = nearbyIds?.map(id => rooms.find(room => room.id === id))
                .find(room => room && !state.constructed.has(room.id))
            // A visitor holding movement against a gate must never starve that
            // room. Prepare approaching bays while moving; leave distant work idle.
            if (document.hidden || (busy() && !approaching) || navigator.scheduling?.isInputPending?.()) {
                timer = window.setTimeout(advance, 200)
                return
            }
            const order = prioritizeMuseumPreloadRooms(rooms, nearbyIds?.[0], rooms.length)
            const room = approaching || order.find(item => !state.constructed.has(item.id))
            if (room) setState(current => ({
                ...current, constructed: new Set([...current.constructed, room.id]), pending: room,
            }))
        }
        timer = window.setTimeout(advance, 250)
        return () => window.clearTimeout(timer)
    }, [enabled, rooms, nearbyIds, state, busy])

    useEffect(() => {
        if (!state.pending) return
        const controller = new AbortController()
        const room = state.pending
        // Effects run after the new room's geometry and atlases have committed.
        Promise.resolve().then(() => prepare(room, controller.signal)).then(() => {
            if (!controller.signal.aborted) setState(current => ({
                ...current, ready: new Set([...current.ready, room.id]), pending: null,
            }))
        }).catch(cause => {
            if (!controller.signal.aborted) onError(cause)
        })
        return () => controller.abort()
    }, [state.pending, prepare, onError])

    return state
}
