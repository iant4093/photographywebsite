/* eslint-disable react-hooks/immutability -- Three.js scene environment state is managed by the renderer lifecycle. */
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { museumHallSconcePlacements } from '../../utils/museumSupport'

const DARK_BRASS = '#735332'
let textileDetailTexture = null
const BENCH_ROUNDED_BOX = new RoundedBoxGeometry(1, 1, 1, 3, 0.1)
const RUG_ROUNDED_BOX = new RoundedBoxGeometry(1, 1, 1, 2, 0.07)
const BENCH_PALETTES = [
    { base: '#342126', cushion: '#75464f', rugOuter: '#3e282c', rugInner: '#5b3940', rugBorder: '#8a744f', rugCenter: '#48292f' },
    { base: '#252c31', cushion: '#4f6570', rugOuter: '#273137', rugInner: '#3f535d', rugBorder: '#9a8257', rugCenter: '#30444e' },
    { base: '#352d22', cushion: '#70604b', rugOuter: '#393128', rugInner: '#5b4e3d', rugBorder: '#a28958', rugCenter: '#493d30' },
]

function getTextileDetailTexture() {
    if (textileDetailTexture || typeof document === 'undefined') return textileDetailTexture
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')
    context.fillStyle = '#777'
    context.fillRect(0, 0, 64, 64)
    context.strokeStyle = 'rgba(235,235,235,.3)'
    context.lineWidth = 1
    for (let offset = -64; offset < 128; offset += 5) {
        context.beginPath()
        context.moveTo(offset, 0)
        context.lineTo(offset - 64, 64)
        context.stroke()
        context.beginPath()
        context.moveTo(offset, 0)
        context.lineTo(offset + 64, 64)
        context.stroke()
    }
    textileDetailTexture = new THREE.CanvasTexture(canvas)
    textileDetailTexture.wrapS = THREE.RepeatWrapping
    textileDetailTexture.wrapT = THREE.RepeatWrapping
    textileDetailTexture.repeat.set(8, 12)
    textileDetailTexture.anisotropy = 2
    textileDetailTexture.needsUpdate = true
    return textileDetailTexture
}

const LEAVES = [
    [-0.14, 0.56, 0.02, -0.48, 0.12, 0.36, 0.84],
    [0.18, 0.67, 0.08, 0.42, -0.18, -0.28, 0.78],
    [-0.03, 0.86, -0.12, -0.08, 0.52, 0.12, 0.92],
    [0.26, 0.94, 0.05, 0.34, 0.08, -0.5, 0.72],
    [-0.28, 1.02, 0.09, -0.42, -0.1, 0.48, 0.76],
    [0.05, 1.15, -0.08, 0.08, -0.44, 0.04, 0.7],
    [0.2, 1.27, 0.02, 0.28, 0.3, -0.18, 0.61],
    [-0.17, 1.32, -0.02, -0.3, 0.18, 0.3, 0.64],
]

function EnvironmentLighting({ intensity = 0.22 }) {
    const { gl, scene } = useThree()

    useEffect(() => {
        const pmrem = new THREE.PMREMGenerator(gl)
        const environmentScene = new RoomEnvironment()
        const environment = pmrem.fromScene(environmentScene, 0.035).texture
        const previous = scene.environment
        const previousIntensity = scene.environmentIntensity
        scene.environment = environment
        scene.environmentIntensity = intensity
        return () => {
            scene.environment = previous
            scene.environmentIntensity = previousIntensity
            environment.dispose()
            environmentScene.dispose?.()
            pmrem.dispose()
        }
    }, [gl, intensity, scene])

    return null
}

function RoundedBoxShape({ size, radius = 0.08, segments = 3 }) {
    const geometry = useMemo(() => new RoundedBoxGeometry(
        size[0],
        size[1],
        size[2],
        segments,
        Math.min(radius, size[0] / 4, size[1] / 4, size[2] / 4),
    ), [radius, segments, size])
    useEffect(() => () => geometry.dispose(), [geometry])
    return <primitive object={geometry} attach="geometry" />
}

