import { useCallback, useContext, useEffect, useState } from 'react'
import { UNSAFE_NavigationContext, useLocation, useNavigationType } from 'react-router'

// Keep the rendered collection and its filters with the history entry so a
// restored offset still points at the same albums/photos. Memory only: public
// Explore pages can contain expiring media URLs.
const routers = new WeakMap()

export default function useNavigationState(name, initialValue) {
    const location = useLocation()
    const action = useNavigationType()
    const { navigator } = useContext(UNSAFE_NavigationContext)
    if (!routers.has(navigator)) routers.set(navigator, new Map())
    const entries = routers.get(navigator)
    const key = `${location.pathname}:${location.key}:${name}`
    const initial = () => typeof initialValue === 'function' ? initialValue() : initialValue
    const [state, setState] = useState(() => ({ key, value: entries.has(key) ? entries.get(key) : initial() }))
    let value = state.value
    if (state.key !== key) {
        value = entries.has(key) ? entries.get(key) : action === 'POP' ? initial() : state.value
        setState({ key, value })
    }
    useEffect(() => {
        entries.set(key, value)
        while (entries.size > 150) entries.delete(entries.keys().next().value)
    }, [entries, key, value])
    const update = useCallback(next => setState(current => ({
        key: current.key,
        value: typeof next === 'function' ? next(current.value) : next,
    })), [])
    return [value, update]
}
