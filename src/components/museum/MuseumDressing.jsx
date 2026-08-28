/* eslint-disable react-hooks/immutability -- Three.js scene environment state is managed by the renderer lifecycle. */
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

const BRASS = '#b58a4f'
const DARK_BRASS = '#735332'
const VELVET = '#6f2028'
const DEEP_VELVET = '#3f1118'
const STONE = '#c7bdaf'

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

function EnvironmentLighting({ enabled }) {
    const { gl, scene } = useThree()

    useEffect(() => {
        if (!enabled) return undefined
        const pmrem = new THREE.PMREMGenerator(gl)
        const environmentScene = new RoomEnvironment()
        const environment = pmrem.fromScene(environmentScene, 0.035).texture
        const previous = scene.environment
        const previousIntensity = scene.environmentIntensity
        scene.environment = environment
        scene.environmentIntensity = 0.12
        return () => {
            scene.environment = previous
            scene.environmentIntensity = previousIntensity
            environment.dispose()
            environmentScene.dispose?.()
            pmrem.dispose()
        }
    }, [enabled, gl, scene])

    return null
}

function PottedPlant({ plant, scale = 1 }) {
    return (
        <group position={plant.position} rotation={[0, plant.rotationY || 0, 0]} scale={scale}>
            <mesh castShadow receiveShadow position={[0, 0.32, 0]}>
                <cylinderGeometry args={[0.34, 0.43, 0.64, 12, 1, false]} />
                <meshPhysicalMaterial
                    color="#817267"
                    roughness={0.32}
                    clearcoat={0.34}
                    clearcoatRoughness={0.68}
                />
            </mesh>
            <mesh position={[0, 0.64, 0]}>
                <cylinderGeometry args={[0.32, 0.32, 0.07, 12]} />
                <meshStandardMaterial color="#2a2119" roughness={1} />
            </mesh>
            {[[-0.11, 0.96, 0.05, -0.1], [0.12, 1.04, -0.04, 0.12], [0, 1.15, 0.02, 0]].map((stem, index) => (
                <mesh key={index} position={stem.slice(0, 3)} rotation={[stem[3], 0, stem[3]]} castShadow>
                    <cylinderGeometry args={[0.022, 0.032, 0.92, 7]} />
                    <meshStandardMaterial color="#425638" roughness={0.88} />
                </mesh>
            ))}
            {LEAVES.map(([x, y, z, rx, ry, rz, leafScale], index) => (
                <mesh
                    key={index}
                    position={[x, y, z]}
                    rotation={[rx, ry, rz]}
                    scale={[0.34 * leafScale, 0.055, 0.76 * leafScale]}
                    castShadow
                >
                    <sphereGeometry args={[1, 8, 5]} />
                    <meshStandardMaterial
                        color={index % 3 ? '#526947' : '#667c52'}
                        roughness={0.78}
                        side={THREE.DoubleSide}
                    />
                </mesh>
            ))}
        </group>
    )
}

function VelvetRope({ start, end }) {
    const curve = useMemo(() => {
        const middle = start.clone().lerp(end, 0.5)
        middle.y -= 0.18
        return new THREE.CatmullRomCurve3([start, middle, end], false, 'centripetal', 0.5)
    }, [end, start])
    return (
        <mesh castShadow>
            <tubeGeometry args={[curve, 12, 0.045, 6, false]} />
            <meshStandardMaterial color={VELVET} roughness={0.92} />
        </mesh>
    )
}

function Stanchion({ position }) {
    return (
        <group position={position}>
            <mesh castShadow receiveShadow position={[0, 0.05, 0]}>
                <cylinderGeometry args={[0.2, 0.26, 0.1, 12]} />
                <meshPhysicalMaterial color={DARK_BRASS} metalness={0.76} roughness={0.24} clearcoat={0.3} />
            </mesh>
            <mesh castShadow position={[0, 0.55, 0]}>
                <cylinderGeometry args={[0.055, 0.07, 0.96, 8]} />
                <meshPhysicalMaterial color={BRASS} metalness={0.84} roughness={0.2} clearcoat={0.24} />
            </mesh>
            <mesh castShadow position={[0, 1.04, 0]}>
                <sphereGeometry args={[0.115, 10, 7]} />
                <meshPhysicalMaterial color={BRASS} metalness={0.84} roughness={0.18} clearcoat={0.32} />
            </mesh>
        </group>
    )
}