function InstancedPlants({ plants, castDynamicShadows = false }) {
    const pots = useRef(null)
    const soil = useRef(null)
    const stems = useRef(null)
    const leaves = useRef(null)
    const plantCount = plants.length

    useEffect(() => {
        if (!plantCount) return
        const root = new THREE.Matrix4()
        const local = new THREE.Matrix4()
        const matrix = new THREE.Matrix4()
        const position = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        const scale = new THREE.Vector3()
        const rootRotation = new THREE.Quaternion()
        let stemIndex = 0
        let leafIndex = 0

        const setLocalMatrix = (mesh, index, localPosition, localRotation, localScale) => {
            rotation.setFromEuler(new THREE.Euler(...localRotation))
            local.compose(position.set(...localPosition), rotation, scale.set(...localScale))
            matrix.multiplyMatrices(root, local)
            mesh?.setMatrixAt(index, matrix)
        }

        plants.forEach((plant, plantIndex) => {
            const renderScale = plant.renderScale || 1
            const renderVariant = plant.renderVariant || 0
            rootRotation.setFromEuler(new THREE.Euler(0, plant.rotationY || 0, 0))
            root.compose(
                position.set(...plant.position),
                rootRotation,
                scale.set(renderScale, renderScale, renderScale),
            )
            setLocalMatrix(pots.current, plantIndex, [0, 0.32, 0], [0, 0, 0], [1, 1, 1])
            setLocalMatrix(soil.current, plantIndex, [0, 0.64, 0], [0, 0, 0], [1, 1, 1])
            for (const [stemOffset, stem] of [[-0.11, 0.96, 0.05, -0.1], [0.12, 1.04, -0.04, 0.12], [0, 1.15, 0.02, 0]].entries()) {
                const visibleScale = renderVariant === 1 && stemOffset < 2 ? 0.001 : 1
                setLocalMatrix(stems.current, stemIndex, stem.slice(0, 3), [stem[3], 0, stem[3]], [visibleScale, visibleScale, visibleScale])
                stemIndex += 1
            }
            LEAVES.forEach(([x, y, z, rx, ry, rz, leafScale], sourceIndex) => {
                const palmAngle = (sourceIndex / LEAVES.length) * Math.PI * 2
                const palmRadius = 0.16 + ((sourceIndex % 2) * 0.08)
                const leafPosition = renderVariant === 1
                    ? [Math.cos(palmAngle) * palmRadius, 1.42 + ((sourceIndex % 3) * 0.035), Math.sin(palmAngle) * palmRadius]
                    : [x, y, z]
                const leafRotation = renderVariant === 1
                    ? [-0.62 + ((sourceIndex % 3) * 0.12), palmAngle, (sourceIndex % 2 ? 0.2 : -0.2)]
                    : [rx, ry, rz]
                const leafSize = renderVariant === 1
                    ? [0.15 * leafScale, 0.045, 1.1 * leafScale]
                    : [0.34 * leafScale, 0.055, 0.76 * leafScale]
                setLocalMatrix(
                    leaves.current,
                    leafIndex,
                    leafPosition,
                    leafRotation,
                    leafSize,
                )
                leafIndex += 1
            })
        })
        for (const mesh of [pots.current, soil.current, stems.current, leaves.current]) {
            if (!mesh) continue
            mesh.instanceMatrix.needsUpdate = true
            mesh.computeBoundingSphere?.()
        }
    }, [plantCount, plants])

    if (!plantCount) return null
    return (
        <>
            <instancedMesh ref={pots} args={[undefined, undefined, plantCount]} castShadow={castDynamicShadows} receiveShadow>
                <cylinderGeometry args={[0.34, 0.43, 0.64, 10, 1, false]} />
                <meshPhysicalMaterial
                    color="#817267"
                    roughness={0.32}
                    clearcoat={0.34}
                    clearcoatRoughness={0.68}
                />
            </instancedMesh>
            <instancedMesh ref={soil} args={[undefined, undefined, plantCount]}>
                <cylinderGeometry args={[0.32, 0.32, 0.07, 10]} />
                <meshStandardMaterial color="#2a2119" roughness={1} />
            </instancedMesh>
            <instancedMesh ref={stems} args={[undefined, undefined, plantCount * 3]} castShadow={castDynamicShadows}>
                <cylinderGeometry args={[0.022, 0.032, 0.92, 6]} />
                <meshStandardMaterial color="#425638" roughness={0.88} />
            </instancedMesh>
            <instancedMesh ref={leaves} args={[undefined, undefined, plantCount * LEAVES.length]} castShadow={castDynamicShadows}>
                <sphereGeometry args={[1, 7, 4]} />
                <meshStandardMaterial color="#586f49" roughness={0.78} side={THREE.DoubleSide} />
            </instancedMesh>
        </>
    )
}

