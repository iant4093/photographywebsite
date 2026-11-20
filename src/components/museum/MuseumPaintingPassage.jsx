/* eslint-disable react-hooks/immutability -- The walking camera is animated in place. */
import { useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

import { paintingRipple } from '../../utils/museumPaintingRipple'

const smooth = t => t * t * (3 - 2 * t)

export default function MuseumPaintingPassage({ trip, veil, reducedMotion, arrival, onCross, onArrive }) {
    const { camera } = useThree()
    const home = useRef(null)
    const flight = useRef(null)
    useLayoutEffect(() => {
        flight.current = null
        if (!trip) return
        const start = camera.position.clone()
        const facing = camera.quaternion.clone()
        if (trip.phase === 'jump') {
            if (trip.destination) home.current = { position: start, quaternion: facing }
            const target = new THREE.Vector3(...trip.painting.position)
            const orientation = new THREE.Quaternion().setFromRotationMatrix(
                new THREE.Matrix4().lookAt(start, target, camera.up)
            )
            flight.current = { elapsed: 0, start, facing, target, orientation }
        } else {
            if (trip.destination) {
                camera.position.set(...trip.destination.spawn)
                camera.rotation.set(0, 0, 0, 'YXZ')
            } else if (home.current) {
                camera.position.copy(home.current.position)
                camera.quaternion.copy(home.current.quaternion)
            }
            flight.current = { elapsed: 0 }
        }
        const uniform = paintingRipple(trip.painting)
        return () => { uniform.value = -1 }
    }, [camera, trip])

    useFrame((_, delta) => {
        const f = flight.current
        if (!f || !veil.current) return
        const jumping = trip.phase === 'jump'
        f.elapsed += Math.min(delta, 0.08)
        const t = Math.min(1, f.elapsed / (reducedMotion ? 0.2 : jumping ? 1.12 : 0.45))
        if (jumping && !reducedMotion) {
            const jump = Math.max(0, (t - 0.22) / 0.78)
            camera.position.lerpVectors(f.start, f.target, jump * jump)
            camera.position.y += 0.48 * Math.sin(Math.PI * jump)
            camera.quaternion.slerpQuaternions(f.facing, f.orientation, smooth(Math.min(1, t * 1.7)))
            const progress = Math.min(1, t / 0.70)
            paintingRipple(trip.painting).value = progress
        }
        const closed = jumping ? smooth(Math.max(0, (t - 0.62) / 0.38)) : 1 - smooth(t)
        if (reducedMotion) veil.current.style.opacity = String(jumping ? t : 1 - t)
        else veil.current.style.setProperty('--portal-radius', (145 * (1 - closed) - 2) + 'vmax')
        if (t === 1) {
            // While the iris is shut, give the first wall a brief head start.
            // On a slow connection the photo placeholders can carry the reveal.
            if (jumping && trip.destination && arrival.pending.size && f.elapsed < 2.1) return
            flight.current = null
            if (jumping) onCross()
            else onArrive()
        }
    })
    return null
}
