/* eslint-disable react-hooks/immutability -- The walking camera is animated in place. */
import { useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

import { paintingRipple } from '../../utils/museumPaintingRipple'
import MuseumMorphPass from './MuseumMorphPass'

const PASSAGE_PLAYBACK_RATE = 1.2
const smooth = THREE.MathUtils.smoothstep

export default function MuseumPaintingPassage({ trip, veil, reducedMotion, onCross, onArrive }) {
    const { camera } = useThree()
    const home = useRef(null)
    const flight = useRef(null)
    const morph = useRef({ amount: 0, reveal: 0, focus: new THREE.Vector2() })
    useLayoutEffect(() => {
        flight.current = null
        if (!trip) return
        const start = camera.position.clone()
        const facing = camera.quaternion.clone()
        const baseFov = camera.fov
        const focus = new THREE.Vector2(0.5, 0.5)
        let target, orientation
        if (trip.phase === 'jump') {
            target = new THREE.Vector3(...trip.painting.position)
            if (trip.destination) home.current = { position: start, quaternion: facing, painting: target.clone() }
            orientation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(start, target, camera.up))
            const projected = target.clone().project(camera)
            focus.set((projected.x + 1) / 2, (1 - projected.y) / 2)
            // End just in front of the print so the near clip plane cannot cut
            // through it if the visitor approached from an oblique angle.
            target.lerp(start, 0.18)
        } else if (trip.destination) {
            target = new THREE.Vector3(...trip.destination.spawn)
            orientation = new THREE.Quaternion()
            start.copy(target)
            start.z += 0.65
            facing.copy(orientation)
        } else {
            const saved = home.current
            target = saved?.position.clone() || start.clone()
            orientation = saved?.quaternion.clone() || facing.clone()
            if (saved) {
                start.lerpVectors(saved.painting, target, 0.15)
                facing.setFromRotationMatrix(new THREE.Matrix4().lookAt(target, saved.painting, camera.up))
            }
        }
        flight.current = { elapsed: 0, start, facing, target, orientation, baseFov, focus }
        const uniform = paintingRipple(trip.painting)
        return () => {
            uniform.value = -1
            camera.fov = baseFov
            camera.updateProjectionMatrix()
        }
    }, [camera, trip])

    useFrame((_, delta) => {
        const f = flight.current
        if (!f || (reducedMotion && !veil.current)) return
        const jumping = trip.phase === 'jump'
        const enteringRoom = !jumping && Boolean(trip.destination)
        const duration = jumping ? 1.3 : enteringRoom ? 0.52 : 1.45
        const dt = Math.min(delta, 0.08)
        f.elapsed += dt * PASSAGE_PLAYBACK_RATE
        const t = Math.min(1, f.elapsed / (reducedMotion ? 0.22 : duration))
        if (reducedMotion) {
            if (!jumping) {
                camera.position.copy(f.target)
                camera.quaternion.copy(f.orientation)
            }
            veil.current.style.opacity = String(jumping ? t : 1 - t)
        } else {
            const strength = jumping ? smooth(t, 0, 0.91) : 1 - smooth(t, 0.08, 0.96)
            const distance = jumping ? 0.50 * t + 0.50 * t * t : 1 - (1 - t) ** 2
            camera.position.lerpVectors(f.start, f.target, distance)
            camera.quaternion.slerpQuaternions(f.facing, f.orientation, smooth(t, 0, jumping ? 0.5 : 1))
            camera.fov = f.baseFov + (enteringRoom ? 3 : 18) * (jumping ? smooth(t, 0.35, 0.95) : strength)
            camera.updateProjectionMatrix()
            if (jumping) paintingRipple(trip.painting).value = Math.min(1, t / 0.7)
            morph.current.amount = jumping ? strength : 1
            morph.current.reveal = jumping ? 0 : Math.min(t / (enteringRoom ? 1 : 0.94), 1)
            const centered = smooth(t, 0, 0.5)
            morph.current.focus.set(
                THREE.MathUtils.lerp(f.focus.x, 0.5, centered),
                THREE.MathUtils.lerp(1 - f.focus.y, 0.5, centered),
            )
        }
        if (t === 1) {
            flight.current = null
            if (jumping) onCross()
            else onArrive()
        }
    })
    return <MuseumMorphPass reducedMotion={reducedMotion} phase={reducedMotion ? null : trip?.phase}
        destinationBend={trip?.destination ? 0.12 : 1} motion={morph} />
}