function RunnerCarpet({ layout }) {
    const texture = useMemo(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 1024
        const context = canvas.getContext('2d')
        const gradient = context.createLinearGradient(0, 0, 256, 0)
        gradient.addColorStop(0, '#3b1017')
        gradient.addColorStop(0.16, '#6d2430')
        gradient.addColorStop(0.5, '#7e2b36')
        gradient.addColorStop(0.84, '#6d2430')
        gradient.addColorStop(1, '#3b1017')
        context.fillStyle = gradient
        context.fillRect(0, 0, 256, 1024)
        context.strokeStyle = '#c49a5b'
        context.lineWidth = 7
        context.strokeRect(17, 0, 222, 1024)
        context.strokeStyle = '#e0bd79'
        context.lineWidth = 2
        context.strokeRect(27, 0, 202, 1024)
        for (let y = 70; y < 1024; y += 128) {
            context.save()
            context.translate(128, y)
            context.rotate(Math.PI / 4)
            context.strokeStyle = 'rgba(224, 189, 121, 0.58)'
            context.lineWidth = 3
            context.strokeRect(-18, -18, 36, 36)
            context.restore()
        }
        const next = new THREE.CanvasTexture(canvas)
        next.colorSpace = THREE.SRGBColorSpace
        next.wrapS = THREE.RepeatWrapping
        next.wrapT = THREE.RepeatWrapping
        next.repeat.set(1, Math.max(2, layout.hallLength / 18))
        next.anisotropy = 4
        return next
    }, [layout.hallLength])

    useEffect(() => () => texture.dispose(), [texture])
    const centerZ = (14 + layout.hallBackZ) / 2
    return (
        <group>
            <mesh position={[0, 0.018, centerZ]} receiveShadow>
                <boxGeometry args={[3.1, 0.045, layout.hallLength - 0.72]} />
                <meshStandardMaterial map={texture} bumpMap={texture} roughness={0.97} bumpScale={0.012} />
            </mesh>
            {[-1.56, 1.56].map(x => (
                <mesh key={x} position={[x, 0.034, centerZ]}>
                    <boxGeometry args={[0.035, 0.038, layout.hallLength - 0.74]} />
                    <meshStandardMaterial color="#c6a260" metalness={0.18} roughness={0.72} />
                </mesh>
            ))}
        </group>
    )
}

