/* eslint-disable react-hooks/immutability -- Three.js cameras are intentionally mutable scene objects. */
import { AdaptiveDpr } from '@react-three/drei/core/AdaptiveDpr.js'
import { useTexture } from '@react-three/drei/core/Texture.js'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
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
// Decorative surfaces sit just inside the structural shell. A small, shared
// inset plus polygonOffset avoids z-fighting without letting wallpaper float
// through moulding at the end of a bay.
const WALL_SURFACE_GAP = 0.018
const GOLD = '#9b7747'
const INK = '#171411'
const TEXTURE_ROOT = '/assets/museum/textures'
const WALLPAPER_TILE_SIZE = 3.4
const HALL_WALL_THICKNESS = 0.32
const ROOM_SHELL_INSET = 0.42
// Image decoding and GPU promotion are the only workloads in this scene that
// can create multi-frame stalls. Four concurrent off-thread decodes finish the
// opening warmup quickly without exposing uploads during the walk-through.
const COVER_LOAD_CONCURRENCY = 4
const LOW_RES_COVER_WIDTH = 480
const DESKTOP_COVER_CACHE_BUDGET = 192 * 1024 * 1024
const LOW_POWER_COVER_CACHE_BUDGET = 84 * 1024 * 1024
const coverTextureCache = new Map()
const coverTextureLoads = new Map()
const coverTextureReferences = new Map()
const labelTextureCache = new Map()
const roomPlaqueBatchCache = new Map()
const coverLoadQueue = []
const coverUploadQueue = []
const uploadedCoverTextures = new WeakSet()
const pendingCoverUploads = new WeakMap()
const pinnedCoverTextures = new WeakSet()
// The visual curtain and the player collision must agree about whether a room
// is enterable. Keeping this outside React avoids a scene-wide rerender on
// every curtain animation frame while still giving the movement controller a
// synchronous answer.
const openMuseumPortalIds = new Set()
let activeCoverLoads = 0
let coverLoadSequence = 0
let coverUploadScheduled = false
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
    const deviceMemory = typeof navigator === 'undefined' ? 8 : Number(navigator.deviceMemory || 8)
    const lowPower = usesTouchControls() || deviceMemory <= 4
    const budget = lowPower ? LOW_POWER_COVER_CACHE_BUDGET : DESKTOP_COVER_CACHE_BUDGET
    let bytes = entries.reduce((total, [, texture]) => total + Number(texture?.userData?.museumBytes || 0), 0)
    for (const [key, texture] of entries) {
        if (bytes <= budget) break
        if ((coverTextureReferences.get(key) || 0) > 0 || pinnedCoverTextures.has(texture)) continue
        coverTextureCache.delete(key)
        bytes -= Number(texture?.userData?.museumBytes || 0)
        texture?.image?.close?.()
        texture?.dispose()
    }
}

function enqueueCoverUpload(gl, texture) {
    if (!texture || uploadedCoverTextures.has(texture)) return Promise.resolve(texture)
    const pending = pendingCoverUploads.get(texture)
    if (pending) return pending
    pinnedCoverTextures.add(texture)
    const upload = new Promise((resolve, reject) => {
        coverUploadQueue.push({ gl, texture, resolve, reject })
        if (coverUploadScheduled) return
        coverUploadScheduled = true
        const scheduleFlush = (callback) => {
            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(
                    () => window.requestAnimationFrame(callback),
                    { timeout: 180 },
                )
                return
            }
            window.setTimeout(() => window.requestAnimationFrame(callback), 54)
        }
        const flush = () => {
            const next = coverUploadQueue.shift()
            if (!next) {
                coverUploadScheduled = false
                return
            }
            try {
                if (!uploadedCoverTextures.has(next.texture)) {
                    if (next.gl.getContext?.().isContextLost?.()) {
                        throw new Error('The WebGL context is temporarily unavailable')
                    }
                    next.gl.initTexture?.(next.texture)
                    uploadedCoverTextures.add(next.texture)
                }
                next.resolve(next.texture)
            } catch (cause) {
                // A single failed upload used to throw out of this callback,
                // leaving coverUploadScheduled=true forever. Every later room
                // then waited on a queue that could never be pumped. Reject
                // only this item so useCoverTexture can retry it and always
                // advance the rest of the collection.
                next.reject(cause)
            } finally {
                pinnedCoverTextures.delete(next.texture)
                pendingCoverUploads.delete(next.texture)
                scheduleFlush(flush)
            }
        }
        scheduleFlush(flush)
    })
    pendingCoverUploads.set(texture, upload)
    return upload
}

async function promoteRevealTextures(gl, textures, onProgress) {
    const pending = [...new Set(textures.filter(Boolean))]
    for (let index = 0; index < pending.length; index += 1) {
        const texture = pending[index]
        if (!uploadedCoverTextures.has(texture)) {
            if (gl.getContext?.().isContextLost?.()) {
                throw new Error('The WebGL context is temporarily unavailable')
            }
            // Startup assets are deliberately promoted while the opaque veil is
            // present. The normal idle queue is ideal during play, but its
            // 180 ms gaps made eight tiny uploads add more than a second to a
            // cold start. Two uploads per frame keeps progress smooth without
            // deferring the first real bind until after the reveal.
            gl.initTexture?.(texture)
            uploadedCoverTextures.add(texture)
        }
        pinnedCoverTextures.delete(texture)
        pendingCoverUploads.delete(texture)
        onProgress?.((index + 1) / Math.max(1, pending.length))
        if (index % 2 === 1 && index < pending.length - 1) {
            await new Promise(resolve => window.requestAnimationFrame(resolve))
        }
    }
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

function WallpaperMaterial({ materials, width, height, centerZ = 0, color = '#d8c8b4', side = THREE.FrontSide, shapeUv = false, phase = 0, reverseU = false }) {
    const map = useMemo(() => {
        const next = materials.wallpaper.map.clone()
        next.wrapS = THREE.RepeatWrapping
        next.wrapT = THREE.RepeatWrapping
        if (shapeUv) {
            next.repeat.set(1 / WALLPAPER_TILE_SIZE, 1 / WALLPAPER_TILE_SIZE)
            next.offset.set((centerZ / WALLPAPER_TILE_SIZE) + phase, phase * 0.37)
        } else {
            const horizontalRepeat = Math.max(0.35, width / WALLPAPER_TILE_SIZE)
            next.repeat.set(reverseU ? -horizontalRepeat : horizontalRepeat, Math.max(0.35, height / WALLPAPER_TILE_SIZE))
            next.offset.set((
                (reverseU ? centerZ + (width / 2) : centerZ - (width / 2))
                / WALLPAPER_TILE_SIZE
            ) + phase, phase * 0.37)
        }
        next.colorSpace = THREE.SRGBColorSpace
        next.anisotropy = 4
        next.needsUpdate = true
        return next
    }, [centerZ, height, materials.wallpaper.map, phase, reverseU, shapeUv, width])

    useEffect(() => () => map.dispose(), [map])

    return (
        <meshStandardMaterial
            map={map}
            bumpMap={map}
            bumpScale={0.024}
            color={color}
            roughness={0.9}
            metalness={0}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-2}
            side={side}
        />
    )
}

let curtainTexture = null
let floorLightPoolTexture = null
let wallLightPoolTexture = null
function getCurtainTexture() {
    if (curtainTexture || typeof document === 'undefined') return curtainTexture
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const context = canvas.getContext('2d')
    const gradient = context.createLinearGradient(0, 0, canvas.width, 0)
    for (let index = 0; index <= 16; index += 1) {
        const position = index / 16
        const light = index % 2 === 0 ? 31 : 13
        gradient.addColorStop(position, `hsl(351 45% ${light}%)`)
    }
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)
    const vignette = context.createLinearGradient(0, 0, 0, canvas.height)
    vignette.addColorStop(0, 'rgba(255, 224, 198, 0.12)')
    vignette.addColorStop(0.62, 'rgba(42, 4, 12, 0)')
    vignette.addColorStop(1, 'rgba(24, 2, 8, 0.32)')
    context.fillStyle = vignette
    context.fillRect(0, 0, canvas.width, canvas.height)
    curtainTexture = new THREE.CanvasTexture(canvas)
    curtainTexture.colorSpace = THREE.SRGBColorSpace
    curtainTexture.wrapS = THREE.RepeatWrapping
    curtainTexture.wrapT = THREE.ClampToEdgeWrapping
    curtainTexture.repeat.set(1.75, 1)
    curtainTexture.anisotropy = 2
    curtainTexture.needsUpdate = true
    return curtainTexture
}

