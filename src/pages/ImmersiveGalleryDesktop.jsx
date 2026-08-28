/* eslint-disable react-hooks/immutability -- Three.js cameras are intentionally mutable scene objects. */
import { AdaptiveDpr } from '@react-three/drei/core/AdaptiveDpr.js'
import { PointerLockControls } from '@react-three/drei/core/PointerLockControls.js'
import { Preload } from '@react-three/drei/core/Preload.js'
import { useTexture } from '@react-three/drei/core/Texture.js'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import * as THREE from 'three'
import { fetchAllAlbums } from '../utils/api'
import { albumCoverPreviewSrcSet } from '../utils/mediaUrls'
import {
    buildMuseumCatalog,
    buildMuseumLayout,
    isMuseumPositionWalkable,
    MUSEUM_DIMENSIONS,
    moveMuseumPosition,
    museumPlanarAxes,
    nearbyMuseumRoomIds,
    nearestMuseumRoom,
} from '../utils/museumLayout'

const SESSION_KEY = 'ian-photography-museum-position-v2'
const RETURN_KEY = 'ian-photography-museum-return'
const HALL_PAINT = '#fffaf1'
const ROOM_PAINT = '#f6f0e7'
const GOLD = '#9b7747'
const INK = '#171411'
const TEXTURE_ROOT = '/assets/museum/textures'

function safeSessionPosition(layout) {
    try {
        const value = JSON.parse(sessionStorage.getItem(SESSION_KEY))
        if (
            Number.isFinite(value?.x)
            && Number.isFinite(value?.z)
            && isMuseumPositionWalkable(layout, value.x, value.z)
        ) return value
    } catch {
        // A fresh spawn is preferable to blocking the gallery on corrupt local state.
    }
    return { x: layout.spawn[0], z: layout.spawn[2] }
}

function configureTexture(source, { color = false, repeat = [1, 1] } = {}) {
    const texture = source.clone()
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(...repeat)
    texture.anisotropy = 4
    if (color) texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    return texture
}

function useMuseumMaterials() {
    const sources = useTexture({
        plasterColor: `${TEXTURE_ROOT}/white_plaster_02_diff_1k.jpg`,
        woodColor: `${TEXTURE_ROOT}/wood_floor_diff_1k.jpg`,
    })
    const materials = useMemo(() => ({
        plaster: {
            map: configureTexture(sources.plasterColor, { color: true, repeat: [5, 3] }),
        },
        floor: {
            map: configureTexture(sources.woodColor, { color: true, repeat: [11, 5] }),
        },
        joinery: {
            map: configureTexture(sources.woodColor, { color: true, repeat: [2, 1] }),
        },
    }), [sources])

    useEffect(() => () => {
        Object.values(materials).forEach(material => Object.values(material).forEach(texture => texture.dispose()))
    }, [materials])
    return materials
}

function PlasterMaterial({ materials, color = HALL_PAINT, side, roughness = 0.88, textured = true }) {
    return (
        <meshStandardMaterial
            {...(textured ? materials.plaster : {})}
            color={color}
            roughness={roughness}
            side={side}
        />
    )
}

function FloorMaterial({ materials, color = '#8b6948' }) {
    return (
        <meshStandardMaterial
            {...materials.floor}
            color={color}
            roughness={0.62}
        />
    )
}