function InstancedRoomBenches({ rooms, castDynamicShadows = false }) {
    const benches = useMemo(() => rooms.flatMap((room, roomIndex) => (
        room.benches.map((bench, benchIndex) => ({
            bench,
            // Repeat a restrained three-piece furniture family through long
            // rooms instead of stamping one identical ottoman in every salon.
            variant: roomIndex + benchIndex,
        }))
    )), [rooms])
    const bases = useRef(null)
    const cushions = useRef(null)
    const trimBands = useRef(null)
    const tuftButtons = useRef(null)
    const legs = useRef(null)
    const rugOuter = useRef(null)
    const rugInner = useRef(null)
    const rugBorder = useRef(null)
    const rugCenter = useRef(null)
    const textileDetail = useMemo(() => getTextileDetailTexture(), [])

    useEffect(() => {
        const parent = new THREE.Matrix4()
        const local = new THREE.Matrix4()
        const matrix = new THREE.Matrix4()
        const position = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        const localRotation = new THREE.Quaternion()
        const scale = new THREE.Vector3()
        const parentScale = new THREE.Vector3(1, 1, 1)
        let legIndex = 0
        let tuftIndex = 0
        benches.forEach(({ bench, variant }, index) => {
            const [width, height, depth] = bench.size
            const style = variant % BENCH_PALETTES.length
            const palette = BENCH_PALETTES[style]
            rotation.setFromEuler(new THREE.Euler(0, bench.rotationY || 0, 0))
            parent.compose(position.set(...bench.position), rotation, parentScale)
            const place = (mesh, offset, size, quaternion = localRotation.identity()) => {
                if (!mesh) return
                local.compose(position.set(...offset), quaternion, scale.set(...size))
                matrix.multiplyMatrices(parent, local)
                mesh.setMatrixAt(index, matrix)
            }
            place(bases.current, [0, 0.04, 0], [width, height * 0.72, depth])
            place(cushions.current, [0, height * 0.44, 0], [width + 0.04, height * 0.28, depth + 0.04])
            place(trimBands.current, [0, height * 0.25, 0], [width + 0.075, 0.055, depth + 0.075])
            // Six inset upholstery buttons catch grazing picture light and
            // break the broad cushion into human-scale detail. The instances
            // are cheaper than separate hero meshes but remove the blockout
            // look at the visitor's nearest recurring prop.
            for (const along of [-0.36, 0, 0.36]) {
                for (const across of [-0.22, 0.22]) {
                    local.compose(
                        position.set(along * width, (height * 0.59) + 0.018, across * depth),
                        localRotation.identity(),
                        scale.set(0.045, 0.018, 0.045),
                    )
                    matrix.multiplyMatrices(parent, local)
                    tuftButtons.current?.setMatrixAt(tuftIndex, matrix)
                    tuftButtons.current?.setColorAt(tuftIndex, new THREE.Color(palette.base))
                    tuftIndex += 1
                }
            }

            bases.current?.setColorAt(index, new THREE.Color(palette.base))
            cushions.current?.setColorAt(index, new THREE.Color(palette.cushion))
            rugOuter.current?.setColorAt(index, new THREE.Color(palette.rugOuter))
            rugInner.current?.setColorAt(index, new THREE.Color(palette.rugInner))
            rugBorder.current?.setColorAt(index, new THREE.Color(palette.rugBorder))
            rugCenter.current?.setColorAt(index, new THREE.Color(palette.rugCenter))

            const rugParent = new THREE.Matrix4().compose(
                position.set(bench.position[0], 0.024, bench.position[2]),
                rotation,
                parentScale,
            )
            const placeRug = (mesh, y, size) => {
                local.compose(position.set(0, y, 0), localRotation.identity(), scale.set(...size))
                matrix.multiplyMatrices(rugParent, local)
                mesh?.setMatrixAt(index, matrix)
            }
            placeRug(rugOuter.current, 0, [width + 1.15, 0.035, depth + 0.95])
            placeRug(rugInner.current, 0.021, [width + 0.78, 0.022, depth + 0.58])
            placeRug(rugBorder.current, 0.029, [width + 0.58, 0.016, depth + 0.38])
            placeRug(rugCenter.current, 0.035, [width + 0.44, 0.012, depth + 0.24])

            for (const x of [-0.56, 0.56]) {
                for (const direction of [-1, 1]) {
                    local.compose(
                        position.set(x, -0.23, direction * ((depth / 2) - 0.18)),
                        localRotation.identity(),
                        scale.set(1, 1, 1),
                    )
                    matrix.multiplyMatrices(parent, local)
                    legs.current?.setMatrixAt(legIndex, matrix)
                    legIndex += 1
                }
            }
        })
        for (const mesh of [bases.current, cushions.current, trimBands.current, tuftButtons.current, legs.current, rugOuter.current, rugInner.current, rugBorder.current, rugCenter.current]) {
            if (!mesh) continue
            mesh.instanceMatrix.needsUpdate = true
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
            mesh.computeBoundingSphere?.()
        }
    }, [benches])

    if (!benches.length) return null
    return (
        <>
            <instancedMesh ref={bases} args={[BENCH_ROUNDED_BOX, undefined, benches.length]} castShadow={castDynamicShadows}>
                <meshStandardMaterial color="#ffffff" vertexColors roughness={0.96} />
            </instancedMesh>
            <instancedMesh ref={cushions} args={[BENCH_ROUNDED_BOX, undefined, benches.length]} castShadow={castDynamicShadows}>
                <meshPhysicalMaterial color="#ffffff" vertexColors bumpMap={textileDetail} bumpScale={0.026} roughness={0.82} sheen={0.68} sheenColor="#d5abb0" sheenRoughness={0.72} emissive="#271216" emissiveIntensity={0.1} />
            </instancedMesh>
            <instancedMesh ref={trimBands} args={[BENCH_ROUNDED_BOX, undefined, benches.length]} castShadow={castDynamicShadows}>
                <meshPhysicalMaterial color="#9a7441" metalness={0.7} roughness={0.28} clearcoat={0.28} clearcoatRoughness={0.42} />
            </instancedMesh>
            <instancedMesh ref={tuftButtons} args={[undefined, undefined, benches.length * 6]} castShadow={castDynamicShadows}>
                <sphereGeometry args={[1, 8, 5]} />
                <meshPhysicalMaterial color="#ffffff" vertexColors roughness={0.82} sheen={0.32} sheenColor="#d9b4b0" />
            </instancedMesh>
            <instancedMesh ref={legs} args={[undefined, undefined, benches.length * 4]} castShadow={castDynamicShadows}>
                <cylinderGeometry args={[0.055, 0.075, 0.25, 10]} />
                <meshStandardMaterial color={DARK_BRASS} metalness={0.72} roughness={0.28} />
            </instancedMesh>
            <instancedMesh ref={rugOuter} args={[RUG_ROUNDED_BOX, undefined, benches.length]}><meshStandardMaterial color="#ffffff" vertexColors roughness={0.98} /></instancedMesh>
            <instancedMesh ref={rugInner} args={[RUG_ROUNDED_BOX, undefined, benches.length]}><meshStandardMaterial color="#ffffff" vertexColors roughness={0.97} /></instancedMesh>
            <instancedMesh ref={rugBorder} args={[RUG_ROUNDED_BOX, undefined, benches.length]}><meshStandardMaterial color="#ffffff" vertexColors roughness={0.88} /></instancedMesh>
            <instancedMesh ref={rugCenter} args={[RUG_ROUNDED_BOX, undefined, benches.length]}><meshStandardMaterial color="#ffffff" vertexColors roughness={0.98} /></instancedMesh>
        </>
    )
}

