/* eslint-disable react-hooks/immutability -- Three.js scene environment state is managed by the renderer lifecycle. */
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

const BRASS = '#b58a4f'
const DARK_BRASS = '#735332'
const VELVET = '#6f2028'
const DEEP_VELVET = '#3f1118'
const STONE = '#c7bdaf'
const ROOM_TEXTILES = [
    { bench: '#633740', base: '#39242a', rug: '#3e282c', rugInner: '#5b3940', rugCenter: '#48292f' },
    { bench: '#415751', base: '#293936', rug: '#2a3b38', rugInner: '#3f5650', rugCenter: '#30443f' },
    { bench: '#61543c', base: '#393224', rug: '#3e382a', rugInner: '#5c513a', rugCenter: '#463d2c' },
    { bench: '#51495e', base: '#312d39', rug: '#34303b', rugInner: '#4e4659', rugCenter: '#3c3545' },
]
let sconceGlowTexture = null
let textileDetailTexture = null

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

function getSconceGlowTexture() {
    if (sconceGlowTexture || typeof document === 'undefined') return sconceGlowTexture
    const canvas = document.createElement('canvas')
    canvas.width = 192
    canvas.height = 256
    const context = canvas.getContext('2d')
    const gradient = context.createRadialGradient(96, 116, 4, 96, 116, 104)
    gradient.addColorStop(0, 'rgba(255, 226, 179, 0.68)')
    gradient.addColorStop(0.3, 'rgba(239, 179, 104, 0.3)')
    gradient.addColorStop(0.72, 'rgba(180, 104, 42, 0.07)')
    gradient.addColorStop(1, 'rgba(80, 42, 18, 0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)
    sconceGlowTexture = new THREE.CanvasTexture(canvas)
    sconceGlowTexture.colorSpace = THREE.SRGBColorSpace
    sconceGlowTexture.minFilter = THREE.LinearFilter
    sconceGlowTexture.magFilter = THREE.LinearFilter
    return sconceGlowTexture
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

function ContactPatch({ position, scale = [1, 1] }) {
    return (
        <mesh position={[position[0], (position[1] || 0) + 0.012, position[2]]} rotation={[-Math.PI / 2, 0, 0]} scale={[scale[0], scale[1], 1]}>
            <circleGeometry args={[0.72, 20]} />
            <meshBasicMaterial color="#120d09" transparent opacity={0.32} depthWrite={false} />
        </mesh>
    )
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
            rootRotation.setFromEuler(new THREE.Euler(0, plant.rotationY || 0, 0))
            root.compose(
                position.set(...plant.position),
                rootRotation,
                scale.set(renderScale, renderScale, renderScale),
            )
            setLocalMatrix(pots.current, plantIndex, [0, 0.32, 0], [0, 0, 0], [1, 1, 1])
            setLocalMatrix(soil.current, plantIndex, [0, 0.64, 0], [0, 0, 0], [1, 1, 1])
            for (const stem of [[-0.11, 0.96, 0.05, -0.1], [0.12, 1.04, -0.04, 0.12], [0, 1.15, 0.02, 0]]) {
                setLocalMatrix(stems.current, stemIndex, stem.slice(0, 3), [stem[3], 0, stem[3]], [1, 1, 1])
                stemIndex += 1
            }
            LEAVES.forEach(([x, y, z, rx, ry, rz, leafScale]) => {
                setLocalMatrix(
                    leaves.current,
                    leafIndex,
                    [x, y, z],
                    [rx, ry, rz],
                    [0.34 * leafScale, 0.055, 0.76 * leafScale],
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

function UpholsteredBench({ bench, variant = 0 }) {
    const [width, height, depth] = bench.size
    const textile = ROOM_TEXTILES[variant % ROOM_TEXTILES.length]
    const baseSize = useMemo(() => [width, height * 0.72, depth], [depth, height, width])
    const cushionSize = useMemo(() => [width + 0.04, height * 0.28, depth + 0.04], [depth, height, width])
    const textileDetail = useMemo(() => getTextileDetailTexture(), [])
    return (
        <group position={bench.position} rotation={[0, bench.rotationY || 0, 0]}>
            <ContactPatch position={[0, -bench.position[1], 0]} scale={[width * 0.58, depth * 0.78]} />
            <mesh castShadow receiveShadow position={[0, 0.04, 0]}>
                <RoundedBoxShape size={baseSize} radius={0.1} />
                <meshStandardMaterial color={textile.base || DEEP_VELVET} roughness={0.96} />
            </mesh>
            <mesh castShadow position={[0, height * 0.44, 0]}>
                <RoundedBoxShape size={cushionSize} radius={0.11} />
                <meshPhysicalMaterial
                    color={textile.bench || VELVET}
                    bumpMap={textileDetail}
                    bumpScale={0.026}
                    roughness={0.88}
                    sheen={0.55}
                    sheenRoughness={0.78}
                />
            </mesh>
            {[-0.56, 0.56].map(x => [-1, 1].map(direction => (
                <mesh key={`${x}-${direction}`} castShadow position={[x, -0.37, direction * ((depth / 2) - 0.18)]}>
                    <cylinderGeometry args={[0.055, 0.075, 0.6, 10]} />
                    <meshStandardMaterial color={DARK_BRASS} metalness={0.72} roughness={0.28} />
                </mesh>
            )))}
        </group>
    )
}

function BenchRug({ bench, variant = 0 }) {
    const [width, , depth] = bench.size
    const textile = ROOM_TEXTILES[variant % ROOM_TEXTILES.length]
    return (
        <group position={[bench.position[0], 0.024, bench.position[2]]} rotation={[0, bench.rotationY || 0, 0]}>
            <mesh receiveShadow>
                <boxGeometry args={[width + 1.15, 0.035, depth + 0.95]} />
                <meshStandardMaterial color={textile.rug} roughness={0.98} />
            </mesh>
            <mesh position={[0, 0.021, 0]}>
                <boxGeometry args={[width + 0.78, 0.01, depth + 0.58]} />
                <meshStandardMaterial color={textile.rugInner} roughness={0.97} />
            </mesh>
            <mesh position={[0, 0.029, 0]}>
                <boxGeometry args={[width + 0.58, 0.008, depth + 0.38]} />
                <meshStandardMaterial color="#8a744f" roughness={0.88} />
            </mesh>
            <mesh position={[0, 0.035, 0]}>
                <boxGeometry args={[width + 0.44, 0.008, depth + 0.24]} />
                <meshStandardMaterial color={textile.rugCenter} roughness={0.98} />
            </mesh>
        </group>
    )
}

function AbstractSculpture({ sculpture }) {
    return (
        <group position={sculpture.position}>
            <mesh castShadow receiveShadow position={[0, 0.47, 0]}>
                <boxGeometry args={[1.5, 0.94, 1.5]} />
                <meshPhysicalMaterial color={STONE} roughness={0.56} clearcoat={0.16} clearcoatRoughness={0.72} />
            </mesh>
            <mesh castShadow position={[0, 1.36, 0]} rotation={[0.24, 0.38, 0.18]}>
                <torusKnotGeometry args={[0.46, 0.14, 48, 8, 2, 3]} />
                <meshPhysicalMaterial color={BRASS} metalness={0.78} roughness={0.24} clearcoat={0.32} />
            </mesh>
        </group>
    )
}

function ReceptionDesk({ layout, materials, LabelPlane, WoodMaterial }) {
    const [x, y, z] = layout.desk.position
    return (
        <group position={[x, y, z]}>
            <ContactPatch position={[0, -y, 0]} scale={[2.9, 1.2]} />
            <mesh castShadow receiveShadow position={[0, -0.62, 0]}>
                <RoundedBoxShape size={[layout.desk.size[0] - 0.42, 0.22, layout.desk.size[2] - 0.24]} radius={0.045} />
                <meshStandardMaterial color="#24160f" roughness={0.78} />
            </mesh>
            <mesh castShadow receiveShadow>
                <RoundedBoxShape size={layout.desk.size} radius={0.07} />
                <WoodMaterial materials={materials} color="#4c2f1d" roughness={0.42} />
            </mesh>
            <mesh position={[0, 0.76, 0]} castShadow receiveShadow>
                <RoundedBoxShape size={[layout.desk.size[0] + 0.24, 0.14, layout.desk.size[2] + 0.18]} radius={0.055} />
                <meshPhysicalMaterial color="#d2c8ba" roughness={0.3} clearcoat={0.52} clearcoatRoughness={0.46} />
            </mesh>
            <mesh position={[0, 0.05, 0.68]}>
                <boxGeometry args={[3.5, 0.9, 0.04]} />
                <meshStandardMaterial color="#211b17" roughness={0.72} />
            </mesh>
            <LabelPlane
                title="Ian Truong Photography"
                subtitle="Welcome · Explore every room"
                position={[0, 0.08, 0.715]}
                size={[3.25, 0.76]}
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
                        <boxGeometry args={[2.25, 7.4, 0.28]} />
                        <PlasterMaterial materials={materials} color="#d8d1c5" />
                    </mesh>
                    <mesh position={[x, 1.45, -0.17]}>
                        <boxGeometry args={[1.6, 2.25, 0.06]} />
                        <meshStandardMaterial color="#c7b9a6" roughness={0.82} />
                    </mesh>
                </group>
            ))}
            {[-1.2, 1.2].map(x => (
                <group key={x} position={[x, 2.25, -0.03]}>
                    <mesh>
                        <boxGeometry args={[2.18, 4.5, 0.1]} />
                        <meshPhysicalMaterial color="#8fa5aa" transparent opacity={0.23} roughness={0.08} metalness={0.05} transmission={0.24} />
                    </mesh>
                    {[-1, 1].map(axis => (
                        <mesh key={axis} position={[axis * 1.08, 0, 0.06]}>
                            <boxGeometry args={[0.07, 4.62, 0.08]} />
                            <meshStandardMaterial color="#4d3d2d" metalness={0.24} roughness={0.52} />
                        </mesh>
                    ))}
                    <mesh position={[0, 2.27, 0.06]}>
                        <boxGeometry args={[2.23, 0.07, 0.08]} />
                        <meshStandardMaterial color="#4d3d2d" metalness={0.24} roughness={0.52} />
                    </mesh>
                </group>
            ))}
            <mesh position={[0, 5.35, 0]}>
                <boxGeometry args={[5.1, 1.65, 0.28]} />
                <PlasterMaterial materials={materials} color="#d8d1c5" />
            </mesh>
            <LabelPlane title="The Photography Archive" subtitle="Est. 2026" position={[0, 5.4, -0.18]} rotation={[0, Math.PI, 0]} size={[4.35, 0.92]} />
        </group>
    )
}

function InstancedWallSconces({ placements }) {
    const glow = useMemo(() => getSconceGlowTexture(), [])
    const glows = useRef(null)
    const bases = useRef(null)
    const shades = useRef(null)

    useEffect(() => {
        const matrix = new THREE.Matrix4()
        const position = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        const scale = new THREE.Vector3(1, 1, 1)
        placements.forEach(({ side, z }, index) => {
            const x = side * 4.64
            rotation.setFromEuler(new THREE.Euler(0, side < 0 ? Math.PI / 2 : -Math.PI / 2, 0))
            matrix.compose(position.set(x - (side * 0.105), 3.69, z), rotation, scale)
            glows.current?.setMatrixAt(index, matrix)
            rotation.identity()
            matrix.compose(position.set(x, 3.65, z), rotation, scale)
            bases.current?.setMatrixAt(index, matrix)
            rotation.setFromEuler(new THREE.Euler(0, 0, side * -0.26))
            matrix.compose(position.set(x - (side * 0.19), 3.77, z), rotation, scale)
            shades.current?.setMatrixAt(index, matrix)
        })
        for (const mesh of [glows.current, bases.current, shades.current]) {
            if (!mesh) continue
            mesh.instanceMatrix.needsUpdate = true
            mesh.computeBoundingSphere?.()
        }
    }, [placements])

    return (
        <>
            <instancedMesh ref={glows} args={[undefined, undefined, placements.length]} renderOrder={1}>
                <planeGeometry args={[2.8, 3.4]} />
                <meshBasicMaterial
                    map={glow}
                    color="#e7a861"
                    transparent
                    opacity={0.58}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
                />
            </instancedMesh>
            <instancedMesh ref={bases} args={[undefined, undefined, placements.length]} castShadow>
                <cylinderGeometry args={[0.15, 0.19, 0.48, 10]} />
                <meshStandardMaterial color={DARK_BRASS} metalness={0.76} roughness={0.28} />
            </instancedMesh>
            <instancedMesh ref={shades} args={[undefined, undefined, placements.length]}>
                <cylinderGeometry args={[0.24, 0.15, 0.42, 10, 1, true]} />
                <meshStandardMaterial color="#f2dfbf" emissive="#d99d51" emissiveIntensity={0.5} transparent opacity={0.78} roughness={0.48} side={THREE.DoubleSide} />
            </instancedMesh>
        </>
    )
}

export default function MuseumDressing({ layout, activeRoomIds, materials, LabelPlane, PlasterMaterial, WoodMaterial, reflectionsEnabled = true }) {
    const bayCount = Math.max(1, Math.ceil(layout.rooms.length / 2))
    const bayZs = useMemo(
        () => Array.from({ length: bayCount }, (_, index) => -7 - (index * 16.5)),
        [bayCount],
    )
    const activeRoomSet = useMemo(() => new Set(activeRoomIds), [activeRoomIds])
    const activeRooms = useMemo(() => layout.rooms.filter(room => activeRoomSet.has(room.id)), [activeRoomSet, layout.rooms])
    const staticPlants = useMemo(() => [
        ...layout.dressing.lobbyPlants.map(plant => ({ ...plant, renderScale: 1.05 })),
        ...layout.dressing.hallPlants.map(plant => ({ ...plant, renderScale: 0.9 })),
    ], [layout.dressing.hallPlants, layout.dressing.lobbyPlants])
    const activeRoomPlants = useMemo(() => [
        ...activeRooms.flatMap(room => room.plants).map(plant => ({ ...plant, renderScale: 0.92 })),
    ], [activeRooms])
    const sconcePlacements = useMemo(
        () => bayZs.flatMap(z => [-1, 1].map(side => ({ side, z: z + 7.4 }))),
        [bayZs],
    )
    return (
        <group>
            <EnvironmentLighting intensity={reflectionsEnabled ? 0.17 : 0.08} />
            <RunnerCarpet layout={layout} />
            <LobbyEntrance materials={materials} LabelPlane={LabelPlane} PlasterMaterial={PlasterMaterial} />
            <ReceptionDesk layout={layout} materials={materials} LabelPlane={LabelPlane} WoodMaterial={WoodMaterial} />
            <InstancedPlants plants={staticPlants} />
            <InstancedPlants plants={activeRoomPlants} castDynamicShadows={reflectionsEnabled} />
            <AbstractSculpture sculpture={layout.dressing.terminalSculpture} />
            {layout.rooms.map((room, roomIndex) => (
                <group key={`furnishings-${room.id}`} visible={activeRoomSet.has(room.id)}>
                    {room.benches.map(bench => <BenchRug key={`rug-${bench.id}`} bench={bench} variant={roomIndex} />)}
                    {room.benches.map(bench => <UpholsteredBench key={bench.id} bench={bench} variant={roomIndex} />)}
                </group>
            ))}
            {/* Place sconces on the solid wall between galleries, clear of the
                room end walls and arched entry trim. */}
            <InstancedWallSconces placements={sconcePlacements} />
        </group>
    )
}