function WoodMaterial({ materials, color = '#6f4d31', roughness = 0.55 }) {
    return (
        <meshStandardMaterial
            {...materials.joinery}
            color={color}
            roughness={roughness}
        />
    )
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
            <meshBasicMaterial map={texture} toneMapped={false} side={THREE.DoubleSide} />
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
        album.coverThumbnailUrl,
        previews[0],
        previews[1],
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

function ArtworkSpotlight() {
    const light = useRef(null)
    const target = useRef(null)

    useEffect(() => {
        if (light.current && target.current) light.current.target = target.current
    }, [])

    return (
        <>
            <spotLight
                ref={light}
                position={[0, 2.55, 2.25]}
                color="#fff0d2"
                intensity={62}
                distance={7.5}
                decay={2}
                angle={0.5}
                penumbra={0.82}
            />
            <object3D ref={target} position={[0, 0, 0.12]} />
        </>
    )
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
            <mesh position={[0, -0.04, -0.08]}>
                <boxGeometry args={[4.15, 4.45, 0.08]} />
                <meshStandardMaterial color="#c8c0b3" roughness={0.93} />
            </mesh>
            <mesh castShadow>
                <boxGeometry args={[3.24, 2.34, 0.14]} />
                <meshPhysicalMaterial
                    color={GOLD}
                    roughness={0.3}
                    metalness={0.66}
                    clearcoat={0.25}
                    clearcoatRoughness={0.5}
                />
            </mesh>
            <mesh position={[0, 0, 0.1]}>
                <boxGeometry args={[3, 2.1, 0.08]} />
                <meshStandardMaterial color="#f7f2e8" roughness={0.72} />
            </mesh>
            <mesh position={[0, 0, 0.155]}>
                <planeGeometry args={[2.66, 1.76]} />
                <meshStandardMaterial
                    map={texture || placeholder}
                    color="#ffffff"
                    roughness={0.67}
                />
            </mesh>
            <mesh position={[0, -1.55, 0.13]}>
                <planeGeometry args={[2.9, 0.62]} />
                <meshBasicMaterial map={plaque} toneMapped={false} />
            </mesh>
            <mesh position={[0, 1.72, 0.28]} rotation={[0.16, 0, 0]}>
                <boxGeometry args={[1.45, 0.08, 0.11]} />
                <meshStandardMaterial color="#8a7356" metalness={0.45} roughness={0.46} />
            </mesh>
            {active && <ArtworkSpotlight />}
        </group>
    )
}

