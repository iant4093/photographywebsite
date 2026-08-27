/* eslint-disable react-hooks/immutability -- Three.js cameras are intentionally mutable scene objects. */
import { AdaptiveDpr, PointerLockControls, Preload } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import * as THREE from 'three'
import { fetchAllAlbums } from '../utils/api'
import { albumCoverPreviewSrcSet } from '../utils/mediaUrls'
import {
    buildMuseumCatalog,
    buildMuseumLayout,
    MUSEUM_DIMENSIONS,
    moveMuseumPosition,
    museumPlanarAxes,
    nearbyMuseumRoomIds,
    nearestMuseumRoom,
} from '../utils/museumLayout'

const SESSION_KEY = 'ian-photography-museum-position-v1'
const HALL_PAINT = '#bbb4a9'
const ROOM_PAINT = '#aaa399'
const FLOOR = '#292622'
const GOLD = '#8f704b'
const INK = '#12110f'

function safeSessionPosition(spawn) {
    try {
        const value = JSON.parse(sessionStorage.getItem(SESSION_KEY))
        if (Number.isFinite(value?.x) && Number.isFinite(value?.z)) return value
    } catch {
        // A fresh spawn is preferable to blocking the gallery on corrupt local state.
    }
    return { x: spawn[0], z: spawn[2] }
}

function useLabelTexture(title, subtitle = '', { width = 1024, height = 256, dark = true } = {}) {
    const texture = useMemo(() => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        context.fillStyle = dark ? '#1d1916' : '#eee8dc'
        context.fillRect(0, 0, width, height)
        context.strokeStyle = dark ? '#b58a55' : '#5c4634'
        context.lineWidth = 8
        context.strokeRect(8, 8, width - 16, height - 16)
        context.fillStyle = dark ? '#f3ede1' : '#211d18'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        const longest = Math.max(8, title.length)
        const fontSize = Math.max(42, Math.min(88, Math.floor((width * 1.25) / longest)))
        context.font = `500 ${fontSize}px Georgia, serif`
        context.fillText(title, width / 2, subtitle ? height * 0.43 : height / 2, width - 90)
        if (subtitle) {
            context.fillStyle = dark ? '#c4b6a3' : '#6f6256'
            context.font = '500 28px Helvetica, Arial, sans-serif'
            context.fillText(subtitle.toUpperCase(), width / 2, height * 0.72, width - 90)
        }
        const next = new THREE.CanvasTexture(canvas)
        next.colorSpace = THREE.SRGBColorSpace
        next.needsUpdate = true
        return next
    }, [dark, height, subtitle, title, width])

    useEffect(() => () => texture.dispose(), [texture])
    return texture
}

function LabelPlane({ title, subtitle, position, rotation = [0, 0, 0], size = [3, 0.75] }) {
    const texture = useLabelTexture(title, subtitle)
    return (
        <mesh position={position} rotation={rotation}>
            <planeGeometry args={size} />
            <meshBasicMaterial map={texture} toneMapped={false} />
        </mesh>
    )
}

async function optimizedCoverUrls(album) {
    const srcSet = await albumCoverPreviewSrcSet(album).catch(() => '')
    const previews = srcSet
        .split(',')
        .map(candidate => candidate.trim().split(/\s+/)[0])
        .filter(Boolean)
    return [...new Set([
        previews[1],
        previews[0],
        album.coverThumbnailUrl,
        previews[2],
        album.coverImageUrl,
    ].filter(Boolean))]
}

function developmentMediaUrl(value) {
    if (!import.meta.env.DEV || typeof value !== 'string') return value
    try {
        const parsed = new URL(value)
        if (parsed.hostname.endsWith('.cloudfront.net')) {
            return `${parsed.pathname}${parsed.search}`
        }
    } catch {
        return value
    }
    return value
}