function getFloorLightPoolTexture() {
    if (floorLightPoolTexture || typeof document === 'undefined') return floorLightPoolTexture
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 160
    const context = canvas.getContext('2d')
    const gradient = context.createRadialGradient(80, 80, 4, 80, 80, 78)
    gradient.addColorStop(0, 'rgba(255, 215, 166, 0.34)')
    gradient.addColorStop(0.34, 'rgba(236, 168, 96, 0.18)')
    gradient.addColorStop(0.72, 'rgba(171, 91, 42, 0.055)')
    gradient.addColorStop(1, 'rgba(80, 36, 18, 0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)
    floorLightPoolTexture = new THREE.CanvasTexture(canvas)
    floorLightPoolTexture.colorSpace = THREE.SRGBColorSpace
    floorLightPoolTexture.minFilter = THREE.LinearFilter
    floorLightPoolTexture.magFilter = THREE.LinearFilter
    floorLightPoolTexture.needsUpdate = true
    return floorLightPoolTexture
}

function getWallLightPoolTexture() {
    if (wallLightPoolTexture || typeof document === 'undefined') return wallLightPoolTexture
    const canvas = document.createElement('canvas')
    canvas.width = 192
    canvas.height = 160
    const context = canvas.getContext('2d')
    const gradient = context.createRadialGradient(96, 30, 4, 96, 70, 112)
    gradient.addColorStop(0, 'rgba(255, 235, 204, 0.48)')
    gradient.addColorStop(0.3, 'rgba(245, 190, 124, 0.24)')
    gradient.addColorStop(0.7, 'rgba(161, 88, 40, 0.07)')
    gradient.addColorStop(1, 'rgba(70, 34, 18, 0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)
    wallLightPoolTexture = new THREE.CanvasTexture(canvas)
    wallLightPoolTexture.colorSpace = THREE.SRGBColorSpace
    wallLightPoolTexture.minFilter = THREE.LinearFilter
    wallLightPoolTexture.magFilter = THREE.LinearFilter
    wallLightPoolTexture.generateMipmaps = false
    wallLightPoolTexture.needsUpdate = true
    return wallLightPoolTexture
}

function FloorLightPool({ position, size = [4.8, 5.8], opacity = 0.16 }) {
    const map = useMemo(() => getFloorLightPoolTexture(), [])
    return (
        <mesh position={position} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
            <planeGeometry args={size} />
            <meshBasicMaterial
                map={map}
                color="#efb779"
                transparent
                opacity={opacity}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
                toneMapped={false}
            />
        </mesh>
    )
}

function WallpaperPanel({ materials, side, centerZ, width, height = MUSEUM_DIMENSIONS.hallHeight }) {
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    return (
        <mesh
            position={[
                side * (MUSEUM_DIMENSIONS.hallHalfWidth - ((HALL_WALL_THICKNESS / 2) + WALL_SURFACE_GAP)),
                height / 2,
                centerZ,
            ]}
            rotation={[0, rotationY, 0]}
        >
            <planeGeometry args={[width, height]} />
            <WallpaperMaterial materials={materials} width={width} height={height} centerZ={centerZ} reverseU={side < 0} />
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
    shadowKey = '',
}) {
    const light = useRef(null)
    const targetObject = useMemo(() => new THREE.Object3D(), [])
    useEffect(() => {
        if (!castShadow || !light.current?.shadow) return undefined
        const shadow = light.current.shadow
        // The room shell, frames and furniture are already mounted when an
        // active-room slot changes. Render that shadow once, then keep it
        // frozen while camera-aware artwork materials come and go; otherwise
        // a 512px shadow pass needlessly rerenders on every walking frame.
        targetObject.updateMatrixWorld(true)
        light.current.updateMatrixWorld(true)
        shadow.autoUpdate = false
        shadow.needsUpdate = true
        return () => {
            shadow.autoUpdate = true
        }
    }, [castShadow, shadowKey, targetObject])
    return (
        <>
            <primitive object={targetObject} position={target} />
            <spotLight
                ref={light}
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

function getLabelTexture(title, subtitle = '', { width = 1024, height = 256, dark = true } = {}) {
    const key = `${dark ? 'dark' : 'light'}:${width}:${height}:${title}:${subtitle}`
    const cached = labelTextureCache.get(key)
    if (cached) return cached

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
        // Plaques are flat UI-like surfaces. Avoiding per-label mip generation
        // removes a burst of GPU work when a large room is activated.
        next.generateMipmaps = false
        next.minFilter = THREE.LinearFilter
        next.magFilter = THREE.LinearFilter
        next.anisotropy = 1
        next.needsUpdate = true
    labelTextureCache.set(key, next)
    return next
}

function useLabelTexture(title, subtitle = '', options = {}) {
    const { width = 1024, height = 256, dark = true } = options
    return useMemo(
        () => getLabelTexture(title, subtitle, { width, height, dark }),
        [dark, height, subtitle, title, width],
    )
}

function roomPlaqueBatchKey(paintings) {
    return paintings.map(({ album, id }) => (
        `${id}:${album?.title || ''}:${albumPlaqueSubtitle(album)}`
    )).join('|')
}

function getRoomPlaqueBatch(paintings) {
    const key = roomPlaqueBatchKey(paintings)
    const cached = roomPlaqueBatchCache.get(key)
    if (cached) return cached

    const columns = Math.min(4, Math.max(1, paintings.length))
    const rows = Math.max(1, Math.ceil(paintings.length / columns))
    // Preserve the exact per-plaque source resolution; the optimization is a
    // bind/draw-call reduction, not a visible quality tradeoff.
    const tileWidth = 512
    const tileHeight = 128
    const canvas = document.createElement('canvas')
    canvas.width = columns * tileWidth
    canvas.height = rows * tileHeight
    const context = canvas.getContext('2d')
    const parent = new THREE.Matrix4()
    const local = new THREE.Matrix4().makeTranslation(0, -1.55, 0.13)
    const rotation = new THREE.Quaternion()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const geometries = paintings.map((painting, index) => {
        const source = getLabelTexture(
            painting.album.title,
            albumPlaqueSubtitle(painting.album),
            { width: 512, height: 128, dark: false },
        ).image
        const column = index % columns
        const row = Math.floor(index / columns)
        context.drawImage(source, column * tileWidth, row * tileHeight, tileWidth, tileHeight)

        const geometry = new THREE.PlaneGeometry(2.9, 0.62)
        const uv = geometry.getAttribute('uv')
        for (let vertex = 0; vertex < uv.count; vertex += 1) {
            uv.setXY(
                vertex,
                (column + uv.getX(vertex)) / columns,
                ((rows - row - 1) + uv.getY(vertex)) / rows,
            )
        }
        uv.needsUpdate = true
        rotation.setFromEuler(new THREE.Euler(0, painting.rotationY, 0))
        scale.set(...(painting.scale || [1, 1, 1]))
        parent.compose(position.set(...painting.position), rotation, scale)
        geometry.applyMatrix4(parent.multiply(local))
        return geometry
    })
    const geometry = mergeGeometries(geometries, false)
    geometries.forEach(item => item.dispose())
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.generateMipmaps = false
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.anisotropy = 1
    texture.needsUpdate = true
    const batch = { geometry, texture }
    roomPlaqueBatchCache.set(key, batch)
    return batch
}

function RoomPlaqueBatch({ paintings }) {
    const batch = useMemo(() => getRoomPlaqueBatch(paintings), [paintings])
    if (!paintings.length) return null
    return (
        <mesh geometry={batch.geometry}>
            <meshBasicMaterial map={batch.texture} toneMapped={false} />
        </mesh>
    )
}

function albumPlaqueSubtitle(album) {
    const date = album?.createdAt || album?.uploadedAt || ''
    return date ? new Date(`${String(date).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
    }) : 'Photographic series'
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

function useUnavailableArtworkTexture(title, enabled) {
    const texture = useMemo(() => {
        if (!enabled || typeof document === 'undefined') return null
        const canvas = document.createElement('canvas')
        canvas.width = 512
        canvas.height = 320
        const context = canvas.getContext('2d')
        const gradient = context.createLinearGradient(0, 0, 512, 320)
        gradient.addColorStop(0, '#29231f')
        gradient.addColorStop(1, '#14110f')
        context.fillStyle = gradient
        context.fillRect(0, 0, 512, 320)
        context.strokeStyle = '#9b7747'
        context.lineWidth = 5
        context.strokeRect(18, 18, 476, 284)
        context.fillStyle = '#eee5d7'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.font = '500 34px Georgia, serif'
        context.fillText(title, 256, 145, 420)
        context.fillStyle = '#a9957e'
        context.font = '500 18px Helvetica, Arial, sans-serif'
        context.fillText('PREVIEW UNAVAILABLE', 256, 196, 420)
        const next = new THREE.CanvasTexture(canvas)
        next.colorSpace = THREE.SRGBColorSpace
        next.generateMipmaps = false
        next.minFilter = THREE.LinearFilter
        next.magFilter = THREE.LinearFilter
        next.needsUpdate = true
        return next
    }, [enabled, title])
    useEffect(() => () => texture?.dispose(), [texture])
    return texture
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
    const generatedPreviews = previews.map(candidate => candidate.url)
    return [...new Set((targetWidth <= LOW_RES_COVER_WIDTH ? [
        // The API-supplied thumbnail is the one derivative guaranteed to exist
        // for legacy as well as current albums. It must lead the room-opening
        // path; probing four speculative public-preview URLs first could keep a
        // perfectly valid room behind its curtain for 30+ seconds.
        album.coverThumbnailUrl,
        ...generatedPreviews,
        album.coverImageUrl,
    ] : [
        ...generatedPreviews,
        album.coverImageUrl,
        album.coverThumbnailUrl,
    ]).filter(Boolean))]
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
        }, 5200)
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

async function loadDecodedImage(url, highPriority = false) {
    if (typeof createImageBitmap !== 'function') return loadHtmlImage(url, highPriority)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), highPriority ? 6500 : 4500)
    try {
        const response = await fetch(developmentMediaUrl(url), {
            cache: 'force-cache',
            credentials: 'omit',
            priority: highPriority ? 'high' : 'low',
            signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Museum cover request failed (${response.status})`)
        const blob = await response.blob()
        return await createImageBitmap(blob, {
            // WebGL ignores Texture.flipY for ImageBitmap sources, so perform
            // the upload-space flip during off-thread decoding instead.
            imageOrientation: 'flipY',
            premultiplyAlpha: 'none',
        })
    } catch (cause) {
        // A timed-out request or a real HTTP miss will not improve by issuing
        // the same request again through an <img>. Only use that path when the
        // browser rejected fetch/ImageBitmap for compatibility reasons (most
        // notably older Safari CORS implementations).
        if (cause?.name === 'AbortError' || /request failed/.test(cause?.message || '')) {
            throw cause
        }
        // Safari and cross-origin endpoints do not all expose ImageBitmap in
        // the same way. The async HTML image path remains a robust fallback.
        return loadHtmlImage(url, highPriority)
    } finally {
        window.clearTimeout(timeout)
    }
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
                const image = await loadDecodedImage(url, targetWidth > LOW_RES_COVER_WIDTH)
                const texture = new THREE.Texture(image)
                cropMuseumCover(texture, image)
                texture.colorSpace = THREE.SRGBColorSpace
                // Generating mipmaps during a walk-through is a major source of
                // interaction-frame stalls. Linear filtering plus restrained
                // anisotropy stays crisp without that upload penalty.
                texture.minFilter = THREE.LinearFilter
                texture.magFilter = THREE.LinearFilter
                texture.generateMipmaps = false
                texture.anisotropy = targetWidth <= LOW_RES_COVER_WIDTH ? 2 : 4
                texture.userData.museumCacheKey = cacheKey
                texture.userData.museumBytes = Math.round(
                    (image.width || image.naturalWidth || targetWidth)
                    * (image.height || image.naturalHeight || targetWidth)
                    * 4
                    * 1,
                )
                texture.needsUpdate = true
                pinnedCoverTextures.add(texture)
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

function useCoverTexture(album, targetWidth, priority = targetWidth, onPermanentError) {
    const { gl, invalidate } = useThree()
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
                // A room can fall out of the camera residency set while its
                // image is still decoding. Do not promote that stale texture
                // to the GPU after the consumer has gone away.
                .then(texture => (cancelled ? texture : enqueueCoverUpload(gl, texture)))
                .then(texture => {
                    if (!cancelled) {
                        setLoaded(texture)
                        invalidate()
                    }
                })
                .catch((cause) => {
                    if (cancelled) return
                    if (import.meta.env.DEV) {
                        const errors = JSON.parse(document.documentElement.dataset.museumCoverErrors || '[]')
                        errors.push({
                            albumId: album.albumId,
                            targetWidth,
                            attempt,
                            message: cause?.message || String(cause),
                        })
                        document.documentElement.dataset.museumCoverErrors = JSON.stringify(errors.slice(-40))
                    }
                    if (attempt >= 2) {
                        onPermanentError?.()
                        return
                    }
                    retryTimer = window.setTimeout(() => load(attempt + 1), 500 * (attempt + 1))
                })
        }
        load()

        return () => {
            cancelled = true
            window.clearTimeout(retryTimer)
        }
    }, [album, cacheKey, gl, invalidate, onPermanentError, priority, targetWidth])

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

function RoomFrameShells({ paintings, materials }) {
    const shadow = useRef(null)
    const glow = useRef(null)
    const backing = useRef(null)
    const frame = useRef(null)
    const mat = useRef(null)
    const canvas = useRef(null)
    const lamp = useRef(null)
    const wallGlow = useMemo(() => getWallLightPoolTexture(), [])
    const roundedBacking = useMemo(() => new RoundedBoxGeometry(1, 1, 1, 2, 0.035), [])
    const roundedFrame = useMemo(() => new RoundedBoxGeometry(1, 1, 1, 2, 0.045), [])

    useEffect(() => () => {
        roundedBacking.dispose()
        roundedFrame.dispose()
    }, [roundedBacking, roundedFrame])

    useEffect(() => {
        const parent = new THREE.Matrix4()
        const local = new THREE.Matrix4()
        const matrix = new THREE.Matrix4()
        const position = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        const scale = new THREE.Vector3()
        const parentRotation = new THREE.Quaternion()
        const paintingScale = new THREE.Vector3()
        const batches = [
            [shadow.current, [0.1, -0.12, -0.105], [0, 0, 0], [3.55, 2.64, 1]],
            [glow.current, [0, 0.28, -0.125], [0, 0, 0], [5.9, 4.8, 1]],
            [backing.current, [0, -0.04, -0.08], [0, 0, 0], [4.15, 4.45, 0.08]],
            [frame.current, [0, 0, 0], [0, 0, 0], [3.24, 2.34, 0.14]],
            [mat.current, [0, 0, 0.1], [0, 0, 0], [3, 2.1, 0.08]],
            [canvas.current, [0, 0, 0.151], [0, 0, 0], [2.66, 1.76, 1]],
            [lamp.current, [0, 1.72, 0.28], [0.16, 0, 0], [1.45, 0.08, 0.11]],
        ]
        paintings.forEach((painting, index) => {
            parentRotation.setFromEuler(new THREE.Euler(0, painting.rotationY, 0))
            paintingScale.set(...(painting.scale || [1, 1, 1]))
            parent.compose(position.set(...painting.position), parentRotation, paintingScale)
            batches.forEach(([mesh, localPosition, localRotation, localScale]) => {
                if (!mesh) return
                rotation.setFromEuler(new THREE.Euler(...localRotation))
                local.compose(position.set(...localPosition), rotation, scale.set(...localScale))
                matrix.multiplyMatrices(parent, local)
                mesh.setMatrixAt(index, matrix)
            })
            // A quiet cool/warm alternation gives the room photographic depth
            // without adding another real light or draw call.
            glow.current?.setColorAt(
                index,
                new THREE.Color(index % 4 === 2 ? '#a9bfd0' : '#edb478'),
            )
        })
        batches.forEach(([mesh]) => {
            if (!mesh) return
            mesh.instanceMatrix.needsUpdate = true
            mesh.computeBoundingSphere?.()
        })
        if (glow.current?.instanceColor) {
            glow.current.instanceColor.needsUpdate = true
            glow.current.material.needsUpdate = true
        }
    }, [paintings])

    const count = paintings.length
    if (!count) return null
    return (
        <>
            <RoomPlaqueBatch paintings={paintings} />
            <instancedMesh ref={shadow} args={[undefined, undefined, count]} renderOrder={1}>
                <planeGeometry args={[1, 1]} />
                <meshBasicMaterial
                    color="#120d09"
                    transparent
                    opacity={0.24}
                    depthWrite={false}
                    polygonOffset
                    polygonOffsetFactor={-1}
                    polygonOffsetUnits={-1}
                />
            </instancedMesh>
            <instancedMesh ref={glow} args={[undefined, undefined, count]} renderOrder={1}>
                <planeGeometry args={[1, 1]} />
                <meshBasicMaterial
                    map={wallGlow}
                    color="#ffffff"
                    transparent
                    opacity={0.72}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
                />
            </instancedMesh>
            <instancedMesh ref={backing} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedBacking} attach="geometry" />
                <meshStandardMaterial color="#c8c0b3" roughness={0.93} />
            </instancedMesh>
            <instancedMesh ref={frame} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedFrame} attach="geometry" />
                <meshPhysicalMaterial
                    map={materials.joinery.map}
                    bumpMap={materials.joinery.map}
                    bumpScale={0.012}
                    color={GOLD}
                    roughness={0.34}
                    metalness={0.66}
                    clearcoat={0.25}
                    clearcoatRoughness={0.5}
                />
            </instancedMesh>
            <instancedMesh ref={mat} args={[undefined, undefined, count]} castShadow receiveShadow>
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial color="#f7f2e8" roughness={0.72} />
            </instancedMesh>
            <instancedMesh ref={canvas} args={[undefined, undefined, count]}>
                <planeGeometry args={[1, 1]} />
                <meshStandardMaterial color="#28241f" roughness={0.96} />
            </instancedMesh>
            <instancedMesh ref={lamp} args={[undefined, undefined, count]}>
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial color="#9b7c59" emissive="#e1a765" emissiveIntensity={0.68} metalness={0.45} roughness={0.42} />
            </instancedMesh>
        </>
    )
}