function LobbyStanchions({ stanchions }) {
    const bySide = useMemo(() => [-1, 1].map(side => stanchions.filter(stanchion => Math.sign(stanchion.position[0]) === side)), [stanchions])
    return (
        <group>
            {stanchions.map(stanchion => <Stanchion key={stanchion.id} position={stanchion.position} />)}
            {bySide.map((pair, index) => pair.length === 2 && (
                <VelvetRope
                    key={index}
                    start={new THREE.Vector3(pair[0].position[0], 1.02, pair[0].position[2])}
                    end={new THREE.Vector3(pair[1].position[0], 1.02, pair[1].position[2])}
                />
            ))}
        </group>
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

function UpholsteredBench({ bench }) {
    const [width, height, depth] = bench.size
    return (
        <group position={bench.position}>
            <mesh castShadow receiveShadow position={[0, 0.04, 0]}>
                <boxGeometry args={[width, height * 0.72, depth]} />
                <meshStandardMaterial color={DEEP_VELVET} roughness={0.96} />
            </mesh>
            <mesh castShadow position={[0, height * 0.44, 0]}>
                <boxGeometry args={[width + 0.04, height * 0.28, depth + 0.04]} />
                <meshPhysicalMaterial color={VELVET} roughness={0.88} sheen={0.55} sheenRoughness={0.78} />
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
            <mesh castShadow receiveShadow>
                <boxGeometry args={layout.desk.size} />
                <WoodMaterial materials={materials} color="#4c2f1d" roughness={0.42} />
            </mesh>
            <mesh position={[0, 0.76, 0]} castShadow receiveShadow>
                <boxGeometry args={[layout.desk.size[0] + 0.24, 0.14, layout.desk.size[2] + 0.18]} />
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
            <group position={[-1.45, 0.98, -0.12]} rotation={[0, -0.22, 0]}>
                <mesh castShadow>
                    <boxGeometry args={[0.58, 0.04, 0.78]} />
                    <meshStandardMaterial color="#d7c7af" roughness={0.8} />
                </mesh>
                <mesh position={[0, 0.04, 0.04]}>
                    <boxGeometry args={[0.46, 0.025, 0.6]} />
                    <meshStandardMaterial color="#6f2028" roughness={0.88} />
                </mesh>
            </group>
            <group position={[1.4, 1.08, -0.06]} rotation={[0, 0.2, 0]}>
                <mesh castShadow>
                    <boxGeometry args={[0.72, 0.56, 0.04]} />
                    <meshPhysicalMaterial color="#1c1a18" roughness={0.32} clearcoat={0.22} />
                </mesh>
                <mesh position={[0, -0.35, 0.08]}>
                    <boxGeometry args={[0.42, 0.18, 0.28]} />
                    <meshStandardMaterial color={DARK_BRASS} metalness={0.55} roughness={0.4} />
                </mesh>
            </group>
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

function WallSconce({ side, z }) {
    const x = side * 4.64
    return (
        <group position={[x, 3.65, z]}>
            <mesh castShadow>
                <cylinderGeometry args={[0.15, 0.19, 0.48, 10]} />
                <meshStandardMaterial color={DARK_BRASS} metalness={0.76} roughness={0.28} />
            </mesh>
            <mesh position={[-side * 0.19, 0.12, 0]} rotation={[0, 0, side * -0.26]}>
                <cylinderGeometry args={[0.24, 0.15, 0.42, 10, 1, true]} />
                <meshStandardMaterial color="#f2dfbf" emissive="#d99d51" emissiveIntensity={0.5} transparent opacity={0.78} roughness={0.48} side={THREE.DoubleSide} />
            </mesh>
        </group>
    )
}

export default function MuseumDressing({ layout, activeRoomIds, materials, LabelPlane, PlasterMaterial, WoodMaterial, reflectionsEnabled = true }) {
    const bayCount = Math.max(1, Math.ceil(layout.rooms.length / 2))
    const bayZs = Array.from({ length: bayCount }, (_, index) => -7 - (index * 16.5))
    const activeRooms = useMemo(() => {
        const active = new Set(activeRoomIds)
        return layout.rooms.filter(room => active.has(room.id))
    }, [activeRoomIds, layout.rooms])
    return (
        <group>
            <EnvironmentLighting enabled={reflectionsEnabled} />
            <RunnerCarpet layout={layout} />
            <LobbyEntrance materials={materials} LabelPlane={LabelPlane} PlasterMaterial={PlasterMaterial} />
            <ReceptionDesk layout={layout} materials={materials} LabelPlane={LabelPlane} WoodMaterial={WoodMaterial} />
            {layout.dressing.lobbyPlants.map(plant => <PottedPlant key={plant.id} plant={plant} scale={1.05} />)}
            {layout.dressing.hallPlants.map(plant => <PottedPlant key={plant.id} plant={plant} scale={0.9} />)}
            <LobbyStanchions stanchions={layout.dressing.stanchions} />
            <AbstractSculpture sculpture={layout.dressing.terminalSculpture} />
            {activeRooms.flatMap(room => room.plants).map(plant => <PottedPlant key={plant.id} plant={plant} scale={0.92} />)}
            {activeRooms.flatMap(room => room.benches).map(bench => <UpholsteredBench key={bench.id} bench={bench} />)}
            {bayZs.flatMap(z => [-1, 1].map(side => <WallSconce key={`${z}-${side}`} side={side} z={z + 5.45} />))}
        </group>
    )
}