function useCoverTexture(album, active) {
    const [loaded, setLoaded] = useState(null)

    useEffect(() => {
        let cancelled = false
        let loadedTexture = null
        let image = null
        if (!active) return undefined

        optimizedCoverUrls(album).then((urls) => {
            const loadCandidate = (index) => {
                const url = urls[index]
                if (!url || cancelled) return
                image = new Image()
                image.crossOrigin = 'anonymous'
                image.decoding = 'async'
                image.onload = () => {
                    if (cancelled) return
                    loadedTexture = new THREE.Texture(image)
                    const imageAspect = image.naturalWidth / image.naturalHeight
                    const frameAspect = 2.66 / 1.76
                    if (imageAspect > frameAspect) {
                        loadedTexture.repeat.x = frameAspect / imageAspect
                        loadedTexture.offset.x = (1 - loadedTexture.repeat.x) / 2
                    } else if (imageAspect > 0) {
                        loadedTexture.repeat.y = imageAspect / frameAspect
                        loadedTexture.offset.y = (1 - loadedTexture.repeat.y) / 2
                    }
                    loadedTexture.colorSpace = THREE.SRGBColorSpace
                    loadedTexture.minFilter = THREE.LinearMipmapLinearFilter
                    loadedTexture.magFilter = THREE.LinearFilter
                    loadedTexture.generateMipmaps = true
                    loadedTexture.needsUpdate = true
                    setLoaded({ albumId: album.albumId, texture: loadedTexture })
                }
                image.onerror = () => loadCandidate(index + 1)
                image.src = developmentMediaUrl(url)
            }
            loadCandidate(0)
        })

        return () => {
            cancelled = true
            if (image) {
                image.onload = null
                image.onerror = null
            }
            loadedTexture?.dispose()
        }
    }, [active, album])

    return active && loaded?.albumId === album.albumId ? loaded.texture : null
}