function Painting({ painting, targetWidth = 0, loadLow = false, lowPriority = 0, onTextureReady }) {
    const [lowFailed, setLowFailed] = useState(false)
    const markLowFailed = useCallback(() => setLowFailed(true), [])
    const lowTexture = useCoverTexture(
        painting.album,
        loadLow ? LOW_RES_COVER_WIDTH : 0,
        5000 + lowPriority,
        markLowFailed,
    )
    const detailTexture = useCoverTexture(
        painting.album,
        lowTexture && targetWidth > LOW_RES_COVER_WIDTH ? targetWidth : 0,
        targetWidth,
    )
    const unavailableTexture = useUnavailableArtworkTexture(painting.album.title, lowFailed)
    const texture = detailTexture || lowTexture || (lowFailed ? unavailableTexture : null)
    const artworkMaterial = useRef(null)

    useEffect(() => {
        if (!texture) return
        if (artworkMaterial.current) artworkMaterial.current.opacity = 0
        onTextureReady?.(painting.id)
    }, [onTextureReady, painting.id, texture])
    useFrame((state, delta) => {
        if (texture && artworkMaterial.current && artworkMaterial.current.opacity < 1) {
            artworkMaterial.current.opacity = Math.min(1, artworkMaterial.current.opacity + (delta * 4.5))
        }
    })

    return (
        <group position={painting.position} rotation={[0, painting.rotationY, 0]} scale={painting.scale || [1, 1, 1]}>
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
        </group>
    )
}

