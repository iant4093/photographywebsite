/* eslint-disable react-hooks/immutability -- Three.js scene environment state is managed by the renderer lifecycle. */
import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { museumGalleryDisplayParts, museumGalleryDisplays, museumReadingProps } from '../../utils/museumDecor'
import { createMuseumDisplayPartGeometry } from '../../utils/museumDisplayGeometry'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { museumHallSconcePlacements } from '../../utils/museumSupport'
import { MUSEUM_DIMENSIONS } from '../../utils/museumLayout'
import { MUSEUM_PLANT_FORM, MUSEUM_PLANT_LEAF_MESH, museumPlantLeaves } from '../../utils/museumPlants'

const DARK_BRASS = '#735332'
let textileDetailTexture = null
const BENCH_ROUNDED_BOX = new RoundedBoxGeometry(1, 1, 1, 3, 0.1)
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

const PLANT_LEAF_GEOMETRY = new THREE.BufferGeometry()
PLANT_LEAF_GEOMETRY.setAttribute('position', new THREE.Float32BufferAttribute(MUSEUM_PLANT_LEAF_MESH.positions, 3))
PLANT_LEAF_GEOMETRY.setIndex(MUSEUM_PLANT_LEAF_MESH.indices)
PLANT_LEAF_GEOMETRY.computeVertexNormals()
const PLANT_POT_GEOMETRY = new THREE.LatheGeometry([
    new THREE.Vector2(0, 0),
    new THREE.Vector2(MUSEUM_PLANT_FORM.potBottomRadius, 0),
    new THREE.Vector2(MUSEUM_PLANT_FORM.potTopRadius, MUSEUM_PLANT_FORM.potHeight - 0.015),
    new THREE.Vector2(MUSEUM_PLANT_FORM.potTopRadius - 0.005, MUSEUM_PLANT_FORM.potHeight),
    new THREE.Vector2(MUSEUM_PLANT_FORM.soilRadius, MUSEUM_PLANT_FORM.potHeight),
    new THREE.Vector2(MUSEUM_PLANT_FORM.soilRadius - 0.01, MUSEUM_PLANT_FORM.soilY),
], 12)
const PLANT_LEAF_COLORS = ['#527744', '#63834c', '#3e673c', '#73905b'].map(color => new THREE.Color(color))