function ReceptionDesk({ layout, materials, LabelPlane, WoodMaterial }) {
    const [x, y, z] = layout.desk.position
    const facadeGeometry = useMemo(() => {
        // A bespoke tapered reception silhouette reads as joinery rather than
        // a scaled primitive. The shallow bow and inset lower corners preserve
        // the original collision footprint while opening negative space around
        // the base and keeping the desk human-scaled from the spawn camera.
        const shape = new THREE.Shape()
        shape.moveTo(-1.72, -0.67)
        shape.quadraticCurveTo(-1.86, -0.65, -1.9, -0.48)
        shape.lineTo(-2.12, 0.47)
        shape.quadraticCurveTo(-2.16, 0.66, -1.94, 0.69)
        shape.lineTo(1.94, 0.69)
        shape.quadraticCurveTo(2.16, 0.66, 2.12, 0.47)
        shape.lineTo(1.9, -0.48)
        shape.quadraticCurveTo(1.86, -0.65, 1.72, -0.67)
        shape.closePath()
        const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: 1.08,
            bevelEnabled: true,
            bevelSegments: 3,
            bevelSize: 0.055,
            bevelThickness: 0.055,
            curveSegments: 16,
        })
        geometry.translate(0, 0, -0.54)
        geometry.computeVertexNormals()
        return geometry
    }, [])

    useEffect(() => () => facadeGeometry.dispose(), [facadeGeometry])

    return (
        <group position={[x, y, z]}>
            <mesh castShadow receiveShadow position={[0, -0.61, -0.02]}>
                <RoundedBoxShape size={[layout.desk.size[0] - 0.78, 0.18, layout.desk.size[2] - 0.38]} radius={0.055} segments={4} />
                <meshPhysicalMaterial color="#281a14" roughness={0.62} clearcoat={0.12} />
            </mesh>
            <mesh geometry={facadeGeometry} castShadow receiveShadow>
                <WoodMaterial materials={materials} color="#704834" roughness={0.44} />
            </mesh>
            <mesh position={[0, 0.76, 0]} castShadow receiveShadow>
                <RoundedBoxShape size={[layout.desk.size[0] + 0.18, 0.12, layout.desk.size[2] + 0.12]} radius={0.06} segments={4} />
                <meshPhysicalMaterial color="#d1c7b8" roughness={0.38} clearcoat={0.34} clearcoatRoughness={0.52} />
            </mesh>
            <mesh position={[0, 0.04, 0.592]} castShadow>
                <RoundedBoxShape size={[3.16, 0.82, 0.055]} radius={0.045} segments={4} />
                <meshPhysicalMaterial color="#201917" roughness={0.66} clearcoat={0.14} clearcoatRoughness={0.66} />
            </mesh>
            <mesh position={[0, 0.04, 0.626]}>
                <RoundedBoxShape size={[3.0, 0.69, 0.018]} radius={0.035} segments={3} />
                <meshStandardMaterial color="#3c261d" roughness={0.7} />
            </mesh>
            {[-1.86, -1.56, -1.26, 1.26, 1.56, 1.86].map(fluteX => (
                <mesh key={fluteX} position={[fluteX, -0.02, 0.565]} castShadow>
                    <cylinderGeometry args={[0.028, 0.028, 1.14, 8]} />
                    <meshPhysicalMaterial color="#9a7441" metalness={0.68} roughness={0.3} clearcoat={0.2} />
                </mesh>
            ))}
            <LabelPlane
                title="Ian Truong Photography"
                subtitle="Welcome · Explore every room"
                position={[0, 0.08, 0.642]}
                size={[2.76, 0.58]}
            />
        </group>
    )
}