function CameraAwareRoomPaintings({ room, active, detailed, allowDetail, qualityLighting, materials, readyPaintingIds, onTextureReady }) {
    const { camera } = useThree()
    const baselineSelection = useMemo(() => room.paintings.map(painting => ({
        painting,
        targetWidth: LOW_RES_COVER_WIDTH,
    })), [room.paintings])
    const initialSelection = useMemo(() => baselineSelection.slice(0, Math.min(4, baselineSelection.length)), [baselineSelection])
    const [selection, setSelection] = useState(() => (active ? initialSelection : []))
    const selectionRef = useRef(active ? initialSelection : [])
    const hasActivated = useRef(active)
    const selectionKey = useRef((active ? initialSelection : []).map(item => `${item.painting.id}:${item.targetWidth}`).join('|'))
    const selectionSeenAt = useRef(new Map())
    const detailFocus = useRef({ id: null, since: 0 })
    const activatedAt = useRef(null)
    const activationFloorCount = useRef(active ? initialSelection.length : 0)
    const lastProbe = useRef(-1)
    const projection = useMemo(() => new THREE.Matrix4(), [])
    const frustum = useMemo(() => new THREE.Frustum(), [])
    const sphere = useMemo(() => new THREE.Sphere(new THREE.Vector3(), 2.5), [])
    const viewDirection = useMemo(() => new THREE.Vector3(), [])
    const toPainting = useMemo(() => new THREE.Vector3(), [])

    useEffect(() => {
        let timer
        activatedAt.current = null
        detailFocus.current = { id: null, since: 0 }
        if (active) {
            hasActivated.current = true
            activationFloorCount.current = initialSelection.length
            timer = window.setTimeout(() => {
                if (activationFloorCount.current > initialSelection.length) return
                const nextKey = initialSelection.map(item => `${item.painting.id}:${item.targetWidth}`).join('|')
                selectionKey.current = nextKey
                selectionRef.current = initialSelection
                setSelection(initialSelection)
            }, 0)
        } else {
            activationFloorCount.current = 0
            // A room's first four low-resolution covers become its permanent,
            // bounded revisit set only after the visitor has reached that bay.
            // This keeps the cold start small while ensuring a later circuit
            // never has to reopen a gate onto an empty room or redownload its
            // readiness images. At 480px this is a small, predictable budget.
            timer = window.setTimeout(() => {
                const next = hasActivated.current ? initialSelection : []
                selectionKey.current = next.map(item => `${item.painting.id}:${item.targetWidth}`).join('|')
                selectionRef.current = next
                selectionSeenAt.current.clear()
                setSelection(next)
            }, 620)
        }
        return () => window.clearTimeout(timer)
    }, [active, initialSelection])
    useEffect(() => {
        if (!active || !readyPaintingIds?.size) return
        const resident = baselineSelection.filter(({ painting }) => readyPaintingIds.has(painting.id))
        if (resident.length <= activationFloorCount.current) return
        // A revisit must never replay the first-visit streaming reveal for
        // textures that are already decoded and resident. Remount every ready
        // work immediately, then let the normal bounded streamer handle only
        // genuinely missing frames. This removes black-frame flashes on rapid
        // second and third circuits without creating new network/GPU bursts.
        activationFloorCount.current = resident.length
        const residentIds = new Set(resident.map(item => item.painting.id))
        const promoted = new Map(selectionRef.current.map(item => [item.painting.id, item]))
        const next = baselineSelection
            .filter(item => residentIds.has(item.painting.id))
            .map(item => promoted.get(item.painting.id) || item)
        const nextKey = next.map(item => `${item.painting.id}:${item.targetWidth}`).join('|')
        if (nextKey === selectionKey.current) return
        selectionKey.current = nextKey
        selectionRef.current = next
        const timer = window.setTimeout(() => setSelection(next), 0)
        return () => window.clearTimeout(timer)
    }, [active, baselineSelection, readyPaintingIds])
    useEffect(() => {
        if (!import.meta.env.DEV) return
        const current = JSON.parse(document.documentElement.dataset.museumSelections || '{}')
        current[room.id] = {
            active,
            count: selection.length,
            ids: selection.map(item => item.painting.id),
        }
        document.documentElement.dataset.museumSelections = JSON.stringify(current)
    }, [active, room.id, selection])

    useFrame((state) => {
        if (!active) return
        if (activatedAt.current === null) activatedAt.current = state.clock.elapsedTime
        const activationAge = state.clock.elapsedTime - activatedAt.current
        // Desktop galleries should eventually finish hanging every authored
        // work. The old fixed ceiling of twenty left the final bay of larger
        // collections looking permanently unfinished. Lower-power profiles
        // retain a conservative cap, while the camera/frustum selection below
        // still prevents off-screen textures from mounting all at once.
        const maximum = detailed
            ? (qualityLighting ? Math.min(room.paintings.length, 28) : Math.min(room.paintings.length, 18))
            : Math.min(room.paintings.length, 12)
        const warmupDuration = 0.72
        if (activationAge < warmupDuration) {
            const stagedCount = Math.min(
                baselineSelection.length,
                Math.max(4, activationFloorCount.current),
            )
            const staged = baselineSelection.slice(0, stagedCount)
            const stagedKey = staged.map(item => `${item.painting.id}:${item.targetWidth}`).join('|')
            if (stagedKey !== selectionKey.current) {
                selectionKey.current = stagedKey
                selectionRef.current = staged
                setSelection(staged)
            }
            return
        }
        if (state.clock.elapsedTime - lastProbe.current < 0.16) return
        lastProbe.current = state.clock.elapsedTime
        camera.updateMatrixWorld()
        projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        frustum.setFromProjectionMatrix(projection)
        camera.getWorldDirection(viewDirection)

        const entranceDistance = Math.hypot(
            camera.position.x - room.entrance[0],
            camera.position.z - room.entrance[2],
        )
        const candidates = room.paintings.map((painting, index) => {
            sphere.center.set(...painting.position)
            toPainting.copy(sphere.center).sub(camera.position)
            const distance = toPainting.length()
            const facing = distance > 0 ? viewDirection.dot(toPainting.multiplyScalar(1 / distance)) : 1
            const visible = frustum.intersectsSphere(sphere) && facing > -0.12
            const entranceWarmup = entranceDistance < 12 && index < 4
            return { painting, distance, facing, visible: visible || entranceWarmup }
        }).filter(candidate => candidate.visible && candidate.distance < 68)
            .sort((left, right) => left.distance - right.distance)

        // Textures have already been resident since the opening preload. Keep
        // every artwork the camera can plausibly see mounted so long galleries
        // never end in conspicuous dark canvases, while still avoiding the
        // per-frame cost of mounting the whole room.
        // Never turn room activation into a burst of 15-20 simultaneous image
        // decodes/uploads. Keep four entrance works ready for the curtain,
        // then admit one additional visible work every 360 ms. Frames and
        // plaques stay mounted, so this affects I/O rather than architecture.
        const streamBudget = Math.min(
            maximum,
            Math.max(
                activationFloorCount.current,
                4 + Math.floor(Math.max(0, activationAge - warmupDuration) / 0.32),
            ),
        )
        const focusCandidate = candidates.find(({ distance, facing }) => (
            allowDetail && distance < 8 && facing > 0.22
        ))
        if (focusCandidate?.painting.id !== detailFocus.current.id) {
            detailFocus.current = {
                id: focusCandidate?.painting.id || null,
                since: state.clock.elapsedTime,
            }
        }
        const stableDetailId = focusCandidate
            && state.clock.elapsedTime - detailFocus.current.since >= 0.6
            ? focusCandidate.painting.id
            : null
        const candidateIds = new Set(candidates.map(candidate => candidate.painting.id))
        // Visible work always wins the queue, but once that foreground set is
        // ready continue filling the remaining authored frames in wall order.
        // This preserves the gentle one-at-a-time upload cadence while making
        // it impossible for a large room to retain conspicuous blank mats.
        const streamCandidates = [
            ...candidates,
            ...room.paintings
                .filter(painting => !candidateIds.has(painting.id))
                .map(painting => ({ painting, distance: Infinity, facing: -1 })),
        ]
        const next = streamCandidates.slice(0, streamBudget).map(({ painting, distance, facing }) => {
            const shouldPromote = painting.id === stableDetailId
                && distance < 8
                && facing > 0.22
            selectionSeenAt.current.set(painting.id, state.clock.elapsedTime)
            return {
                painting,
                targetWidth: shouldPromote
                    ? (qualityLighting ? 1600 : 960)
                    : LOW_RES_COVER_WIDTH,
            }
        })
        // Keep a small entrance set resident when the visitor turns away. The
        // previous all-room fallback was the main cause of mass decode/upload
        // bursts while walking between galleries.
        const primary = next.length ? next : initialSelection
        const primaryIds = new Set(primary.map(item => item.painting.id))
        const retained = selectionRef.current.filter((item) => {
            if (primaryIds.has(item.painting.id)) return false
            const lastSeen = selectionSeenAt.current.get(item.painting.id) || 0
            sphere.center.set(...item.painting.position)
            const distance = camera.position.distanceTo(sphere.center)
            return state.clock.elapsedTime - lastSeen < 0.72 && distance < 74
        })
        const effective = [...primary, ...retained]
            .slice(0, maximum)
            .sort((left, right) => room.paintings.indexOf(left.painting) - room.paintings.indexOf(right.painting))
        const nextKey = effective.map(item => `${item.painting.id}:${item.targetWidth}`).join('|')
        if (nextKey === selectionKey.current) return
        selectionKey.current = nextKey
        selectionRef.current = effective
        setSelection(effective)
    })

    // Frame, mat, plaque and picture-light geometry always stays present while
    // a room is active. The camera-aware selection controls texture I/O only.
    // This preserves the authored gallery rhythm and removes geometry pop-in,
    // while Three.js still frustum-culls shells that are outside the view.
    return (
        <>
            <RoomFrameShells paintings={room.paintings} materials={materials} />
            {selection.map(({ painting, targetWidth }) => {
                const paintingIndex = room.paintings.indexOf(painting)
                const lowPriority = room.paintings.length - paintingIndex
                return (
                    <Painting
                        key={painting.id}
                        painting={painting}
                        targetWidth={targetWidth}
                        loadLow={targetWidth > 0}
                        lowPriority={lowPriority}
                        onTextureReady={onTextureReady}
                    />
                )
            })}
        </>
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
                    room.outerX - (room.side * ((wallThickness / 2) + WALL_SURFACE_GAP)),
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
                    reverseU={room.side < 0}
                />
            </mesh>
            {[-1, 1].map(direction => (
                <mesh
                    receiveShadow
                    key={direction}
                    position={[
                        shellCenterX,
                        ceilingY / 2,
                        room.centerZ + direction * ((room.width / 2) - ((wallThickness / 2) + WALL_SURFACE_GAP)),
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
                        reverseU={direction > 0}
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

function VelvetCurtainMaterial({ map }) {
    return (
        <meshPhysicalMaterial
            map={map}
            bumpMap={map}
            bumpScale={0.035}
            color="#7b2835"
            roughness={0.82}
            sheen={0.7}
            sheenColor="#c7737b"
            sheenRoughness={0.76}
            side={THREE.DoubleSide}
        />
    )
}

function makePleatedCurtainGeometry(width, height, depth = 0.2, pleats = 11) {
    const geometry = new THREE.BufferGeometry()
    const positions = []
    const uvs = []
    const indices = []
    const segments = pleats * 2

    const addQuad = (corners, quadUvs) => {
        const offset = positions.length / 3
        corners.forEach(([x, y, z]) => positions.push(x, y, z))
        quadUvs.forEach(([u, v]) => uvs.push(u, v))
        indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
    }

    const edge = (index, front) => {
        const ratio = index / segments
        const x = (-width / 2) + (ratio * width)
        const fold = Math.sin(ratio * pleats * Math.PI * 2)
        const z = (front ? depth / 2 : -depth / 2) + (fold * depth * (front ? 0.34 : 0.16))
        return { ratio, x, z }
    }

    for (let index = 0; index < segments; index += 1) {
        const frontA = edge(index, true)
        const frontB = edge(index + 1, true)
        const backA = edge(index, false)
        const backB = edge(index + 1, false)
        addQuad(
            [[frontA.x, 0, frontA.z], [frontB.x, 0, frontB.z], [frontB.x, height, frontB.z], [frontA.x, height, frontA.z]],
            [[frontA.ratio, 0], [frontB.ratio, 0], [frontB.ratio, 1], [frontA.ratio, 1]],
        )
        addQuad(
            [[backB.x, 0, backB.z], [backA.x, 0, backA.z], [backA.x, height, backA.z], [backB.x, height, backB.z]],
            [[backB.ratio, 0], [backA.ratio, 0], [backA.ratio, 1], [backB.ratio, 1]],
        )
        addQuad(
            [[backA.x, height, backA.z], [frontA.x, height, frontA.z], [frontB.x, height, frontB.z], [backB.x, height, backB.z]],
            [[frontA.ratio, 0], [frontA.ratio, 1], [frontB.ratio, 1], [frontB.ratio, 0]],
        )
        addQuad(
            [[backB.x, 0, backB.z], [frontB.x, 0, frontB.z], [frontA.x, 0, frontA.z], [backA.x, 0, backA.z]],
            [[frontB.ratio, 0], [frontB.ratio, 1], [frontA.ratio, 1], [frontA.ratio, 0]],
        )
    }

    const frontLeft = edge(0, true)
    const backLeft = edge(0, false)
    const frontRight = edge(segments, true)
    const backRight = edge(segments, false)
    addQuad(
        [[backLeft.x, 0, backLeft.z], [frontLeft.x, 0, frontLeft.z], [frontLeft.x, height, frontLeft.z], [backLeft.x, height, backLeft.z]],
        [[0, 0], [1, 0], [1, 1], [0, 1]],
    )
    addQuad(
        [[frontRight.x, 0, frontRight.z], [backRight.x, 0, backRight.z], [backRight.x, height, backRight.z], [frontRight.x, height, frontRight.z]],
        [[0, 0], [1, 0], [1, 1], [0, 1]],
    )

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
}

function RoomPortalScrim({ room, ready }) {
    const left = useRef(null)
    const right = useRef(null)
    const progress = useRef(ready ? 1 : 0)
    const curtainMap = useMemo(() => getCurtainTexture(), [])
    const panelWidth = (MUSEUM_DIMENSIONS.doorwayWidth / 2) + 0.18
    const panelHeight = 4.5
    const curtainGeometry = useMemo(
        () => makePleatedCurtainGeometry(panelWidth, panelHeight),
        [panelHeight, panelWidth],
    )
    useEffect(() => () => curtainGeometry.dispose(), [curtainGeometry])
    useEffect(() => {
        if (!ready) openMuseumPortalIds.delete(room.id)
        return () => openMuseumPortalIds.delete(room.id)
    }, [ready, room.id])
    useFrame((_, delta) => {
        progress.current = THREE.MathUtils.damp(progress.current, ready ? 1 : 0, ready ? 4.8 : 8, delta)
        if (ready && progress.current >= 0.88) openMuseumPortalIds.add(room.id)
        else openMuseumPortalIds.delete(room.id)
        ;[[-1, left.current], [1, right.current]].forEach(([direction, group]) => {
            if (!group) return
            group.position.x = direction * ((panelWidth / 2) + (progress.current * 1.92))
            group.scale.x = Math.max(0.14, 1 - (progress.current * 0.86))
        })
    })
    const rotationY = room.side < 0 ? Math.PI / 2 : -Math.PI / 2
    return (
        <group
            // The curtain has real depth and retracts into side pockets rather
            // than vanishing. It therefore holds up from oblique views and can
            // never reveal an empty portal while a room is still streaming.
            position={[room.innerX + (room.side * 0.64), 0, room.centerZ]}
            rotation={[0, rotationY, 0]}
        >
            <mesh position={[0, 4.34, 0]} castShadow receiveShadow>
                <boxGeometry args={[MUSEUM_DIMENSIONS.doorwayWidth + 0.46, 0.34, 0.28]} />
                <meshStandardMaterial color="#5a1c27" roughness={0.88} />
            </mesh>
            {[-1, 1].map(direction => (
                <mesh key={`curtain-pocket-${direction}`} position={[direction * 3.14, 2.18, 0]} castShadow receiveShadow>
                    <boxGeometry args={[0.54, 4.36, 0.34]} />
                    <meshStandardMaterial color="#4a1821" roughness={0.9} />
                </mesh>
            ))}
            <group ref={left} position={[-panelWidth / 2, 0, 0]}>
                <mesh castShadow receiveShadow>
                    <primitive object={curtainGeometry} attach="geometry" />
                    <VelvetCurtainMaterial map={curtainMap} />
                </mesh>
                <mesh position={[-(panelWidth * 0.28), 1.48, 0.12]} rotation={[Math.PI / 2, 0, 0]}>
                    <torusGeometry args={[0.14, 0.035, 7, 14]} />
                    <meshStandardMaterial color="#b98c53" metalness={0.72} roughness={0.28} />
                </mesh>
            </group>
            <group ref={right} position={[panelWidth / 2, 0, 0]}>
                <mesh castShadow receiveShadow>
                    <primitive object={curtainGeometry} attach="geometry" />
                    <VelvetCurtainMaterial map={curtainMap} />
                </mesh>
                <mesh position={[panelWidth * 0.28, 1.48, 0.12]} rotation={[Math.PI / 2, 0, 0]}>
                    <torusGeometry args={[0.14, 0.035, 7, 14]} />
                    <meshStandardMaterial color="#b98c53" metalness={0.72} roughness={0.28} />
                </mesh>
            </group>
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

function useArchOpeningShape() {
    return useMemo(() => {
        const radius = MUSEUM_DIMENSIONS.doorwayWidth / 2
        const springHeight = 2.7
        const archRise = 1.55
        const shape = new THREE.Shape()
        shape.moveTo(-radius, 0)
        shape.lineTo(-radius, springHeight)
        for (let segment = 0; segment <= 18; segment += 1) {
            const angle = Math.PI - ((Math.PI * segment) / 18)
            shape.lineTo(
                Math.cos(angle) * radius,
                springHeight + (Math.sin(angle) * archRise),
            )
        }
        shape.lineTo(radius, 0)
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
                            side * (MUSEUM_DIMENSIONS.hallHalfWidth - ((thickness / 2) + WALL_SURFACE_GAP)),
                            0,
                            centerZ,
                        ]}
                        rotation={[0, rotationY, 0]}
                    >
                        <extrudeGeometry args={[spandrelShape, {
                            depth: thickness + (WALL_SURFACE_GAP * 2),
                            bevelEnabled: false,
                            steps: 1,
                            curveSegments: 24,
                        }]} />
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
                        wallX - (side * ((thickness / 2) + 0.045)),
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
                        <meshStandardMaterial
                            map={materials.joinery.map}
                            bumpMap={materials.joinery.map}
                            bumpScale={0.01}
                            color="#c9bda9"
                            roughness={0.72}
                        />
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
                    <group
                        position={[wallX - (side * 0.34), 4.6, centerZ]}
                        rotation={[0, rotationY, 0]}
                    >
                        {[-1.42, 1.42].map(offset => (
                            <mesh key={offset} position={[offset, 0.31, -0.09]} rotation={[Math.PI / 2, 0, 0]} castShadow>
                                <cylinderGeometry args={[0.035, 0.035, 0.24, 8]} />
                                <meshStandardMaterial color="#80603a" metalness={0.62} roughness={0.36} />
                            </mesh>
                        ))}
                        <mesh position={[0, 0, -0.032]} castShadow>
                            <boxGeometry args={[3.25, 0.74, 0.09]} />
                            <meshPhysicalMaterial
                                map={materials.joinery.map}
                                bumpMap={materials.joinery.map}
                                bumpScale={0.01}
                                color="#9b7747"
                                metalness={0.62}
                                roughness={0.32}
                                clearcoat={0.24}
                            />
                        </mesh>
                        <mesh position={[0, 0, 0.025]}>
                            <boxGeometry args={[3.07, 0.56, 0.055]} />
                            <meshStandardMaterial color="#181411" roughness={0.72} />
                        </mesh>
                        <LabelPlane
                            title={room.name}
                            subtitle={`${room.albums.length} ${room.albums.length === 1 ? 'album' : 'albums'}`}
                            position={[0, 0, 0.058]}
                            size={[2.98, 0.5]}
                        />
                    </group>
                </>
            )}
        </group>
    )
}

function FarDoorWall({ side, centerZ, room, materials }) {
    const wallX = side * MUSEUM_DIMENSIONS.hallHalfWidth
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    const openingShape = useArchOpeningShape()
    const archCurve = useArchTrimCurve()

    return (
        <group>
            <mesh position={[wallX, MUSEUM_DIMENSIONS.hallHeight / 2, centerZ]}>
                <boxGeometry args={[HALL_WALL_THICKNESS, MUSEUM_DIMENSIONS.hallHeight, MUSEUM_DIMENSIONS.baySpacing]} />
                <PlasterMaterial materials={materials} color={HALL_PAINT} textured={false} />
            </mesh>
            <WallpaperPanel
                materials={materials}
                side={side}
                centerZ={centerZ}
                width={MUSEUM_DIMENSIONS.baySpacing}
            />
            {room && (
                <>
                    {/* From a distance the real room is hidden by an intentional
                        velvet portal rather than an obvious loading blocker. */}
                    <mesh
                        position={[wallX - (side * ((HALL_WALL_THICKNESS / 2) + 0.044)), 0.02, centerZ]}
                        rotation={[0, rotationY, 0]}
                    >
                        <shapeGeometry args={[openingShape, 18]} />
                        <meshStandardMaterial color="#251116" roughness={0.93} side={THREE.DoubleSide} />
                    </mesh>
                    <mesh
                        position={[wallX - (side * ((HALL_WALL_THICKNESS / 2) + 0.052)), 0, centerZ]}
                        rotation={[0, rotationY, 0]}
                    >
                        <tubeGeometry args={[archCurve, 20, 0.12, 6, false]} />
                        <meshStandardMaterial
                            map={materials.joinery.map}
                            bumpMap={materials.joinery.map}
                            bumpScale={0.01}
                            color="#c9bda9"
                            roughness={0.72}
                        />
                    </mesh>
                    <LabelPlane
                        title={room.name}
                        subtitle={`${room.albums.length} ${room.albums.length === 1 ? 'album' : 'albums'}`}
                        position={[wallX - (side * 0.225), 4.78, centerZ]}
                        rotation={[0, rotationY, 0]}
                        size={[3.02, 0.58]}
                    />
                </>
            )}
        </group>
    )
}

function DistanceManagedDoorWall({ side, centerZ, room, materials, forceNear = false }) {
    if (!room) return <FarDoorWall side={side} centerZ={centerZ} room={null} materials={materials} />
    // Portals are part of the architectural silhouette, so they deliberately
    // keep one geometry at every distance. Swapping a flat far impostor for a
    // deep near doorway caused the arch, plaque, and curtain to visibly pop as
    // visitors crossed the streaming threshold.
    return <DoorWall side={side} centerZ={centerZ} room={room} materials={materials} forceNear={forceNear} />
}

function VaultedCeiling({ layout, centerZ, materials }) {
    const { geometry, ribCurve } = useMemo(() => {
        const radius = 6.35
        const centerY = 0.85
        const start = Math.acos(MUSEUM_DIMENSIONS.hallHalfWidth / radius)
        const end = Math.PI - start
        const count = 32
        const frontZ = centerZ + (layout.hallLength / 2)
        // Stop the vault just in front of the terminal wall. Ending on the
        // exact same plane produced the striped/hatched z-fighting visible at
        // the back of the corridor.
        const backZ = centerZ - (layout.hallLength / 2) + 0.14
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
                <mesh key={side} position={[side * (MUSEUM_DIMENSIONS.hallHalfWidth - 0.06), 4.98, centerZ + 0.14]}>
                    <boxGeometry args={[0.16, 0.22, Math.max(1, layout.hallLength - 0.28)]} />
                    <meshStandardMaterial color="#b8aa95" roughness={0.72} />
                </mesh>
            ))}
        </group>
    )
}

function FixedRoomLighting({ rooms, qualityLighting }) {
    const slots = [rooms[0] || null, rooms[1] || null]
    return slots.flatMap((room, slotIndex) => {
        const centerX = room ? room.centerX + (room.side * (ROOM_SHELL_INSET / 2)) : 0
        const centerZ = room?.centerZ || -500
        const targetX = room ? room.outerX - (room.side * 0.62) : 0
        const halfWidth = room ? Math.max(1.5, room.width * 0.27) : 1.5
        const intensity = room
            ? (qualityLighting ? (slotIndex === 0 ? 38 : 30) : 23)
            : 0
        return [-1, 1].map(direction => (
            <StaticSpotlight
                key={`fixed-room-light-${slotIndex}-${direction}`}
                position={[centerX, 5.78, centerZ + (direction * 1.25)]}
                target={[targetX, 2.18, centerZ + (direction * halfWidth)]}
                color={direction < 0 ? '#ffd3a0' : '#d9c7b7'}
                intensity={intensity}
                distance={12}
                angle={0.48}
                penumbra={0.82}
                castShadow={qualityLighting && slotIndex === 0 && direction < 0}
                shadowKey={room?.id || 'inactive'}
            />
        ))
    })
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
    const thresholdDepth = ROOM_SHELL_INSET + HALL_WALL_THICKNESS + 0.18
    const thresholdCenterX = room.innerX + (room.side * ((ROOM_SHELL_INSET - HALL_WALL_THICKNESS) / 2))
    const [readyPaintingIds, setReadyPaintingIds] = useState(() => new Set())
    const readyPaintingIdsRef = useRef(new Set())
    const readyFlushTimer = useRef(null)
    const [allowDetail, setAllowDetail] = useState(false)
    const [interiorVisible, setInteriorVisible] = useState(active)
    const roomPaintingIds = useMemo(() => new Set(
        room.paintings.slice(0, Math.min(4, room.paintings.length)).map(painting => painting.id),
    ), [room.paintings])
    // One transient or legacy derivative must not strand a whole gallery behind
    // its portal. Three resident works are enough to establish a convincing
    // first sightline while the fourth continues through its bounded fallback.
    const requiredReadyCount = Math.min(roomPaintingIds.size, 3)
    const roomReady = active && [...roomPaintingIds]
        .filter(id => readyPaintingIds.has(id)).length >= requiredReadyCount
    useEffect(() => {
        if (!import.meta.env.DEV) return
        const current = JSON.parse(document.documentElement.dataset.museumRooms || '{}')
        current[room.id] = {
            active,
            interiorVisible,
            roomReady,
            ready: readyPaintingIds.size,
            required: requiredReadyCount,
            readyIds: [...readyPaintingIds],
            requiredIds: [...roomPaintingIds],
        }
        document.documentElement.dataset.museumRooms = JSON.stringify(current)
    }, [active, interiorVisible, readyPaintingIds, requiredReadyCount, room.id, roomPaintingIds, roomReady])
    useEffect(() => {
        // Keep the previous room behind its closing curtain briefly. The old
        // immediate unmount exposed an empty void for the duration of the
        // curtain animation when residency moved to the next bay.
        const timer = window.setTimeout(
            () => setInteriorVisible(active),
            active ? 0 : 560,
        )
        return () => window.clearTimeout(timer)
    }, [active])
    useEffect(() => {
        let timer
        if (!active) {
            timer = window.setTimeout(() => setAllowDetail(false), 0)
        } else if (!detailed || !roomReady) {
            timer = window.setTimeout(() => setAllowDetail(false), 0)
        } else {
            // Let the portal complete and the player settle before one nearby
            // painting upgrades. Entry frames should only ever show cached lows.
            timer = window.setTimeout(() => setAllowDetail(true), 700)
        }
        return () => {
            window.clearTimeout(timer)
            window.clearTimeout(readyFlushTimer.current)
        }
    }, [active, detailed, roomReady])
    const markPaintingReady = useCallback((paintingId) => {
        if (readyPaintingIdsRef.current.has(paintingId)) return
        readyPaintingIdsRef.current.add(paintingId)
        if (readyFlushTimer.current) return
        readyFlushTimer.current = window.setTimeout(() => {
            readyFlushTimer.current = null
            setReadyPaintingIds(new Set(readyPaintingIdsRef.current))
        }, 72)
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
            <group>
                <mesh position={[thresholdCenterX, -0.02, room.centerZ]} receiveShadow>
                    <boxGeometry args={[thresholdDepth, 0.16, MUSEUM_DIMENSIONS.doorwayWidth - 0.18]} />
                    <FloorMaterial materials={materials} color="#73573f" />
                </mesh>
                <mesh position={[thresholdCenterX, 0.055, room.centerZ]}>
                    <boxGeometry args={[thresholdDepth - 0.08, 0.025, MUSEUM_DIMENSIONS.doorwayWidth - 0.38]} />
                    <meshPhysicalMaterial color="#9b7747" metalness={0.62} roughness={0.38} />
                </mesh>
                {[-1, 1].map(direction => (
                    <mesh
                        key={`portal-return-${direction}`}
                        position={[
                            thresholdCenterX,
                            1.34,
                            room.centerZ + (direction * ((MUSEUM_DIMENSIONS.doorwayWidth / 2) + 0.12)),
                        ]}
                    >
                        <boxGeometry args={[thresholdDepth, 2.68, 0.22]} />
                        <meshStandardMaterial color="#b9aa95" roughness={0.76} />
                    </mesh>
                ))}
            </group>
            <group visible={active || interiorVisible}>
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
                    <mesh position={[shellCenterX, 0.16, room.centerZ + direction * ((roomWidth / 2) - 0.26)]}>
                        <boxGeometry args={[shellDepth, 0.32, 0.18]} />
                        <meshStandardMaterial color="#887763" roughness={0.7} />
                    </mesh>
                    <mesh position={[shellCenterX, 0.035, room.centerZ + direction * ((roomWidth / 2) - 0.34)]}>
                        <boxGeometry args={[Math.max(0.5, shellDepth - 0.3), 0.055, 0.3]} />
                        <meshBasicMaterial color="#160f0c" transparent opacity={0.4} depthWrite={false} />
                    </mesh>
                    <mesh position={[shellCenterX, 5.56, room.centerZ + direction * ((roomWidth / 2) - 0.28)]}>
                        <boxGeometry args={[shellDepth, 0.18, 0.22]} />
                        <meshStandardMaterial color="#b9aa95" roughness={0.72} />
                    </mesh>
                    <mesh position={[shellCenterX, 5.72, room.centerZ + direction * ((roomWidth / 2) - 0.48)]}>
                        <boxGeometry args={[Math.max(0.5, shellDepth - 0.8), 0.065, 0.08]} />
                    <meshStandardMaterial color="#8d704e" metalness={0.62} roughness={0.45} />
                    </mesh>
                    <mesh position={[
                        outerWallX - (room.side * 0.15),
                        ceilingY / 2,
                        room.centerZ + direction * ((roomWidth / 2) - 0.16),
                    ]}>
                        <boxGeometry args={[0.16, ceilingY - 0.2, 0.2]} />
                        <meshStandardMaterial color="#b9aa95" roughness={0.74} />
                    </mesh>
                </group>
            ))}
            <mesh position={[outerWallX - (room.side * 0.25), 0.17, room.centerZ]}>
                <boxGeometry args={[0.18, 0.34, roomWidth]} />
                <meshStandardMaterial color="#887763" roughness={0.7} />
            </mesh>
            <group position={[outerWallX - (room.side * 0.145), 3.08, room.centerZ]}>
                <mesh receiveShadow>
                    <boxGeometry args={[0.055, 2.28, 5.65]} />
                    <meshStandardMaterial color="#211a17" roughness={0.86} />
                </mesh>
                {[-1, 1].map(direction => (
                    <mesh key={`end-cap-horizontal-${direction}`} position={[-room.side * 0.035, direction * 1.12, 0]}>
                        <boxGeometry args={[0.075, 0.09, 5.78]} />
                        <meshPhysicalMaterial color="#9b7747" metalness={0.58} roughness={0.35} />
                    </mesh>
                ))}
                {[-1, 1].map(direction => (
                    <mesh key={`end-cap-vertical-${direction}`} position={[-room.side * 0.035, 0, direction * 2.83]}>
                        <boxGeometry args={[0.075, 2.32, 0.09]} />
                        <meshPhysicalMaterial color="#9b7747" metalness={0.58} roughness={0.35} />
                    </mesh>
                ))}
            </group>
            <LabelPlane
                title={room.name}
                subtitle={`${room.albums.length} ${room.albums.length === 1 ? 'collection' : 'collections'}`}
                position={[outerWallX - (room.side * 0.19), 3.05, room.centerZ]}
                rotation={[0, endRotation, 0]}
                size={[4.6, 1.2]}
            />
            <CameraAwareRoomPaintings
                room={room}
                active={active}
                detailed={detailed}
                allowDetail={allowDetail}
                qualityLighting={qualityLighting}
                materials={materials}
                readyPaintingIds={readyPaintingIds}
                onTextureReady={markPaintingReady}
            />
            {illuminatedXs.map(x => (
                <FloorLightPool
                    key={`room-pool-${x}`}
                    position={[x, 0.052, room.centerZ]}
                    size={[5.4, Math.max(4.2, roomWidth - 1.1)]}
                    opacity={qualityLighting ? 0.28 : 0.15}
                />
            ))}
            </group>
            <RoomPortalScrim room={room} ready={roomReady} />
            {active && lightXs.map(x => (
                <group key={x} position={[x, ceilingY - 0.12, room.centerZ]}>
                    <mesh rotation={[Math.PI / 2, 0, 0]}>
                        <circleGeometry args={[0.26, 12]} />
                        <meshBasicMaterial color="#fff1d6" toneMapped={false} />
                    </mesh>
                </group>
            ))}
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
    const activeRoomList = useMemo(
        () => layout.rooms.filter(room => activeRooms.has(room.id)).slice(0, 2),
        [activeRooms, layout.rooms],
    )
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
                    <DistanceManagedDoorWall
                        side={-1}
                        centerZ={bay.centerZ}
                        room={bay.left}
                        materials={materials}
                        forceNear={Boolean(bay.left && activeRooms.has(bay.left.id))}
                    />
                    <DistanceManagedDoorWall
                        side={1}
                        centerZ={bay.centerZ}
                        room={bay.right}
                        materials={materials}
                        forceNear={Boolean(bay.right && activeRooms.has(bay.right.id))}
                    />
                </group>
            ))}
            <mesh position={[0, MUSEUM_DIMENSIONS.hallHeight / 2, layout.hallBackZ]}>
                <boxGeometry args={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, MUSEUM_DIMENSIONS.hallHeight, 0.24]} />
                <PlasterMaterial materials={materials} color={HALL_PAINT} textured={false} />
            </mesh>
            <mesh position={[0, MUSEUM_DIMENSIONS.hallHeight / 2, layout.hallBackZ + 0.135]}>
                <planeGeometry args={[(MUSEUM_DIMENSIONS.hallHalfWidth * 2) - 0.28, MUSEUM_DIMENSIONS.hallHeight - 0.26]} />
                <WallpaperMaterial
                    materials={materials}
                    width={MUSEUM_DIMENSIONS.hallHalfWidth * 2}
                    height={MUSEUM_DIMENSIONS.hallHeight}
                    centerZ={layout.hallBackZ}
                    color="#d0bfab"
                />
            </mesh>
            {/* A shallow terminal frame physically separates the perpendicular
                surfaces, so texture sampling can never expose a coplanar seam. */}
            {[-1, 1].map(side => (
                <mesh
                    key={`terminal-pilaster-${side}`}
                    position={[side * (MUSEUM_DIMENSIONS.hallHalfWidth - 0.16), MUSEUM_DIMENSIONS.hallHeight / 2, layout.hallBackZ + 0.18]}
                >
                    <boxGeometry args={[0.24, MUSEUM_DIMENSIONS.hallHeight - 0.12, 0.18]} />
                    <meshStandardMaterial color="#b9aa95" roughness={0.74} />
                </mesh>
            ))}
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
            <FixedRoomLighting rooms={activeRoomList} qualityLighting={reflectionsEnabled} />
            {ceilingLights.map(z => (
                <group key={z} position={[0, 6.85, z]}>
                    <mesh rotation={[Math.PI / 2, 0, 0]}>
                        <circleGeometry args={[0.25, 12]} />
                        <meshBasicMaterial color="#fff0d3" toneMapped={false} />
                    </mesh>
                </group>
            ))}
            {illuminatedHallLights.map(z => (
                <group key={`hall-light-${z}`}>
                    <StaticSpotlight
                        position={[0, 5.9, z]}
                        target={[0, 0, z]}
                        color="#ffd8aa"
                        intensity={reflectionsEnabled ? 31 : 20}
                        distance={22}
                        angle={0.68}
                        penumbra={0.86}
                    />
                    <pointLight
                        position={[0, 6.35, z]}
                        color="#f4bd82"
                        intensity={reflectionsEnabled ? 5.5 : 3.2}
                        distance={13}
                        decay={2}
                    />
                    <FloorLightPool
                        position={[0, 0.064, z]}
                        size={[7.6, 8.8]}
                        opacity={reflectionsEnabled ? 0.12 : 0.08}
                    />
                </group>
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
    const { camera, performance } = useThree()
    const keys = useRef(new Set())
    const lastRoom = useRef(null)
    const lastNearbyRooms = useRef('')
    const lastFocused = useRef(null)
    const lastSavedAt = useRef(0)
    const lastProbeAt = useRef(0)
    const lastPerformanceRegressionAt = useRef(-10)
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
        if (
            frameDelta > 0.038
            && state.clock.elapsedTime - lastPerformanceRegressionAt.current > 0.9
        ) {
            lastPerformanceRegressionAt.current = state.clock.elapsedTime
            performance.regress()
        }
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
                0.35,
                openMuseumPortalIds,
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
            const nearbyRooms = nearbyMuseumRoomIds(layout, position, touchMode ? 15 : 20)
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
        } else if (mode === 'portal' && room) {
            camera.position.set(
                room.side * (MUSEUM_DIMENSIONS.hallHalfWidth - 3.8),
                2.05,
                room.centerZ + 4.8,
            )
            camera.lookAt(room.innerX + (room.side * 1.1), 2.15, room.centerZ)
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

function SceneWarmup({ layout, initialRoomIds, onReady, onProgress, touchMode }) {
    const { camera, gl, invalidate, scene } = useThree()
    const [warmRoomIds] = useState(() => initialRoomIds)

    useEffect(() => {
        let cancelled = false
        const startedAt = performance.now()
        const publishStage = (stage, extra = {}) => {
            if (!import.meta.env.DEV) return
            document.documentElement.dataset.museumWarmup = JSON.stringify({
                stage,
                elapsedMs: Math.round(performance.now() - startedAt),
                ...extra,
            })
        }
        const nearbyInitialRooms = layout.rooms.filter(room => warmRoomIds.includes(room.id))
        const initialRooms = (nearbyInitialRooms.length ? nearbyInitialRooms : layout.rooms)
            .slice(0, touchMode ? 1 : 2)
        const warmAlbums = [...new Map(
            initialRooms
                // Three entrance works are the room-ready threshold. Warming
                // exactly those covers avoids both a post-reveal first-bay
                // hitch and unnecessary startup work for paintings that remain
                // behind the visitor.
                .flatMap(room => room.albums.slice(0, 3))
                .filter(Boolean)
                .map(album => [album.albumId, album]),
        ).values()]
        let didFinish = false
        const finish = () => {
            if (cancelled || didFinish) return
            didFinish = true
            publishStage('ready', { roomCount: initialRooms.length, coverCount: warmAlbums.length })
            onProgress?.(1)
            onReady()
        }
        const timeout = window.setTimeout(finish, touchMode ? 7200 : 4800)
        onProgress?.(0)
        publishStage('decoding', { roomCount: initialRooms.length, coverCount: warmAlbums.length })

        // Plaque canvases are small, but creating dozens during a room-entry
        // frame is enough to hitch the main thread. Build and cache them while
        // the opening veil is already present.
        // Each room uses one precomposed plaque atlas and merged plaque mesh,
        // replacing one texture bind/draw call per visible painting. Promote
        // those atlases under the opening veil alongside the cover previews so
        // entering a room cannot trigger the atlas' first GPU upload.
        const plaqueTextures = initialRooms.map(room => (
            getRoomPlaqueBatch(room.paintings).texture
        ))
        const preparedCovers = Promise.allSettled(warmAlbums.map((album, index) => (
            createMuseumCoverTexture(
                album,
                LOW_RES_COVER_WIDTH,
                warmAlbums.length - index,
            )
        )))

        preparedCovers.then(async (coverResults) => {
            if (cancelled) return
            const coverTextures = coverResults
                .filter(result => result.status === 'fulfilled')
                .map(result => result.value)
            publishStage('uploading', { prepared: coverTextures.length, coverCount: warmAlbums.length })
            await promoteRevealTextures(
                gl,
                [...coverTextures, ...plaqueTextures],
                ratio => onProgress?.(0.55 + (ratio * 0.25)),
            )
            // Compile after the resident textures and plaque atlases exist.
            // Running this concurrently compiled an earlier scene and deferred
            // the real shader/texture-bind spike until the veil lifted.
            const compile = gl.compileAsync?.(scene, camera) || Promise.resolve()
            publishStage('compiling', { prepared: coverTextures.length })
            await Promise.race([
                compile,
                new Promise(resolve => window.setTimeout(resolve, 1500)),
            ])
            onProgress?.(0.9)
            invalidate()
            // Let two actual scene frames settle camera-aware artwork and the
            // first portal while the loading veil still hides the canvas.
            await new Promise(resolve => window.requestAnimationFrame(resolve))
            invalidate()
            await new Promise(resolve => window.requestAnimationFrame(resolve))
            if (cancelled) return
            finish()
        }).catch(() => {
            finish()
        })

        return () => {
            cancelled = true
            window.clearTimeout(timeout)
        }
    }, [camera, gl, invalidate, layout, onProgress, onReady, scene, touchMode, warmRoomIds])

    return null
}

function DevelopmentPerformanceProbe() {
    const { gl } = useThree()
    const samples = useRef([])
    const lastPublishedAt = useRef(0)
    useFrame((state, delta) => {
        samples.current.push(delta * 1000)
        if (samples.current.length > 180) samples.current.shift()
        if (state.clock.elapsedTime - lastPublishedAt.current < 1 || samples.current.length < 30) return
        lastPublishedAt.current = state.clock.elapsedTime
        const ordered = [...samples.current].sort((left, right) => left - right)
        const pick = ratio => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))]
        document.documentElement.dataset.museumPerf = JSON.stringify({
            medianMs: Number(pick(0.5).toFixed(2)),
            p95Ms: Number(pick(0.95).toFixed(2)),
            maxMs: Number(ordered.at(-1).toFixed(2)),
            calls: gl.info.render.calls,
            triangles: gl.info.render.triangles,
            textures: gl.info.memory.textures,
        })
    })
    return null
}

