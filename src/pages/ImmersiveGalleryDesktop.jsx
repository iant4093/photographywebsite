/* eslint-disable react-hooks/immutability -- Three.js cameras are intentionally mutable scene objects. */
import { useTexture } from '@react-three/drei/core/Texture.js'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
    nearbyMuseumRoomIds,
    nearestMuseumRoom,
} from '../utils/museumLayout'

const SESSION_KEY = 'ian-photography-museum-position-v2'
const RETURN_KEY = 'ian-photography-museum-return'
const HALL_PAINT = '#d8d0c4'
const ROOM_PAINT = '#d2c9bc'
const GOLD = '#9b7747'
const INK = '#171411'
const TEXTURE_ROOT = '/assets/museum/textures'
const WALLPAPER_TILE_SIZE = 3.4
const HALL_WALL_THICKNESS = 0.32
const ROOM_SHELL_INSET = 0.42
const COVER_LOAD_CONCURRENCY = 4
const LOW_RES_COVER_WIDTH = 640
const MAX_LOW_RES_COVERS = 120
// The largest live bay currently contains 32 detailed covers. Keep enough
// headroom that cache eviction never disposes a texture still mounted in view.
const MAX_DETAIL_COVERS = 48
const coverTextureCache = new Map()
const coverTextureLoads = new Map()
const coverTextureReferences = new Map()
const coverLoadQueue = []
let activeCoverLoads = 0
let coverLoadSequence = 0
const MuseumDressing = lazy(() => import('../components/museum/MuseumDressing.jsx'))
function coverCacheKey(album, targetWidth) {
    return `${album.albumId}:${targetWidth}:${album.coverImageUrl || album.coverThumbnailUrl || album.coverThumbKey || ''}`
}

function cachedCoverTexture(album, targetWidth) {
    const key = coverCacheKey(album, targetWidth)
    const cached = coverTextureCache.get(key) || null
    if (cached) {
        coverTextureCache.delete(key)
        coverTextureCache.set(key, cached)
    }
    return cached
}

function trimCoverTextureCache() {
    const entries = [...coverTextureCache.entries()]
    const lowResolution = entries.filter(([key]) => Number(key.split(':')[1]) <= LOW_RES_COVER_WIDTH)
    const detail = entries.filter(([key]) => Number(key.split(':')[1]) > LOW_RES_COVER_WIDTH)
    const overflow = [
        ...lowResolution.slice(0, Math.max(0, lowResolution.length - MAX_LOW_RES_COVERS)),
        ...detail.slice(0, Math.max(0, detail.length - MAX_DETAIL_COVERS)),
    ].filter(([key]) => (coverTextureReferences.get(key) || 0) === 0)
    overflow.forEach(([key, texture]) => {
        coverTextureCache.delete(key)
        texture?.dispose()
    })
}

function usesTouchControls() {
    if (typeof window === 'undefined') return false
    return Boolean(window.matchMedia?.('(pointer: coarse)').matches)
        || (window.innerWidth < 900 && (navigator.maxTouchPoints || 0) > 0)
}

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
        wallpaperColor: `${TEXTURE_ROOT}/museum_wallpaper_albedo_512.jpg`,
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
        wallpaper: {
            map: configureTexture(sources.wallpaperColor, { color: true }),
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
            bumpMap={textured ? materials.plaster.map : null}
            bumpScale={textured ? 0.018 : 0}
            side={side}
        />
    )
}

function WallpaperMaterial({ materials, width, height, centerZ = 0, color = '#d8c8b4', side = THREE.FrontSide, shapeUv = false, phase = 0 }) {
    const map = useMemo(() => {
        const next = materials.wallpaper.map.clone()
        next.wrapS = THREE.RepeatWrapping
        next.wrapT = THREE.RepeatWrapping
        if (shapeUv) {
            next.repeat.set(1 / WALLPAPER_TILE_SIZE, 1 / WALLPAPER_TILE_SIZE)
            next.offset.set((centerZ / WALLPAPER_TILE_SIZE) + phase, phase * 0.37)
        } else {
            next.repeat.set(
                Math.max(0.35, width / WALLPAPER_TILE_SIZE),
                Math.max(0.35, height / WALLPAPER_TILE_SIZE),
            )
            next.offset.set(((centerZ - (width / 2)) / WALLPAPER_TILE_SIZE) + phase, phase * 0.37)
        }
        next.colorSpace = THREE.SRGBColorSpace
        next.anisotropy = 4
        next.needsUpdate = true
        return next
    }, [centerZ, height, materials.wallpaper.map, phase, shapeUv, width])

    useEffect(() => () => map.dispose(), [map])

    return (
        <meshStandardMaterial
            map={map}
            bumpMap={map}
            bumpScale={0.024}
            color={color}
            roughness={0.9}
            metalness={0}
            side={side}
        />
    )
}