function LobbyEntrance({ materials, LabelPlane, PlasterMaterial }) {
    const z = 13.96
    return (
        <group position={[0, 0, z]}>
            {[-3.65, 3.65].map(x => (
                <group key={x}>
                    <mesh position={[x, 3.7, 0]} receiveShadow>
                        <RoundedBoxShape size={[2.25, 7.4, 0.28]} radius={0.065} segments={3} />
                        <PlasterMaterial materials={materials} color="#d8d1c5" />
                    </mesh>
                    <mesh position={[x, 1.45, -0.17]}>
                        <RoundedBoxShape size={[1.6, 2.25, 0.06]} radius={0.045} segments={3} />
                        <meshStandardMaterial color="#c7b9a6" roughness={0.82} />
                    </mesh>
                </group>
            ))}
            {[-1.2, 1.2].map(x => (
                <group key={x} position={[x, 2.25, -0.03]}>
                    <mesh>
                        <RoundedBoxShape size={[2.18, 4.5, 0.1]} radius={0.035} segments={3} />
                        <meshPhysicalMaterial color="#8fa5aa" transparent opacity={0.23} roughness={0.08} metalness={0.05} transmission={0.24} />
                    </mesh>
                    {[-1, 1].map(axis => (
                        <mesh key={axis} position={[axis * 1.08, 0, 0.06]}>
                            <RoundedBoxShape size={[0.07, 4.62, 0.08]} radius={0.025} segments={2} />
                            <meshStandardMaterial color="#4d3d2d" metalness={0.24} roughness={0.52} />
                        </mesh>
                    ))}
                    <mesh position={[0, 2.27, 0.06]}>
                        <RoundedBoxShape size={[2.23, 0.07, 0.08]} radius={0.025} segments={2} />
                        <meshStandardMaterial color="#4d3d2d" metalness={0.24} roughness={0.52} />
                    </mesh>
                </group>
            ))}
            <mesh position={[0, 5.35, 0]}>
                <RoundedBoxShape size={[5.1, 1.65, 0.28]} radius={0.07} segments={3} />
                <PlasterMaterial materials={materials} color="#d8d1c5" />
            </mesh>
            <LabelPlane title="The Photography Archive" subtitle="Est. 2026" position={[0, 5.4, -0.18]} rotation={[0, Math.PI, 0]} size={[4.35, 0.92]} />
        </group>
    )
}