function Bench({ bench, materials }) {
    return (
        <group position={bench.position}>
            <mesh castShadow>
                <boxGeometry args={bench.size} />
                <WoodMaterial materials={materials} color="#5f422d" roughness={0.5} />
            </mesh>
            {[-0.55, 0.55].map(x => (
                <mesh key={x} position={[x, -0.37, 0]} castShadow>
                    <boxGeometry args={[0.13, 0.58, 2.55]} />
                    <meshStandardMaterial color="#2f2923" metalness={0.25} roughness={0.54} />
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
        const springHeight = 2.7
        const archRise = 1.55
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
        const springHeight = 2.7
        const archRise = 1.55
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

function DoorWall({ side, centerZ, room, materials }) {
    const wallX = side * MUSEUM_DIMENSIONS.hallHalfWidth
    const thickness = 0.3
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    const wallShape = useArchedWallShape(Boolean(room))
    const archCurve = useArchTrimCurve()
    const archRadius = MUSEUM_DIMENSIONS.doorwayWidth / 2
    const panelOffset = (archRadius + (MUSEUM_DIMENSIONS.baySpacing / 2)) / 2
    const panelWidth = ((MUSEUM_DIMENSIONS.baySpacing / 2) - archRadius) - 0.7

    return (
        <group>
            <mesh position={[wallX, 0, centerZ]} rotation={[0, Math.PI / 2, 0]}>
                <shapeGeometry args={[wallShape, 48]} />
                <PlasterMaterial materials={materials} color={HALL_PAINT} side={THREE.DoubleSide} />
            </mesh>
            {[-1, 1].map(direction => (
                <group
                    key={`panel-${direction}`}
                    position={[wallX - (side * 0.135), 1.42, centerZ + (direction * panelOffset)]}
                >
                    <mesh>
                        <boxGeometry args={[0.07, 1.92, panelWidth]} />
                        <meshStandardMaterial color="#c8bba8" roughness={0.78} />
                    </mesh>
                    <mesh position={[-side * 0.042, 0, 0]}>
                        <boxGeometry args={[0.075, 1.62, panelWidth - 0.3]} />
                        <meshStandardMaterial color="#e0d7ca" roughness={0.84} />
                    </mesh>
                    <mesh position={[0, -1.15, 0]}>
                        <boxGeometry args={[0.11, 0.25, panelWidth + 0.16]} />
                        <meshStandardMaterial color="#9d8c75" roughness={0.7} />
                    </mesh>
                </group>
            ))}
            {room && (
                <>
                    <mesh
                        position={[wallX - (side * (thickness / 2)), 0, centerZ]}
                        rotation={[0, rotationY, 0]}
                    >
                        <tubeGeometry args={[archCurve, 64, 0.13, 12, false]} />
                        <meshStandardMaterial color="#c9bda9" roughness={0.72} />
                    </mesh>
                    {[-1, 1].map(direction => (
                        <group key={direction} position={[wallX, 1.42, centerZ + direction * (archRadius + 0.18)]}>
                            <mesh>
                                <boxGeometry args={[0.42, 2.84, 0.34]} />
                                <meshStandardMaterial color="#c9bda9" roughness={0.76} />
                            </mesh>
                            <mesh position={[0, 1.48, 0]}>
                                <boxGeometry args={[0.49, 0.16, 0.52]} />
                                <meshStandardMaterial color="#b9aa94" roughness={0.7} />
                            </mesh>
                            <mesh position={[0, -1.47, 0]}>
                                <boxGeometry args={[0.5, 0.16, 0.54]} />
                                <meshStandardMaterial color="#b9aa94" roughness={0.7} />
                            </mesh>
                        </group>
                    ))}
                    <LabelPlane
                        title={room.name}
                        subtitle={`${room.albums.length} ${room.albums.length === 1 ? 'album' : 'albums'}`}
                        position={[wallX - (side * 0.18), 4.64, centerZ]}
                        rotation={[0, rotationY, 0]}
                        size={[3.3, 0.56]}
                    />
                </>
            )}
        </group>
    )
}

function VaultedCeiling({ layout, centerZ, materials }) {
    const { panels, ribCurve } = useMemo(() => {
        const radius = 6.35
        const centerY = 0.85
        const start = Math.acos(MUSEUM_DIMENSIONS.hallHalfWidth / radius)
        const end = Math.PI - start
        const count = 24
        const step = (end - start) / count
        const nextPanels = Array.from({ length: count }, (_, index) => {
            const angle = start + ((index + 0.5) * step)
            return {
                angle,
                x: radius * Math.cos(angle),
                y: centerY + (radius * Math.sin(angle)),
                width: (radius * step) * 1.025,
            }
        })
        const points = Array.from({ length: 49 }, (_, index) => {
            const angle = start + ((index / 48) * (end - start))
            return new THREE.Vector3(radius * Math.cos(angle), centerY + radius * Math.sin(angle), 0)
        })
        return {
            panels: nextPanels,
            ribCurve: new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5),
        }
    }, [])
    const ribZs = useMemo(() => {
        const values = [MUSEUM_DIMENSIONS.lobbyFrontZ - 0.3]
        for (let z = MUSEUM_DIMENSIONS.firstBayZ + (MUSEUM_DIMENSIONS.baySpacing / 2); z > layout.hallBackZ; z -= MUSEUM_DIMENSIONS.baySpacing) {
            values.push(z)
        }
        values.push(layout.hallBackZ + 0.3)
        return values
    }, [layout.hallBackZ])

    return (
        <group>
            {panels.map(panel => (
                <mesh
                    key={panel.angle}
                    position={[panel.x, panel.y, centerZ]}
                    rotation={[0, 0, panel.angle + (Math.PI / 2)]}
                >
                    <boxGeometry args={[panel.width, 0.16, layout.hallLength]} />
                    <PlasterMaterial materials={materials} color="#e8e1d5" roughness={0.92} textured={false} />
                </mesh>
            ))}
            {ribZs.map(z => (
                <mesh key={z} position={[0, 0, z]}>
                    <tubeGeometry args={[ribCurve, 72, 0.075, 8, false]} />
                    <meshStandardMaterial color="#b9ab97" roughness={0.7} />
                </mesh>
            ))}
            {[-1, 1].map(side => (
                <mesh key={side} position={[side * (MUSEUM_DIMENSIONS.hallHalfWidth - 0.06), 4.98, centerZ]}>
                    <boxGeometry args={[0.16, 0.22, layout.hallLength]} />
                    <meshStandardMaterial color="#b8aa95" roughness={0.72} />
                </mesh>
            ))}
        </group>
    )
}

function CategoryRoom({ room, active, materials }) {
    const roomWidth = room.width
    const outerWallX = room.outerX
    const wallThickness = 0.24
    const ceilingY = 6.15
    const rowXs = useMemo(() => [...new Set(room.paintings.map(painting => painting.position[0]))], [room.paintings])
    const endRotation = room.side < 0 ? Math.PI / 2 : -Math.PI / 2
    return (
        <group>
            <mesh position={[room.centerX, -0.11, room.centerZ]} receiveShadow>
                <boxGeometry args={[room.depth, 0.22, roomWidth]} />
                <FloorMaterial materials={materials} color="#c7a47d" />
            </mesh>
            <mesh position={[room.centerX, ceilingY, room.centerZ]}>
                <boxGeometry args={[room.depth, 0.18, roomWidth]} />
                <PlasterMaterial materials={materials} color="#e9e2d8" textured={false} />
            </mesh>
            <mesh position={[outerWallX, ceilingY / 2, room.centerZ]}>
                <boxGeometry args={[wallThickness, ceilingY, roomWidth]} />
                <PlasterMaterial materials={materials} color={ROOM_PAINT} />
            </mesh>
            {[-1, 1].map(direction => (
                <group key={direction}>
                    <mesh position={[room.centerX, ceilingY / 2, room.centerZ + direction * (roomWidth / 2)]}>
                        <boxGeometry args={[room.depth, ceilingY, wallThickness]} />
                        <PlasterMaterial materials={materials} color={ROOM_PAINT} />
                    </mesh>
                    <mesh position={[room.centerX, 0.16, room.centerZ + direction * ((roomWidth / 2) - 0.15)]}>
                        <boxGeometry args={[room.depth, 0.32, 0.18]} />
                        <meshStandardMaterial color="#887763" roughness={0.7} />
                    </mesh>
                    <mesh position={[room.centerX, 5.56, room.centerZ + direction * ((roomWidth / 2) - 0.16)]}>
                        <boxGeometry args={[room.depth, 0.18, 0.22]} />
                        <meshStandardMaterial color="#b9aa95" roughness={0.72} />
                    </mesh>
                    <mesh position={[room.centerX, 5.72, room.centerZ + direction * ((roomWidth / 2) - 0.48)]}>
                        <boxGeometry args={[room.depth - 0.8, 0.065, 0.08]} />
                        <meshStandardMaterial color="#433b33" metalness={0.45} roughness={0.55} />
                    </mesh>
                </group>
            ))}
            <mesh position={[outerWallX - (room.side * 0.15), 0.17, room.centerZ]}>
                <boxGeometry args={[0.18, 0.34, roomWidth]} />
                <meshStandardMaterial color="#887763" roughness={0.7} />
            </mesh>
            <LabelPlane
                title={room.name}
                subtitle={`${room.albums.length} ${room.albums.length === 1 ? 'collection' : 'collections'}`}
                position={[outerWallX - (room.side * 0.16), 3.05, room.centerZ]}
                rotation={[0, endRotation, 0]}
                size={[4.6, 1.2]}
            />
            {room.benches.map(bench => <Bench key={bench.id} bench={bench} materials={materials} />)}
            {active && room.paintings.map(painting => (
                <Painting key={painting.id} painting={painting} active />
            ))}
            {rowXs.map(x => (
                <group key={x} position={[x, ceilingY - 0.12, room.centerZ]}>
                    <mesh rotation={[Math.PI / 2, 0, 0]}>
                        <circleGeometry args={[0.34, 32]} />
                        <meshBasicMaterial color="#fff1d6" toneMapped={false} />
                    </mesh>
                    {active && (
                        <pointLight
                            position={[0, -0.18, 0]}
                            intensity={24}
                            distance={8.5}
                            decay={2}
                            color="#ffe5bc"
                        />
                    )}
                </group>
            ))}
            {rowXs.map(x => (
                <mesh key={`beam-${x}`} position={[x, ceilingY - 0.16, room.centerZ]}>
                    <boxGeometry args={[0.12, 0.16, roomWidth - 0.45]} />
                    <meshStandardMaterial color="#b8aa96" roughness={0.74} />
                </mesh>
            ))}
        </group>
    )
}

function WallSconce({ side, z, active = true }) {
    const x = side * (MUSEUM_DIMENSIONS.hallHalfWidth - 0.16)
    return (
        <group position={[x, 3.75, z]}>
            <mesh>
                <boxGeometry args={[0.16, 0.46, 0.34]} />
                <meshStandardMaterial color="#6f5a42" metalness={0.58} roughness={0.4} />
            </mesh>
            <mesh position={[-side * 0.18, 0.08, 0]}>
                <sphereGeometry args={[0.2, 20, 12]} />
                <meshBasicMaterial color="#ffe9c6" toneMapped={false} />
            </mesh>
            {active && (
                <pointLight
                    position={[-side * 0.3, 0.08, 0]}
                    color="#ffd7a4"
                    intensity={16}
                    distance={5.4}
                    decay={2}
                />
            )}
        </group>
    )
}

function ReceptionDesk({ layout, materials }) {
    const [x, y, z] = layout.desk.position
    return (
        <group position={[x, y, z]}>
            <mesh castShadow>
                <boxGeometry args={layout.desk.size} />
                <WoodMaterial materials={materials} color="#5e3e27" roughness={0.46} />
            </mesh>
            <mesh position={[0, 0.76, 0]} castShadow>
                <boxGeometry args={[layout.desk.size[0] + 0.24, 0.14, layout.desk.size[2] + 0.18]} />
                <meshPhysicalMaterial color="#c7bbab" roughness={0.38} clearcoat={0.42} clearcoatRoughness={0.58} />
            </mesh>
            <mesh position={[0, 0.05, 0.68]}>
                <boxGeometry args={[3.5, 0.9, 0.04]} />
                <meshStandardMaterial color="#251f1a" roughness={0.72} />
            </mesh>
            <LabelPlane
                title="Ian Truong Photography"
                subtitle="Welcome · Explore every room"
                position={[0, 0.08, 0.715]}
                size={[3.25, 0.76]}
            />
            <rectAreaLight
                position={[0, 1.18, 0.35]}
                rotation={[-Math.PI / 2, 0, 0]}
                width={3.2}
                height={0.7}
                intensity={5}
                color="#ffe3b5"
            />
        </group>
    )
}

function LobbyEntrance({ materials }) {
    const z = MUSEUM_DIMENSIONS.lobbyFrontZ - 0.04
    return (
        <group position={[0, 0, z]}>
            {[-3.65, 3.65].map(x => (
                <mesh key={x} position={[x, 3.7, 0]}>
                    <boxGeometry args={[2.25, 7.4, 0.28]} />
                    <PlasterMaterial materials={materials} color="#d8d1c5" />
                </mesh>
            ))}
            {[-1.2, 1.2].map(x => (
                <group key={x} position={[x, 2.25, -0.03]}>
                    <mesh>
                        <boxGeometry args={[2.18, 4.5, 0.1]} />
                        <meshPhysicalMaterial
                            color="#8fa5aa"
                            transparent
                            opacity={0.26}
                            roughness={0.12}
                            metalness={0.08}
                            transmission={0.18}
                        />
                    </mesh>
                    <mesh position={[0, 0, 0.08]}>
                        <boxGeometry args={[2.28, 4.62, 0.08]} />
                        <meshStandardMaterial color="#4e4032" wireframe />
                    </mesh>
                    <mesh position={[-0.82 * Math.sign(x), 0, -0.12]}>
                        <sphereGeometry args={[0.07, 16, 12]} />
                        <meshStandardMaterial color="#af8958" metalness={0.74} roughness={0.26} />
                    </mesh>
                </group>
            ))}
            <mesh position={[0, 5.35, 0]}>
                <boxGeometry args={[5.1, 1.65, 0.28]} />
                <PlasterMaterial materials={materials} color="#d8d1c5" />
            </mesh>
            <LabelPlane
                title="The Photography Archive"
                subtitle="Est. 2026"
                position={[0, 5.4, -0.18]}
                rotation={[0, Math.PI, 0]}
                size={[4.35, 0.92]}
            />
        </group>
    )
}

function MainHall({ layout, activeRoomIds, materials }) {
    const hallCenterZ = (MUSEUM_DIMENSIONS.lobbyFrontZ + layout.hallBackZ) / 2
    const bayCount = Math.max(1, Math.ceil(layout.rooms.length / 2))
    const bays = Array.from({ length: bayCount }, (_, index) => ({
        centerZ: MUSEUM_DIMENSIONS.firstBayZ - (index * MUSEUM_DIMENSIONS.baySpacing),
        left: layout.rooms.find(room => room.bay === index && room.side === -1),
        right: layout.rooms.find(room => room.bay === index && room.side === 1),
    }))
    const activeRooms = useMemo(() => new Set(activeRoomIds), [activeRoomIds])
    const firstWallEndZ = MUSEUM_DIMENSIONS.firstBayZ + (MUSEUM_DIMENSIONS.baySpacing / 2)
    const lobbyWallLength = MUSEUM_DIMENSIONS.lobbyFrontZ - firstWallEndZ
    const lobbyWallCenterZ = firstWallEndZ + (lobbyWallLength / 2)
    const lastBayZ = bays.at(-1)?.centerZ ?? MUSEUM_DIMENSIONS.firstBayZ
    const tailFrontZ = lastBayZ - (MUSEUM_DIMENSIONS.baySpacing / 2)
    const tailLength = Math.max(0, tailFrontZ - layout.hallBackZ)
    const ceilingLights = Array.from({ length: Math.ceil(layout.hallLength / 8) }, (_, index) => (
        MUSEUM_DIMENSIONS.lobbyFrontZ - 3.3 - (index * 8)
    )).filter(z => z > layout.hallBackZ)

    return (
        <group>
            <mesh position={[0, -0.11, hallCenterZ]} receiveShadow>
                <boxGeometry args={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, 0.22, layout.hallLength]} />
                <FloorMaterial materials={materials} color="#c7a47d" />
            </mesh>
            <mesh position={[0, 0.015, hallCenterZ]}>
                <boxGeometry args={[3.05, 0.04, layout.hallLength - 0.7]} />
                <meshStandardMaterial color="#6d342e" roughness={0.94} />
            </mesh>
            <VaultedCeiling layout={layout} centerZ={hallCenterZ} materials={materials} />
            {[-1, 1].map(side => (
                <group key={side}>
                    <mesh position={[
                        side * MUSEUM_DIMENSIONS.hallHalfWidth,
                        MUSEUM_DIMENSIONS.hallHeight / 2,
                        lobbyWallCenterZ,
                    ]}>
                        <boxGeometry args={[0.24, MUSEUM_DIMENSIONS.hallHeight, lobbyWallLength]} />
                        <PlasterMaterial materials={materials} color={HALL_PAINT} />
                    </mesh>
                    {tailLength > 0 && (
                        <mesh position={[
                            side * MUSEUM_DIMENSIONS.hallHalfWidth,
                            MUSEUM_DIMENSIONS.hallHeight / 2,
                            layout.hallBackZ + (tailLength / 2),
                        ]}>
                            <boxGeometry args={[0.24, MUSEUM_DIMENSIONS.hallHeight, tailLength]} />
                            <PlasterMaterial materials={materials} color={HALL_PAINT} />
                        </mesh>
                    )}
                </group>
            ))}
            {bays.map(bay => (
                <group key={bay.centerZ}>
                    <DoorWall side={-1} centerZ={bay.centerZ} room={bay.left} materials={materials} />
                    <DoorWall side={1} centerZ={bay.centerZ} room={bay.right} materials={materials} />
                    {[-1, 1].map(side => (
                        <WallSconce key={side} side={side} z={bay.centerZ + 5.45} />
                    ))}
                </group>
            ))}
            <mesh position={[0, MUSEUM_DIMENSIONS.hallHeight / 2, layout.hallBackZ]}>
                <boxGeometry args={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, MUSEUM_DIMENSIONS.hallHeight, 0.24]} />
                <PlasterMaterial materials={materials} color={HALL_PAINT} />
            </mesh>
            <LobbyEntrance materials={materials} />
            <ReceptionDesk layout={layout} materials={materials} />
            {layout.rooms.map(room => (
                <CategoryRoom
                    key={room.id}
                    room={room}
                    active={activeRooms.has(room.id)}
                    materials={materials}
                />
            ))}
            {ceilingLights.map(z => (
                <group key={z} position={[0, 6.85, z]}>
                    <mesh rotation={[Math.PI / 2, 0, 0]}>
                        <circleGeometry args={[0.3, 32]} />
                        <meshBasicMaterial color="#fff0d3" toneMapped={false} />
                    </mesh>
                    <pointLight position={[0, -0.35, 0]} intensity={31} distance={10} decay={2} color="#ffe2b8" />
                </group>
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

function PlayerController({ layout, enabled, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
    const { camera } = useThree()
    const keys = useRef(new Set())
    const lastRoom = useRef(null)
    const lastNearbyRooms = useRef('')
    const lastFocused = useRef(null)
    const lastSavedAt = useRef(0)

    useEffect(() => {
        const returningFromAlbum = sessionStorage.getItem(RETURN_KEY) === 'true'
        sessionStorage.removeItem(RETURN_KEY)
        const restored = returningFromAlbum
            ? safeSessionPosition(layout)
            : { x: layout.spawn[0], z: layout.spawn[2] }
        camera.position.set(restored.x, layout.spawn[1], restored.z)
        if (returningFromAlbum) {
            camera.lookAt(restored.x, layout.spawn[1], restored.z - 1)
        } else {
            camera.lookAt(layout.desk.position[0], 1.55, layout.desk.position[2])
        }
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

function PreviewCamera({ mode, roomIndex, layout }) {
    const { camera } = useThree()
    useEffect(() => {
        const room = layout.rooms[roomIndex] || layout.rooms[0]
        if (mode === 'room' && room) {
            const x = room.innerX + (room.side * 4.2)
            camera.position.set(x, 2.25, room.centerZ - 4.15)
            camera.lookAt(x + (room.side * 5.5), 2.5, room.centerZ + 1.35)
        } else if (mode === 'hall') {
            camera.position.set(0, 1.95, 1.5)
            camera.lookAt(0, 2.3, MUSEUM_DIMENSIONS.firstBayZ - 14)
        } else {
            camera.position.set(...layout.spawn)
            camera.lookAt(layout.desk.position[0], 1.55, layout.desk.position[2])
        }
        camera.updateProjectionMatrix()
    }, [camera, layout, mode, roomIndex])
    return null
}

function MuseumScene({ layout, controlsEnabled, visualPreview, previewMode, previewRoomIndex, onLock, onUnlock, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
    const materials = useMuseumMaterials()
    return (
        <>
            <color attach="background" args={[INK]} />
            <fog attach="fog" args={[INK, 30, 135]} />
            <ambientLight intensity={0.46} color="#fff4e6" />
            <hemisphereLight args={['#fff5e5', '#554538', 0.66]} />
            <directionalLight
                position={[0, 9, 17]}
                intensity={2.4}
                color="#fff2dc"
                castShadow
                shadow-mapSize={[1024, 1024]}
                shadow-camera-left={-8}
                shadow-camera-right={8}
                shadow-camera-top={10}
                shadow-camera-bottom={-3}
            />
            <MainHall layout={layout} activeRoomIds={controlsEnabled.activeRoomIds} materials={materials} />
            {visualPreview && <PreviewCamera mode={previewMode} roomIndex={previewRoomIndex} layout={layout} />}
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
            <AdaptiveDpr />
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
    const previewParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null
    const previewMode = previewParams?.get('museum-preview') || ''
    const previewRoomIndex = Number.parseInt(previewParams?.get('museum-room') || '0', 10) || 0
    const visualPreview = ['lobby', 'hall', 'room'].includes(previewMode)
    const renderedActiveRoomIds = visualPreview
        ? (previewMode === 'room' ? [layout.rooms[previewRoomIndex]?.id].filter(Boolean) : [])
        : activeRoomIds
    const openAlbum = useCallback((album) => {
        sessionStorage.setItem(RETURN_KEY, 'true')
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
                camera={{ fov: 66, near: 0.08, far: 220, position: layout.spawn }}
                dpr={[0.75, 1.5]}
                shadows
                gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
                onCreated={({ gl }) => {
                    gl.outputColorSpace = THREE.SRGBColorSpace
                    gl.toneMapping = THREE.ACESFilmicToneMapping
                    gl.toneMappingExposure = 1.32
                }}
            >
                <Suspense fallback={null}>
                    <MuseumScene
                        layout={layout}
                        controlsEnabled={{ locked, activeRoomIds: renderedActiveRoomIds }}
                        visualPreview={visualPreview}
                        previewMode={previewMode}
                        previewRoomIndex={previewRoomIndex}
                        onLock={() => setLocked(true)}
                        onUnlock={() => setLocked(false)}
                        onActiveRoom={setActiveRoomId}
                        onNearbyRooms={setActiveRoomIds}
                        onFocusedPainting={setFocused}
                        onOpenAlbum={openAlbum}
                    />
                </Suspense>
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