function Painting({ painting, active }) {
    const texture = useCoverTexture(painting.album, active)
    const date = painting.album.createdAt || painting.album.uploadedAt || ''
    const subtitle = date ? new Date(`${String(date).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
    }) : 'Photographic series'
    const plaque = useLabelTexture(painting.album.title, subtitle, { width: 1024, height: 220, dark: false })
    const placeholder = useLabelTexture(painting.album.title, 'Loading collection', {
        width: 1024,
        height: 680,
    })

    return (
        <group position={painting.position} rotation={[0, painting.rotationY, 0]}>
            <mesh>
                <boxGeometry args={[3.18, 2.28, 0.13]} />
                <meshStandardMaterial color={GOLD} roughness={0.36} metalness={0.62} />
            </mesh>
            <mesh position={[0, 0, 0.1]}>
                <boxGeometry args={[2.94, 2.04, 0.08]} />
                <meshStandardMaterial color="#f5efe3" roughness={0.8} />
            </mesh>
            <mesh position={[0, 0, 0.155]}>
                <planeGeometry args={[2.66, 1.76]} />
                <meshStandardMaterial
                    map={texture || placeholder}
                    color="#ffffff"
                    emissive={texture ? '#17120d' : '#000000'}
                    emissiveIntensity={texture ? 0.16 : 0}
                    roughness={0.82}
                />
            </mesh>
            <mesh position={[0, -1.48, 0.12]}>
                <planeGeometry args={[2.8, 0.6]} />
                <meshBasicMaterial map={plaque} toneMapped={false} />
            </mesh>
            <mesh position={[0, 1.56, 0.22]} rotation={[0.18, 0, 0]}>
                <boxGeometry args={[1.35, 0.09, 0.12]} />
                <meshStandardMaterial color="#b89969" emissive="#8f6a3b" emissiveIntensity={0.5} />
            </mesh>
        </group>
    )
}

function Bench({ bench }) {
    return (
        <group position={bench.position}>
            <mesh>
                <boxGeometry args={bench.size} />
                <meshStandardMaterial color="#564234" roughness={0.68} />
            </mesh>
            {[-0.55, 0.55].map(x => (
                <mesh key={x} position={[x, -0.42, 0]}>
                    <boxGeometry args={[0.12, 0.65, 2.25]} />
                    <meshStandardMaterial color="#211b17" />
                </mesh>
            ))}
        </group>
    )
}

function useArchedWallShape(hasDoor) {
    return useMemo(() => {
        const halfBay = MUSEUM_DIMENSIONS.baySpacing / 2
        const shape = new THREE.Shape()
        shape.moveTo(-halfBay, 0)
        shape.lineTo(halfBay, 0)
        shape.lineTo(halfBay, MUSEUM_DIMENSIONS.hallHeight)
        shape.lineTo(-halfBay, MUSEUM_DIMENSIONS.hallHeight)
        shape.closePath()
        if (!hasDoor) return shape

        const radius = MUSEUM_DIMENSIONS.doorwayWidth / 2
        const springHeight = 2.55
        const archRise = 1.4
        const opening = new THREE.Path()
        opening.moveTo(-radius, 0)
        opening.lineTo(-radius, springHeight)
        for (let segment = 1; segment <= 32; segment += 1) {
            const angle = Math.PI - ((Math.PI * segment) / 32)
            opening.lineTo(Math.cos(angle) * radius, springHeight + (Math.sin(angle) * archRise))
        }
        opening.lineTo(radius, 0)
        opening.closePath()
        shape.holes.push(opening)
        return shape
    }, [hasDoor])
}

function useArchTrimCurve() {
    return useMemo(() => {
        const radius = MUSEUM_DIMENSIONS.doorwayWidth / 2
        const springHeight = 2.55
        const archRise = 1.4
        const points = [new THREE.Vector3(-radius, 0.08, 0)]
        for (let segment = 0; segment <= 32; segment += 1) {
            const angle = Math.PI - ((Math.PI * segment) / 32)
            points.push(new THREE.Vector3(
                Math.cos(angle) * radius,
                springHeight + (Math.sin(angle) * archRise),
                0,
            ))
        }
        points.push(new THREE.Vector3(radius, 0.08, 0))
        return new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5)
    }, [])
}

function DoorWall({ side, centerZ, room }) {
    const wallX = side * MUSEUM_DIMENSIONS.hallHalfWidth
    const thickness = 0.24
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    const wallShape = useArchedWallShape(Boolean(room))
    const archCurve = useArchTrimCurve()

    return (
        <group>
            <mesh position={[wallX, 0, centerZ]} rotation={[0, Math.PI / 2, 0]}>
                <shapeGeometry args={[wallShape, 48]} />
                <meshStandardMaterial color={HALL_PAINT} roughness={0.96} side={THREE.DoubleSide} />
            </mesh>
            {room && (
                <>
                    <mesh position={[wallX - (side * (thickness / 2 + 0.025)), 0, centerZ]} rotation={[0, rotationY, 0]}>
                        <tubeGeometry args={[archCurve, 48, 0.055, 8, false]} />
                        <meshStandardMaterial color="#a68155" metalness={0.2} roughness={0.62} />
                    </mesh>
                    <LabelPlane
                        title={room.name}
                        subtitle={`${room.albums.length} ${room.albums.length === 1 ? 'album' : 'albums'}`}
                        position={[wallX - (side * 0.15), 4.72, centerZ]}
                        rotation={[0, rotationY, 0]}
                        size={[3.05, 0.72]}
                    />
                </>
            )}
        </group>
    )
}

function VaultedCeiling({ layout, centerZ }) {
    const panels = useMemo(() => {
        const radius = 5.5
        const centerY = 0.72
        const start = Math.acos(MUSEUM_DIMENSIONS.hallHalfWidth / radius)
        const end = Math.PI - start
        const count = 16
        const step = (end - start) / count
        return Array.from({ length: count }, (_, index) => {
            const angle = start + ((index + 0.5) * step)
            return {
                angle,
                x: radius * Math.cos(angle),
                y: centerY + (radius * Math.sin(angle)),
                width: (radius * step) * 1.025,
            }
        })
    }, [])

    return (
        <group>
            {panels.map(panel => (
                <mesh
                    key={panel.angle}
                    position={[panel.x, panel.y, centerZ]}
                    rotation={[0, 0, panel.angle + (Math.PI / 2)]}
                >
                    <boxGeometry args={[panel.width, 0.16, layout.hallLength]} />
                    <meshStandardMaterial
                        color="#c7c0b5"
                        emissive="#5d554b"
                        emissiveIntensity={0.42}
                        roughness={0.92}
                    />
                </mesh>
            ))}
        </group>
    )
}

function CategoryRoom({ room, active }) {
    const roomWidth = MUSEUM_DIMENSIONS.roomSpan
    const outerWallX = room.outerX
    const wallThickness = 0.24
    return (
        <group>
            <mesh position={[room.centerX, -0.13, room.centerZ]}>
                <boxGeometry args={[room.depth, 0.26, roomWidth]} />
                <meshStandardMaterial color={FLOOR} roughness={0.76} />
            </mesh>
            <mesh position={[room.centerX, 5.78, room.centerZ]}>
                <boxGeometry args={[room.depth, 0.18, roomWidth]} />
                <meshStandardMaterial
                    color="#9b958c"
                    emissive="#403a34"
                    emissiveIntensity={0.38}
                    roughness={0.92}
                />
            </mesh>
            <mesh position={[outerWallX, 2.9, room.centerZ]}>
                <boxGeometry args={[wallThickness, 5.8, roomWidth]} />
                <meshStandardMaterial color={ROOM_PAINT} roughness={0.92} />
            </mesh>
            {[-1, 1].map(direction => (
                <mesh key={direction} position={[room.centerX, 2.9, room.centerZ + direction * (roomWidth / 2)]}>
                    <boxGeometry args={[room.depth, 5.8, wallThickness]} />
                    <meshStandardMaterial color={ROOM_PAINT} roughness={0.92} />
                </mesh>
            ))}
            {room.benches.map(bench => <Bench key={bench.id} bench={bench} />)}
            {room.paintings.map(painting => (
                <Painting key={painting.id} painting={painting} active={active} />
            ))}
            {active && [0.22, 0.5, 0.78].map((fraction) => {
                const x = room.innerX + ((room.outerX - room.innerX) * fraction)
                return (
                    <group key={fraction} position={[x, 5.56, room.centerZ]}>
                        <mesh rotation={[-Math.PI / 2, 0, 0]}>
                            <planeGeometry args={[1.35, 0.34]} />
                            <meshBasicMaterial color="#ffe4b9" toneMapped={false} />
                        </mesh>
                        <pointLight
                            position={[0, -0.25, 0]}
                            intensity={8.5}
                            distance={7}
                            decay={2}
                            color="#ffddb0"
                        />
                    </group>
                )
            })}
        </group>
    )
}

function MainHall({ layout, activeRoomIds }) {
    const hallCenterZ = (MUSEUM_DIMENSIONS.lobbyFrontZ + layout.hallBackZ) / 2
    const bayCount = Math.max(1, Math.ceil(layout.rooms.length / 2))
    const bays = Array.from({ length: bayCount }, (_, index) => ({
        centerZ: MUSEUM_DIMENSIONS.firstBayZ - (index * MUSEUM_DIMENSIONS.baySpacing),
        left: layout.rooms.find(room => room.bay === index && room.side === -1),
        right: layout.rooms.find(room => room.bay === index && room.side === 1),
    }))
    const activeRooms = useMemo(() => new Set(activeRoomIds), [activeRoomIds])

    return (
        <group>
            <mesh position={[0, -0.14, hallCenterZ]}>
                <boxGeometry args={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, 0.28, layout.hallLength]} />
                <meshStandardMaterial color={FLOOR} roughness={0.7} />
            </mesh>
            <mesh position={[0, -0.04, hallCenterZ]}>
                <boxGeometry args={[3.25, 0.035, layout.hallLength - 0.7]} />
                <meshStandardMaterial color="#4a4036" roughness={0.88} />
            </mesh>
            <VaultedCeiling layout={layout} centerZ={hallCenterZ} />
            {[-1, 1].map(side => (
                <mesh key={side} position={[
                    side * MUSEUM_DIMENSIONS.hallHalfWidth,
                    MUSEUM_DIMENSIONS.hallHeight / 2,
                    MUSEUM_DIMENSIONS.lobbyFrontZ / 2,
                ]}>
                    <boxGeometry args={[0.24, MUSEUM_DIMENSIONS.hallHeight, MUSEUM_DIMENSIONS.lobbyFrontZ]} />
                    <meshStandardMaterial color={HALL_PAINT} roughness={0.96} />
                </mesh>
            ))}
            {bays.map(bay => (
                <group key={bay.centerZ}>
                    <DoorWall side={-1} centerZ={bay.centerZ} room={bay.left} />
                    <DoorWall side={1} centerZ={bay.centerZ} room={bay.right} />
                </group>
            ))}
            <mesh position={[0, MUSEUM_DIMENSIONS.hallHeight / 2, layout.hallBackZ]}>
                <boxGeometry args={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, MUSEUM_DIMENSIONS.hallHeight, 0.24]} />
                <meshStandardMaterial color={HALL_PAINT} roughness={0.9} />
            </mesh>
            <mesh position={layout.desk.position}>
                <boxGeometry args={layout.desk.size} />
                <meshStandardMaterial color="#382a20" roughness={0.62} />
            </mesh>
            <LabelPlane
                title="Ian Truong Photography"
                subtitle="Welcome · Explore every room"
                position={[0, 1.36, layout.desk.position[2] + 0.59]}
                size={[3.45, 0.86]}
            />
            {layout.rooms.map(room => (
                <CategoryRoom key={room.id} room={room} active={activeRooms.has(room.id)} />
            ))}
            {Array.from({ length: Math.ceil(layout.hallLength / 10) }, (_, index) => {
                const z = MUSEUM_DIMENSIONS.lobbyFrontZ - 3 - (index * 10)
                return (
                    <rectAreaLight
                        key={z}
                        position={[0, 5.55, z]}
                        rotation={[-Math.PI / 2, 0, 0]}
                        width={4.6}
                        height={1.5}
                        intensity={3.2}
                        color="#ffddb1"
                    />
                )
            })}
        </group>
    )
}

function focusedPainting(layout, camera) {
    const direction = new THREE.Vector3()
    camera.getWorldDirection(direction)
    let best = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const painting of layout.rooms.flatMap(room => room.paintings)) {
        const target = new THREE.Vector3(...painting.position)
        const distance = target.distanceTo(camera.position)
        if (distance > 4.6) continue
        const toward = target.sub(camera.position).normalize()
        const alignment = direction.dot(toward)
        if (alignment < 0.8) continue
        const score = distance + ((1 - alignment) * 7)
        if (score < bestScore) {
            best = painting
            bestScore = score
        }
    }
    return best
}

function PlayerController({ layout, enabled, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
    const { camera } = useThree()
    const keys = useRef(new Set())
    const lastRoom = useRef(null)
    const lastNearbyRooms = useRef('')
    const lastFocused = useRef(null)
    const lastSavedAt = useRef(0)

    useEffect(() => {
        const restored = safeSessionPosition(layout.spawn)
        camera.position.set(restored.x, layout.spawn[1], restored.z)
        camera.lookAt(restored.x, layout.spawn[1], restored.z - 1)
    }, [camera, layout])

    useEffect(() => {
        const onKeyDown = (event) => {
            keys.current.add(event.code)
            if (event.code === 'KeyE' && enabled) {
                const painting = focusedPainting(layout, camera)
                if (painting) onOpenAlbum(painting.album)
            }
        }
        const onKeyUp = event => keys.current.delete(event.code)
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('keyup', onKeyUp)
        return () => {
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('keyup', onKeyUp)
        }
    }, [camera, enabled, layout, onOpenAlbum])

    useFrame((state, frameDelta) => {
        if (!enabled) return
        const delta = Math.min(frameDelta, 0.05)
        const speed = keys.current.has('ShiftLeft') || keys.current.has('ShiftRight') ? 5.3 : 3.25
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
        forward.y = 0
        forward.normalize()
        const axes = museumPlanarAxes(forward.x, forward.z)
        const right = new THREE.Vector3(axes.right.x, 0, axes.right.z)
        const movement = new THREE.Vector3()
        if (keys.current.has('KeyW') || keys.current.has('ArrowUp')) movement.add(forward)
        if (keys.current.has('KeyS') || keys.current.has('ArrowDown')) movement.sub(forward)
        if (keys.current.has('KeyD') || keys.current.has('ArrowRight')) movement.add(right)
        if (keys.current.has('KeyA') || keys.current.has('ArrowLeft')) movement.sub(right)
        if (movement.lengthSq()) {
            movement.normalize().multiplyScalar(speed * delta)
            const next = moveMuseumPosition(
                layout,
                { x: camera.position.x, z: camera.position.z },
                { x: movement.x, z: movement.z },
            )
            camera.position.x = next.x
            camera.position.z = next.z
        }
        camera.position.y = layout.spawn[1]

        const room = nearestMuseumRoom(layout, { x: camera.position.x, z: camera.position.z })
        if (room !== lastRoom.current) {
            lastRoom.current = room
            onActiveRoom(room)
        }
        const nearbyRooms = nearbyMuseumRoomIds(layout, { x: camera.position.x, z: camera.position.z })
        const nearbyKey = nearbyRooms.join('|')
        if (nearbyKey !== lastNearbyRooms.current) {
            lastNearbyRooms.current = nearbyKey
            onNearbyRooms(nearbyRooms)
        }
        const focused = focusedPainting(layout, camera)
        if (focused?.id !== lastFocused.current?.id) {
            lastFocused.current = focused
            onFocusedPainting(focused)
        }
        if (state.clock.elapsedTime - lastSavedAt.current > 0.8) {
            lastSavedAt.current = state.clock.elapsedTime
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({
                x: camera.position.x,
                z: camera.position.z,
            }))
        }
    })

    return null
}

function MuseumScene({ layout, controlsEnabled, visualPreview, onLock, onUnlock, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
    return (
        <>
            <color attach="background" args={[INK]} />
            <fog attach="fog" args={[INK, 20, 105]} />
            <ambientLight intensity={0.42} color="#f2e7d7" />
            <hemisphereLight args={['#f5e9d6', '#211d19', 0.82]} />
            <directionalLight position={[3, 10, 8]} intensity={1.15} color="#fff1d8" />
            <MainHall layout={layout} activeRoomIds={controlsEnabled.activeRoomIds} />
            {!visualPreview && (
                <>
                    <PlayerController
                        layout={layout}
                        enabled={controlsEnabled.locked}
                        onActiveRoom={onActiveRoom}
                        onNearbyRooms={onNearbyRooms}
                        onFocusedPainting={onFocusedPainting}
                        onOpenAlbum={onOpenAlbum}
                    />
                    <PointerLockControls selector="#museum-enter" onLock={onLock} onUnlock={onUnlock} />
                </>
            )}
            <AdaptiveDpr pixelated />
            <Preload all={false} />
        </>
    )
}

function CatalogStatus({ error, onRetry }) {
    return (
        <div className="museum-loading museum-loading--error" role="alert">
            <span className="museum-loading-mark">IT</span>
            <h1>The gallery could not open</h1>
            <p>{error}</p>
            <button type="button" onClick={onRetry}>Try again</button>
            <Link to="/explore" state={{ restoreExploreScroll: true }}>Back to Explore</Link>
        </div>
    )
}

export default function ImmersiveGalleryDesktop() {
    const navigate = useNavigate()
    const [albums, setAlbums] = useState(null)
    const [error, setError] = useState('')
    const [loadVersion, setLoadVersion] = useState(0)
    const [locked, setLocked] = useState(false)
    const [activeRoomId, setActiveRoomId] = useState(null)
    const [activeRoomIds, setActiveRoomIds] = useState([])
    const [focused, setFocused] = useState(null)

    useEffect(() => {
        const controller = new AbortController()
        fetchAllAlbums({ type: 'photo', limit: 100 }, { signal: controller.signal })
            .then(setAlbums)
            .catch((cause) => {
                if (cause?.name !== 'AbortError') setError(cause?.message || 'The photo catalog is unavailable.')
            })
        return () => controller.abort()
    }, [loadVersion])

    const catalog = useMemo(() => buildMuseumCatalog(albums || []), [albums])
    const layout = useMemo(() => buildMuseumLayout(catalog), [catalog])
    const visualPreview = import.meta.env.DEV
        && new URLSearchParams(window.location.search).get('museum-preview') === 'room'
    const renderedActiveRoomIds = visualPreview
        ? layout.rooms.filter(room => room.bay === 0).map(room => room.id)
        : activeRoomIds
    const openAlbum = useCallback((album) => {
        sessionStorage.setItem('ian-photography-museum-return', 'true')
        navigate(`/album/${encodeURIComponent(album.albumId)}`, { state: { fromImmersiveGallery: true } })
    }, [navigate])

    if (error) return <CatalogStatus error={error} onRetry={() => {
        setError('')
        setAlbums(null)
        setLoadVersion(value => value + 1)
    }} />
    if (!albums) return <div className="museum-loading" role="status"><span className="museum-loading-mark">IT</span><p>Hanging the collection…</p></div>
    if (!catalog.length) return <CatalogStatus error="There are no public photo albums to display yet." onRetry={() => setLoadVersion(value => value + 1)} />

    return (
        <div className="museum-experience" aria-label="Ian Truong Photography immersive gallery">
            <Canvas
                className="museum-canvas"
                camera={visualPreview
                    ? { fov: 62, near: 0.08, far: 180, position: [0.2, 2.1, MUSEUM_DIMENSIONS.firstBayZ], rotation: [0, -Math.PI / 2, 0] }
                    : { fov: 66, near: 0.08, far: 180, position: layout.spawn }}
                dpr={[0.75, 1.5]}
                gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
                onCreated={({ gl }) => {
                    gl.outputColorSpace = THREE.SRGBColorSpace
                    gl.toneMapping = THREE.ACESFilmicToneMapping
                    gl.toneMappingExposure = 1.08
                }}
            >
                <MuseumScene
                    layout={layout}
                    controlsEnabled={{ locked, activeRoomIds: renderedActiveRoomIds }}
                    visualPreview={visualPreview}
                    onLock={() => setLocked(true)}
                    onUnlock={() => setLocked(false)}
                    onActiveRoom={setActiveRoomId}
                    onNearbyRooms={setActiveRoomIds}
                    onFocusedPainting={setFocused}
                    onOpenAlbum={openAlbum}
                />
            </Canvas>
            <div className="museum-topbar">
                <Link to="/explore" state={{ restoreExploreScroll: true }}>← Exit gallery</Link>
                <div>
                    <strong>Ian Truong Photography</strong>
                    <span>{catalog.length} rooms · {catalog.reduce((sum, category) => sum + category.albums.length, 0)} albums</span>
                </div>
            </div>
            <div className="museum-crosshair" aria-hidden="true" />
            {focused && locked && (
                <div className="museum-interaction" role="status">
                    <span>E</span>
                    <p>Open <strong>{focused.album.title}</strong></p>
                </div>
            )}
            <div className="museum-controls-legend" aria-hidden="true">
                <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move</span>
                <span><kbd>Mouse</kbd> Look</span>
                <span><kbd>Shift</kbd> Walk faster</span>
                <span><kbd>Esc</kbd> Pause</span>
            </div>
            {!locked && !visualPreview && (
                <div className="museum-entry-panel">
                    <span className="museum-entry-number">The virtual archive</span>
                    <h1>{activeRoomId ? 'Gallery paused' : 'Enter the gallery'}</h1>
                    <p>
                        Walk through rooms generated from the live photography archive. Look toward a framed album and press E to open it.
                    </p>
                    <button id="museum-enter" type="button">{activeRoomId ? 'Continue exploring' : 'Begin walk-through'}</button>
                    <div><kbd>WASD</kbd> to move · <kbd>Mouse</kbd> to look · <kbd>Esc</kbd> to pause</div>
                </div>
            )}
        </div>
    )
}