let paintingWashTexture = null
function getPaintingWashTexture() {
    if (paintingWashTexture || typeof document === 'undefined') return paintingWashTexture
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 384
    const context = canvas.getContext('2d')
    const gradient = context.createRadialGradient(128, 52, 6, 128, 122, 218)
    gradient.addColorStop(0, 'rgba(255, 231, 193, 0.66)')
    gradient.addColorStop(0.34, 'rgba(255, 213, 161, 0.28)')
    gradient.addColorStop(0.76, 'rgba(204, 152, 100, 0.07)')
    gradient.addColorStop(1, 'rgba(120, 80, 42, 0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)
    paintingWashTexture = new THREE.CanvasTexture(canvas)
    paintingWashTexture.colorSpace = THREE.SRGBColorSpace
    paintingWashTexture.minFilter = THREE.LinearFilter
    paintingWashTexture.magFilter = THREE.LinearFilter
    paintingWashTexture.needsUpdate = true
    return paintingWashTexture
}

function WallpaperPanel({ materials, side, centerZ, width, height = MUSEUM_DIMENSIONS.hallHeight }) {
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    return (
        <mesh
            position={[
                side * (MUSEUM_DIMENSIONS.hallHalfWidth - ((HALL_WALL_THICKNESS / 2) + 0.006)),
                height / 2,
                centerZ,
            ]}
            rotation={[0, rotationY, 0]}
        >
            <planeGeometry args={[width, height]} />
            <WallpaperMaterial materials={materials} width={width} height={height} centerZ={centerZ} />
        </mesh>
    )
}

function CeilingMaterial({ materials, hallLength }) {
    const map = useMemo(() => {
        const next = materials.plaster.map.clone()
        next.wrapS = THREE.RepeatWrapping
        next.wrapT = THREE.RepeatWrapping
        next.repeat.set(3.5, Math.max(2, hallLength / 5.5))
        next.colorSpace = THREE.SRGBColorSpace
        next.anisotropy = 4
        next.needsUpdate = true
        return next
    }, [hallLength, materials.plaster.map])
    useEffect(() => () => map.dispose(), [map])
    return (
        <meshStandardMaterial
            map={map}
            bumpMap={map}
            bumpScale={0.01}
            color="#eee7dc"
            roughness={0.93}
            side={THREE.DoubleSide}
        />
    )
}

function StaticSpotlight({
    position,
    target,
    color = '#ffd4a0',
    intensity = 18,
    distance = 16,
    angle = 0.62,
    penumbra = 0.78,
    castShadow = false,
}) {
    const targetObject = useMemo(() => new THREE.Object3D(), [])
    return (
        <>
            <primitive object={targetObject} position={target} />
            <spotLight
                position={position}
                target={targetObject}
                color={color}
                intensity={intensity}
                distance={distance}
                angle={angle}
                penumbra={penumbra}
                decay={2}
                castShadow={castShadow}
                shadow-mapSize-width={512}
                shadow-mapSize-height={512}
                shadow-bias={-0.00045}
                shadow-normalBias={0.035}
                shadow-camera-near={0.8}
                shadow-camera-far={distance}
            />
        </>
    )
}

function FloorMaterial({ materials, color = '#8b6948' }) {
    return (
        <meshPhysicalMaterial
            {...materials.floor}
            bumpMap={materials.floor.map}
            bumpScale={0.012}
            color={color}
            metalness={0.025}
            roughness={0.62}
            clearcoat={0.08}
            clearcoatRoughness={0.72}
            envMapIntensity={0.14}
        />
    )
}

function WoodMaterial({ materials, color = '#6f4d31', roughness = 0.55 }) {
    return (
        <meshStandardMaterial
            {...materials.joinery}
            bumpMap={materials.joinery.map}
            bumpScale={0.008}
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
        next.generateMipmaps = true
        next.minFilter = THREE.LinearMipmapLinearFilter
        next.magFilter = THREE.LinearFilter
        next.anisotropy = 2
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

async function optimizedCoverUrls(album, targetWidth = 960) {
    const srcSet = await albumCoverPreviewSrcSet(album).catch(() => '')
    const previews = srcSet
        .split(',')
        .map((candidate) => {
            const [url, widthToken = ''] = candidate.trim().split(/\s+/)
            return { url, width: Number.parseInt(widthToken, 10) || 0 }
        })
        .filter(candidate => candidate.url)
        .sort((left, right) => (
            Math.abs(left.width - targetWidth) - Math.abs(right.width - targetWidth)
            || right.width - left.width
        ))
    return [...new Set([
        // Nearby galleries start with a fast 960px preview. Once a visitor
        // enters a room, that same frame is upgraded to the 1920px derivative.
        ...previews.map(candidate => candidate.url),
        album.coverThumbnailUrl,
        album.coverImageUrl,
    ].filter(Boolean))]
}

function runCoverLoadQueue() {
    while (activeCoverLoads < COVER_LOAD_CONCURRENCY && coverLoadQueue.length > 0) {
        // The room the visitor most recently approached should not sit behind
        // stale work left over from the previous end of the hall.
        // Detail work for the room being entered outranks background previews.
        // Within the same tier, preserve scene order so the first visible rooms
        // are never starved behind the far end of the museum.
        coverLoadQueue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
        const job = coverLoadQueue.shift()
        activeCoverLoads += 1
        const start = () => Promise.resolve().then(job.task)
        // A short stagger prevents simultaneous GPU uploads without making a
        // newly entered room wait behind the entire previous bay.
        const scheduled = new Promise(resolve => window.setTimeout(resolve, 32)).then(start)
        scheduled
            .then(job.resolve, job.reject)
            .finally(() => {
                activeCoverLoads -= 1
                runCoverLoadQueue()
            })
    }
}

function enqueueCoverLoad(task, priority = 0) {
    return new Promise((resolve, reject) => {
        coverLoadQueue.push({ task, resolve, reject, priority, sequence: coverLoadSequence++ })
        runCoverLoadQueue()
    })
}

function loadHtmlImage(url, highPriority = false) {
    return new Promise((resolve, reject) => {
        const image = new Image()
        const timeout = window.setTimeout(() => {
            image.onload = null
            image.onerror = null
            image.src = ''
            reject(new Error('Museum cover timed out while decoding'))
        }, 7000)
        image.crossOrigin = 'anonymous'
        image.decoding = 'async'
        image.fetchPriority = highPriority ? 'high' : 'low'
        image.onload = () => {
            window.clearTimeout(timeout)
            resolve(image)
        }
        image.onerror = () => {
            window.clearTimeout(timeout)
            reject(new Error('Museum cover could not be decoded'))
        }
        image.src = developmentMediaUrl(url)
    })
}

function cropMuseumCover(texture, image) {
    const imageWidth = image.width || image.naturalWidth
    const imageHeight = image.height || image.naturalHeight
    const imageAspect = imageWidth / imageHeight
    const frameAspect = 2.66 / 1.76
    if (imageAspect > frameAspect) {
        texture.repeat.x = frameAspect / imageAspect
        texture.offset.x = (1 - texture.repeat.x) / 2
    } else if (imageAspect > 0) {
        texture.repeat.y = imageAspect / frameAspect
        texture.offset.y = (1 - texture.repeat.y) / 2
    }
}

async function createMuseumCoverTexture(album, targetWidth = 960, priority = targetWidth) {
    const cacheKey = coverCacheKey(album, targetWidth)
    const cached = coverTextureCache.get(cacheKey)
    if (cached) return cached
    const pending = coverTextureLoads.get(cacheKey)
    if (pending) return pending

    const request = enqueueCoverLoad(async () => {
        const urls = await optimizedCoverUrls(album, targetWidth)
        let lastError = null
        for (const url of urls) {
            try {
                const image = await loadHtmlImage(url, targetWidth > LOW_RES_COVER_WIDTH)
                const texture = new THREE.Texture(image)
                cropMuseumCover(texture, image)
                texture.colorSpace = THREE.SRGBColorSpace
                texture.minFilter = THREE.LinearMipmapLinearFilter
                texture.magFilter = THREE.LinearFilter
                texture.generateMipmaps = true
                texture.anisotropy = 4
                texture.userData.museumCacheKey = cacheKey
                texture.needsUpdate = true
                coverTextureCache.delete(cacheKey)
                coverTextureCache.set(cacheKey, texture)
                trimCoverTextureCache()
                return texture
            } catch (cause) {
                lastError = cause
            }
        }
        throw lastError || new Error('Museum cover is unavailable')
    }, priority).finally(() => coverTextureLoads.delete(cacheKey))
    coverTextureLoads.set(cacheKey, request)
    return request
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

function useCoverTexture(album, targetWidth, priority = targetWidth) {
    const cacheKey = coverCacheKey(album, targetWidth)
    const [loaded, setLoaded] = useState(() => (
        cachedCoverTexture(album, targetWidth)
        || (targetWidth > LOW_RES_COVER_WIDTH ? cachedCoverTexture(album, LOW_RES_COVER_WIDTH) : null)
    ))

    useEffect(() => {
        let cancelled = false
        let retryTimer
        if (!targetWidth) return undefined
        const load = (attempt = 0) => {
            createMuseumCoverTexture(album, targetWidth, priority)
                .then(texture => {
                    if (!cancelled) setLoaded(texture)
                })
                .catch(() => {
                    if (cancelled || attempt >= 2) return
                    retryTimer = window.setTimeout(() => load(attempt + 1), 500 * (attempt + 1))
                })
        }
        load()

        return () => {
            cancelled = true
            window.clearTimeout(retryTimer)
        }
    }, [album, cacheKey, priority, targetWidth])

    useEffect(() => {
        const referenceKey = loaded?.userData?.museumCacheKey
        if (!referenceKey) return undefined
        coverTextureReferences.set(referenceKey, (coverTextureReferences.get(referenceKey) || 0) + 1)
        return () => {
            const nextCount = Math.max(0, (coverTextureReferences.get(referenceKey) || 1) - 1)
            if (nextCount) coverTextureReferences.set(referenceKey, nextCount)
            else coverTextureReferences.delete(referenceKey)
            trimCoverTextureCache()
        }
    }, [loaded])

    return loaded
}

function Painting({ painting, targetWidth = 0, onTextureReady }) {
    const lowTexture = useCoverTexture(painting.album, LOW_RES_COVER_WIDTH, 5000 + targetWidth)
    const detailTexture = useCoverTexture(painting.album, targetWidth, targetWidth)
    const texture = detailTexture || lowTexture
    const artworkMaterial = useRef(null)
    const paintingGroup = useRef(null)
    const plaqueMesh = useRef(null)
    const worldPosition = useMemo(() => new THREE.Vector3(), [])
    const lastPlaqueProbe = useRef(-1)
    const date = painting.album.createdAt || painting.album.uploadedAt || ''
    const subtitle = date ? new Date(`${String(date).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
    }) : 'Photographic series'
    const plaque = useLabelTexture(painting.album.title, subtitle, { width: 768, height: 192, dark: false })
    const lightWash = useMemo(() => getPaintingWashTexture(), [])

    useEffect(() => {
        if (!texture) return
        if (artworkMaterial.current) artworkMaterial.current.opacity = 0
        onTextureReady?.(painting.id)
    }, [onTextureReady, painting.id, texture])
    useFrame((state, delta) => {
        if (texture && artworkMaterial.current && artworkMaterial.current.opacity < 1) {
            artworkMaterial.current.opacity = Math.min(1, artworkMaterial.current.opacity + (delta * 4.5))
        }
        if (
            plaqueMesh.current
            && paintingGroup.current
            && state.clock.elapsedTime - lastPlaqueProbe.current > 0.18
        ) {
            lastPlaqueProbe.current = state.clock.elapsedTime
            paintingGroup.current.getWorldPosition(worldPosition)
            plaqueMesh.current.visible = state.camera.position.distanceToSquared(worldPosition) < 360
        }
    })

    return (
        <group ref={paintingGroup} position={painting.position} rotation={[0, painting.rotationY, 0]}>
            <mesh position={[0, 0.16, -0.075]} renderOrder={-1}>
                <planeGeometry args={[5.35, 5.7]} />
                <meshBasicMaterial
                    map={lightWash}
                    color="#f1c78f"
                    transparent
                    opacity={0.9}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
                />
            </mesh>
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
            <mesh position={[0, 0, 0.151]}>
                <planeGeometry args={[2.66, 1.76]} />
                <meshStandardMaterial color="#28241f" roughness={0.96} />
            </mesh>
            {texture && (
                <mesh position={[0, 0, 0.155]}>
                    <planeGeometry args={[2.66, 1.76]} />
                    <meshBasicMaterial
                        key={texture.uuid}
                        ref={artworkMaterial}
                        map={texture}
                        color="#ffffff"
                        toneMapped={false}
                        transparent
                        opacity={0}
                    />
                </mesh>
            )}
            <mesh ref={plaqueMesh} position={[0, -1.55, 0.13]}>
                <planeGeometry args={[2.9, 0.62]} />
                <meshBasicMaterial map={plaque} toneMapped={false} />
            </mesh>
            <mesh position={[0, 1.72, 0.28]} rotation={[0.16, 0, 0]}>
                <boxGeometry args={[1.45, 0.08, 0.11]} />
                <meshStandardMaterial
                    color="#9b7c59"
                    emissive="#d99d58"
                    emissiveIntensity={0.22}
                    metalness={0.45}
                    roughness={0.46}
                />
            </mesh>
        </group>
    )
}

function RoomWallpaperSurfaces({ room, shellCenterX, shellDepth, ceilingY, materials, wallThickness, color = '#d8cab8' }) {
    const outerRotationY = room.side < 0 ? Math.PI / 2 : -Math.PI / 2
    const roomPhase = useMemo(() => (
        [...room.id].reduce((total, character) => total + character.charCodeAt(0), 0) % 17
    ) / 17, [room.id])
    return (
        <>
            <mesh
                receiveShadow
                position={[
                    room.outerX - (room.side * ((wallThickness / 2) + 0.007)),
                    ceilingY / 2,
                    room.centerZ,
                ]}
                rotation={[0, outerRotationY, 0]}
            >
                <planeGeometry args={[Math.max(1, room.width - 0.32), ceilingY - 0.28]} />
                <WallpaperMaterial
                    materials={materials}
                    width={room.width}
                    height={ceilingY}
                    centerZ={room.centerZ}
                    color={color}
                    phase={roomPhase}
                />
            </mesh>
            {[-1, 1].map(direction => (
                <mesh
                    receiveShadow
                    key={direction}
                    position={[
                        shellCenterX,
                        ceilingY / 2,
                        room.centerZ + direction * ((room.width / 2) - ((wallThickness / 2) + 0.007)),
                    ]}
                    rotation={[0, direction < 0 ? 0 : Math.PI, 0]}
                >
                    <planeGeometry args={[Math.max(1, shellDepth - 0.28), ceilingY - 0.28]} />
                    <WallpaperMaterial
                        materials={materials}
                        width={shellDepth}
                        height={ceilingY}
                        centerZ={shellCenterX}
                        color={color}
                        phase={roomPhase}
                    />
                </mesh>
            ))}
        </>
    )
}

function RoomCofferedCeiling({ room, shellCenterX, shellDepth, ceilingY, materials }) {
    const panelCount = Math.max(2, Math.min(5, Math.round(shellDepth / 6.4)))
    const panelLength = Math.max(2.7, (shellDepth - 1.2) / panelCount)
    const startX = shellCenterX - (shellDepth / 2) + 0.6 + (panelLength / 2)
    return (
        <group>
            {Array.from({ length: panelCount }, (_, index) => {
                const x = startX + (index * panelLength)
                return (
                    <group key={index} position={[x, ceilingY - 0.115, room.centerZ]}>
                        <mesh>
                            <boxGeometry args={[panelLength - 0.32, 0.08, room.width - 1.15]} />
                            <meshStandardMaterial color="#b7ab9a" roughness={0.84} />
                        </mesh>
                        <mesh position={[0, -0.048, 0]}>
                            <boxGeometry args={[panelLength - 0.62, 0.026, room.width - 1.48]} />
                            <PlasterMaterial materials={materials} color="#dfd6c8" roughness={0.92} />
                        </mesh>
                    </group>
                )
            })}
            <group position={[shellCenterX, ceilingY - 0.19, room.centerZ]}>
                <mesh>
                    <boxGeometry args={[Math.max(1, shellDepth - 0.8), 0.055, 0.1]} />
                    <meshStandardMaterial color="#8b6d48" metalness={0.58} roughness={0.48} />
                </mesh>
                {Array.from({ length: Math.max(2, Math.min(7, Math.round(shellDepth / 4.2))) }, (_, index) => {
                    const fixtureCount = Math.max(2, Math.min(7, Math.round(shellDepth / 4.2)))
                    const span = Math.max(1, shellDepth - 2.15)
                    const x = fixtureCount === 1
                        ? 0
                        : (-span / 2) + ((span * index) / (fixtureCount - 1))
                    return (
                        <group key={index} position={[x, -0.06, 0]}>
                            <mesh rotation={[0, 0, -0.22]}>
                                <cylinderGeometry args={[0.075, 0.11, 0.24, 10]} />
                                <meshStandardMaterial color="#b28a55" metalness={0.66} roughness={0.38} />
                            </mesh>
                            <mesh position={[0.05, -0.12, 0]} rotation={[Math.PI / 2, 0, 0]}>
                                <circleGeometry args={[0.075, 10]} />
                                <meshBasicMaterial color="#ffe7bf" toneMapped={false} />
                            </mesh>
                        </group>
                    )
                })}
            </group>
        </group>
    )
}

function useDoorwayShape() {
    return useMemo(() => {
        const radius = (MUSEUM_DIMENSIONS.doorwayWidth / 2) - 0.12
        const springHeight = 2.68
        const archRise = 1.48
        const shape = new THREE.Shape()
        shape.moveTo(-radius, 0.05)
        shape.lineTo(-radius, springHeight)
        for (let segment = 0; segment <= 24; segment += 1) {
            const angle = Math.PI - ((Math.PI * segment) / 24)
            shape.lineTo(
                Math.cos(angle) * radius,
                springHeight + (Math.sin(angle) * archRise),
            )
        }
        shape.lineTo(radius, 0.05)
        shape.closePath()
        return shape
    }, [])
}

function RoomPortalScrim({ room, ready }) {
    const material = useRef(null)
    const labelMaterial = useRef(null)
    const doorwayShape = useDoorwayShape()
    const portalLabel = useLabelTexture(room.name, '', { width: 640, height: 180, dark: true })
    useFrame((_, delta) => {
        if (!material.current) return
        const target = ready ? 0 : 0.96
        material.current.opacity = THREE.MathUtils.damp(
            material.current.opacity,
            target,
            ready ? 7 : 12,
            delta,
        )
        material.current.visible = material.current.opacity > 0.012
        if (labelMaterial.current) {
            labelMaterial.current.opacity = Math.min(1, material.current.opacity * 1.35)
            labelMaterial.current.visible = material.current.visible
        }
    })
    const rotationY = room.side < 0 ? Math.PI / 2 : -Math.PI / 2
    return (
        <group
            position={[room.innerX + (room.side * 0.23), 0, room.centerZ]}
            rotation={[0, rotationY, 0]}
        >
            <mesh renderOrder={2}>
                <shapeGeometry args={[doorwayShape, 24]} />
                <meshPhysicalMaterial
                    ref={material}
                    color="#211318"
                    roughness={0.94}
                    sheen={0.42}
                    sheenColor="#7b343d"
                    transparent
                    opacity={ready ? 0 : 0.96}
                    depthWrite={false}
                    side={THREE.DoubleSide}
                />
            </mesh>
            <mesh position={[0, 2.25, 0.018]} renderOrder={3}>
                <planeGeometry args={[2.7, 0.76]} />
                <meshBasicMaterial
                    ref={labelMaterial}
                    map={portalLabel}
                    toneMapped={false}
                    transparent
                    opacity={ready ? 0 : 1}
                    depthWrite={false}
                    side={THREE.DoubleSide}
                />
            </mesh>
        </group>
    )
}

function useArchSpandrelShape() {
    return useMemo(() => {
        const radius = MUSEUM_DIMENSIONS.doorwayWidth / 2
        const springHeight = 2.7
        const archRise = 1.55
        const shape = new THREE.Shape()
        shape.moveTo(-radius, springHeight)
        for (let segment = 0; segment <= 24; segment += 1) {
            const angle = Math.PI - ((Math.PI * segment) / 24)
            shape.lineTo(
                Math.cos(angle) * radius,
                springHeight + (Math.sin(angle) * archRise),
            )
        }
        shape.lineTo(radius, MUSEUM_DIMENSIONS.hallHeight)
        shape.lineTo(-radius, MUSEUM_DIMENSIONS.hallHeight)
        shape.closePath()
        return shape
    }, [])
}

function useArchTrimCurve() {
    return useMemo(() => {
        const radius = MUSEUM_DIMENSIONS.doorwayWidth / 2
        const springHeight = 2.7
        const archRise = 1.55
        const points = [new THREE.Vector3(-radius, 0.08, 0)]
        for (let segment = 0; segment <= 16; segment += 1) {
            const angle = Math.PI - ((Math.PI * segment) / 16)
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
    const thickness = HALL_WALL_THICKNESS
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    const spandrelShape = useArchSpandrelShape()
    const archCurve = useArchTrimCurve()
    const archRadius = MUSEUM_DIMENSIONS.doorwayWidth / 2
    const halfBay = MUSEUM_DIMENSIONS.baySpacing / 2
    const pierWidth = halfBay - archRadius
    const panelOffset = (archRadius + (MUSEUM_DIMENSIONS.baySpacing / 2)) / 2
    const panelWidth = ((MUSEUM_DIMENSIONS.baySpacing / 2) - archRadius) - 0.7

    return (
        <group>
            {room ? (
                <>
                    {[-1, 1].map(direction => (
                        <group key={`pier-${direction}`}>
                            <mesh position={[
                                wallX,
                                MUSEUM_DIMENSIONS.hallHeight / 2,
                                centerZ + direction * (archRadius + (pierWidth / 2)),
                            ]}>
                                <boxGeometry args={[thickness, MUSEUM_DIMENSIONS.hallHeight, pierWidth]} />
                                <PlasterMaterial materials={materials} color={HALL_PAINT} textured={false} />
                            </mesh>
                            <WallpaperPanel
                                materials={materials}
                                side={side}
                                centerZ={centerZ + direction * (archRadius + (pierWidth / 2))}
                                width={pierWidth}
                            />
                        </group>
                    ))}
                    <mesh
                        position={[
                            side * (MUSEUM_DIMENSIONS.hallHalfWidth - ((thickness / 2) + 0.007)),
                            0,
                            centerZ,
                        ]}
                        rotation={[0, rotationY, 0]}
                    >
                        <shapeGeometry args={[spandrelShape, 24]} />
                        <WallpaperMaterial
                            materials={materials}
                            width={MUSEUM_DIMENSIONS.doorwayWidth}
                            height={MUSEUM_DIMENSIONS.hallHeight}
                            centerZ={centerZ}
                            side={THREE.DoubleSide}
                            shapeUv
                        />
                    </mesh>
                </>
            ) : (
                <>
                    <mesh position={[wallX, MUSEUM_DIMENSIONS.hallHeight / 2, centerZ]}>
                        <boxGeometry args={[thickness, MUSEUM_DIMENSIONS.hallHeight, MUSEUM_DIMENSIONS.baySpacing]} />
                        <PlasterMaterial materials={materials} color={HALL_PAINT} textured={false} />
                    </mesh>
                    <WallpaperPanel
                        materials={materials}
                        side={side}
                        centerZ={centerZ}
                        width={MUSEUM_DIMENSIONS.baySpacing}
                    />
                </>
            )}
            {[-1, 1].map(direction => (
                <group
                    key={`panel-${direction}`}
                    position={[
                        wallX - (side * ((thickness / 2) + 0.055)),
                        1.42,
                        centerZ + (direction * panelOffset),
                    ]}
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
                        position={[wallX - (side * ((thickness / 2) + 0.018)), 0, centerZ]}
                        rotation={[0, rotationY, 0]}
                    >
                        <tubeGeometry args={[archCurve, 28, 0.13, 7, false]} />
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
    const { geometry, ribCurve } = useMemo(() => {
        const radius = 6.35
        const centerY = 0.85
        const start = Math.acos(MUSEUM_DIMENSIONS.hallHalfWidth / radius)
        const end = Math.PI - start
        const count = 32
        const frontZ = centerZ + (layout.hallLength / 2)
        const backZ = centerZ - (layout.hallLength / 2)
        const positions = []
        const uvs = []
        const indices = []
        for (let index = 0; index <= count; index += 1) {
            const ratio = index / count
            const angle = start + (ratio * (end - start))
            const x = radius * Math.cos(angle)
            const y = centerY + (radius * Math.sin(angle))
            positions.push(x, y, frontZ, x, y, backZ)
            uvs.push(ratio, 0, ratio, 1)
            if (index < count) {
                const current = index * 2
                const next = current + 2
                indices.push(current, next, current + 1, next, next + 1, current + 1)
            }
        }
        const shell = new THREE.BufferGeometry()
        shell.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        shell.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
        shell.setIndex(indices)
        shell.computeVertexNormals()
        const points = Array.from({ length: 29 }, (_, index) => {
            const angle = start + ((index / 28) * (end - start))
            return new THREE.Vector3(radius * Math.cos(angle), centerY + radius * Math.sin(angle), 0)
        })
        return {
            geometry: shell,
            ribCurve: new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5),
        }
    }, [centerZ, layout.hallLength])
    useEffect(() => () => geometry.dispose(), [geometry])
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
            <mesh geometry={geometry} receiveShadow>
                <CeilingMaterial materials={materials} hallLength={layout.hallLength} />
            </mesh>
            {ribZs.map(z => (
                <mesh key={z} position={[0, 0, z]}>
                    <tubeGeometry args={[ribCurve, 30, 0.075, 6, false]} />
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

function CategoryRoom({ room, active, detailed, materials, qualityLighting }) {
    const roomWidth = room.width
    const outerWallX = room.outerX
    const wallThickness = 0.24
    const ceilingY = 6.15
    const rowXs = useMemo(() => [...new Set(room.paintings.map(painting => painting.position[0]))], [room.paintings])
    const lightXs = useMemo(() => {
        if (rowXs.length <= 4) return rowXs
        const lastIndex = rowXs.length - 1
        return [
            rowXs[0],
            rowXs[Math.round(lastIndex / 3)],
            rowXs[Math.round((lastIndex * 2) / 3)],
            rowXs[lastIndex],
        ]
    }, [rowXs])
    const endRotation = room.side < 0 ? Math.PI / 2 : -Math.PI / 2
    const shellDepth = Math.max(1, room.depth - ROOM_SHELL_INSET)
    const shellCenterX = room.centerX + (room.side * (ROOM_SHELL_INSET / 2))
    const [readyPaintingIds, setReadyPaintingIds] = useState(() => new Set())
    const revealThreshold = Math.min(4, room.paintings.length)
    const roomReady = active && readyPaintingIds.size >= revealThreshold
    const markPaintingReady = useCallback((paintingId) => {
        setReadyPaintingIds((current) => {
            if (current.has(paintingId)) return current
            const next = new Set(current)
            next.add(paintingId)
            return next
        })
    }, [])
    const illuminatedXs = useMemo(() => {
        const candidates = detailed
            ? lightXs
            : lightXs.filter((_, index) => index === 0 || index === lightXs.length - 1)
        return candidates.filter((_, index) => index === 0 || index === candidates.length - 1)
    }, [detailed, lightXs])
    const roomVariant = useMemo(() => (
        [...room.id].reduce((total, character) => total + character.charCodeAt(0), 0) % 4
    ), [room.id])
    const roomTint = ['#d8cab8', '#c9cbbd', '#d3c2bb', '#c7bdaf'][roomVariant]
    return (
        <group>
            <mesh position={[room.centerX, -0.11, room.centerZ]} receiveShadow>
                <boxGeometry args={[room.depth, 0.22, roomWidth]} />
                <FloorMaterial materials={materials} color="#73573f" />
            </mesh>
            <mesh position={[shellCenterX, ceilingY, room.centerZ]}>
                <boxGeometry args={[shellDepth, 0.18, roomWidth]} />
                <PlasterMaterial materials={materials} color="#e9e2d8" textured={false} />
            </mesh>
            <RoomCofferedCeiling
                room={room}
                shellCenterX={shellCenterX}
                shellDepth={shellDepth}
                ceilingY={ceilingY}
                materials={materials}
            />
            <mesh position={[outerWallX, ceilingY / 2, room.centerZ]}>
                <boxGeometry args={[wallThickness, ceilingY, roomWidth]} />
                <PlasterMaterial materials={materials} color={ROOM_PAINT} />
            </mesh>
            <RoomWallpaperSurfaces
                room={room}
                shellCenterX={shellCenterX}
                shellDepth={shellDepth}
                ceilingY={ceilingY}
                materials={materials}
                wallThickness={wallThickness}
                color={roomTint}
            />
            {[-1, 1].map(direction => (
                <group key={direction}>
                    <mesh position={[shellCenterX, ceilingY / 2, room.centerZ + direction * (roomWidth / 2)]}>
                        <boxGeometry args={[shellDepth, ceilingY, wallThickness]} />
                        <PlasterMaterial materials={materials} color={ROOM_PAINT} />
                    </mesh>
                    <mesh position={[shellCenterX, 0.16, room.centerZ + direction * ((roomWidth / 2) - 0.15)]}>
                        <boxGeometry args={[shellDepth, 0.32, 0.18]} />
                        <meshStandardMaterial color="#887763" roughness={0.7} />
                    </mesh>
                    <mesh position={[shellCenterX, 5.56, room.centerZ + direction * ((roomWidth / 2) - 0.16)]}>
                        <boxGeometry args={[shellDepth, 0.18, 0.22]} />
                        <meshStandardMaterial color="#b9aa95" roughness={0.72} />
                    </mesh>
                    <mesh position={[shellCenterX, 5.72, room.centerZ + direction * ((roomWidth / 2) - 0.48)]}>
                        <boxGeometry args={[Math.max(0.5, shellDepth - 0.8), 0.065, 0.08]} />
                    <meshStandardMaterial color="#8d704e" metalness={0.62} roughness={0.45} />
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
            {active && room.paintings.map((painting) => (
                    <Painting
                        key={painting.id}
                        painting={painting}
                        targetWidth={detailed
                            ? (qualityLighting ? 2048 : 1280)
                            : (qualityLighting ? 1280 : 960)}
                        onTextureReady={markPaintingReady}
                    />
            ))}
            <RoomPortalScrim room={room} ready={roomReady} />
            {lightXs.map(x => (
                <group key={x} position={[x, ceilingY - 0.12, room.centerZ]}>
                    <mesh rotation={[Math.PI / 2, 0, 0]}>
                        <circleGeometry args={[0.26, 12]} />
                        <meshBasicMaterial color="#fff1d6" toneMapped={false} />
                    </mesh>
                </group>
            ))}
            {active && illuminatedXs.flatMap((x, xIndex) => [-1, 1].map((direction, directionIndex) => (
                <StaticSpotlight
                    key={`room-light-${x}-${direction}`}
                    position={[x, ceilingY - 0.28, room.centerZ + (direction * 1.35)]}
                    target={[x, 2.15, room.centerZ + (direction * ((roomWidth / 2) - 0.42))]}
                    color="#ffd4a2"
                    intensity={qualityLighting ? 22 : 16}
                    distance={12}
                    angle={0.46}
                    penumbra={0.76}
                    castShadow={detailed && qualityLighting && xIndex === 0 && directionIndex === 0}
                />
            )))}
            {active && (
                <rectAreaLight
                    position={[shellCenterX, ceilingY - 0.34, room.centerZ]}
                    rotation={[-Math.PI / 2, 0, 0]}
                    color="#f0d1ad"
                    intensity={qualityLighting ? 3.2 : 2.3}
                    width={Math.max(3, shellDepth - 1.2)}
                    height={Math.max(3, roomWidth - 1.2)}
                />
            )}
        </group>
    )
}

function MainHall({ layout, activeRoomId, activeRoomIds, materials, reflectionsEnabled }) {
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
    // Keep fixtures between the transverse ceiling ribs. Their matching light
    // sources are stationary so illumination cannot jump or flash while walking.
    const ceilingLights = [7, ...bays.map(bay => bay.centerZ)]
        .filter(z => z > layout.hallBackZ)
    const illuminatedHallLights = ceilingLights.filter((_, index) => (
        index % (reflectionsEnabled ? 2 : 4) === 0
    ))
    return (
        <group>
            <mesh position={[0, -0.11, hallCenterZ]} receiveShadow>
                <boxGeometry args={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, 0.22, layout.hallLength]} />
                <FloorMaterial materials={materials} color="#73573f" />
            </mesh>
            <VaultedCeiling layout={layout} centerZ={hallCenterZ} materials={materials} />
            {[-1, 1].map(side => (
                <group key={side}>
                    <mesh position={[
                        side * MUSEUM_DIMENSIONS.hallHalfWidth,
                        MUSEUM_DIMENSIONS.hallHeight / 2,
                        lobbyWallCenterZ,
                    ]}>
                        <boxGeometry args={[HALL_WALL_THICKNESS, MUSEUM_DIMENSIONS.hallHeight, lobbyWallLength]} />
                        <PlasterMaterial materials={materials} color={HALL_PAINT} textured={false} />
                    </mesh>
                    <WallpaperPanel
                        materials={materials}
                        side={side}
                        centerZ={lobbyWallCenterZ}
                        width={lobbyWallLength}
                    />
                    {tailLength > 0 && (
                        <>
                            <mesh position={[
                                side * MUSEUM_DIMENSIONS.hallHalfWidth,
                                MUSEUM_DIMENSIONS.hallHeight / 2,
                                layout.hallBackZ + (tailLength / 2),
                            ]}>
                                <boxGeometry args={[HALL_WALL_THICKNESS, MUSEUM_DIMENSIONS.hallHeight, tailLength]} />
                                <PlasterMaterial materials={materials} color={HALL_PAINT} textured={false} />
                            </mesh>
                            <WallpaperPanel
                                materials={materials}
                                side={side}
                                centerZ={layout.hallBackZ + (tailLength / 2)}
                                width={tailLength}
                            />
                        </>
                    )}
                </group>
            ))}
            {bays.map(bay => (
                <group key={bay.centerZ}>
                    <DoorWall side={-1} centerZ={bay.centerZ} room={bay.left} materials={materials} />
                    <DoorWall side={1} centerZ={bay.centerZ} room={bay.right} materials={materials} />
                </group>
            ))}
            <mesh position={[0, MUSEUM_DIMENSIONS.hallHeight / 2, layout.hallBackZ]}>
                <boxGeometry args={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, MUSEUM_DIMENSIONS.hallHeight, 0.24]} />
                <PlasterMaterial materials={materials} color={HALL_PAINT} textured={false} />
            </mesh>
            {layout.rooms.map(room => (
                <CategoryRoom
                    key={room.id}
                    room={room}
                    active={activeRooms.has(room.id)}
                    detailed={activeRoomId === room.id}
                    materials={materials}
                    qualityLighting={reflectionsEnabled}
                />
            ))}
            {ceilingLights.map(z => (
                <group key={z} position={[0, 6.85, z]}>
                    <mesh rotation={[Math.PI / 2, 0, 0]}>
                        <circleGeometry args={[0.25, 12]} />
                        <meshBasicMaterial color="#fff0d3" toneMapped={false} />
                    </mesh>
                </group>
            ))}
            {illuminatedHallLights.map(z => (
                <StaticSpotlight
                    key={`hall-light-${z}`}
                    position={[0, 5.9, z]}
                    target={[0, 0, z]}
                    color="#ffd8aa"
                    intensity={reflectionsEnabled ? 28 : 18}
                    distance={24}
                    angle={0.72}
                    penumbra={0.82}
                />
            ))}
            <MuseumDressing
                layout={layout}
                activeRoomIds={activeRoomIds}
                materials={materials}
                LabelPlane={LabelPlane}
                PlasterMaterial={PlasterMaterial}
                WoodMaterial={WoodMaterial}
                reflectionsEnabled={reflectionsEnabled}
            />
        </group>
    )
}

function focusedPainting(layout, camera, direction = new THREE.Vector3()) {
    camera.getWorldDirection(direction)
    let best = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const painting of layout.rooms.flatMap(room => room.paintings)) {
        const dx = painting.position[0] - camera.position.x
        const dy = painting.position[1] - camera.position.y
        const dz = painting.position[2] - camera.position.z
        const distance = Math.hypot(dx, dy, dz)
        if (distance > 4.6) continue
        const inverseDistance = distance > 0 ? 1 / distance : 0
        const alignment = (
            (direction.x * dx * inverseDistance)
            + (direction.y * dy * inverseDistance)
            + (direction.z * dz * inverseDistance)
        )
        if (alignment < 0.8) continue
        const score = distance + ((1 - alignment) * 7)
        if (score < bestScore) {
            best = painting
            bestScore = score
        }
    }
    return best
}

function MuseumTouchControls({ input, onPause }) {
    const stick = useRef(null)
    const knob = useRef(null)
    const lastLook = useRef({ x: 0, y: 0 })

    const resetMovement = () => {
        input.current.moveX = 0
        input.current.moveY = 0
        if (knob.current) knob.current.style.transform = 'translate3d(0, 0, 0)'
    }

    const updateMovement = (event) => {
        const rect = stick.current?.getBoundingClientRect()
        if (!rect) return
        const radius = Math.min(rect.width, rect.height) * 0.34
        const rawX = event.clientX - (rect.left + (rect.width / 2))
        const rawY = event.clientY - (rect.top + (rect.height / 2))
        const length = Math.hypot(rawX, rawY)
        const scale = length > radius ? radius / length : 1
        const x = rawX * scale
        const y = rawY * scale
        input.current.moveX = x / radius
        input.current.moveY = y / radius
        if (knob.current) knob.current.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }

    useEffect(() => () => {
        input.current.moveX = 0
        input.current.moveY = 0
        input.current.lookX = 0
        input.current.lookY = 0
    }, [input])

    return (
        <div className="museum-touch-controls">
            <div
                className="museum-look-zone"
                aria-label="Drag to look around"
                onPointerDown={(event) => {
                    event.preventDefault()
                    lastLook.current = { x: event.clientX, y: event.clientY }
                    event.currentTarget.setPointerCapture(event.pointerId)
                }}
                onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                    input.current.lookX += event.clientX - lastLook.current.x
                    input.current.lookY += event.clientY - lastLook.current.y
                    lastLook.current = { x: event.clientX, y: event.clientY }
                }}
            >
                <span>Drag to look</span>
            </div>
            <div
                ref={stick}
                className="museum-joystick"
                aria-label="Movement joystick"
                onPointerDown={(event) => {
                    event.preventDefault()
                    event.currentTarget.setPointerCapture(event.pointerId)
                    updateMovement(event)
                }}
                onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                    updateMovement(event)
                }}
                onPointerUp={resetMovement}
                onPointerCancel={resetMovement}
                onLostPointerCapture={resetMovement}
            >
                <div ref={knob} className="museum-joystick-knob" />
                <span>Move</span>
            </div>
            <button className="museum-touch-pause" type="button" onClick={onPause}>Pause</button>
        </div>
    )
}

function NativePointerLockControls({ onLock, onUnlock }) {
    const { camera, gl } = useThree()

    useEffect(() => {
        camera.rotation.order = 'YXZ'
        const handleLockChange = () => {
            if (document.pointerLockElement === gl.domElement) onLock()
            else onUnlock()
        }
        const handleMouseMove = (event) => {
            if (document.pointerLockElement !== gl.domElement) return
            camera.rotation.y -= event.movementX * 0.002
            camera.rotation.x = THREE.MathUtils.clamp(
                camera.rotation.x - (event.movementY * 0.002),
                (-Math.PI / 2) + 0.04,
                (Math.PI / 2) - 0.04,
            )
        }
        document.addEventListener('pointerlockchange', handleLockChange)
        document.addEventListener('mousemove', handleMouseMove)
        return () => {
            document.removeEventListener('pointerlockchange', handleLockChange)
            document.removeEventListener('mousemove', handleMouseMove)
        }
    }, [camera, gl, onLock, onUnlock])

    return null
}

function PlayerController({ layout, enabled, touchMode, touchInput, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
    const { camera } = useThree()
    const keys = useRef(new Set())
    const lastRoom = useRef(null)
    const lastNearbyRooms = useRef('')
    const lastFocused = useRef(null)
    const lastSavedAt = useRef(0)
    const lastProbeAt = useRef(0)
    const touchEuler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), [])
    const forward = useMemo(() => new THREE.Vector3(), [])
    const right = useMemo(() => new THREE.Vector3(), [])
    const movement = useMemo(() => new THREE.Vector3(), [])
    const focusDirection = useMemo(() => new THREE.Vector3(), [])

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
                const painting = focusedPainting(layout, camera, focusDirection)
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
    }, [camera, enabled, focusDirection, layout, onOpenAlbum])

    useFrame((state, frameDelta) => {
        if (!enabled) return
        const delta = Math.min(frameDelta, 0.05)
        if (touchMode && (touchInput.current.lookX || touchInput.current.lookY)) {
            touchEuler.setFromQuaternion(camera.quaternion)
            touchEuler.y -= touchInput.current.lookX * 0.0042
            touchEuler.x = THREE.MathUtils.clamp(
                touchEuler.x - (touchInput.current.lookY * 0.0038),
                -1.28,
                1.28,
            )
            camera.quaternion.setFromEuler(touchEuler)
            touchInput.current.lookX = 0
            touchInput.current.lookY = 0
        }
        const touchMagnitude = touchMode
            ? Math.min(1, Math.hypot(touchInput.current.moveX, touchInput.current.moveY))
            : 0
        const speed = keys.current.has('ShiftLeft') || keys.current.has('ShiftRight') || touchMagnitude > 0.9 ? 5.3 : 3.25
        forward.set(0, 0, -1).applyQuaternion(camera.quaternion)
        forward.y = 0
        forward.normalize()
        right.set(-forward.z, 0, forward.x)
        movement.set(0, 0, 0)
        if (keys.current.has('KeyW') || keys.current.has('ArrowUp')) movement.add(forward)
        if (keys.current.has('KeyS') || keys.current.has('ArrowDown')) movement.sub(forward)
        if (keys.current.has('KeyD') || keys.current.has('ArrowRight')) movement.add(right)
        if (keys.current.has('KeyA') || keys.current.has('ArrowLeft')) movement.sub(right)
        if (touchMode) {
            movement.addScaledVector(forward, -touchInput.current.moveY)
            movement.addScaledVector(right, touchInput.current.moveX)
        }
        if (movement.lengthSq()) {
            const movementScale = touchMode && touchMagnitude > 0 ? Math.max(0.18, touchMagnitude) : 1
            movement.normalize().multiplyScalar(speed * delta * movementScale)
            const next = moveMuseumPosition(
                layout,
                { x: camera.position.x, z: camera.position.z },
                { x: movement.x, z: movement.z },
            )
            camera.position.x = next.x
            camera.position.z = next.z
        }
        camera.position.y = layout.spawn[1]

        if (state.clock.elapsedTime - lastProbeAt.current > 0.12) {
            lastProbeAt.current = state.clock.elapsedTime
            const position = { x: camera.position.x, z: camera.position.z }
            const room = nearestMuseumRoom(layout, position)
            if (room !== lastRoom.current) {
                lastRoom.current = room
                onActiveRoom(room)
            }
            const nearbyRooms = nearbyMuseumRoomIds(layout, position)
            const nearbyKey = nearbyRooms.join('|')
            if (nearbyKey !== lastNearbyRooms.current) {
                lastNearbyRooms.current = nearbyKey
                onNearbyRooms(nearbyRooms)
            }
            const nextFocused = focusedPainting(layout, camera, focusDirection)
            if (nextFocused?.id !== lastFocused.current?.id) {
                lastFocused.current = nextFocused
                onFocusedPainting(nextFocused)
            }
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

function SceneWarmup({ layout, onReady, touchMode }) {
    const { camera, gl, invalidate, scene } = useThree()

    useEffect(() => {
        let cancelled = false
        let idleHandle = null
        let fallbackTimer = null
        const timeout = window.setTimeout(() => {
            if (!cancelled) onReady()
        }, 2200)
        const initialPosition = safeSessionPosition(layout)
        const nearbyRoomIds = new Set(nearbyMuseumRoomIds(layout, initialPosition))
        const nearbyAlbums = layout.rooms
            .filter(room => nearbyRoomIds.has(room.id))
            .flatMap(room => room.albums)
            .filter(Boolean)
            .slice(0, 8)

        const covers = Promise.allSettled(nearbyAlbums.map(album => createMuseumCoverTexture(album, LOW_RES_COVER_WIDTH)))
        covers.then((results) => {
            results.forEach((result) => {
                if (result.status === 'fulfilled') gl.initTexture?.(result.value)
            })
            invalidate()
        })

        const compile = gl.compileAsync?.(scene, camera) || Promise.resolve()
        Promise.race([
            compile,
            new Promise(resolve => window.setTimeout(resolve, 1600)),
        ]).then(() => {
            invalidate()
            window.setTimeout(() => {
                if (!cancelled) onReady()
            }, 120)
        }).catch(() => {
            if (!cancelled) onReady()
        })

        // Quietly warm a representative handful from every room after the
        // opening view is responsive. Running one decode per idle slice keeps
        // movement smooth while making the first doorway reveal much faster.
        const backgroundAlbums = layout.rooms.flatMap(room => (
            room.albums.slice(0, touchMode ? 1 : 3)
        )).filter(Boolean)
        let backgroundIndex = 0
        const warmNextRoomCover = () => {
            if (cancelled || backgroundIndex >= backgroundAlbums.length) return
            const album = backgroundAlbums[backgroundIndex]
            backgroundIndex += 1
            createMuseumCoverTexture(album, LOW_RES_COVER_WIDTH, -500)
                .catch(() => {})
                .finally(() => {
                    if (cancelled) return
                    if ('requestIdleCallback' in window) {
                        idleHandle = window.requestIdleCallback(warmNextRoomCover, { timeout: 900 })
                    } else {
                        fallbackTimer = window.setTimeout(warmNextRoomCover, 220)
                    }
                })
        }
        fallbackTimer = window.setTimeout(warmNextRoomCover, 1500)

        return () => {
            cancelled = true
            window.clearTimeout(timeout)
            window.clearTimeout(fallbackTimer)
            if (idleHandle !== null && 'cancelIdleCallback' in window) {
                window.cancelIdleCallback(idleHandle)
            }
        }
    }, [camera, gl, invalidate, layout, onReady, scene, touchMode])

    return null
}

function MuseumScene({ layout, controlsEnabled, touchMode, touchInput, visualPreview, previewMode, previewRoomIndex, onSceneReady, onLock, onUnlock, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
    const materials = useMuseumMaterials()
    return (
        <>
            <color attach="background" args={[INK]} />
            <fog attach="fog" args={['#151310', 30, 120]} />
            <ambientLight intensity={touchMode ? 0.2 : 0.12} color="#f3dcc4" />
            <hemisphereLight args={['#d8e0e4', '#38261d', touchMode ? 0.28 : 0.2]} />
            <directionalLight
                position={[-6, 10, 12]}
                intensity={touchMode ? 0.24 : 0.16}
                color="#dce8ef"
                castShadow={false}
            />
            <directionalLight position={[7, 6, -12]} intensity={0.08} color="#d69e6a" castShadow={false} />
            <MainHall
                layout={layout}
                activeRoomId={controlsEnabled.activeRoomId}
                activeRoomIds={controlsEnabled.activeRoomIds}
                materials={materials}
                reflectionsEnabled={!touchMode}
            />
            <SceneWarmup layout={layout} onReady={onSceneReady} touchMode={touchMode} />
            {visualPreview && <PreviewCamera mode={previewMode} roomIndex={previewRoomIndex} layout={layout} />}
            {!visualPreview && (
                <>
                    <PlayerController
                        layout={layout}
                        enabled={controlsEnabled.locked}
                        touchMode={touchMode}
                        touchInput={touchInput}
                        onActiveRoom={onActiveRoom}
                        onNearbyRooms={onNearbyRooms}
                        onFocusedPainting={onFocusedPainting}
                        onOpenAlbum={onOpenAlbum}
                    />
                    {!touchMode && <NativePointerLockControls onLock={onLock} onUnlock={onUnlock} />}
                </>
            )}
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
    const previewParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null
    const forceTouchPreview = previewParams?.get('museum-touch') === '1'
    const [albums, setAlbums] = useState(null)
    const [error, setError] = useState('')
    const [loadVersion, setLoadVersion] = useState(0)
    const [locked, setLocked] = useState(false)
    const [activeRoomId, setActiveRoomId] = useState(null)
    const [activeRoomIds, setActiveRoomIds] = useState([])
    const [focused, setFocused] = useState(null)
    const [sceneReady, setSceneReady] = useState(false)
    const [touchMode, setTouchMode] = useState(() => forceTouchPreview || usesTouchControls())
    const touchInput = useRef({ moveX: 0, moveY: 0, lookX: 0, lookY: 0 })

    useEffect(() => {
        const pointer = window.matchMedia?.('(pointer: coarse)')
        const update = () => setTouchMode(forceTouchPreview || usesTouchControls())
        pointer?.addEventListener?.('change', update)
        window.addEventListener('resize', update)
        return () => {
            pointer?.removeEventListener?.('change', update)
            window.removeEventListener('resize', update)
        }
    }, [forceTouchPreview])

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
    const previewMode = previewParams?.get('museum-preview') || ''
    const previewRoomIndex = Number.parseInt(previewParams?.get('museum-room') || '0', 10) || 0
    const visualPreview = ['lobby', 'hall', 'room'].includes(previewMode)
    const initialActiveRoomIds = useMemo(
        () => nearbyMuseumRoomIds(layout, safeSessionPosition(layout)),
        [layout],
    )
    const renderedActiveRoomIds = visualPreview
        ? (previewMode === 'room' ? [layout.rooms[previewRoomIndex]?.id].filter(Boolean) : [])
        : (activeRoomIds.length > 0 ? activeRoomIds : initialActiveRoomIds)
    const renderedActiveRoomId = visualPreview && previewMode === 'room'
        ? layout.rooms[previewRoomIndex]?.id
        : activeRoomId
    const openAlbum = useCallback((album) => {
        sessionStorage.setItem(RETURN_KEY, 'true')
        navigate(`/album/${encodeURIComponent(album.albumId)}`, { state: { fromImmersiveGallery: true } })
    }, [navigate])
    const handleSceneReady = useCallback(() => setSceneReady(true), [setSceneReady])
    const deviceMemory = typeof navigator === 'undefined' ? 8 : Number(navigator.deviceMemory || 8)
    const hardwareConcurrency = typeof navigator === 'undefined' ? 8 : Number(navigator.hardwareConcurrency || 8)
    const lowPowerMode = touchMode || (
        deviceMemory <= 4
        || hardwareConcurrency <= 4
    )

    if (error) return <CatalogStatus error={error} onRetry={() => {
        setError('')
        setAlbums(null)
        setLoadVersion(value => value + 1)
    }} />
    if (!albums) return <div className="museum-loading" role="status"><span className="museum-loading-mark">IT</span><p>Hanging the collection…</p></div>
    if (!catalog.length) return <CatalogStatus error="There are no public photo albums to display yet." onRetry={() => setLoadVersion(value => value + 1)} />

    return (
        <div className={`museum-experience${touchMode ? ' museum-experience--touch' : ''}`} aria-label="Ian Truong Photography immersive gallery">
            <Canvas
                className="museum-canvas"
                camera={{ fov: touchMode ? 72 : 66, near: 0.08, far: 220, position: layout.spawn }}
                dpr={touchMode ? [0.58, 0.84] : [0.68, 1]}
                frameloop={locked && !visualPreview ? 'always' : 'demand'}
                performance={{ min: 0.45, max: 1, debounce: 240 }}
                shadows={!lowPowerMode}
                gl={{
                    antialias: true,
                    powerPreference: 'high-performance',
                    alpha: false,
                    stencil: false,
                }}
                onCreated={({ gl }) => {
                    gl.outputColorSpace = THREE.SRGBColorSpace
                    gl.toneMapping = THREE.ACESFilmicToneMapping
                    gl.toneMappingExposure = touchMode ? 1.18 : 1.08
                    gl.shadowMap.type = THREE.PCFSoftShadowMap
                }}
            >
                <Suspense fallback={null}>
                    <MuseumScene
                        layout={layout}
                        controlsEnabled={{ locked, activeRoomId: renderedActiveRoomId, activeRoomIds: renderedActiveRoomIds }}
                        touchMode={touchMode}
                        touchInput={touchInput}
                        visualPreview={visualPreview}
                        previewMode={previewMode}
                        previewRoomIndex={previewRoomIndex}
                        onSceneReady={handleSceneReady}
                        onLock={() => setLocked(true)}
                        onUnlock={() => setLocked(false)}
                        onActiveRoom={setActiveRoomId}
                        onNearbyRooms={setActiveRoomIds}
                        onFocusedPainting={setFocused}
                        onOpenAlbum={openAlbum}
                    />
                </Suspense>
            </Canvas>
            {!sceneReady && (
                <div className="museum-loading museum-loading--scene" role="status" aria-live="polite">
                    <span className="museum-loading-mark">IT</span>
                    <p className="museum-kicker">Preparing the virtual archive</p>
                    <h1>Opening the gallery</h1>
                    <p>Calibrating the lights and hanging the first nearby photographs…</p>
                    <span className="museum-loading-progress" aria-hidden="true"><i /></span>
                </div>
            )}
            <div className="museum-topbar">
                <Link to="/explore" state={{ restoreExploreScroll: true }}>← Exit gallery</Link>
                <div>
                    <strong>Ian Truong Photography</strong>
                    <span>{catalog.length} rooms · {catalog.reduce((sum, category) => sum + category.albums.length, 0)} albums</span>
                </div>
            </div>
            {sceneReady && <div className="museum-crosshair" aria-hidden="true" />}
            {sceneReady && focused && locked && (touchMode ? (
                <button className="museum-interaction museum-interaction--touch" type="button" onClick={() => openAlbum(focused.album)}>
                    Open <strong>{focused.album.title}</strong>
                </button>
            ) : (
                <div className="museum-interaction" role="status">
                    <span>E</span>
                    <p>Open <strong>{focused.album.title}</strong></p>
                </div>
            ))}
            {!touchMode && (
                <div className="museum-controls-legend" aria-hidden="true">
                    <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move</span>
                    <span><kbd>Mouse</kbd> Look</span>
                    <span><kbd>Shift</kbd> Walk faster</span>
                    <span><kbd>Esc</kbd> Pause</span>
                </div>
            )}
            {sceneReady && touchMode && locked && !visualPreview && (
                <MuseumTouchControls input={touchInput} onPause={() => setLocked(false)} />
            )}
            {sceneReady && !locked && !visualPreview && (
                <div className="museum-entry-panel">
                    <span className="museum-entry-number">The virtual archive</span>
                    <h1>{activeRoomId ? 'Gallery paused' : 'Enter the gallery'}</h1>
                    <p>
                        Walk through rooms generated from the live photography archive. Look toward a framed album and {touchMode ? 'tap Open to enter it.' : 'press E to open it.'}
                    </p>
                    <button
                        id="museum-enter"
                        type="button"
                        onClick={touchMode
                            ? () => setLocked(true)
                            : () => document.querySelector('.museum-canvas canvas')?.requestPointerLock()}
                    >
                        {activeRoomId ? 'Continue exploring' : 'Begin walk-through'}
                    </button>
                    <div>{touchMode ? 'Use the joystick to move · Drag the view to look around' : <><kbd>WASD</kbd> to move · <kbd>Mouse</kbd> to look · <kbd>Esc</kbd> to pause</>}</div>
                </div>
            )}
        </div>
    )
}
