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
    nearestMuseumRoom,
} from '../utils/museumLayout'

const SESSION_KEY = 'ian-photography-museum-position-v1'
const HALL_PAINT = '#d8cfc0'
const ROOM_PAINT = '#cfc4b3'
const FLOOR = '#332d28'
const GOLD = '#9b7541'
const INK = '#1a1714'

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

async function optimizedCoverUrl(album) {
    const srcSet = await albumCoverPreviewSrcSet(album).catch(() => '')
    const smallest = srcSet.split(',')[0]?.trim().split(/\s+/)[0]
    return smallest || album.coverThumbnailUrl || album.coverImageUrl || ''
}

function useCoverTexture(album, active) {
    const [loaded, setLoaded] = useState(null)

    useEffect(() => {
        let cancelled = false
        let loadedTexture = null
        let image = null
        if (!active) return undefined

        optimizedCoverUrl(album).then((url) => {
            if (!url || cancelled) return
            image = new Image()
            image.crossOrigin = 'anonymous'
            image.decoding = 'async'
            image.onload = () => {
                if (cancelled) return
                loadedTexture = new THREE.Texture(image)
                loadedTexture.colorSpace = THREE.SRGBColorSpace
                loadedTexture.minFilter = THREE.LinearMipmapLinearFilter
                loadedTexture.magFilter = THREE.LinearFilter
                loadedTexture.generateMipmaps = true
                loadedTexture.needsUpdate = true
                setLoaded({ albumId: album.albumId, texture: loadedTexture })
            }
            image.src = url
        })

        return () => {
            cancelled = true
            if (image) image.onload = null
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
                    map={texture}
                    color={texture ? '#ffffff' : '#4d453d'}
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

function DoorWall({ side, centerZ, room }) {
    const wallX = side * MUSEUM_DIMENSIONS.hallHalfWidth
    const thickness = 0.24
    const baySpan = MUSEUM_DIMENSIONS.baySpacing
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2

    if (!room) {
        return (
            <mesh position={[wallX, MUSEUM_DIMENSIONS.hallHeight / 2, centerZ]}>
                <boxGeometry args={[thickness, MUSEUM_DIMENSIONS.hallHeight, baySpan]} />
                <meshStandardMaterial color={HALL_PAINT} roughness={0.9} />
            </mesh>
        )
    }

    const doorway = 3.45
    const doorHeight = 4.35
    const panel = (baySpan - doorway) / 2
    return (
        <group>
            {[-1, 1].map(direction => (
                <mesh
                    key={direction}
                    position={[wallX, MUSEUM_DIMENSIONS.hallHeight / 2, centerZ + direction * (doorway / 2 + panel / 2)]}
                >
                    <boxGeometry args={[thickness, MUSEUM_DIMENSIONS.hallHeight, panel]} />
                    <meshStandardMaterial color={HALL_PAINT} roughness={0.9} />
                </mesh>
            ))}
            <mesh position={[wallX, doorHeight + ((MUSEUM_DIMENSIONS.hallHeight - doorHeight) / 2), centerZ]}>
                <boxGeometry args={[thickness, MUSEUM_DIMENSIONS.hallHeight - doorHeight, doorway]} />
                <meshStandardMaterial color={HALL_PAINT} roughness={0.9} />
            </mesh>
            <mesh position={[wallX - (side * 0.08), doorHeight - 0.03, centerZ]} rotation={[0, Math.PI / 2, 0]}>
                <torusGeometry args={[doorway / 2, 0.13, 8, 32, Math.PI]} />
                <meshStandardMaterial color={GOLD} metalness={0.42} roughness={0.5} />
            </mesh>
            <LabelPlane
                title={room.name}
                subtitle={`${room.albums.length} ${room.albums.length === 1 ? 'album' : 'albums'}`}
                position={[wallX - (side * 0.15), 5.15, centerZ]}
                rotation={[0, rotationY, 0]}
                size={[3.25, 0.82]}
            />
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
            <mesh position={[room.centerX, 5.25, room.centerZ]}>
                <boxGeometry args={[room.depth, 0.18, roomWidth]} />
                <meshStandardMaterial color="#b5aa9a" roughness={0.92} />
            </mesh>
            <mesh position={[outerWallX, 2.6, room.centerZ]}>
                <boxGeometry args={[wallThickness, 5.2, roomWidth]} />
                <meshStandardMaterial color={ROOM_PAINT} roughness={0.92} />
            </mesh>
            {[-1, 1].map(direction => (
                <mesh key={direction} position={[room.centerX, 2.6, room.centerZ + direction * (roomWidth / 2)]}>
                    <boxGeometry args={[room.depth, 5.2, wallThickness]} />
                    <meshStandardMaterial color={ROOM_PAINT} roughness={0.92} />
                </mesh>
            ))}
            {room.benches.map(bench => <Bench key={bench.id} bench={bench} />)}
            {room.paintings.map(painting => (
                <Painting key={painting.id} painting={painting} active={active} />
            ))}
            {active && [0.22, 0.5, 0.78].map((fraction, index) => (
                <pointLight
                    key={fraction}
                    position={[
                        room.innerX + ((room.outerX - room.innerX) * fraction),
                        4.4,
                        room.centerZ,
                    ]}
                    intensity={index === 1 ? 11 : 8}
                    distance={8}
                    decay={2}
                    color="#ffdca9"
                />
            ))}
        </group>
    )
}

function MainHall({ layout, activeRoomId }) {
    const hallCenterZ = (MUSEUM_DIMENSIONS.lobbyFrontZ + layout.hallBackZ) / 2
    const bayCount = Math.max(1, Math.ceil(layout.rooms.length / 2))
    const bays = Array.from({ length: bayCount }, (_, index) => ({
        centerZ: MUSEUM_DIMENSIONS.firstBayZ - (index * MUSEUM_DIMENSIONS.baySpacing),
        left: layout.rooms.find(room => room.bay === index && room.side === -1),
        right: layout.rooms.find(room => room.bay === index && room.side === 1),
    }))
    const ribCount = Math.ceil(layout.hallLength / 5)

    return (
        <group>
            <mesh position={[0, -0.14, hallCenterZ]}>
                <boxGeometry args={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, 0.28, layout.hallLength]} />
                <meshStandardMaterial color={FLOOR} roughness={0.7} />
            </mesh>
            <mesh position={[0, MUSEUM_DIMENSIONS.hallHeight + 0.1, hallCenterZ]}>
                <boxGeometry args={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, 0.2, layout.hallLength]} />
                <meshStandardMaterial color="#b9ae9e" roughness={0.95} />
            </mesh>
            {Array.from({ length: ribCount }, (_, index) => {
                const z = MUSEUM_DIMENSIONS.lobbyFrontZ - 1.5 - (index * 5)
                return (
                    <mesh key={z} position={[0, MUSEUM_DIMENSIONS.hallHeight - MUSEUM_DIMENSIONS.hallHalfWidth + 0.35, z]}>
                        <torusGeometry args={[MUSEUM_DIMENSIONS.hallHalfWidth - 0.18, 0.085, 8, 48, Math.PI]} />
                        <meshStandardMaterial color="#a78c70" roughness={0.66} metalness={0.12} />
                    </mesh>
                )
            })}
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
                <CategoryRoom key={room.id} room={room} active={activeRoomId === room.id} />
            ))}
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

function PlayerController({ layout, enabled, onActiveRoom, onFocusedPainting, onOpenAlbum }) {
    const { camera } = useThree()
    const keys = useRef(new Set())
    const lastRoom = useRef(null)
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
        const right = new THREE.Vector3(forward.z, 0, -forward.x)
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

function MuseumScene({ layout, controlsEnabled, onLock, onUnlock, onActiveRoom, onFocusedPainting, onOpenAlbum }) {
    return (
        <>
            <color attach="background" args={[INK]} />
            <fog attach="fog" args={[INK, 14, 85]} />
            <hemisphereLight args={['#f3e3c7', '#1f1b18', 1.7]} />
            <directionalLight position={[2, 9, 7]} intensity={2.2} color="#ffe4bd" />
            <MainHall layout={layout} activeRoomId={controlsEnabled.activeRoomId} />
            <PlayerController
                layout={layout}
                enabled={controlsEnabled.locked}
                onActiveRoom={onActiveRoom}
                onFocusedPainting={onFocusedPainting}
                onOpenAlbum={onOpenAlbum}
            />
            <PointerLockControls selector="#museum-enter" onLock={onLock} onUnlock={onUnlock} />
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
                camera={{ fov: 66, near: 0.08, far: 180, position: layout.spawn }}
                dpr={[0.75, 1.5]}
                gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
            >
                <MuseumScene
                    layout={layout}
                    controlsEnabled={{ locked, activeRoomId }}
                    onLock={() => setLocked(true)}
                    onUnlock={() => setLocked(false)}
                    onActiveRoom={setActiveRoomId}
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
            {!locked && (
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
