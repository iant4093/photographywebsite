import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RETURN_PRINT_ASPECT, ALBUM_ARCH_DEPTH, ALBUM_DOOR_HALF_WIDTH, ALBUM_HANG_HEIGHT, albumBayAt, albumPrintWidth } from '../../utils/museumAlbumWing'
import { mediaDisplayUrl, mediaPreviewCandidates, mediaThumbnailUrl } from '../../utils/mediaUrls'

import { albumFrameGeometry, albumPhotoPlaque } from '../../utils/museumAlbumFrame'
import { applyPaintingRipple } from '../../utils/museumPaintingRipple'
import { InstancedPlants, InstancedRoomBenches } from './MuseumDressing'
import MuseumChandeliers from './MuseumChandeliers'

const hallView = '/assets/museum/gallery-return.webp'

function Block({ position, size, color, lit = false }) {
    return <mesh position={position} scale={size}>
        <boxGeometry />
        {lit ? <meshBasicMaterial color={color} /> : <meshStandardMaterial color={color} roughness={0.8} />}
    </mesh>
}

function usePrintTexture(image, maxEdge, detail, loadImage, requestFrames, priority = false) {
    const [print, setPrint] = useState(null)
    useEffect(() => {
        const controller = new AbortController()
        let texture
        const load = async () => {
            const previews = mediaPreviewCandidates(image)
            const preview = previews.find(item => item.width === maxEdge)?.url
            const sources = detail ? [preview, mediaDisplayUrl(image)]
                : [preview, mediaThumbnailUrl(image), mediaDisplayUrl(image)]
            for (const url of new Set(sources)) {
                if (!url) continue
                try {
                    const decoded = await loadImage(url, detail || priority, 0, controller.signal)
                    if (controller.signal.aborted) return
                    const ratio = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height))
                    let source = decoded
                    if (ratio < 1 && (url !== preview || ratio < 0.62)) {
                        source = document.createElement('canvas')
                        source.width = Math.max(1, Math.round(decoded.width * ratio))
                        source.height = Math.max(1, Math.round(decoded.height * ratio))
                        source.getContext('2d').drawImage(decoded, 0, 0, source.width, source.height)
                    }
                    texture = new THREE.Texture(source)
                    texture.colorSpace = THREE.SRGBColorSpace
                    texture.anisotropy = 4
                    texture.needsUpdate = true
                    setPrint({ texture, aspect: decoded.width / decoded.height })
                    requestFrames(2)
                    return
                } catch {
                    if (controller.signal.aborted) return
                }
            }
            setPrint({ failed: true })
            requestFrames(2)
        }
        load()
        return () => { controller.abort(); texture?.dispose() }
    }, [image, loadImage, maxEdge, requestFrames, detail, priority])
    return print
}

function PrintPlaceholder({ image, width, height, drawPlaceholder }) {
    const texture = useMemo(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 24
        drawPlaceholder(canvas.getContext('2d'), { id: image?.id, album: { coverBlurhash: image?.blurhash } },
            0, 0, canvas.width, canvas.height, 0)
        const map = new THREE.CanvasTexture(canvas)
        map.colorSpace = THREE.SRGBColorSpace
        return map
    }, [image, drawPlaceholder])
    useEffect(() => () => texture.dispose(), [texture])
    return <PrintSurface texture={texture} width={width} height={height} />
}

