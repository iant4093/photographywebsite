import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const UPHOLSTERY = new THREE.MeshStandardMaterial({ color: '#263b43', roughness: 0.75 })
const METAL = new THREE.MeshStandardMaterial({ color: '#b4c2c6', metalness: 0.7, roughness: 0.3 })
const RUBBER = new THREE.MeshStandardMaterial({ color: '#171c20', roughness: 0.85 })
const CLOTHING = new THREE.MeshStandardMaterial({ color: '#54585b', roughness: 0.85 })
const SHOE_MATERIAL = new THREE.MeshStandardMaterial({ color: '#252a2b', roughness: 0.85 })

function boxes(parts) {
    const pieces = parts.map(([position, size]) => new THREE.BoxGeometry(...size).translate(...position))
    const geometry = mergeGeometries(pieces)
    pieces.forEach(piece => piece.dispose())
    return geometry
}

const SIDES = [-1, 1]
// Shared, merged geometry keeps four detailed chairs inexpensive to render.
const SEAT = boxes([
    [[0, 0.55, 0], [0.7, 0.11, 0.65]],
    [[0, 0.91, 0.3], [0.7, 0.64, 0.1]],
    ...SIDES.map(side => [[side * 0.39, 0.86, -0.24], [0.13, 0.075, 0.94]]),
])
const FRAME = boxes([
    [[0, 0.34, 0], [0.86, 0.045, 0.05]],
    ...SIDES.flatMap(side => [
        [[side * 0.39, 0.59, -0.22], [0.035, 0.48, 0.035]],
        [[side * 0.33, 0.35, -0.36], [0.04, 0.4, 0.045]],
        [[side * 0.22, 0.17, -0.59], [0.29, 0.035, 0.27]],
    ]),
])
const HANDLES = boxes(SIDES.map(side => [[side * 0.33, 1.12, 0.4], [0.04, 0.04, 0.23]]))
const LEGS = boxes(SIDES.flatMap(side => [
    [[side * 0.17, 0.65, -0.18], [0.23, 0.17, 0.54]],
    [[side * 0.17, 0.43, -0.42], [0.18, 0.42, 0.17]],
]))
const SHOES = boxes(SIDES.map(side => [[side * 0.17, 0.25, -0.57], [0.2, 0.12, 0.29]]))
function wheelGeometry(radius) {
    const pieces = [
        new THREE.TorusGeometry(radius - 0.09, 0.014, 6, 24),
        new THREE.SphereGeometry(0.045, 8, 8),
        ...[0, Math.PI / 3, Math.PI * 2 / 3].map(angle =>
            new THREE.BoxGeometry(radius * 1.8, 0.012, 0.016).rotateZ(angle)),
    ]
    const metal = mergeGeometries(pieces)
    pieces.forEach(piece => piece.dispose())
    return { metal, tire: new THREE.TorusGeometry(radius - 0.035, 0.035, 8, 24) }
}
const REAR_WHEEL = wheelGeometry(0.36)
const CASTER = wheelGeometry(0.115)

function Wheel({ x, z, radius, wheelRef }) {
    const geometry = radius > 0.2 ? REAR_WHEEL : CASTER
    return <group ref={wheelRef} position={[x, radius, z]} rotation={[0, Math.PI / 2, 0]}>
        <mesh geometry={geometry.tire} material={RUBBER} />
        <mesh geometry={geometry.metal} material={METAL} />
    </group>
}

function MuseumWheelchair({ chair, ride }) {
    const group = useRef(null)
    const leftWheel = useRef(null)
    const rightWheel = useRef(null)
    const rider = useRef(null)
    useFrame(() => {
        if (!group.current) return
        group.current.position.set(...chair.position)
        group.current.rotation.y = chair.rotationY
        leftWheel.current.rotation.z = chair.wheelAngle
        rightWheel.current.rotation.z = chair.wheelAngle
        rider.current.visible = ride.current === chair.id
    })
    return <group ref={group} name={chair.id} position={chair.position} rotation={[0, chair.rotationY, 0]} dispose={null}>
        <mesh geometry={SEAT} material={UPHOLSTERY} />
        <mesh geometry={FRAME} material={METAL} />
        <mesh geometry={HANDLES} material={RUBBER} />
        {SIDES.map(side => <group key={side}>
            <Wheel x={side * 0.51} z={0.14} radius={0.36} wheelRef={side < 0 ? leftWheel : rightWheel} />
            <Wheel x={side * 0.36} z={-0.49} radius={0.115} />
        </group>)}
        {/* Armrests frame the level view; legs and footrests are visible below. */}
        <group ref={rider} visible={false}>
            <mesh geometry={LEGS} material={CLOTHING} />
            <mesh geometry={SHOES} material={SHOE_MATERIAL} />
        </group>
    </group>
}

export default function MuseumWheelchairs({ chairs, ride }) {
    return chairs.map(chair => <MuseumWheelchair key={chair.id} chair={chair} ride={ride} />)
}
