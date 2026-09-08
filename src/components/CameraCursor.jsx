import { useEffect } from 'react'
import { installCameraCursor } from '../utils/cameraCursor'
import './CameraCursor.css'

export default function CameraCursor({ enabled, routeKey }) {
    useEffect(() => {
        if (!enabled) return undefined
        return installCameraCursor()
    }, [enabled, routeKey])
    return null
}