function EnvironmentLighting({ intensity = 0.22 }) {
    const { gl, scene } = useThree()

    useEffect(() => {
        const pmrem = new THREE.PMREMGenerator(gl)
        const environmentScene = new RoomEnvironment()
        // Author the existing one-time reflection capture as a lamplit salon.
        // Darker surroundings and small warm sources give brass and polished
        // timber highlights without another runtime light or reflection pass.
        environmentScene.traverse(object => {
            if (object.isLight) {
                object.color.set('#f2cea0')
                object.intensity *= 0.75
            }
            const material = object.material
            if (!material) return
            if (material.emissiveIntensity > 1) {
                material.emissive.set(object.position.z > 14 ? '#c3d7e7' : '#ffd49b')
                material.emissiveIntensity *= object.position.z > 14 ? 0.5 : 0.85
            } else {
                material.color.set(object.isInstancedMesh ? '#46342c' : '#9a8872')
            }
        })
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

    useLayoutEffect(() => {
        if (!plantCount) return
        const root = new THREE.Matrix4()
        const local = new THREE.Matrix4()
        const matrix = new THREE.Matrix4()
        const position = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        const scale = new THREE.Vector3()
        const rootRotation = new THREE.Quaternion()
        const stemStart = new THREE.Vector3()
        const stemEnd = new THREE.Vector3()
        const stemDirection = new THREE.Vector3()
        const up = new THREE.Vector3(0, 1, 0)
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
            setLocalMatrix(pots.current, plantIndex, [0, 0, 0], [0, 0, 0], [1, 1, 1])
            setLocalMatrix(soil.current, plantIndex, [0, MUSEUM_PLANT_FORM.soilY, 0], [-Math.PI / 2, 0, 0], [1, 1, 1])
            museumPlantLeaves(renderVariant).forEach((leaf, sourceIndex) => {
                // Each petiole terminates at its own leaf root. Leaves occupy
                // separate radial sectors, so no stalk pierces another blade.
                stemStart.set(...leaf.stemStart)
                stemEnd.set(...leaf.position)
                stemDirection.subVectors(stemEnd, stemStart)
                const stemLength = stemDirection.length()
                rotation.setFromUnitVectors(up, stemDirection.normalize())
                local.compose(
                    position.copy(stemStart).add(stemEnd).multiplyScalar(0.5),
                    rotation,
                    scale.set(MUSEUM_PLANT_FORM.stemRadius, stemLength, MUSEUM_PLANT_FORM.stemRadius),
                )
                matrix.multiplyMatrices(root, local)
                stems.current?.setMatrixAt(stemIndex, matrix)
                stemIndex += 1
                setLocalMatrix(
                    leaves.current,
                    leafIndex,
                    leaf.position,
                    [-leaf.lift, leaf.angle, 0, 'YXZ'],
                    [leaf.width, leaf.length, leaf.length],
                )
                leaves.current?.setColorAt(leafIndex, PLANT_LEAF_COLORS[(sourceIndex + plantIndex) % PLANT_LEAF_COLORS.length])
                leafIndex += 1
            })
        })
        for (const mesh of [pots.current, soil.current, stems.current, leaves.current]) {
            if (!mesh) continue
            mesh.instanceMatrix.needsUpdate = true
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
            mesh.computeBoundingSphere?.()
        }
    }, [plantCount, plants])

    if (!plantCount) return null
    return (
        <>
            <instancedMesh ref={pots} args={[PLANT_POT_GEOMETRY, undefined, plantCount]} castShadow={castDynamicShadows} receiveShadow>
                <meshPhysicalMaterial
                    color="#a1937d"
                    roughness={0.48}
                    clearcoat={0.18}
                    clearcoatRoughness={0.68}
                />
            </instancedMesh>
            <instancedMesh ref={soil} args={[undefined, undefined, plantCount]}>
                <circleGeometry args={[MUSEUM_PLANT_FORM.soilRadius - 0.01, 12]} />
                <meshStandardMaterial color="#2a2119" roughness={1} />
            </instancedMesh>
            <instancedMesh ref={stems} args={[undefined, undefined, plantCount * MUSEUM_PLANT_FORM.leafCount]} castShadow={castDynamicShadows}>
                <cylinderGeometry args={[1, 1, 1, 5, 1, true]} />
                <meshStandardMaterial color="#3f5e37" roughness={0.88} />
            </instancedMesh>
            <instancedMesh ref={leaves} args={[PLANT_LEAF_GEOMETRY, undefined, plantCount * MUSEUM_PLANT_FORM.leafCount]} castShadow={castDynamicShadows}>
                <meshStandardMaterial color="#ffffff" roughness={0.68} side={THREE.DoubleSide} />
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

function SalonRugs({ benches }) {
    const rug = useMemo(() => {
        const canvas = document.createElement('canvas')
        const tile = 256
        canvas.width = tile
        canvas.height = tile * BENCH_PALETTES.length
        const context = canvas.getContext('2d')
        BENCH_PALETTES.forEach((palette, index) => {
            context.save()
            context.translate(0, index * tile)
            context.fillStyle = palette.rugOuter
            context.fillRect(0, 0, tile, tile)
            context.fillStyle = palette.rugInner
            context.fillRect(10, 10, 236, 236)
            context.strokeStyle = palette.rugBorder
            context.lineWidth = 3
            context.strokeRect(16, 16, 224, 224)
            context.lineWidth = 1
            context.strokeRect(25, 25, 206, 206)
            context.fillStyle = palette.rugCenter
            context.fillRect(30, 30, 196, 196)
            // Woven geometry gives each reading area a quieter, finer pattern
            // than four stacked slabs. One small atlas serves every salon.
            for (let y = 48; y < 224; y += 32) {
                for (let x = 48; x < 224; x += 32) {
                    context.beginPath()
                    context.moveTo(x, y - 5)
                    context.lineTo(x + 4, y)
                    context.lineTo(x, y + 5)
                    context.lineTo(x - 4, y)
                    context.closePath()
                    context.stroke()
                }
            }
            context.globalAlpha = 0.1
            context.strokeStyle = '#eadbc1'
            for (let line = 2; line < tile; line += 3) {
                context.beginPath()
                context.moveTo(1, line)
                context.lineTo(tile - 1, line)
                context.stroke()
            }
            context.restore()
        })
        const texture = new THREE.CanvasTexture(canvas)
        texture.colorSpace = THREE.SRGBColorSpace
        texture.anisotropy = 4
        const parts = benches.map(({ bench, variant }) => {
            const geometry = new THREE.PlaneGeometry(bench.size[0] + 1.15, bench.size[2] + 0.95)
            const uv = geometry.getAttribute('uv')
            const row = variant % BENCH_PALETTES.length
            for (let index = 0; index < uv.count; index += 1) {
                // Keep samples inside the tile so distant mip levels cannot
                // borrow a contrasting edge from the next colorway.
                uv.setXY(index, 0.015 + uv.getX(index) * 0.97, 1 - (row + 0.015 + (1 - uv.getY(index)) * 0.97) / BENCH_PALETTES.length)
            }
            geometry.rotateX(-Math.PI / 2)
            geometry.rotateY(bench.rotationY || 0)
            geometry.translate(bench.position[0], 0.049, bench.position[2])
            return geometry
        })
        const geometry = mergeGeometries(parts)
        parts.forEach(part => part.dispose())
        return { geometry, texture }
    }, [benches])
    useEffect(() => () => {
        rug.geometry.dispose()
        rug.texture.dispose()
    }, [rug])
    return (
        <mesh geometry={rug.geometry} receiveShadow>
            <meshStandardMaterial map={rug.texture} roughness={0.97} />
        </mesh>
    )
}

function ReadingRoomDetails({ layout }) {
    const geometry = useMemo(() => {
        const parts = museumReadingProps(layout).map(part => {
            const next = part.shape === 'cylinder'
                ? new THREE.CylinderGeometry(1, 1, 1, 12)
                : new THREE.BoxGeometry(1, 1, 1)
            next.scale(...part.size)
            next.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...part.rotation)))
            next.translate(...part.position)
            const color = new THREE.Color(part.color)
            const values = new Float32Array(next.getAttribute('position').count * 3)
            for (let index = 0; index < values.length; index += 3) color.toArray(values, index)
            next.setAttribute('color', new THREE.BufferAttribute(values, 3))
            return next
        })
        const merged = mergeGeometries(parts)
        parts.forEach(part => part.dispose())
        return merged
    }, [layout])
    useEffect(() => () => geometry.dispose(), [geometry])
    return (
        <mesh geometry={geometry}>
            <meshStandardMaterial vertexColors roughness={0.67} metalness={0.12} />
        </mesh>
    )
}