function PrintSurface({ texture, width, height, portal }) {
    const prepare = useCallback(shader => {
        if (portal) applyPaintingRipple(shader, portal, width / height)
    }, [portal, width, height])
    return <mesh position={[0, 0, 0.052]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={texture} toneMapped={false} onBeforeCompile={prepare}
            customProgramCacheKey={() => portal ? 'museum-print-ripple' : 'album-photo'} />
    </mesh>
}

function InspectedPrint({ image, inspectionWidth, loadImage, requestFrames, base, width, height }) {
    const detail = usePrintTexture(image, inspectionWidth, true, loadImage, requestFrames)
    return <PrintSurface texture={detail?.texture || base.texture} width={width} height={height} />
}

function FramedPrint({ position, rotationY, image, loadImage, requestFrames, Label, inspectionWidth, portal,
    arrival, index, id, drawPlaceholder, arrivalPrint = false }) {
    const { gl } = useThree()
    const base = usePrintTexture(image, 960, false, loadImage, requestFrames, arrivalPrint)
    useLayoutEffect(() => {
        const key = portal ? id : index
        if (!base || !arrival.pending.has(key)) return
        if (base.texture) gl.initTexture(base.texture)
        arrival.pending.delete(key)
    }, [base, gl, arrival, index, id, portal])
    const aspect = portal ? RETURN_PRINT_ASPECT : (image?.width / image?.height) || base?.aspect || 1.5
    const width = albumPrintWidth(aspect)
    const height = width / aspect
    const geometry = useMemo(() => albumFrameGeometry(width, height), [width, height])
    useEffect(() => () => geometry.dispose(), [geometry])
    const plaque = portal ? 'Return to gallery' : albumPhotoPlaque(image)
    return <group position={position} rotation={[0, rotationY, 0]}>
        <mesh geometry={geometry}><meshStandardMaterial vertexColors roughness={0.67} /></mesh>
        {base?.texture ? (inspectionWidth
            ? <InspectedPrint image={image} inspectionWidth={inspectionWidth} base={base}
                loadImage={loadImage} requestFrames={requestFrames} width={width} height={height} />
            : <PrintSurface texture={base.texture} width={width} height={height} portal={portal} />)
            : <PrintPlaceholder image={image} width={width} height={height} drawPlaceholder={drawPlaceholder} />}
        {plaque && <Label title={plaque}
            position={[0, -height / 2 - 0.45, 0.042]} size={portal ? [1.75, 0.36] : [1.64, 0.29]} photoPlaque={!portal} />}
    </group>
}

// Bake each picture light's pool into the plaster. Even a long album then
// needs only the scene lights, independent of the number of framed prints.
function SalonWall({ bay, side, wing, materials, Wallpaper }) {
    const x = side * bay.width / 2
    const geometry = useMemo(() => {
        const height = wing.height
        const surface = new THREE.PlaneGeometry(bay.length, height, Math.ceil(bay.length * 3), 18)
        const positions = surface.attributes.position
        const colors = new Float32Array(positions.count * 3)
        const centers = bay.prints.filter(print => print.position[0] * side > 0)
            .map(print => print.position[2])
        for (let i = 0; i < positions.count; i++) {
            const z = (bay.front + bay.back) / 2 + side * positions.getX(i)
            const y = positions.getY(i) + height / 2
            const pool = centers.reduce((sum, center) => sum + Math.exp(
                -((z - center) ** 2) / 1.35 - ((y - ALBUM_HANG_HEIGHT - 0.46) ** 2) / 1.45
            ), 0)
            const daylight = Math.sin(Math.PI * y / height)
            const base = 0.52 + 0.24 * daylight
            colors.set([base + pool * 0.83, base + pool * 0.62, base + pool * 0.39], i * 3)
        }
        surface.setAttribute('color', new THREE.BufferAttribute(colors, 3))
        return surface
    }, [bay, side, wing.height])
    useEffect(() => () => geometry.dispose(), [geometry])
    return <mesh geometry={geometry} position={[x, wing.height / 2, (bay.front + bay.back) / 2]}
        rotation={[0, -side * Math.PI / 2, 0]}>
        <Wallpaper materials={materials} width={bay.length} height={wing.height} centerZ={(bay.front + bay.back) / 2}
            reverseU={side < 0} vertexColors />
    </mesh>
}

// Both extrusions use the exact same sampled outer curve. The U-shaped
// surround owns the whole reveal, including the jambs down to the floor.
function archOutline(radius) {
    const points = [new THREE.Vector2(-radius, 0)]
    for (let segment = 0; segment <= 48; segment++) {
        const angle = Math.PI * (1 - segment / 48)
        points.push(new THREE.Vector2(radius * Math.cos(angle), 2.95 + radius * Math.sin(angle)))
    }
    points.push(new THREE.Vector2(radius, 0))
    return points
}

function ArchWall({ width, height, z, materials, Wallpaper }) {
    const [wall, surround] = useMemo(() => {
        const outer = archOutline(ALBUM_DOOR_HALF_WIDTH + 0.17)
        const half = width / 2
        return [
            new THREE.Shape([new THREE.Vector2(-half, 0), ...outer, new THREE.Vector2(half, 0),
                new THREE.Vector2(half, height), new THREE.Vector2(-half, height)]),
            new THREE.Shape([...outer, ...archOutline(ALBUM_DOOR_HALF_WIDTH).reverse()]),
        ]
    }, [width, height])
    return <group position={[0, 0, z]}>
        <mesh position={[0, 0, -0.12]}>
            <extrudeGeometry args={[wall, { depth: 0.24, bevelEnabled: false }]} />
            <Wallpaper materials={materials} width={width} height={height} shapeUv />
        </mesh>
        <mesh position={[0, 0, -ALBUM_ARCH_DEPTH / 2]}>
            <extrudeGeometry args={[surround, { depth: ALBUM_ARCH_DEPTH, bevelEnabled: false }]} />
            <meshStandardMaterial color="#877863" roughness={0.86} />
        </mesh>
    </group>
}

function EndWall({ width, height, z, rotationY, materials, Wallpaper, trim }) {
    return <group position={[0, 0, z]} rotation={[0, rotationY, 0]}>
        <mesh position={[0, height / 2, 0]}>
            <planeGeometry args={[width, height]} />
            <Wallpaper materials={materials} width={width} height={height} />
        </mesh>
        <Block position={[0, 0.14, 0.0375]} size={[width - 0.15, 0.28, 0.075]} color="#453b32" />
        <Block position={[0, 0.30, 0.045]} size={[width - 0.18, 0.04, 0.09]} color="#776751" />
        <Block position={[0, height - 0.08, 0.045]} size={[width - 0.18, 0.16, 0.09]} color={trim} />
    </group>
}

function Salon({ wing, bay, index, hang, focus, inspectionWidth, materials, Wallpaper, Floor, ...printProps }) {
    const { width: w, length: d } = bay
    const z = (bay.front + bay.back) / 2
    const h = wing.height
    const previous = wing.bays[index - 1]
    const last = index === wing.bays.length - 1
    // Rails terminate at the finished wall faces on either side of the arch.
    const railFront = bay.front - (previous ? 0.12 : 0)
    const railBack = bay.back + (last ? 0 : 0.12)
    const railLength = railFront - railBack
    const railZ = (railFront + railBack) / 2
    return <group>
        <mesh position={[0, 0, z]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[w, d]} />
            <Floor materials={materials} color="#96816e" width={w} depth={d} centerX={0} centerZ={z} />
        </mesh>
        <Block position={[0, h + 0.1, z]} size={[w, 0.2, d]} color="#6d6458" />
        {[-1, 1].map(side => <group key={side}>
            <SalonWall bay={bay} side={side} wing={wing} materials={materials} Wallpaper={Wallpaper} />
            <Block position={[side * w / 2, 0.14, railZ]} size={[0.15, 0.28, railLength]} color="#453b32" />
            <Block position={[side * w / 2, 0.30, railZ]} size={[0.18, 0.04, railLength]} color="#776751" />
            <Block position={[side * w / 2, h - 0.08, railZ]} size={[0.18, 0.16, railLength]} color={wing.palette[1]} />
        </group>)}
        {previous ? <ArchWall width={Math.max(w, previous.width)} height={h} z={bay.front} materials={materials} Wallpaper={Wallpaper} />
            : <EndWall width={w} height={h} z={bay.front} rotationY={Math.PI} Wallpaper={Wallpaper} materials={materials} trim={wing.palette[1]} />}
        {last && <EndWall width={w} height={h} z={bay.back} rotationY={0} Wallpaper={Wallpaper} materials={materials} trim={wing.palette[1]} />}
        {hang && bay.prints.map(print => <FramedPrint key={print.index} {...print} {...printProps} arrivalPrint={index === 1}
            inspectionWidth={focus === print.index ? inspectionWidth : 0} />)}
    </group>
}

export default function MuseumAlbumWing({ wing, visible, inspectionWidth, ...props }) {
    const { camera } = useThree()
    const [activeBay, setActiveBay] = useState(0)
    const [focus, setFocus] = useState(null)
    const probe = useRef({ time: -1, candidate: null, since: 0 })
    const direction = useMemo(() => new THREE.Vector3(), [])
    const offset = useMemo(() => new THREE.Vector3(), [])
    useFrame(({ clock }) => {
        if (!visible) return
        const index = albumBayAt(wing.bays, camera.position.z)
        if (index !== activeBay) setActiveBay(index)
        const now = clock.elapsedTime
        const state = probe.current
        if (now - state.time < 0.16) return
        state.time = now
        camera.getWorldDirection(direction)
        let candidate = null
        let bestFacing = 0.68
        let retain = false
        for (const print of wing.bays[index].prints) {
            offset.set(...print.position).sub(camera.position)
            const distance = offset.length()
            const facing = direction.dot(offset.normalize())
            if (print.index === focus && distance <= 14 && facing > 0.25) retain = true
            if (distance < 12 && facing > bestFacing) {
                bestFacing = facing
                candidate = print.index
            }
        }
        if (state.candidate !== candidate) {
            state.candidate = candidate
            state.since = now
        }
        if (candidate !== null && now - state.since >= 0.16) {
            if (focus !== candidate) setFocus(candidate)
        } else if (!retain && focus !== null) setFocus(null)
    })
    const bay = wing.bays[activeBay]
    const first = albumBayAt(wing.bays, bay.front + camera.far)
    const last = albumBayAt(wing.bays, bay.back - camera.far)
    const rooms = useMemo(() => wing.bays.slice(first, last + 1), [wing, first, last])
    const plants = useMemo(() => rooms.flatMap(room => room.plants), [rooms])
    const fixtures = useMemo(() => rooms.map(room => [0, (room.front + room.back) / 2]), [rooms])
    return <group visible={visible}>
        <hemisphereLight args={['#c6b198', '#564438', 0.44]} />
        <MuseumChandeliers positions={fixtures} ceilingY={wing.height} materials={props.materials} />
        <InstancedRoomBenches rooms={rooms} materials={props.materials} />
        <InstancedPlants plants={plants} materials={props.materials} />
        {rooms.map((bay, i) => <Salon key={first + i} index={first + i}
            bay={bay} wing={wing} focus={focus} inspectionWidth={inspectionWidth}
            hang={Math.abs(first + i - activeBay) <= 2} {...props} />)}
        {wing.portals.map((portal, i) => (i === 0 ? first === 0 : last === wing.bays.length - 1)
            && <FramedPrint key={portal.id} {...portal} image={hallView} portal={portal} arrivalPrint={i === 0} {...props} />)}
    </group>
}