function DevelopmentMuseumTour({ layout, onActiveRoom, onNearbyRooms }) {
    const { camera, gl } = useThree()
    const state = useRef({
        circuit: 0,
        roomIndex: 0,
        phase: 0,
        phaseStartedAt: 0,
        phaseStart: null,
        portalFailures: [],
        maxTextures: 0,
        maxCalls: 0,
        maxTriangles: 0,
    })
    const target = useMemo(() => new THREE.Vector3(), [])
    const lookAt = useMemo(() => new THREE.Vector3(), [])

    useFrame((frameState) => {
        const tour = state.current
        const room = layout.rooms[tour.roomIndex]
        if (!room || tour.circuit >= 3) {
            document.documentElement.dataset.museumTour = JSON.stringify({
                status: 'complete',
                circuits: Math.min(3, tour.circuit),
                portalFailures: tour.portalFailures,
                maxTextures: tour.maxTextures,
                maxCalls: tour.maxCalls,
                maxTriangles: tour.maxTriangles,
            })
            return
        }
        if (!tour.phaseStartedAt) {
            tour.phaseStartedAt = frameState.clock.elapsedTime
            tour.phaseStart = camera.position.clone()
        }
        const elapsed = frameState.clock.elapsedTime - tour.phaseStartedAt
        const hallX = room.side * (MUSEUM_DIMENSIONS.hallHalfWidth - 1.25)
        const entranceX = room.innerX - (room.side * 0.42)
        const insideX = room.innerX + (room.side * 2.5)
        const deepX = room.innerX + (room.side * Math.max(4.6, room.depth - 2.2))
        const phases = [
            { duration: 0.62, position: [hallX, layout.spawn[1], room.centerZ + 1.1] },
            { duration: 0.52, position: [entranceX, layout.spawn[1], room.centerZ] },
            { duration: 0.9, position: [insideX, layout.spawn[1], room.centerZ] },
            { duration: 0.8, position: [deepX, layout.spawn[1], room.centerZ + 1.3] },
            { duration: 0.76, position: [insideX, layout.spawn[1], room.centerZ - 1.1] },
            { duration: 0.9, position: [hallX, layout.spawn[1], room.centerZ] },
        ]
        const phase = phases[tour.phase]
        target.set(...phase.position)

        // The real player cannot cross a closed portal. Hold the automated
        // endurance route at the same point until the physical curtain and
        // collision state agree, recording a bounded failure instead of
        // teleporting into an unmounted room and masking the defect.
        if (tour.phase === 2 && !openMuseumPortalIds.has(room.id)) {
            camera.position.copy(tour.phaseStart)
            camera.lookAt(room.innerX + (room.side * 3), 2.4, room.centerZ)
            if (elapsed < 10) {
                document.documentElement.dataset.museumTour = JSON.stringify({
                    status: 'waiting-for-portal',
                    circuit: tour.circuit + 1,
                    room: room.name,
                    roomIndex: tour.roomIndex,
                    waitedMs: Math.round(elapsed * 1000),
                    portalFailures: tour.portalFailures,
                    textures: gl.info.memory.textures,
                })
                return
            }
            tour.portalFailures.push(`${tour.circuit + 1}:${room.id}`)
            tour.phase = 5
            tour.phaseStartedAt = frameState.clock.elapsedTime
            tour.phaseStart = camera.position.clone()
            return
        }

        const progress = THREE.MathUtils.smoothstep(Math.min(1, elapsed / phase.duration), 0, 1)
        camera.position.lerpVectors(tour.phaseStart, target, progress)
        if (tour.phase <= 1) {
            lookAt.set(room.innerX + (room.side * 2.5), 2.4, room.centerZ)
        } else if (tour.phase <= 3) {
            lookAt.set(room.outerX - (room.side * 0.8), 2.45, room.centerZ)
        } else {
            lookAt.set(0, 2.25, room.centerZ)
        }
        camera.lookAt(lookAt)

        const position = { x: camera.position.x, z: camera.position.z }
        onActiveRoom(nearestMuseumRoom(layout, position))
        onNearbyRooms(nearbyMuseumRoomIds(layout, position, 20))
        tour.maxTextures = Math.max(tour.maxTextures, gl.info.memory.textures)
        tour.maxCalls = Math.max(tour.maxCalls, gl.info.render.calls)
        tour.maxTriangles = Math.max(tour.maxTriangles, gl.info.render.triangles)
        document.documentElement.dataset.museumTour = JSON.stringify({
            status: 'running',
            circuit: tour.circuit + 1,
            room: room.name,
            roomIndex: tour.roomIndex,
            phase: tour.phase,
            portalOpen: openMuseumPortalIds.has(room.id),
            portalFailures: tour.portalFailures,
            textures: gl.info.memory.textures,
            maxTextures: tour.maxTextures,
            calls: gl.info.render.calls,
            triangles: gl.info.render.triangles,
            coverLoads: activeCoverLoads,
            coverQueue: coverLoadQueue.length,
            uploadQueue: coverUploadQueue.length,
            uploadScheduled: coverUploadScheduled,
        })

        if (elapsed < phase.duration) return
        tour.phase += 1
        if (tour.phase >= phases.length) {
            tour.phase = 0
            tour.roomIndex += 1
            if (tour.roomIndex >= layout.rooms.length) {
                tour.roomIndex = 0
                tour.circuit += 1
            }
        }
        tour.phaseStartedAt = frameState.clock.elapsedTime
        tour.phaseStart = camera.position.clone()
    })

    return null
}