function GalleryDisplayFurniture({ layout }) {
    const geometries = useMemo(() => {
        const bySurface = { wood: [], brass: [], ceramic: [] }
        for (const display of museumGalleryDisplays(layout)) {
            for (const part of museumGalleryDisplayParts(display)) {
                bySurface[part.surface].push(createMuseumDisplayPartGeometry(part))
            }
        }
        return Object.fromEntries(Object.entries(bySurface).map(([surface, parts]) => {
            const merged = parts.length ? mergeGeometries(parts) : null
            parts.forEach(part => part.dispose())
            merged?.computeBoundingSphere()
            return [surface, merged]
        }))
    }, [layout])
    useEffect(() => () => {
        Object.values(geometries).forEach(geometry => geometry?.dispose())
    }, [geometries])
    // Three global material batches hold every display station. No live lights,
    // shadow passes, texture downloads, or per-frame transforms are introduced.
    return (
        <group>
            {geometries.wood && <mesh geometry={geometries.wood}><meshStandardMaterial vertexColors roughness={0.57} metalness={0.08} /></mesh>}
            {geometries.brass && <mesh geometry={geometries.brass}><meshStandardMaterial vertexColors roughness={0.32} metalness={0.74} /></mesh>}
            {geometries.ceramic && <mesh geometry={geometries.ceramic}><meshStandardMaterial vertexColors roughness={0.43} metalness={0.03} /></mesh>}
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

            for (const x of [-0.56, 0.56]) {
                for (const direction of [-1, 1]) {
                    local.compose(
                        position.set(x, -0.245, direction * ((depth / 2) - 0.18)),
                        localRotation.identity(),
                        scale.set(1, 1, 1),
                    )
                    matrix.multiplyMatrices(parent, local)
                    legs.current?.setMatrixAt(legIndex, matrix)
                    legIndex += 1
                }
            }
        })
        for (const mesh of [bases.current, cushions.current, trimBands.current, tuftButtons.current, legs.current]) {
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
                <cylinderGeometry args={[0.055, 0.075, 0.28, 10]} />
                <meshStandardMaterial color={DARK_BRASS} metalness={0.72} roughness={0.28} />
            </instancedMesh>
            <SalonRugs benches={benches} />
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
                    <mesh position={[x, MUSEUM_DIMENSIONS.hallHeight / 2, 0]} receiveShadow>
                        <RoundedBoxShape size={[2.25, MUSEUM_DIMENSIONS.hallHeight, 0.28]} radius={0.065} segments={3} />
                        <PlasterMaterial materials={materials} color="#d8d1c5" textured={false} />
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
                        {/* Frosted daylight glass needs no offscreen refraction
                            pass, keeping the added gallery detail affordable. */}
                        <meshStandardMaterial color="#abc2cd" emissive="#829fb5" emissiveIntensity={0.3} roughness={0.72} />
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
            <mesh position={[0, (MUSEUM_DIMENSIONS.hallHeight + 4.525) / 2, 0]}>
                <RoundedBoxShape size={[5.1, MUSEUM_DIMENSIONS.hallHeight - 4.525, 0.28]} radius={0.07} segments={3} />
                <PlasterMaterial materials={materials} color="#d8d1c5" textured={false} />
            </mesh>
            <LabelPlane title="The Photography Archive" subtitle="Est. 2026" position={[0, 5.4, -0.145]} rotation={[0, Math.PI, 0]} size={[4.35, 0.92]} />
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
        ...layout.dressing.lobbyPlants,
        ...layout.dressing.hallPlants,
    ], [layout.dressing.hallPlants, layout.dressing.lobbyPlants])
    const roomPlants = useMemo(() => [
        ...dressedRooms.flatMap(room => room.plants),
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
            <ReadingRoomDetails layout={layout} />
            <GalleryDisplayFurniture layout={layout} />
            {/* Place sconces on the solid wall between galleries, clear of the
                room end walls and arched entry trim. Every lens uses the same
                emissive and baked-light treatment; selective live point lights
                made isolated fittings look powered while their neighbors did not. */}
            <InstancedWallSconces placements={sconcePlacements} />
        </group>
    )
}