function InstancedWallSconces({ placements }) {
    const plates = useRef(null)
    const arms = useRef(null)
    const bases = useRef(null)
    const shades = useRef(null)
    const bulbs = useRef(null)

    useEffect(() => {
        const matrix = new THREE.Matrix4()
        const position = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        const scale = new THREE.Vector3(1, 1, 1)
        placements.forEach(({ side, z }, index) => {
            const x = side * 4.64
            // The wall plate and light wash face into the hall. The previous
            // transform was overwritten before it reached an instance, which
            // left a tilted shade floating beside a vertical brass cylinder.
            rotation.setFromEuler(new THREE.Euler(0, 0, Math.PI / 2))
            matrix.compose(position.set(x - (side * 0.035), 3.66, z), rotation, scale)
            plates.current?.setMatrixAt(index, matrix)
            rotation.identity()
            matrix.compose(position.set(x - (side * 0.19), 3.66, z), rotation, scale.set(0.34, 0.07, 0.07))
            arms.current?.setMatrixAt(index, matrix)
            scale.set(1, 1, 1)
            matrix.compose(position.set(x - (side * 0.34), 3.67, z), rotation, scale)
            bases.current?.setMatrixAt(index, matrix)
            matrix.compose(position.set(x - (side * 0.39), 3.82, z), rotation, scale)
            shades.current?.setMatrixAt(index, matrix)
            matrix.compose(position.set(x - (side * 0.39), 3.76, z), rotation, scale.set(0.11, 0.11, 0.11))
            bulbs.current?.setMatrixAt(index, matrix)
            scale.set(1, 1, 1)
        })
        for (const mesh of [plates.current, arms.current, bases.current, shades.current, bulbs.current]) {
            if (!mesh) continue
            mesh.instanceMatrix.needsUpdate = true
            mesh.computeBoundingSphere?.()
        }
    }, [placements])

    return (
        <>
            {/* The baked wall irradiance already supplies the warm light pool.
                Removing the transparent halo avoids a sorting/fog threshold
                that made a large tan disc appear only at close range. These
                tiny fixture batches stay uncullable so every physical part is
                present from the full length of the corridor. */}
            <instancedMesh ref={plates} args={[undefined, undefined, placements.length]} castShadow frustumCulled={false}>
                <cylinderGeometry args={[0.22, 0.22, 0.09, 14]} />
                <meshPhysicalMaterial color={DARK_BRASS} metalness={0.76} roughness={0.28} clearcoat={0.22} />
            </instancedMesh>
            <instancedMesh ref={arms} args={[undefined, undefined, placements.length]} castShadow frustumCulled={false}>
                <boxGeometry args={[1, 1, 1]} />
                <meshPhysicalMaterial color={DARK_BRASS} metalness={0.76} roughness={0.28} clearcoat={0.2} />
            </instancedMesh>
            <instancedMesh ref={bases} args={[undefined, undefined, placements.length]} castShadow frustumCulled={false}>
                <cylinderGeometry args={[0.15, 0.19, 0.2, 12]} />
                <meshStandardMaterial color={DARK_BRASS} metalness={0.76} roughness={0.28} />
            </instancedMesh>
            <instancedMesh ref={shades} args={[undefined, undefined, placements.length]} frustumCulled={false}>
                <cylinderGeometry args={[0.29, 0.18, 0.42, 14, 1, true]} />
                <meshPhysicalMaterial color="#f3dfbd" emissive="#d99d51" emissiveIntensity={0.7} transparent opacity={0.84} roughness={0.45} side={THREE.DoubleSide} />
            </instancedMesh>
            <instancedMesh ref={bulbs} args={[undefined, undefined, placements.length]} renderOrder={4} frustumCulled={false}>
                <sphereGeometry args={[1, 12, 8]} />
                <meshBasicMaterial color="#ffd49b" toneMapped={false} />
            </instancedMesh>
        </>
    )
}