function MuseumScene({ layout, controlsEnabled, touchMode, touchInput, visualPreview, developmentTour, previewMode, previewRoomIndex, onSceneReady, onSceneProgress, onLock, onUnlock, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
    const materials = useMuseumMaterials()
    return (
        <>
            <color attach="background" args={[INK]} />
            <fog attach="fog" args={['#151310', 30, 120]} />
            <ambientLight intensity={touchMode ? 0.14 : 0.11} color="#f3dcc4" />
            <hemisphereLight args={['#d8e0e4', '#38261d', touchMode ? 0.21 : 0.19]} />
            <directionalLight
                position={[-6, 10, 12]}
                intensity={touchMode ? 0.2 : 0.12}
                color="#dce8ef"
                castShadow={false}
            />
            <directionalLight position={[7, 6, -12]} intensity={0.055} color="#d69e6a" castShadow={false} />
            <MainHall
                layout={layout}
                activeRoomId={controlsEnabled.activeRoomId}
                activeRoomIds={controlsEnabled.activeRoomIds}
                materials={materials}
                reflectionsEnabled={!touchMode}
            />
            <SceneWarmup
                layout={layout}
                initialRoomIds={controlsEnabled.activeRoomIds}
                onReady={onSceneReady}
                onProgress={onSceneProgress}
                touchMode={touchMode}
            />
            {import.meta.env.DEV && <DevelopmentPerformanceProbe />}
            {visualPreview && <PreviewCamera mode={previewMode} roomIndex={previewRoomIndex} layout={layout} />}
            {import.meta.env.DEV && developmentTour && (
                <DevelopmentMuseumTour
                    layout={layout}
                    onActiveRoom={onActiveRoom}
                    onNearbyRooms={onNearbyRooms}
                />
            )}
            {!visualPreview && !developmentTour && (
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
    const [activeRoomIds, setActiveRoomIds] = useState(null)
    const [focused, setFocused] = useState(null)
    const [sceneReady, setSceneReady] = useState(false)
    const [sceneVeilVisible, setSceneVeilVisible] = useState(true)
    const [sceneProgress, setSceneProgress] = useState(0)
    const [touchMode, setTouchMode] = useState(() => forceTouchPreview || usesTouchControls())
    const touchInput = useRef({ moveX: 0, moveY: 0, lookX: 0, lookY: 0 })

    // Suspense can delay SceneWarmup itself while the first static materials
    // decode. This is an emergency escape hatch, not a normal readiness timer:
    // revealing the scene while cover uploads are active causes black frames
    // and severe walk-through hitches on a cold cache.
    useEffect(() => {
        if (!albums || sceneReady) return undefined
        const fallback = window.setTimeout(() => setSceneReady(true), touchMode ? 18000 : 14000)
        return () => window.clearTimeout(fallback)
    }, [albums, sceneReady, touchMode])
    useEffect(() => {
        if (!sceneReady) return undefined
        const timer = window.setTimeout(() => setSceneVeilVisible(false), 520)
        return () => window.clearTimeout(timer)
    }, [sceneReady])

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
        const request = import.meta.env.DEV && typeof window.fetch !== 'function'
            ? new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest()
                xhr.open('GET', '/api/public/albums?type=photo&limit=100')
                xhr.onload = () => {
                    if (xhr.status < 200 || xhr.status >= 300) {
                        reject(new Error(`Catalog request failed (${xhr.status})`))
                        return
                    }
                    try {
                        const payload = JSON.parse(xhr.responseText)
                        resolve(payload?.items || payload || [])
                    } catch (cause) {
                        reject(cause)
                    }
                }
                xhr.onerror = () => reject(new Error('The local catalog proxy is unavailable.'))
                controller.signal.addEventListener('abort', () => xhr.abort(), { once: true })
                xhr.send()
            })
            : fetchAllAlbums({ type: 'photo', limit: 100 }, { signal: controller.signal })
        request
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
    const developmentTour = import.meta.env.DEV && previewParams?.get('museum-tour') === '1'
    const visualPreview = import.meta.env.DEV && ['lobby', 'hall', 'room', 'portal'].includes(previewMode)
    const initialActiveRoomIds = useMemo(
        () => nearbyMuseumRoomIds(
            layout,
            sessionStorage.getItem(RETURN_KEY) === 'true'
                ? safeSessionPosition(layout)
                : { x: layout.spawn[0], z: layout.spawn[2] },
            touchMode ? 15 : 20,
        ),
        [layout, touchMode],
    )
    const renderedActiveRoomIds = visualPreview
        ? (['room', 'portal'].includes(previewMode) ? [layout.rooms[previewRoomIndex]?.id].filter(Boolean) : [])
        : (activeRoomIds ?? initialActiveRoomIds)
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
                frameloop={locked || visualPreview || developmentTour || !sceneReady ? 'always' : 'demand'}
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
                    gl.toneMappingExposure = touchMode ? 1.2 : 1.22
                    gl.shadowMap.type = THREE.PCFShadowMap
                }}
            >
                <Suspense fallback={null}>
                    <AdaptiveDpr pixelated={false} />
                    <MuseumScene
                        layout={layout}
                        controlsEnabled={{ locked, activeRoomId: renderedActiveRoomId, activeRoomIds: renderedActiveRoomIds }}
                        touchMode={touchMode}
                        touchInput={touchInput}
                        visualPreview={visualPreview}
                        developmentTour={developmentTour}
                        previewMode={previewMode}
                        previewRoomIndex={previewRoomIndex}
                        onSceneReady={handleSceneReady}
                        onSceneProgress={setSceneProgress}
                        onLock={() => setLocked(true)}
                        onUnlock={() => setLocked(false)}
                        onActiveRoom={setActiveRoomId}
                        onNearbyRooms={setActiveRoomIds}
                        onFocusedPainting={setFocused}
                        onOpenAlbum={openAlbum}
                    />
                </Suspense>
            </Canvas>
            {sceneVeilVisible && (
                <div
                    className={`museum-loading museum-loading--scene${sceneReady ? ' museum-loading--leaving' : ''}`}
                    role="status"
                    aria-live="polite"
                >
                    <span className="museum-loading-mark">IT</span>
                    <p className="museum-kicker">Preparing the virtual archive</p>
                    <h1>Opening the gallery</h1>
                    <p>Calibrating the lights and hanging the collection… {Math.round(sceneProgress * 100)}%</p>
                    <span className="museum-loading-progress museum-loading-progress--determinate" aria-hidden="true">
                        <i style={{ transform: `scaleX(${Math.max(0.02, sceneProgress)})` }} />
                    </span>
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
            {sceneReady && !locked && !visualPreview && !developmentTour && (
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
