import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { MUSEUM_DIMENSIONS } from '../../utils/museumLayout'
import { museumRoomCofferPanels } from '../../utils/museumSkylights'

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1)

function ArchitectureBatch({ items, color, luminous = false }) {
    const mesh = useRef(null)
    useLayoutEffect(() => {
        const matrix = new THREE.Matrix4()
        const position = new THREE.Vector3()
        const scale = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        items.forEach((item, index) => {
            matrix.compose(position.set(...item.position), rotation, scale.set(...item.size))
            mesh.current.setMatrixAt(index, matrix)
        })
        mesh.current.instanceMatrix.needsUpdate = true
        mesh.current.computeBoundingSphere()
    }, [items])
    return (
        <instancedMesh ref={mesh} args={[UNIT_BOX, undefined, items.length]}>
            {luminous
                ? <meshBasicMaterial color={color} toneMapped={false} />
                : <meshStandardMaterial color={color} roughness={0.78} />}
        </instancedMesh>
    )
}

function PictureLightWash({ paintings }) {
    const mesh = useRef(null)
    useLayoutEffect(() => {
        const matrix = new THREE.Matrix4()
        const position = new THREE.Vector3()
        const scale = new THREE.Vector3(4.6, 4.8, 1)
        const rotation = new THREE.Quaternion()
        paintings.forEach((painting, index) => {
            const direction = painting.normal[2]
            rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, painting.rotationY)
            // Flush to the wallpaper, behind every piece of the frame assembly.
            position.set(painting.position[0], 2.4, painting.position[2] - direction * 0.115)
            matrix.compose(position, rotation, scale)
            mesh.current.setMatrixAt(index, matrix)
        })
        mesh.current.instanceMatrix.needsUpdate = true
        mesh.current.computeBoundingSphere()
    }, [paintings])
    return (
        <instancedMesh ref={mesh} args={[UNIT_PLANE, undefined, paintings.length]} renderOrder={1}>
            <shaderMaterial
                transparent depthWrite={false} blending={THREE.AdditiveBlending}
                vertexShader={`
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
                    }
                `}
                fragmentShader={`
                    varying vec2 vUv;
                    void main() {
                        float down = 1.0 - vUv.y;
                        float spread = 0.12 + down * 0.38;
                        float pool = exp(-2.0 * pow((vUv.x - 0.5) / spread, 2.0));
                        pool *= smoothstep(0.0, 0.24, vUv.y) * smoothstep(0.0, 0.22, down);
                        gl_FragColor = vec4(0.96, 0.68, 0.37, pool * 0.25);
                    }
                `}
            />
        </instancedMesh>
    )
}

export function MuseumCofferedCeiling({ room }) {
    const panels = useMemo(() => museumRoomCofferPanels(room), [room])
    return (
        <group>
            <ArchitectureBatch items={panels.surround} color="#82705b" />
            <ArchitectureBatch items={panels.inset} color="#d1c2a8" />
        </group>
    )
}