export default function MuseumDressing({ layout, materials, LabelPlane, PlasterMaterial, WoodMaterial, reflectionsEnabled = true, shadowsEnabled = false }) {
    // The production catalog currently has a small furniture set. Keeping one
    // stable all-room instance allocation is cheaper than reconstructing plant
    // and bench meshes every time the visitor crosses a preparation radius.
    const dressedRooms = layout.rooms
    const staticPlants = useMemo(() => [
        ...layout.dressing.lobbyPlants.map((plant, index) => ({ ...plant, renderScale: 1.05, renderVariant: index % 2 })),
        ...layout.dressing.hallPlants.map((plant, index) => ({ ...plant, renderScale: 0.9, renderVariant: (index + 1) % 2 })),
    ], [layout.dressing.hallPlants, layout.dressing.lobbyPlants])
    const roomPlants = useMemo(() => [
        ...dressedRooms.flatMap((room, roomIndex) => room.plants.map((plant, plantIndex) => ({
            ...plant,
            renderScale: [0.82, 0.94, 1.06][(roomIndex + plantIndex) % 3],
            renderVariant: (roomIndex + plantIndex) % 2,
            rotationY: (plant.rotationY || 0) + (((roomIndex % 3) - 1) * 0.22),
        }))),
    ], [dressedRooms])
    const sconcePlacements = useMemo(
        () => museumHallSconcePlacements(layout),
        [layout],
    )
    return (
        <group>
            <EnvironmentLighting intensity={reflectionsEnabled ? 0.22 : 0.15} />
            <RunnerCarpet layout={layout} />
            <LobbyEntrance materials={materials} LabelPlane={LabelPlane} PlasterMaterial={PlasterMaterial} />
            <ReceptionDesk layout={layout} materials={materials} LabelPlane={LabelPlane} WoodMaterial={WoodMaterial} />
            <InstancedPlants plants={staticPlants} />
            <InstancedPlants plants={roomPlants} castDynamicShadows={shadowsEnabled} />
            <InstancedRoomBenches rooms={dressedRooms} castDynamicShadows={shadowsEnabled} />
            {/* Place sconces on the solid wall between galleries, clear of the
                room end walls and arched entry trim. Every lens uses the same
                emissive and baked-light treatment; selective live point lights
                made isolated fittings look powered while their neighbors did not. */}
            <InstancedWallSconces placements={sconcePlacements} />
        </group>
    )
}