export function MuseumRoomArchitecture({ room, shellCenterX, shellDepth, ribXs }) {
    const batches = useMemo(() => {
        const stone = []
        const brass = []
        const cove = []
        const wallZ = room.width / 2 - 0.2
        for (const direction of [-1, 1]) {
            const z = room.centerZ + direction * wallZ
            // Continuous cornice and dado cover surface edges. All piers are
            // in frame gaps; the picture rail is above the highest light arm.
            stone.push(
                { position: [shellCenterX, 5.84, z], size: [shellDepth, 0.2, 0.2] },
                { position: [shellCenterX, 0.52, z], size: [shellDepth, 0.4, 0.12] },
                { position: [shellCenterX, 0.765, z - direction * 0.03], size: [shellDepth, 0.075, 0.17] },
            )
            brass.push({ position: [shellCenterX, 4.68, z], size: [shellDepth, 0.035, 0.1] })
            cove.push({ position: [shellCenterX, 5.96, z - direction * 0.055], size: [shellDepth - 0.12, 0.025, 0.05] })
            for (const x of [room.innerX + room.side * 0.22, room.outerX - room.side * 0.19]) {
                stone.push({ position: [x, 3.05, z], size: [0.22, 6.1, 0.2] })
            }
            for (const x of ribXs) {
                stone.push({ position: [x, 3.05, z], size: [0.2, 5.7, 0.18] })
                brass.push({ position: [x, 3.12, z - direction * 0.1], size: [0.035, 5.25, 0.018] })
            }
        }
        for (const x of ribXs) {
            stone.push({ position: [x, 5.83, room.centerZ], size: [0.2, 0.2, room.width - 0.3] })
        }
        return { stone, brass, cove }
    }, [ribXs, room, shellCenterX, shellDepth])
    return (
        <group>
            <ArchitectureBatch items={batches.stone} color="#bbae99" />
            <ArchitectureBatch items={batches.brass} color="#9f7845" />
            <ArchitectureBatch items={batches.cove} color="#f5d5a4" luminous />
            <PictureLightWash paintings={room.paintings} />
        </group>
    )
}

export function MuseumAtmosphere({ layout, roomId, motionSuppressed }) {
    const material = useRef(null)
    const room = layout.rooms.find(item => item.id === roomId)
    const volume = useMemo(() => {
        if (room) return {
            center: [room.centerX, 2.8, room.centerZ],
            size: [Math.max(1, room.depth - 1.6), 4.8, room.width - 1.6],
        }
        return {
            center: [0, 3, (MUSEUM_DIMENSIONS.lobbyFrontZ + layout.hallBackZ) / 2],
            size: [7.2, 5.4, layout.hallLength - 2],
        }
    }, [layout, room])
    const geometry = useMemo(() => {
        const points = new THREE.BufferGeometry()
        const positions = new Float32Array(72 * 3)
        for (let index = 0; index < 72; index += 1) {
            // Stable distribution: no random allocations or instance updates
            // while walking. The vertex shader moves all 72 motes in one draw.
            positions[index * 3] = ((index * 0.618034) % 1) - 0.5
            positions[index * 3 + 1] = ((index * 0.414214) % 1) - 0.5
            positions[index * 3 + 2] = ((index * 0.732051) % 1) - 0.5
        }
        points.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        return points
    }, [])
    const uniforms = useMemo(() => ({ time: { value: 0 } }), [])
    useEffect(() => () => geometry.dispose(), [geometry])
    useFrame((_, delta) => {
        if (!motionSuppressed && material.current) {
            material.current.uniforms.time.value += Math.min(delta, 0.05)
        }
    })
    if (motionSuppressed) return null
    return (
        <points position={volume.center} scale={volume.size} geometry={geometry} frustumCulled={false}>
            <shaderMaterial
                ref={material} uniforms={uniforms} transparent depthWrite={false}
                vertexShader={`
                    uniform float time;
                    varying float visibility;
                    void main() {
                        vec3 p = position;
                        p.x += sin(time * 0.16 + position.z * 25.0) * 0.004;
                        p.y = mod(p.y + 0.5 + time * 0.003, 1.0) - 0.5;
                        vec4 view = modelViewMatrix * vec4(p, 1.0);
                        gl_Position = projectionMatrix * view;
                        gl_PointSize = clamp(15.0 / max(1.0, -view.z), 1.0, 2.4);
                        visibility = smoothstep(1.0, 3.0, -view.z) * (1.0 - smoothstep(8.0, 18.0, -view.z));
                    }
                `}
                fragmentShader={`
                    varying float visibility;
                    void main() {
                        float radius = length(gl_PointCoord - 0.5) * 2.0;
                        gl_FragColor = vec4(1.0, 0.85, 0.63, (1.0 - smoothstep(0.0, 1.0, radius)) * visibility * 0.2);
                    }
                `}
            />
        </points>
    )
}
