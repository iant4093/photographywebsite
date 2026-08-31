/* eslint-disable react-hooks/immutability -- Three.js cameras are intentionally mutable scene objects. */
import { useTexture } from '@react-three/drei/core/Texture.js'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { decode as decodeBlurhash } from 'blurhash'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { fetchAllAlbums } from '../utils/api'
import { albumCoverPreviewSrcSet } from '../utils/mediaUrls'
import {
    buildMuseumCatalog,
    buildMuseumLayout,
    initialMuseumRoomIds,
    isMuseumPositionWalkable,
    MUSEUM_DIMENSIONS,
    museumArtworkLightIndex,
    museumFloorSurface,
    moveMuseumPosition,
    nearbyMuseumRoomIds,
    nearestMuseumRoom,
    prioritizeMuseumPreloadRooms,
} from '../utils/museumLayout'
import {
    DEFAULT_MUSEUM_PREFERENCES,
    buildBakedFloorGrid,
    museumHallSconcePlacements,
    persistMuseumPreferences,
    readMuseumPreferences,
    sampleBakedWallIrradiance,
} from '../utils/museumSupport'

const SESSION_KEY = 'ian-photography-museum-position-v2'
const RETURN_KEY = 'ian-photography-museum-return'
const PREFERENCES_KEY = 'ian-photography-museum-preferences-v2'
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
const EMPTY_FIXTURES = Object.freeze([])
const ARCHITECTURAL_ROUNDED_BOX = new RoundedBoxGeometry(1, 1, 1, 2, 0.045)
const PORTAL_ARCH_STONE_GEOMETRY = makePortalArchGeometry(0.18, 0.12, 0.24)
const PORTAL_ARCH_REVEAL_GEOMETRY = makePortalArchGeometry(0.01, 0.015, 0.085)
RectAreaLightUniformsLib.init()
// Image decoding and GPU promotion are the only workloads in this scene that
// can create multi-frame stalls. Four concurrent off-thread decodes finish the
// opening warmup quickly without exposing uploads during the walk-through.
const DEFAULT_COVER_LOAD_CONCURRENCY = 3
const LOW_RES_COVER_WIDTH = 512
const DESKTOP_COVER_CACHE_BUDGET = 72 * 1024 * 1024
const LOW_POWER_COVER_CACHE_BUDGET = 40 * 1024 * 1024
const DESKTOP_COVER_CACHE_ENTRIES = 72
const LOW_POWER_COVER_CACHE_ENTRIES = 42
const coverTextureCache = new Map()
const coverTextureLoads = new Map()
const coverTextureReferences = new Map()
const coverPreviewCandidateCache = new Map()
const labelTextureCache = new Map()
const roomPlaqueBatchCache = new Map()
const roomPlaceholderBatchCache = new Map()
const coverLoadQueue = []
const coverUploadQueue = []
const uploadedCoverTextures = new WeakSet()
const pendingCoverUploads = new WeakMap()
const pinnedCoverTextures = new WeakSet()
let activeCoverLoads = 0
let coverLoadSequence = 0
let coverUploadSequence = 0
let coverUploadScheduled = false
const MuseumDressing = lazy(() => import('../components/museum/MuseumDressing.jsx'))

function isFirefoxBrowser() {
    return typeof navigator !== 'undefined' && /firefox\//i.test(navigator.userAgent || '')
}

function isWindowsFirefoxBrowser() {
    if (!isFirefoxBrowser()) return false
    const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
    return /win/i.test(platform)
}

function coverLoadConcurrency() {
    // Firefox can defer several HTMLImageElement decodes and then release all
    // callbacks in one main-thread burst. Two concurrent decodes keep loading
    // progress visible and avoid that burst on Windows graphics drivers.
    return isFirefoxBrowser() ? 2 : DEFAULT_COVER_LOAD_CONCURRENCY
}

function museumPlaceholderColor(value, index = 0) {
    let hash = 2166136261
    for (const character of String(value || 'photograph')) {
        hash ^= character.charCodeAt(0)
        hash = Math.imul(hash, 16777619)
    }
    // These colors multiply the shared blurred placeholder texture. Keep them
    // in the mid/high range so an unstreamed canvas reads as a softly veiled
    // photograph rather than a black rectangle at the far end of a room.
    const palette = ['#b9a99b', '#9daeb0', '#aca4bb', '#a6b19a', '#bea09d', '#a3a7b7']
    return new THREE.Color(palette[Math.abs(hash + index) % palette.length])
}

function drawAlbumPlaceholder(context, album, x, y, width, height, fallbackIndex) {
    const hash = album?.coverBlurhash
    if (hash) {
        try {
            // These samples are deliberately tiny: the atlas is a distant,
            // softened continuity layer, not the final artwork. Cutting the
            // decode area by more than half prevents Windows Firefox from
            // monopolising the main thread while the loading veil is trying
            // to paint progress.
            const sampleWidth = 20
            const sampleHeight = 14
            const pixels = decodeBlurhash(hash, sampleWidth, sampleHeight, 1)
            const sample = document.createElement('canvas')
            sample.width = sampleWidth
            sample.height = sampleHeight
            const sampleContext = sample.getContext('2d')
            sampleContext.putImageData(
                new ImageData(new Uint8ClampedArray(pixels), sampleWidth, sampleHeight),
                0,
                0,
            )
            context.imageSmoothingEnabled = true
            context.imageSmoothingQuality = 'low'
            context.drawImage(sample, x, y, width, height)
            // A small gallery-light veil keeps very dark source hashes from
            // reading as unloaded black canvases. The real cover still fades
            // over this atlas, so the placeholder remains deliberately soft.
            context.fillStyle = 'rgba(238, 226, 210, 0.34)'
            context.fillRect(x, y, width, height)
            return
        } catch {
            // Older albums can contain malformed legacy hashes. The authored
            // color wash below is still preferable to a black canvas.
        }
    }
    const fallback = museumPlaceholderColor(
        `${album?.category || ''}:${album?.title || fallbackIndex}`,
        fallbackIndex,
    )
    const start = `#${fallback.clone().offsetHSL(-0.025, 0.03, 0.09).getHexString()}`
    const end = `#${fallback.clone().offsetHSL(0.025, -0.04, -0.1).getHexString()}`
    const gradient = context.createLinearGradient(x, y, x + width, y + height)
    gradient.addColorStop(0, start)
    gradient.addColorStop(1, end)
    context.fillStyle = gradient
    context.fillRect(x, y, width, height)
}
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
    const entryBudget = lowPower ? LOW_POWER_COVER_CACHE_ENTRIES : DESKTOP_COVER_CACHE_ENTRIES
    let bytes = entries.reduce((total, [, texture]) => total + Number(texture?.userData?.museumBytes || 0), 0)
    for (const [key, texture] of entries) {
        if (bytes <= budget && coverTextureCache.size <= entryBudget) break
        if ((coverTextureReferences.get(key) || 0) > 0 || pinnedCoverTextures.has(texture)) continue
        coverTextureCache.delete(key)
        bytes -= Number(texture?.userData?.museumBytes || 0)
        texture?.image?.close?.()
        texture?.dispose()
    }
}

function enqueueCoverUpload(gl, texture, priority = 0) {
    if (!texture || uploadedCoverTextures.has(texture)) return Promise.resolve(texture)
    const pending = pendingCoverUploads.get(texture)
    if (pending) return pending
    pinnedCoverTextures.add(texture)
    const upload = new Promise((resolve, reject) => {
        coverUploadQueue.push({ gl, texture, resolve, reject, priority, sequence: coverUploadSequence++ })
        if (coverUploadScheduled) return
        coverUploadScheduled = true
        // requestIdleCallback is heavily throttled by Firefox and Safari in
        // precisely the cold-start scenario this queue serves. A deterministic
        // one-upload-per-frame pump keeps progress visible, never releases a
        // burst after the veil, and lets newly approached work outrank stale
        // background requests.
        const scheduleFlush = callback => window.setTimeout(
            () => window.requestAnimationFrame(callback),
            document.visibilityState === 'visible' ? 0 : 48,
        )
        const flush = () => {
            coverUploadQueue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
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

function createBakedOcclusionTexture({
    size = 128,
    edgeWidth = 0.18,
    edgeStrength = 0.24,
    lowerStrength = 0.1,
    upperStrength = 0.025,
} = {}) {
    const values = new Uint8Array(size * size)
    const denominator = Math.max(1, size - 1)
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const u = x / denominator
            const v = y / denominator
            const edgeDistance = Math.min(u, 1 - u, v, 1 - v)
            const edgeRamp = THREE.MathUtils.smoothstep(edgeDistance, 0, edgeWidth)
            const edgeOcclusion = 1 - (edgeStrength * (1 - edgeRamp))
            const verticalOcclusion = 1
                - (lowerStrength * Math.pow(1 - v, 2.2))
                - (upperStrength * Math.pow(v, 3.2))
            values[(y * size) + x] = Math.round(255 * Math.max(0.42, edgeOcclusion * verticalOcclusion))
        }
    }
    const texture = new THREE.DataTexture(values, size, size, THREE.RedFormat, THREE.UnsignedByteType)
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = true
    // AO maps default to the secondary UV channel. Museum shell geometry
    // intentionally shares its authored primary UVs, so use channel zero for
    // this lightweight baked edge/corner grounding pass.
    texture.channel = 0
    texture.needsUpdate = true
    return texture
}

function useMuseumMaterials() {
    const sources = useTexture({
        plasterColor: `${TEXTURE_ROOT}/white_plaster_02_diff_1k.jpg`,
        plasterNormal: `${TEXTURE_ROOT}/white_plaster_02_nor_gl_1k.jpg`,
        plasterRoughness: `${TEXTURE_ROOT}/white_plaster_02_rough_1k.jpg`,
        woodColor: `${TEXTURE_ROOT}/wood_floor_diff_1k.jpg`,
        woodNormal: `${TEXTURE_ROOT}/wood_floor_nor_gl_1k.jpg`,
        woodRoughness: `${TEXTURE_ROOT}/wood_floor_rough_1k.jpg`,
        wallpaperColor: `${TEXTURE_ROOT}/museum_wallpaper_oxblood_authored_1024.jpg`,
    })
    const materials = useMemo(() => {
        // A single generic edge vignette made every surface respond like the
        // same flat card. These compact authored profiles ground walls at the
        // baseboard, floor panels at their perimeter, and narrow joinery at
        // seams without adding runtime lights or shadow-map churn.
        const plasterOcclusion = createBakedOcclusionTexture({
            edgeWidth: 0.2,
            edgeStrength: 0.22,
            lowerStrength: 0.17,
            upperStrength: 0.04,
        })
        const floorOcclusion = createBakedOcclusionTexture({
            edgeWidth: 0.13,
            edgeStrength: 0.3,
            lowerStrength: 0.04,
            upperStrength: 0.04,
        })
        const joineryOcclusion = createBakedOcclusionTexture({
            edgeWidth: 0.08,
            edgeStrength: 0.34,
            lowerStrength: 0.08,
            upperStrength: 0.06,
        })
        const wallpaperOcclusion = createBakedOcclusionTexture({
            edgeWidth: 0.22,
            edgeStrength: 0.17,
            lowerStrength: 0.12,
            upperStrength: 0.03,
        })
        return ({
        plaster: {
            map: configureTexture(sources.plasterColor, { color: true, repeat: [5, 3] }),
            normalMap: configureTexture(sources.plasterNormal, { repeat: [5, 3] }),
            roughnessMap: configureTexture(sources.plasterRoughness, { repeat: [5, 3] }),
            aoMap: plasterOcclusion,
        },
        floor: {
            map: configureTexture(sources.woodColor, { color: true, repeat: [11, 5] }),
            normalMap: configureTexture(sources.woodNormal, { repeat: [11, 5] }),
            roughnessMap: configureTexture(sources.woodRoughness, { repeat: [11, 5] }),
            aoMap: floorOcclusion,
        },
        joinery: {
            map: configureTexture(sources.woodColor, { color: true, repeat: [2, 1] }),
            normalMap: configureTexture(sources.woodNormal, { repeat: [2, 1] }),
            roughnessMap: configureTexture(sources.woodRoughness, { repeat: [2, 1] }),
            aoMap: joineryOcclusion,
        },
        wallpaper: {
            map: configureTexture(sources.wallpaperColor, { color: true }),
            // Velvet's micro-surface must not be inferred from its printed
            // motif. Reuse the neutral plaster micro-normal/roughness data as
            // independent weave-scale response until the color pattern is no
            // longer mistaken for physical relief under grazing light.
            normalMap: configureTexture(sources.plasterNormal, { repeat: [2.5, 2.5] }),
            roughnessMap: configureTexture(sources.plasterRoughness, { repeat: [2.5, 2.5] }),
            aoMap: wallpaperOcclusion,
        },
    })
    }, [sources])

    useEffect(() => () => {
        const textures = new Set(Object.values(materials).flatMap(material => Object.values(material)))
        textures.forEach(texture => texture.dispose())
    }, [materials])
    return materials
}

function PlasterMaterial({ materials, color = HALL_PAINT, side, roughness = 0.88, textured = true }) {
    return (
        <meshStandardMaterial
            {...(textured ? materials.plaster : {})}
            color={color}
            emissive="#8d6f59"
            emissiveIntensity={0.055}
            roughness={roughness}
            normalScale={textured ? [0.42, 0.42] : undefined}
            aoMapIntensity={textured ? 0.58 : 0}
            side={side}
        />
    )
}

function WallpaperMaterial({ materials, width, height, centerZ = 0, color = '#d8c8b4', side = THREE.FrontSide, shapeUv = false, phase = 0, reverseU = false, vertexColors = false }) {
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
        <meshPhysicalMaterial
            map={map}
            normalMap={materials.wallpaper.normalMap}
            normalScale={[0.11, 0.11]}
            roughnessMap={materials.wallpaper.roughnessMap}
            aoMap={materials.wallpaper.aoMap}
            aoMapIntensity={0.46}
            color={color}
            emissive="#45171c"
            emissiveIntensity={0.22}
            roughness={0.84}
            metalness={0}
            sheen={0.16}
            sheenColor="#6d242d"
            sheenRoughness={0.88}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-2}
            side={side}
            vertexColors={vertexColors}
        />
    )
}

function BakedWallpaperSurface({
    materials,
    position,
    rotation,
    width,
    height,
    centerZ = 0,
    color,
    phase = 0,
    reverseU = false,
    mode = 'room',
    fixtures = EMPTY_FIXTURES,
}) {
    const geometry = useMemo(() => {
        const horizontalSegments = Math.max(8, Math.min(28, Math.ceil(width / (mode === 'hall' ? 1.5 : 1.15))))
        const verticalSegments = 6
        const wall = new THREE.PlaneGeometry(width, height, horizontalSegments, verticalSegments)
        const colors = new Float32Array(wall.attributes.position.count * 3)
        const vertex = new THREE.Vector3()
        for (let index = 0; index < wall.attributes.position.count; index += 1) {
            vertex.fromBufferAttribute(wall.attributes.position, index)
            const irradiance = sampleBakedWallIrradiance({
                horizontal: vertex.x,
                vertical: vertex.y,
                width,
                height,
                mode,
                phase,
                fixtures,
            })
            colors[(index * 3)] = irradiance[0]
            colors[(index * 3) + 1] = irradiance[1]
            colors[(index * 3) + 2] = irradiance[2]
        }
        wall.setAttribute('color', new THREE.BufferAttribute(colors, 3))
        return wall
    }, [fixtures, height, mode, phase, width])

    useEffect(() => () => geometry.dispose(), [geometry])

    return (
        <mesh receiveShadow position={position} rotation={rotation} geometry={geometry}>
            <WallpaperMaterial
                materials={materials}
                width={width}
                height={height}
                centerZ={centerZ}
                color={color}
                phase={phase}
                reverseU={reverseU}
                vertexColors
            />
        </mesh>
    )
}

function WallpaperPanel({
    materials,
    side,
    centerZ,
    width,
    height = MUSEUM_DIMENSIONS.hallHeight,
    fixtures = EMPTY_FIXTURES,
    sconcePlacements = EMPTY_FIXTURES,
}) {
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    const localFixtures = useMemo(() => {
        if (fixtures.length) return fixtures
        const halfWidth = (width / 2) + 0.4
        return sconcePlacements
            .filter(placement => placement.side === side && Math.abs(placement.z - centerZ) <= halfWidth)
            .map(placement => (side < 0 ? -1 : 1) * (placement.z - centerZ))
    }, [centerZ, fixtures, sconcePlacements, side, width])
    return (
        <BakedWallpaperSurface
            materials={materials}
            position={[
                side * (MUSEUM_DIMENSIONS.hallHalfWidth - ((HALL_WALL_THICKNESS / 2) + WALL_SURFACE_GAP)),
                height / 2,
                centerZ,
            ]}
            rotation={[0, rotationY, 0]}
            width={width}
            height={height}
            centerZ={centerZ}
            reverseU={side < 0}
            mode="hall"
            phase={(Math.abs(centerZ) % 7.9) / 7.9}
            fixtures={localFixtures}
        />
    )
}

function CeilingMaterial({ materials, hallLength }) {
    const ceilingMaps = useMemo(() => Object.fromEntries(
        Object.entries(materials.plaster).map(([name, source]) => [name, configureTexture(source, {
            color: name === 'map',
            repeat: [3.5, Math.max(2, hallLength / 5.5)],
        })]),
    ), [hallLength, materials.plaster])
    useEffect(() => () => Object.values(ceilingMaps).forEach(texture => texture.dispose()), [ceilingMaps])
    return (
        <meshStandardMaterial
            {...ceilingMaps}
            normalScale={[0.32, 0.32]}
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

function FloorMaterial({ materials, color = '#8b6948', vertexColors = false }) {
    return (
        <meshPhysicalMaterial
            {...materials.floor}
            normalScale={[0.42, 0.42]}
            color={color}
            emissive="#3f2b20"
            emissiveIntensity={0.065}
            metalness={0.015}
            roughness={0.8}
            aoMapIntensity={0.5}
            clearcoat={0.025}
            clearcoatRoughness={0.86}
            envMapIntensity={0.08}
            vertexColors={vertexColors}
        />
    )
}

function BakedIrradianceFloor({
    position,
    size,
    materials,
    color = '#73573f',
    mode = 'room',
    fixtures = EMPTY_FIXTURES,
    occluders = EMPTY_FIXTURES,
}) {
    const [width, depth] = size
    const geometry = useMemo(() => {
        const { positions, normals, uvs, colors, indices } = buildBakedFloorGrid({
            width,
            depth,
            mode,
            fixtures,
            occluders,
        })
        const floor = new THREE.BufferGeometry()
        floor.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        floor.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
        floor.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
        floor.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
        floor.setIndex(indices)
        floor.computeBoundingBox()
        floor.computeBoundingSphere()
        return floor
    }, [depth, fixtures, mode, occluders, width])

    useEffect(() => () => geometry.dispose(), [geometry])

    return (
        <mesh position={position} geometry={geometry} receiveShadow>
            <FloorMaterial materials={materials} color={color} vertexColors />
        </mesh>
    )
}

function bakedFloorOccluder(item, originX, originZ, strength = 0.1) {
    const [width = 1, , depth = 1] = item?.size || []
    return {
        across: Number(((item?.position?.[0] || 0) - originX).toFixed(3)),
        along: Number(((item?.position?.[2] || 0) - originZ).toFixed(3)),
        radiusX: Number(Math.max(0.28, width * 0.5).toFixed(3)),
        radiusZ: Number(Math.max(0.28, depth * 0.5).toFixed(3)),
        rotationY: Number((item?.rotationY || 0).toFixed(4)),
        strength,
    }
}

function WoodMaterial({ materials, color = '#6f4d31', roughness = 0.55 }) {
    return (
        <meshStandardMaterial
            {...materials.joinery}
            normalScale={[0.46, 0.46]}
            color={color}
            roughness={roughness}
            aoMapIntensity={0.46}
        />
    )
}

function InstancedCeilingFixtures({ positions, ceilingY }) {
    const housings = useRef(null)
    const reflectors = useRef(null)
    const lenses = useRef(null)

    useEffect(() => {
        const position = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        const scale = new THREE.Vector3(1, 1, 1)
        const matrix = new THREE.Matrix4()
        const lensRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0))
        positions.forEach(([x, z], index) => {
            rotation.identity()
            matrix.compose(position.set(x, ceilingY, z), rotation, scale)
            housings.current?.setMatrixAt(index, matrix)
            matrix.compose(position.set(x, ceilingY - 0.075, z), rotation, scale)
            reflectors.current?.setMatrixAt(index, matrix)
            matrix.compose(position.set(x, ceilingY - 0.142, z), lensRotation, scale)
            lenses.current?.setMatrixAt(index, matrix)
        })
        for (const mesh of [housings.current, reflectors.current, lenses.current]) {
            if (!mesh) continue
            mesh.instanceMatrix.needsUpdate = true
            mesh.computeBoundingSphere?.()
        }
    }, [ceilingY, positions])

    if (!positions.length) return null
    return (
        <>
            <instancedMesh ref={housings} args={[undefined, undefined, positions.length]}>
                <cylinderGeometry args={[0.31, 0.29, 0.14, 16]} />
                <meshStandardMaterial color="#5d4a38" metalness={0.54} roughness={0.42} />
            </instancedMesh>
            <instancedMesh ref={reflectors} args={[undefined, undefined, positions.length]}>
                <cylinderGeometry args={[0.245, 0.19, 0.11, 16]} />
                <meshPhysicalMaterial color="#c6a875" metalness={0.62} roughness={0.31} clearcoat={0.18} />
            </instancedMesh>
            <instancedMesh ref={lenses} args={[undefined, undefined, positions.length]}>
                <circleGeometry args={[0.19, 16]} />
                <meshStandardMaterial
                    color="#fff0d3"
                    emissive="#e2a65d"
                    emissiveIntensity={1.35}
                    roughness={0.38}
                    toneMapped
                />
            </instancedMesh>
        </>
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
    // Museum labels are seen at steep angles and at several distances. One
    // cached mip chain prevents the sparkling, illegible text produced by a
    // single linear level while remaining negligible beside cover imagery.
    next.generateMipmaps = true
    next.minFilter = THREE.LinearMipmapLinearFilter
    next.magFilter = THREE.LinearFilter
    next.anisotropy = 2
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
    // Plaques occupy only a few hundred screen pixels even at interaction
    // distance. A compact atlas avoids allocating and uploading several large
    // canvases synchronously during Firefox's first scene commit while keeping
    // lettering comfortably above its displayed resolution.
    const tileWidth = 384
    const tileHeight = 160
    const canvas = document.createElement('canvas')
    canvas.width = columns * tileWidth
    canvas.height = rows * tileHeight
    const context = canvas.getContext('2d')
    const parent = new THREE.Matrix4()
    // Keep the caption centered beneath the physical frame. Side-mounted
    // plaques inherited each painting's rotation and crossed the mat at
    // oblique viewing angles.
    const local = new THREE.Matrix4().makeTranslation(0, -1.43, 0.2)
    const rotation = new THREE.Quaternion()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const geometries = paintings.map((painting, index) => {
        const source = getLabelTexture(
            painting.album.title,
            '',
            { width: tileWidth, height: tileHeight, dark: true },
        ).image
        const column = index % columns
        const row = Math.floor(index / columns)
        context.drawImage(source, column * tileWidth, row * tileHeight, tileWidth, tileHeight)

        const geometry = new THREE.PlaneGeometry(1.72, 0.38)
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
    texture.generateMipmaps = true
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.anisotropy = 3
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

function roomPlaceholderBatchKey(paintings) {
    return paintings.map(({ album, id }) => (
        `${id}:${album?.coverBlurhash || ''}:${album?.title || ''}`
    )).join('|')
}

function getRoomPlaceholderBatch(paintings) {
    const key = roomPlaceholderBatchKey(paintings)
    const cached = roomPlaceholderBatchCache.get(key)
    if (cached) return cached

    const columns = Math.min(4, Math.max(1, paintings.length))
    const rows = Math.max(1, Math.ceil(paintings.length / columns))
    // Blurhashes are already returned with the album catalog. Composing them
    // into one tiny atlas gives every distant frame a photographic preview at
    // zero network cost and one draw call, rather than advertising streaming
    // with a grid of black/pastel canvases.
    const tileWidth = 160
    const tileHeight = 106
    const canvas = document.createElement('canvas')
    canvas.width = columns * tileWidth
    canvas.height = rows * tileHeight
    const context = canvas.getContext('2d')
    const parent = new THREE.Matrix4()
    const local = new THREE.Matrix4().makeTranslation(0, 0, 0.151)
    const world = new THREE.Matrix4()
    const rotation = new THREE.Quaternion()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const geometries = paintings.map((painting, index) => {
        const column = index % columns
        const row = Math.floor(index / columns)
        drawAlbumPlaceholder(
            context,
            painting.album,
            column * tileWidth,
            row * tileHeight,
            tileWidth,
            tileHeight,
            index,
        )
        const geometry = new THREE.PlaneGeometry(2.66, 1.76)
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
        world.multiplyMatrices(parent, local)
        geometry.applyMatrix4(world)
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
    roomPlaceholderBatchCache.set(key, batch)
    return batch
}

function RoomPlaceholderBatch({ paintings }) {
    const batch = useMemo(() => getRoomPlaceholderBatch(paintings), [paintings])
    if (!paintings.length) return null
    return (
        <mesh geometry={batch.geometry} renderOrder={2}>
            <meshBasicMaterial map={batch.texture} toneMapped={false} />
        </mesh>
    )
}

async function prepareRoomBatches(rooms, onProgress) {
    const pending = rooms.filter(room => room.paintings.length > 0)
    const placeholderTextures = []
    const plaqueTextures = []
    let sliceStartedAt = performance.now()
    for (let index = 0; index < pending.length; index += 1) {
        const paintings = pending[index].paintings
        placeholderTextures.push(getRoomPlaceholderBatch(paintings).texture)
        plaqueTextures.push(getRoomPlaqueBatch(paintings).texture)
        onProgress?.((index + 1) / pending.length)
        // Blurhash decoding and plaque typography are CPU-only. Build a small
        // time-bounded batch per frame rather than paying one entire frame for
        // every category. This keeps Firefox's determinate progress responsive
        // without making startup scale at 16.7 ms per room as the archive grows.
        const shouldYield = (
            index === pending.length - 1
            || index % 6 === 5
            || performance.now() - sliceStartedAt >= 8
        )
        if (shouldYield) {
            await new Promise(resolve => window.requestAnimationFrame(resolve))
            sliceStartedAt = performance.now()
        }
    }
    return { placeholderTextures, plaqueTextures }
}

function albumPlaqueSubtitle(album) {
    const date = album?.createdAt || album?.uploadedAt || ''
    return date ? new Date(`${String(date).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
    }) : 'Photographic series'
}

function LabelPlane({ title, subtitle, position, rotation = [0, 0, 0], size = [3, 0.75], renderOrder = 0, depthTest = true }) {
    const texture = useLabelTexture(title, subtitle)
    return (
        <mesh position={position} rotation={rotation} renderOrder={renderOrder}>
            <planeGeometry args={size} />
            <meshBasicMaterial map={texture} toneMapped={false} side={THREE.DoubleSide} depthTest={depthTest} />
        </mesh>
    )
}

function CategoryDoorSign({ room, side, centerZ, materials }) {
    const wallX = side * MUSEUM_DIMENSIONS.hallHalfWidth
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    // Keep the plaque as one hall-facing assembly. The earlier nested local
    // transforms placed its label behind the moulding on one side of the hall,
    // so several valid categories appeared to have no nameplate at runtime.
    const surfaceX = wallX - (side * ((HALL_WALL_THICKNESS / 2) + 0.16))
    return (
        <group position={[surfaceX, 4.92, centerZ]} rotation={[0, rotationY, 0]} renderOrder={20}>
            <mesh position={[0, 0, -0.025]} scale={[3.38, 0.82, 0.13]} castShadow receiveShadow>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshPhysicalMaterial
                    {...materials.joinery}
                    color="#9b7747"
                    metalness={0.58}
                    roughness={0.34}
                    clearcoat={0.24}
                />
            </mesh>
            <mesh position={[0, 0, 0.05]} scale={[3.16, 0.6, 0.06]}>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshStandardMaterial color="#181411" roughness={0.74} />
            </mesh>
            <LabelPlane
                title={room.name}
                subtitle={`${room.albums.length} ${room.albums.length === 1 ? 'album' : 'albums'}`}
                position={[0, 0, 0.14]}
                size={[3.04, 0.52]}
                renderOrder={22}
            />
        </group>
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
    const albumKey = [album.albumId, album.coverThumbnailUrl, album.coverImageUrl].join('|')
    let candidates = coverPreviewCandidateCache.get(albumKey)
    if (!candidates) {
        candidates = albumCoverPreviewSrcSet(album)
            .catch(() => '')
            .then(srcSet => srcSet
                .split(',')
                .map((candidate) => {
                    const [url, widthToken = ''] = candidate.trim().split(/\s+/)
                    return { url, width: Number.parseInt(widthToken, 10) || 0 }
                })
                .filter(candidate => candidate.url))
        coverPreviewCandidateCache.set(albumKey, candidates)
    }
    const previews = [...await candidates]
        .sort((left, right) => (
            Math.abs(left.width - targetWidth) - Math.abs(right.width - targetWidth)
            || right.width - left.width
        ))
    const generatedPreviews = previews.map(candidate => candidate.url)
    return [...new Set((targetWidth < LOW_RES_COVER_WIDTH ? [
        // The generated set normally includes a 240–320px derivative. Prefer
        // it for the museum-wide base layer, then fall back to the guaranteed
        // legacy thumbnail when an older album has no preview manifest.
        ...generatedPreviews,
        album.coverThumbnailUrl,
        album.coverImageUrl,
    ] : targetWidth <= LOW_RES_COVER_WIDTH ? [
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
    while (activeCoverLoads < coverLoadConcurrency() && coverLoadQueue.length > 0) {
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

function loadHtmlImage(url, highPriority = false, targetWidth = 0) {
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
            const sourceWidth = image.naturalWidth || image.width
            const sourceHeight = image.naturalHeight || image.height
            if (targetWidth > 0 && sourceWidth > targetWidth * 1.15 && sourceHeight > 0) {
                // Firefox's ImageBitmap pipeline can release multiple full-size
                // decodes in one burst. A compact canvas source keeps the later
                // WebGL upload and retained cache at the size this view asked
                // for, even when a legacy URL resolves to the original image.
                const canvas = document.createElement('canvas')
                canvas.width = Math.max(1, Math.round(targetWidth))
                canvas.height = Math.max(1, Math.round(sourceHeight * (canvas.width / sourceWidth)))
                canvas.getContext('2d', { alpha: false })?.drawImage(image, 0, 0, canvas.width, canvas.height)
                resolve(canvas)
                return
            }
            resolve(image)
        }
        image.onerror = () => {
            window.clearTimeout(timeout)
            reject(new Error('Museum cover could not be decoded'))
        }
        image.src = developmentMediaUrl(url)
    })
}

async function loadDecodedImage(url, highPriority = false, targetWidth = 0) {
    // Firefox can postpone a group of createImageBitmap decodes until the
    // compositor becomes idle, making a determinate loading bar appear frozen
    // before releasing one enormous upload burst. Its HTML image decoder is
    // independently scheduled and provides much steadier cold-start pacing.
    const firefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)
    if (firefox || typeof createImageBitmap !== 'function') return loadHtmlImage(url, highPriority, targetWidth)
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
        const decoded = await createImageBitmap(blob, {
            // WebGL ignores Texture.flipY for ImageBitmap sources, so perform
            // the upload-space flip during off-thread decoding instead.
            imageOrientation: 'flipY',
            premultiplyAlpha: 'none',
        })
        if (targetWidth > 0 && decoded.width > targetWidth * 1.15 && decoded.height > 0) {
            const resizeHeight = Math.max(1, Math.round(decoded.height * (targetWidth / decoded.width)))
            const resized = await createImageBitmap(decoded, 0, 0, decoded.width, decoded.height, {
                resizeWidth: Math.max(1, Math.round(targetWidth)),
                resizeHeight,
                resizeQuality: 'high',
            })
            decoded.close?.()
            return resized
        }
        return decoded
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
        return loadHtmlImage(url, highPriority, targetWidth)
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

function requestMuseumCoverTexture(album, targetWidth = 960, priority = targetWidth) {
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
                const image = await loadDecodedImage(url, targetWidth > LOW_RES_COVER_WIDTH, targetWidth)
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
                coverTextureCache.delete(cacheKey)
                coverTextureCache.set(cacheKey, texture)
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

async function createMuseumCoverTexture(album, targetWidth = 960, priority = targetWidth) {
    const texture = await requestMuseumCoverTexture(album, targetWidth, priority)
    // Every consumer awaiting a shared decode receives its continuation in
    // this microtask turn. Defer trimming until the next task so SceneWarmup
    // can explicitly retain a reveal texture and enqueueCoverUpload can retain
    // only a texture that genuinely still needs a GPU upload. In particular,
    // a cached texture that is already uploaded must never be re-pinned merely
    // because a painting remounted during a room revisit.
    window.setTimeout(trimCoverTextureCache, 0)
    return texture
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
                .then((texture) => {
                    if (!cancelled) return enqueueCoverUpload(gl, texture, priority)
                    trimCoverTextureCache()
                    return texture
                })
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

function GalleryFrameShells({ paintings, materials }) {
    const shadow = useRef(null)
    const backing = useRef(null)
    const frame = useRef(null)
    const frameProfile = useRef(null)
    const mat = useRef(null)
    const innerLip = useRef(null)
    const glazing = useRef(null)
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
            // Keep the assembly physically coherent from the side. The former
            // 4.15 x 4.45 backing projected far beyond a 3.24 x 2.34 frame and
            // read as a second square slab behind every landscape photograph.
            [shadow.current, [0.09, -0.1, -0.105], [0, 0, 0], [3.46, 2.56, 1]],
            [backing.current, [0, -0.025, -0.08], [0, 0, 0], [3.42, 2.52, 0.08]],
            [frame.current, [0, 0, 0], [0, 0, 0], [3.24, 2.34, 0.14]],
            // The two nested profiles are shared instanced layers, not a set
            // of per-painting rails. They give the frame a convincing stepped
            // silhouette at walking distance for two fixed draw calls.
            [frameProfile.current, [0, 0, 0.085], [0, 0, 0], [3.13, 2.23, 0.075]],
            [mat.current, [0, 0, 0.125], [0, 0, 0], [2.96, 2.06, 0.07]],
            [innerLip.current, [0, 0, 0.154], [0, 0, 0], [2.8, 1.9, 0.045]],
            [glazing.current, [0, 0, 0.19], [0, 0, 0], [2.7, 1.8, 1]],
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
        })
        batches.forEach(([mesh]) => {
            if (!mesh) return
            mesh.instanceMatrix.needsUpdate = true
            mesh.computeBoundingSphere?.()
        })
    }, [paintings])

    const count = paintings.length
    if (!count) return null
    return (
        <>
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
            <instancedMesh ref={backing} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedBacking} attach="geometry" />
                <meshStandardMaterial color="#c8c0b3" roughness={0.93} />
            </instancedMesh>
            <instancedMesh ref={frame} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedFrame} attach="geometry" />
                <meshPhysicalMaterial
                    {...materials.joinery}
                    normalScale={[0.32, 0.32]}
                    color={GOLD}
                    roughness={0.34}
                    metalness={0.66}
                    clearcoat={0.25}
                    clearcoatRoughness={0.5}
                />
            </instancedMesh>
            <instancedMesh ref={frameProfile} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedFrame} attach="geometry" />
                <meshPhysicalMaterial
                    {...materials.joinery}
                    normalScale={[0.25, 0.25]}
                    color="#8f6736"
                    roughness={0.3}
                    metalness={0.72}
                    clearcoat={0.32}
                    clearcoatRoughness={0.42}
                />
            </instancedMesh>
            <instancedMesh ref={mat} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedBacking} attach="geometry" />
                <meshStandardMaterial color="#eee7da" roughness={0.84} />
            </instancedMesh>
            <instancedMesh ref={innerLip} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedFrame} attach="geometry" />
                <meshPhysicalMaterial
                    color="#c49a5c"
                    roughness={0.3}
                    metalness={0.68}
                    clearcoat={0.3}
                    clearcoatRoughness={0.44}
                />
            </instancedMesh>
            <instancedMesh ref={glazing} args={[undefined, undefined, count]} renderOrder={5}>
                <planeGeometry args={[1, 1]} />
                <meshPhysicalMaterial
                    color="#e8f0f2"
                    transparent
                    opacity={0.055}
                    depthWrite={false}
                    roughness={0.16}
                    metalness={0.04}
                    clearcoat={0.82}
                    clearcoatRoughness={0.14}
                />
            </instancedMesh>
        </>
    )
}

function Painting({ painting, targetWidth = 0, loadLow = false, lowPriority = 0, onTextureReady }) {
    const [baseFailed, setBaseFailed] = useState(false)
    const markBaseFailed = useCallback(() => setBaseFailed(true), [])
    const baseTexture = useCoverTexture(
        painting.album,
        loadLow ? LOW_RES_COVER_WIDTH : 0,
        8000 + lowPriority,
        markBaseFailed,
    )
    const detailTexture = useCoverTexture(
        painting.album,
        baseTexture && targetWidth > LOW_RES_COVER_WIDTH ? targetWidth : 0,
        targetWidth,
    )
    const unavailableTexture = useUnavailableArtworkTexture(painting.album.title, baseFailed)
    const displayedBaseTexture = baseTexture || (baseFailed ? unavailableTexture : null)
    const baseMaterial = useRef(null)
    const detailMaterial = useRef(null)

    useEffect(() => {
        if (!displayedBaseTexture) return
        if (baseMaterial.current) {
            baseMaterial.current.visible = true
            baseMaterial.current.opacity = displayedBaseTexture.userData.museumDisplayed ? 1 : 0
        }
        onTextureReady?.(painting.id)
    }, [displayedBaseTexture, onTextureReady, painting.id])
    useEffect(() => {
        if (!detailTexture || !detailMaterial.current) return
        detailMaterial.current.visible = true
        detailMaterial.current.opacity = detailTexture.userData.museumDisplayed ? 1 : 0
    }, [detailTexture])
    useFrame((state, delta) => {
        if (displayedBaseTexture && baseMaterial.current && baseMaterial.current.opacity < 1) {
            baseMaterial.current.opacity = Math.min(1, baseMaterial.current.opacity + (delta * 0.9))
            if (baseMaterial.current.opacity >= 0.995) displayedBaseTexture.userData.museumDisplayed = true
        }
        if (detailTexture && detailMaterial.current && detailMaterial.current.opacity < 1) {
            detailMaterial.current.opacity = Math.min(1, detailMaterial.current.opacity + (delta * 1.1))
            if (detailMaterial.current.opacity >= 0.995) {
                detailTexture.userData.museumDisplayed = true
                if (baseMaterial.current) baseMaterial.current.visible = false
            }
        }
    })

    return (
        <group position={painting.position} rotation={[0, painting.rotationY, 0]} scale={painting.scale || [1, 1, 1]}>
            {displayedBaseTexture && (
                <mesh position={[0, 0, 0.181]}>
                    <planeGeometry args={[2.66, 1.76]} />
                    <meshBasicMaterial
                        ref={baseMaterial}
                        map={displayedBaseTexture}
                        color="#ffffff"
                        toneMapped={false}
                        transparent
                        // Transparent objects write depth by default. At opacity
                        // zero that briefly occluded the blurhash plane behind it,
                        // producing the conspicuous black-frame pop while covers
                        // were promoted. Keep the soft placeholder visible through
                        // the entire crossfade instead.
                        depthWrite={false}
                        opacity={0}
                    />
                </mesh>
            )}
            {detailTexture && detailTexture !== displayedBaseTexture && (
                <mesh position={[0, 0, 0.185]} renderOrder={4}>
                    <planeGeometry args={[2.66, 1.76]} />
                    <meshBasicMaterial
                        ref={detailMaterial}
                        map={detailTexture}
                        color="#ffffff"
                        toneMapped={false}
                        transparent
                        depthWrite={false}
                        opacity={0}
                    />
                </mesh>
            )}
        </group>
    )
}

function CameraAwareRoomPaintings({ room, active, detailed, allowDetail, qualityLighting, onTextureReady }) {
    const { camera } = useThree()
    const baselineSelection = useMemo(() => room.paintings.map(painting => ({
        painting,
        targetWidth: LOW_RES_COVER_WIDTH,
    })), [room.paintings])
    const initialSelection = useMemo(() => baselineSelection.slice(0, Math.min(4, baselineSelection.length)), [baselineSelection])
    // Closed physical portals fully conceal inactive rooms. Keep their decoded
    // entrance covers resident in the cache, but do not keep duplicate image
    // planes mounted behind the doors; they accumulated draw calls throughout
    // a long visit even though no visitor could see them.
    const seedSelection = useMemo(() => [], [])
    const [selection, setSelection] = useState(() => (active ? initialSelection : seedSelection))
    const selectionRef = useRef(active ? initialSelection : seedSelection)
    const selectionKey = useRef((active ? initialSelection : seedSelection).map(item => `${item.painting.id}:${item.targetWidth}`).join('|'))
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
            // Textures remain in the bounded shared cover cache, while the
            // inactive room returns to zero image-plane draw calls behind its
            // closed, dimensional portal.
            timer = window.setTimeout(() => {
                const next = seedSelection
                selectionKey.current = next.map(item => `${item.painting.id}:${item.targetWidth}`).join('|')
                selectionRef.current = next
                selectionSeenAt.current.clear()
                setSelection(next)
            }, 620)
        }
        return () => window.clearTimeout(timer)
    }, [active, initialSelection, seedSelection])
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
        // Every authored work is always represented by the room-wide blurhash
        // atlas, so the gallery never looks unfinished. Keep only a bounded
        // set of real cover planes near/in front of the visitor; remounting all
        // previously decoded covers made draw calls and frame subscribers grow
        // throughout a long visit and caused severe revisit stalls.
        const maximum = detailed
            ? Math.min(room.paintings.length, 16)
            : Math.min(room.paintings.length, 10)
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
                // Blurhash artwork is already visible in every frame, so
                // decoded covers can arrive at a deliberately restrained
                // cadence. Admitting one every ~two thirds of a second keeps
                // traversal responsive on integrated GPUs instead of turning
                // a long room into a continuous decode/upload benchmark.
                4 + Math.floor(Math.max(0, activationAge - warmupDuration) / 0.26),
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
            {active && <RoomPlaqueBatch paintings={room.paintings} />}
            {active && <RoomPlaceholderBatch paintings={room.paintings} />}
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
    const pictureLightCoordinates = useMemo(() => Object.fromEntries(
        [-1, 1].map(direction => [direction, room.paintings
            .filter(painting => Math.sign(painting.normal?.[2] || 1) === -direction)
            .map(painting => painting.position[0] - shellCenterX)]),
    ), [room.paintings, shellCenterX])
    return (
        <>
            <BakedWallpaperSurface
                materials={materials}
                position={[
                    room.outerX - (room.side * ((wallThickness / 2) + WALL_SURFACE_GAP)),
                    ceilingY / 2,
                    room.centerZ,
                ]}
                rotation={[0, outerRotationY, 0]}
                width={Math.max(1, room.width - 0.32)}
                height={ceilingY - 0.28}
                centerZ={room.centerZ}
                color={color}
                phase={roomPhase}
                reverseU={room.side < 0}
            />
            {[-1, 1].map(direction => (
                <BakedWallpaperSurface
                    materials={materials}
                    key={direction}
                    position={[
                        shellCenterX,
                        ceilingY / 2,
                        room.centerZ + direction * ((room.width / 2) - ((wallThickness / 2) + WALL_SURFACE_GAP)),
                    ]}
                    rotation={[0, direction < 0 ? 0 : Math.PI, 0]}
                    width={Math.max(1, shellDepth - 0.28)}
                    height={ceilingY - 0.28}
                    centerZ={shellCenterX}
                    color={color}
                    phase={roomPhase}
                    reverseU={direction > 0}
                    fixtures={pictureLightCoordinates[direction]}
                />
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
                        <mesh scale={[panelLength - 0.32, 0.09, room.width - 1.15]}>
                            <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                            <meshStandardMaterial color="#756b61" roughness={0.88} />
                        </mesh>
                        <mesh position={[0, -0.048, 0]} scale={[panelLength - 0.62, 0.026, room.width - 1.48]}>
                            <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                            <PlasterMaterial materials={materials} color="#cbc0b1" roughness={0.93} />
                        </mesh>
                    </group>
                )
            })}
            <group position={[shellCenterX, ceilingY - 0.19, room.centerZ]}>
                <mesh scale={[Math.max(1, shellDepth - 0.8), 0.055, 0.1]}>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
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

function RoomSalonBays({ room, ceilingY, materials }) {
    const wallInset = (room.width / 2) - 0.27
    const salonSpan = room.depth / Math.max(1, room.benches.length)
    const roomVariant = useMemo(() => (
        [...room.id].reduce((total, character) => total + character.charCodeAt(0), 0) % 3
    ), [room.id])
    const accentColors = ['#a98253', '#92704b', '#b18a5b']

    return (
        <group>
            {room.benches.map((bench, index) => {
                const nextBench = room.benches[index + 1]
                const previousBench = room.benches[index - 1]
                // Salon ribs belong at the threshold between seating groups,
                // not through the centerline of a bench and its artwork. The
                // latter made the architecture visibly collide with picture
                // lights in long generated rooms.
                const x = nextBench
                    ? (bench.position[0] + nextBench.position[0]) / 2
                    : previousBench
                        ? bench.position[0] + ((bench.position[0] - previousBench.position[0]) / 2)
                        : bench.position[0]
                const salonStyle = (roomVariant + index) % 3
                const panelTone = ['#b9ad9e', '#a99d90', '#c4b7a7'][salonStyle]
                const localAccent = accentColors[salonStyle]
                const floorInlayWidth = Math.min(
                    [4.25, 4.85, 3.75][salonStyle],
                    Math.max(3.25, salonSpan * 0.58),
                )
                const pierWidth = [0.23, 0.29, 0.2][salonStyle]
                const medallionOuter = [0.48, 0.42, 0.54][salonStyle]
                return (
                    <group key={`${bench.id}-salon`}>
                        {/* A transverse ceiling rib and paired wall piers turn
                            a long generated gallery into a sequence of calm,
                            human-scale viewing salons. Everything hugs the
                            shell, so the architectural rhythm never creates
                            invisible collision or narrows the player route. */}
                        <mesh position={[x, ceilingY - 0.34, room.centerZ]} scale={[[0.28, 0.24, room.width - 0.46], [0.36, 0.2, room.width - 0.72], [0.22, 0.3, room.width - 0.38]][salonStyle]}>
                            <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                            <PlasterMaterial materials={materials} color={panelTone} roughness={0.9} />
                        </mesh>
                        <mesh position={[x, ceilingY - 0.48, room.centerZ]} rotation={[Math.PI / 2, 0, 0]}>
                            <ringGeometry args={[medallionOuter - 0.14, medallionOuter, 24]} />
                            <meshStandardMaterial color={localAccent} metalness={0.5} roughness={0.5} side={THREE.DoubleSide} />
                        </mesh>
                        <mesh position={[x, ceilingY - 0.475, room.centerZ]} rotation={[Math.PI / 2, 0, 0]}>
                            <circleGeometry args={[medallionOuter - 0.17, 24]} />
                            <PlasterMaterial materials={materials} color="#d9d0c5" roughness={0.92} />
                        </mesh>
                        {[-1, 1].map(direction => (
                            <group key={direction} position={[x, 2.72, room.centerZ + (direction * wallInset)]}>
                                <mesh scale={[pierWidth, [5.16, 4.82, 5.34][salonStyle], 0.2]}>
                                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                    <PlasterMaterial materials={materials} color={panelTone} roughness={0.9} />
                                </mesh>
                                <mesh position={[0, 0, -direction * 0.112]} scale={[0.055, 4.44, 0.026]}>
                                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                    <meshStandardMaterial color={localAccent} metalness={0.48} roughness={0.52} />
                                </mesh>
                                <mesh position={[0, 2.6, -direction * 0.02]} scale={[0.44, 0.22, 0.34]}>
                                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                    <PlasterMaterial materials={materials} color="#d7cec2" roughness={0.9} />
                                </mesh>
                                <mesh position={[0, -2.52, -direction * 0.02]} scale={[0.48, 0.26, 0.38]}>
                                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                    <PlasterMaterial materials={materials} color="#c8bcad" roughness={0.92} />
                                </mesh>
                            </group>
                        ))}
                        <mesh position={[x, 0.026, room.centerZ]}>
                            <boxGeometry args={[floorInlayWidth, 0.025, room.width - 1.05]} />
                            <meshStandardMaterial color={['#5c4434', '#4f4037', '#664a39'][salonStyle]} roughness={0.82} />
                        </mesh>
                        <mesh position={[x - (floorInlayWidth / 2), 0.045, room.centerZ]}>
                            <boxGeometry args={[0.035, 0.025, room.width - 1.1]} />
                            <meshStandardMaterial color={localAccent} metalness={0.42} roughness={0.58} />
                        </mesh>
                        <mesh position={[x + (floorInlayWidth / 2), 0.045, room.centerZ]}>
                            <boxGeometry args={[0.035, 0.025, room.width - 1.1]} />
                            <meshStandardMaterial color={localAccent} metalness={0.42} roughness={0.58} />
                        </mesh>
                    </group>
                )
            })}
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

function makePortalArchGeometry(radiusOffset, riseOffset, tubeRadius) {
    const openingRadius = (MUSEUM_DIMENSIONS.doorwayWidth / 2) + radiusOffset
    const springHeight = 2.7
    const archRise = 1.55 + riseOffset
    const points = Array.from({ length: 33 }, (_, segment) => {
        const angle = Math.PI - ((Math.PI * segment) / 32)
        return new THREE.Vector3(
            Math.cos(angle) * openingRadius,
            springHeight + (Math.sin(angle) * archRise),
            0,
        )
    })
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5)
    return new THREE.TubeGeometry(curve, 48, tubeRadius, 8, false)
}

function DoorWall({ side, centerZ, room, materials, sconcePlacements = EMPTY_FIXTURES }) {
    const wallX = side * MUSEUM_DIMENSIONS.hallHalfWidth
    const thickness = HALL_WALL_THICKNESS
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    const spandrelShape = useArchSpandrelShape()
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
                                sconcePlacements={sconcePlacements}
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
                            bevelEnabled: true,
                            bevelSegments: 2,
                            bevelSize: 0.025,
                            bevelThickness: 0.02,
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
                        sconcePlacements={sconcePlacements}
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
                    <mesh scale={[0.075, 1.72, Math.max(0.5, panelWidth - 0.16)]}>
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshStandardMaterial color="#8f806d" roughness={0.78} />
                    </mesh>
                    <mesh position={[-side * 0.046, 0, 0]} scale={[0.08, 1.42, Math.max(0.35, panelWidth - 0.46)]}>
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshStandardMaterial color="#b9aa95" roughness={0.86} />
                    </mesh>
                    <mesh position={[-side * 0.082, 0, 0]} scale={[0.034, 1.22, Math.max(0.24, panelWidth - 0.68)]}>
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshPhysicalMaterial color="#9b7747" metalness={0.38} roughness={0.52} />
                    </mesh>
                    <mesh position={[0, -1.03, 0]} scale={[0.11, 0.2, panelWidth + 0.02]}>
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshStandardMaterial color="#6f5f4e" roughness={0.72} />
                    </mesh>
                </group>
            ))}
            {room && (
                <>
                    <mesh
                        position={[wallX - (side * ((thickness / 2) + 0.018)), 0, centerZ]}
                        rotation={[0, rotationY, 0]}
                        geometry={PORTAL_ARCH_STONE_GEOMETRY}
                        castShadow
                        receiveShadow
                    >
                        <PlasterMaterial materials={materials} color="#b8aa96" />
                    </mesh>
                    <mesh
                        position={[wallX - (side * ((thickness / 2) + 0.145)), 0, centerZ]}
                        rotation={[0, rotationY, 0]}
                        geometry={PORTAL_ARCH_REVEAL_GEOMETRY}
                        castShadow
                    >
                        <meshPhysicalMaterial color="#6e5639" metalness={0.34} roughness={0.48} clearcoat={0.18} />
                    </mesh>
                    {[-1, 1].map(direction => (
                        <group key={direction} position={[wallX, 1.42, centerZ + direction * (archRadius + 0.18)]}>
                            <mesh scale={[0.46, 2.84, 0.38]} castShadow receiveShadow>
                                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                <PlasterMaterial materials={materials} color="#b8aa96" textured={false} />
                            </mesh>
                            <mesh position={[-side * 0.038, 0, 0]} scale={[0.12, 2.46, 0.22]}>
                                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                <meshStandardMaterial color="#8b7861" roughness={0.74} />
                            </mesh>
                            {[-0.13, 0.13].map(offset => (
                                <mesh key={offset} position={[-side * 0.246, 0, offset]} scale={[0.05, 2.38, 0.055]}>
                                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                    <meshStandardMaterial color="#c2b39d" roughness={0.7} />
                                </mesh>
                            ))}
                            <mesh position={[0, 1.48, 0]} scale={[0.56, 0.2, 0.58]} castShadow>
                                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                <meshStandardMaterial color="#ad9c84" roughness={0.72} />
                            </mesh>
                            <mesh position={[0, 1.66, 0]} scale={[0.66, 0.12, 0.68]} castShadow>
                                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                <meshPhysicalMaterial color="#70583b" metalness={0.18} roughness={0.58} />
                            </mesh>
                            <mesh position={[0, -1.47, 0]} scale={[0.58, 0.2, 0.62]} castShadow>
                                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                <meshStandardMaterial color="#ad9c84" roughness={0.72} />
                            </mesh>
                            <mesh position={[0, -1.64, 0]} scale={[0.68, 0.12, 0.72]} castShadow>
                                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                                <meshPhysicalMaterial color="#70583b" metalness={0.18} roughness={0.58} />
                            </mesh>
                        </group>
                    ))}
                    <CategoryDoorSign room={room} side={side} centerZ={centerZ} materials={materials} />
                </>
            )}
        </group>
    )
}

function FarDoorWall({ side, centerZ, room, materials, sconcePlacements = EMPTY_FIXTURES }) {
    const wallX = side * MUSEUM_DIMENSIONS.hallHalfWidth
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    const openingShape = useArchOpeningShape()

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
                sconcePlacements={sconcePlacements}
            />
            <mesh
                position={[
                    wallX - (side * ((HALL_WALL_THICKNESS / 2) + 0.026)),
                    1.35,
                    centerZ,
                ]}
                scale={[0.07, 2.12, MUSEUM_DIMENSIONS.baySpacing - 0.84]}
            >
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshStandardMaterial color="#9c8c78" roughness={0.84} />
            </mesh>
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
                        geometry={PORTAL_ARCH_STONE_GEOMETRY}
                    >
                        <meshStandardMaterial
                            {...materials.joinery}
                            normalScale={[0.24, 0.24]}
                            color="#c9bda9"
                            roughness={0.72}
                        />
                    </mesh>
                    <CategoryDoorSign room={room} side={side} centerZ={centerZ} materials={materials} />
                </>
            )}
        </group>
    )
}

function DistanceManagedDoorWall({ side, centerZ, room, materials, forceNear = false, sconcePlacements = EMPTY_FIXTURES }) {
    if (!room) return <FarDoorWall side={side} centerZ={centerZ} room={null} materials={materials} sconcePlacements={sconcePlacements} />
    return (
        <CameraManagedDoorWall
            side={side}
            centerZ={centerZ}
            room={room}
            materials={materials}
            forceNear={forceNear}
            sconcePlacements={sconcePlacements}
        />
    )
}

function CameraManagedDoorWall({ side, centerZ, room, materials, forceNear, sconcePlacements }) {
    // Distant, nonresident rooms retain an intentional velvet closure instead
    // of exposing an empty black shell. Residency flips while the threshold is
    // still far ahead, so the open architectural entrance is stable by the
    // time a visitor can inspect or cross it.
    if (!forceNear) {
        return <FarDoorWall side={side} centerZ={centerZ} room={room} materials={materials} sconcePlacements={sconcePlacements} />
    }
    return <DoorWall side={side} centerZ={centerZ} room={room} materials={materials} sconcePlacements={sconcePlacements} />
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
                <mesh key={side} position={[side * (MUSEUM_DIMENSIONS.hallHalfWidth - 0.06), 4.98, centerZ + 0.14]} scale={[0.16, 0.22, Math.max(1, layout.hallLength - 0.28)]}>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <meshStandardMaterial color="#b8aa95" roughness={0.72} />
                </mesh>
            ))}
        </group>
    )
}

const ROOM_LIGHTING_PALETTES = [
    { warm: '#ffc48f', cool: '#b9d1df', fill: '#efbd8a' },
    { warm: '#ffd3a9', cool: '#b8c8e0', fill: '#e8c29c' },
    { warm: '#f4bb86', cool: '#c2d9d2', fill: '#e7b67f' },
    { warm: '#ffd0a0', cool: '#c9c3df', fill: '#eac29b' },
]

function roomLightingPalette(room) {
    if (!room) return ROOM_LIGHTING_PALETTES[0]
    const hash = [...room.id].reduce((total, character) => total + character.charCodeAt(0), 0)
    return ROOM_LIGHTING_PALETTES[hash % ROOM_LIGHTING_PALETTES.length]
}

function TransitioningRoomAreaLight({ room, direction, qualityLighting }) {
    const light = useRef(null)
    const renderedRoom = useRef(room || null)
    const desiredRoom = useRef(room || null)
    const placementRoomId = useRef(null)

    useEffect(() => {
        desiredRoom.current = room || null
    }, [room])

    useFrame((state, delta) => {
        if (!light.current) return
        const current = renderedRoom.current
        const desired = desiredRoom.current
        const roomChanged = current?.id !== desired?.id
        if (roomChanged) {
            light.current.intensity = THREE.MathUtils.damp(
                light.current.intensity,
                0,
                12,
                Math.min(delta, 0.05),
            )
            // Reposition only at true blackout. Even a tiny residual from a
            // strong spot becomes a full-wall streak when teleported to a new
            // room and was perceived as a random screen flash.
            if (light.current.intensity < 0.002) {
                renderedRoom.current = desired
                placementRoomId.current = null
            }
            return
        }
        if (current && placementRoomId.current !== current.id) {
            const palette = roomLightingPalette(current)
            light.current.color.set(direction < 0 ? palette.warm : palette.cool)
            const centerX = current.centerX + (current.side * (ROOM_SHELL_INSET / 2))
            const halfWidth = Math.max(1.5, current.width * 0.27)
            const wallZ = current.centerZ + (direction * halfWidth)
            // Area sources face their corresponding picture walls, so their
            // energy cannot leak through the portal and brighten the corridor
            // when a fixture slot changes ownership. They also create a broad,
            // physically lit wall response instead of the former additive
            // glow cards that merely brightened the screen.
            light.current.position.set(
                centerX,
                4.62,
                wallZ - (direction * 0.72),
            )
            light.current.width = THREE.MathUtils.clamp(current.depth * 0.48, 3.9, 6.6)
            light.current.height = 2.2
            light.current.lookAt(centerX, 2.9, wallZ)
            placementRoomId.current = current.id
        }
        const targetIntensity = current ? (qualityLighting ? 3.2 : 2.4) : 0
        light.current.intensity = THREE.MathUtils.damp(
            light.current.intensity,
            targetIntensity,
            current ? 3.6 : 10,
            Math.min(delta, 0.05),
        )
    })

    return (
        <rectAreaLight
            ref={light}
            color={direction < 0 ? '#ffd0a0' : '#c8d5de'}
            intensity={0}
            width={6}
            height={2.2}
        />
    )
}

function TransitioningRoomFill({ room, qualityLighting }) {
    const light = useRef(null)
    const renderedRoom = useRef(room || null)
    const desiredRoom = useRef(room || null)
    const placementRoomId = useRef(null)

    useEffect(() => {
        desiredRoom.current = room || null
    }, [room])

    useFrame((state, delta) => {
        if (!light.current) return
        const current = renderedRoom.current
        const desired = desiredRoom.current
        if (current?.id !== desired?.id) {
            light.current.intensity = THREE.MathUtils.damp(
                light.current.intensity,
                0,
                12,
                Math.min(delta, 0.05),
            )
            if (light.current.intensity < 0.002) {
                renderedRoom.current = desired
                placementRoomId.current = null
            }
            return
        }
        if (current && placementRoomId.current !== current.id) {
            light.current.color.set(roomLightingPalette(current).fill)
            light.current.position.set(
                current.centerX + (current.side * (ROOM_SHELL_INSET / 2)),
                5.25,
                current.centerZ,
            )
            placementRoomId.current = current.id
        }
        light.current.intensity = THREE.MathUtils.damp(
            light.current.intensity,
            current ? (qualityLighting ? 9.1 : 7.2) : 0,
            current ? 3.2 : 10,
            Math.min(delta, 0.05),
        )
    })

    return (
        <pointLight
            ref={light}
            color="#f1cba2"
            intensity={0}
            distance={4.2}
            decay={2}
            castShadow={false}
        />
    )
}

function TransitioningArtworkSpot({ room, slot, slotCount, qualityLighting }) {
    const light = useRef(null)
    const target = useMemo(() => new THREE.Object3D(), [])
    const renderedRoom = useRef(room || null)
    const desiredRoom = useRef(room || null)
    const placementKey = useRef(null)

    useEffect(() => {
        desiredRoom.current = room || null
    }, [room])

    useEffect(() => () => target.removeFromParent(), [target])

    useFrame((state, delta) => {
        if (!light.current) return
        const current = renderedRoom.current
        const desired = desiredRoom.current
        if (current?.id !== desired?.id) {
            light.current.intensity = THREE.MathUtils.damp(
                light.current.intensity,
                0,
                16,
                Math.min(delta, 0.05),
            )
            if (light.current.intensity < 0.001) {
                renderedRoom.current = desired
                placementKey.current = null
            }
            return
        }
        const paintings = current?.paintings || []
        const selectedIndex = museumArtworkLightIndex(paintings.length, slot, slotCount)
        if (selectedIndex < 0) {
            light.current.intensity = THREE.MathUtils.damp(light.current.intensity, 0, 14, delta)
            return
        }
        const painting = paintings[selectedIndex]
        if (!painting) {
            light.current.intensity = THREE.MathUtils.damp(light.current.intensity, 0, 14, delta)
            return
        }
        const nextKey = `${current.id}:${painting.id}`
        if (placementKey.current !== nextKey) {
            const [normalX = 0, , normalZ = 1] = painting.normal || []
            const [x, , z] = painting.position
            light.current.position.set(
                x + (normalX * 1.12),
                4.72,
                z + (normalZ * 1.12),
            )
            target.position.set(
                x + (normalX * 0.04),
                2.58,
                z + (normalZ * 0.04),
            )
            target.updateMatrixWorld(true)
            light.current.target = target
            light.current.color.set(slot % 2 ? '#f0cba4' : '#ffd7a9')
            placementKey.current = nextKey
        }
        light.current.intensity = THREE.MathUtils.damp(
            light.current.intensity,
                qualityLighting ? 54 : 40,
            4.2,
            Math.min(delta, 0.05),
        )
    })

    return (
        <>
            <primitive object={target} />
            <spotLight
                ref={light}
                color="#ffd3a0"
                intensity={0}
                distance={5.4}
                decay={2}
                angle={0.48}
                penumbra={0.88}
                castShadow={false}
            />
        </>
    )
}

function FixedRoomLighting({ rooms, qualityLighting }) {
    const room = rooms[0] || null
    const artworkLightSlots = qualityLighting ? 4 : 2
    // These four fixtures remain mounted for the lifetime of the scene. Their
    // imperative transition code fades to true black before moving, so room
    // changes never remount lights or expose React's intermediate empty state.
    return [
        ...[-1, 1].map(direction => (
            <TransitioningRoomAreaLight
                key={`room-light-slot-${direction}`}
                room={room}
                direction={direction}
                qualityLighting={qualityLighting}
            />
        )),
        <TransitioningRoomFill
            key="room-fill-slot"
            room={room}
            qualityLighting={qualityLighting}
        />,
        // Two localized real sources provide readable picture-light pools.
        // The two broad room area lights handle the remaining wall; adding a
        // forward-rendered light per frame would scale fragment cost with the
        // archive and undermine the long-session stability this pass targets.
        ...Array.from({ length: artworkLightSlots }, (_, slot) => (
            <TransitioningArtworkSpot
                key={`artwork-light-slot-${slot}`}
                room={room}
                slot={slot}
                slotCount={artworkLightSlots}
                qualityLighting={qualityLighting}
            />
        )),
    ]
}

function RoomFocalLandmark({ room, materials }) {
    const landmark = room.landmark
    const [x, , z] = landmark?.position || [0, 0, 0]
    const [landmarkCollisionWidth, landmarkHeight] = landmark?.size || [2.8, 3.8, 4.6]
    const landmarkWidth = Math.min(2.55, landmarkCollisionWidth)
    const scaleFactor = Math.max(0.86, Math.min(1.34, landmarkHeight / 3.8))
    const backdropX = x + (room.side * 0.74 * scaleFactor)
    const backdropWidth = Math.max(3.35, landmarkWidth * 1.48)
    const backdropHeight = Math.max(4.05, landmarkHeight * 1.08)
    const nicheGeometry = useMemo(() => {
        const width = Math.min(backdropWidth - 0.58, 2.7)
        const height = Math.min(backdropHeight - 0.52, 3.46)
        const springY = 0.18
        const archRise = Math.min(width * 0.48, 1.16)
        const shape = new THREE.Shape()
        shape.moveTo(-width / 2, -height / 2)
        shape.lineTo(width / 2, -height / 2)
        shape.lineTo(width / 2, springY)
        for (let segment = 0; segment <= 28; segment += 1) {
            const angle = (Math.PI * segment) / 28
            shape.lineTo(
                Math.cos(angle) * (width / 2),
                springY + (Math.sin(angle) * archRise),
            )
        }
        shape.lineTo(-width / 2, -height / 2)
        shape.closePath()
        const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: 0.09,
            bevelEnabled: true,
            bevelSegments: 3,
            bevelSize: 0.045,
            bevelThickness: 0.035,
            curveSegments: 28,
            steps: 1,
        })
        geometry.translate(0, 0, -0.045)
        geometry.computeVertexNormals()
        return geometry
    }, [backdropHeight, backdropWidth])

    useEffect(() => () => {
        nicheGeometry.dispose()
    }, [nicheGeometry])
    if (!landmark) return null
    return (
        <group position={[0, 0, 0]}>
            {/* A freestanding focal wall gives the sculpture a readable
                silhouette in archive-scale rooms without adding a new light
                or requiring the actual end wall to be visible. The shallow
                dimensional shell and brass reveal keep it convincing from the
                side while leaving generous circulation on both sides. */}
            <group position={[backdropX, backdropHeight / 2, z]}>
                <mesh scale={[0.18, backdropHeight, backdropWidth]} castShadow receiveShadow>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <meshPhysicalMaterial
                        {...materials.joinery}
                        color="#755047"
                        emissive="#23120f"
                        emissiveIntensity={0.14}
                        roughness={0.62}
                        metalness={0.05}
                        clearcoat={0.12}
                        clearcoatRoughness={0.7}
                    />
                </mesh>
                <mesh
                    position={[-room.side * 0.11, 0, 0]}
                    scale={[0.04, backdropHeight - 0.24, backdropWidth - 0.24]}
                >
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <meshPhysicalMaterial color="#ad8250" metalness={0.68} roughness={0.3} clearcoat={0.24} />
                </mesh>
                <mesh position={[-room.side * 0.145, 0, 0]} scale={[0.026, backdropHeight - 0.44, backdropWidth - 0.44]}>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <meshStandardMaterial color="#66423a" emissive="#1d0e0c" emissiveIntensity={0.12} roughness={0.68} />
                </mesh>
                {/* Deep side stiles plus projecting crown/plinth returns turn
                    the illuminated field into architecture instead of a dark
                    card. The same shallow module is reused across rooms. */}
                {[-1, 1].map(direction => (
                    <mesh
                        key={`focal-stile-${direction}`}
                        position={[-room.side * 0.2, 0, direction * ((backdropWidth / 2) - 0.14)]}
                        scale={[0.34, backdropHeight + 0.12, 0.24]}
                        castShadow
                        receiveShadow
                    >
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshPhysicalMaterial {...materials.joinery} color="#34211d" roughness={0.57} clearcoat={0.18} />
                    </mesh>
                ))}
                {[-1, 1].map(direction => (
                    <mesh
                        key={`focal-rail-${direction}`}
                        position={[-room.side * 0.21, direction * ((backdropHeight / 2) - 0.14), 0]}
                        scale={[0.36, 0.22, backdropWidth + 0.12]}
                        castShadow
                        receiveShadow
                    >
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshPhysicalMaterial {...materials.joinery} color="#30201b" roughness={0.56} clearcoat={0.16} />
                    </mesh>
                ))}
            </group>
            {/* The focal sculpture sits inside a shallow, genuinely extruded
                arched niche rather than a rectangular glow card. Closely
                layered beveled shells form a brass reveal, warm inset field,
                and dark inner return that remain dimensional from oblique
                views without another transparent plane or live light. */}
            <group
                position={[backdropX - (room.side * 0.185), backdropHeight * 0.49, z]}
                rotation={[0, room.side < 0 ? Math.PI / 2 : -Math.PI / 2, 0]}
            >
                <mesh geometry={nicheGeometry} scale={[1.08, 1.08, 1]} castShadow receiveShadow>
                    <meshPhysicalMaterial color="#a77a45" metalness={0.62} roughness={0.32} clearcoat={0.28} />
                </mesh>
                <mesh geometry={nicheGeometry} position={[0, 0, 0.085]} scale={[0.94, 0.94, 0.72]} receiveShadow>
                    <meshPhysicalMaterial
                        color="#5a342c"
                        emissive="#321711"
                        emissiveIntensity={0.12}
                        roughness={0.69}
                        clearcoat={0.1}
                    />
                </mesh>
                <mesh geometry={nicheGeometry} position={[0, 0, 0.145]} scale={[0.81, 0.81, 0.48]} receiveShadow>
                    <meshPhysicalMaterial
                        color="#2c1c19"
                        emissive="#190b08"
                        emissiveIntensity={0.06}
                        roughness={0.78}
                        clearcoat={0.04}
                    />
                </mesh>
            </group>
            <group position={[x, 0, z]} scale={[landmarkWidth / 2.35, scaleFactor, landmarkWidth / 2.35]}>
                <mesh position={[0, 0.39, 0]} scale={[1.55, 0.78, 1.55]} castShadow receiveShadow>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <PlasterMaterial materials={materials} color="#bdb2a4" textured={false} />
                </mesh>
                <mesh position={[0, 0.83, 0]} scale={[1.7, 0.12, 1.7]} castShadow receiveShadow>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <meshPhysicalMaterial color="#8f6b42" metalness={0.5} roughness={0.4} clearcoat={0.22} />
                </mesh>
                {landmark.variant === 0 && (
                    <mesh position={[0, 1.7, 0]} rotation={[0.22, 0.48, 0.06]} castShadow>
                        <torusKnotGeometry args={[0.52, 0.14, 64, 10, 2, 3]} />
                        <meshPhysicalMaterial color="#a47843" metalness={0.82} roughness={0.22} clearcoat={0.3} />
                    </mesh>
                )}
                {landmark.variant === 1 && (
                    <group position={[0, 1.62, 0]}>
                        {[
                            [0, 0, 0, 0.18, 0.2, 0],
                            [0, 0.12, 0, 1.18, 0.36, 0.2],
                            [0, -0.1, 0, 0.74, 1.02, -0.18],
                        ].map((entry, index) => (
                            <mesh key={index} position={entry.slice(0, 3)} rotation={entry.slice(3)} castShadow>
                                <torusGeometry args={[0.58 - (index * 0.035), 0.075, 10, 42]} />
                                <meshPhysicalMaterial
                                    color={index === 1 ? '#c3a36e' : '#8e673c'}
                                    metalness={0.78}
                                    roughness={0.25}
                                    clearcoat={0.28}
                                />
                            </mesh>
                        ))}
                    </group>
                )}
                {landmark.variant === 2 && (
                    <group position={[0, 1.5, 0]} rotation={[0, 0.36, 0]}>
                        <mesh rotation={[0.18, 0, -0.42]} castShadow>
                            <capsuleGeometry args={[0.22, 1.18, 8, 14]} />
                            <meshPhysicalMaterial color="#a68259" metalness={0.62} roughness={0.3} clearcoat={0.32} />
                        </mesh>
                        <mesh position={[0.16, 0.55, 0.05]} scale={[0.5, 0.8, 0.5]} castShadow>
                            <sphereGeometry args={[0.55, 18, 12]} />
                            <meshPhysicalMaterial color="#c0a57c" metalness={0.48} roughness={0.34} clearcoat={0.28} />
                        </mesh>
                        <mesh position={[-0.22, -0.48, -0.08]} scale={[0.62, 0.45, 0.62]} castShadow>
                            <sphereGeometry args={[0.48, 18, 12]} />
                            <meshPhysicalMaterial color="#795735" metalness={0.66} roughness={0.28} clearcoat={0.3} />
                        </mesh>
                    </group>
                )}
            </group>
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
    const roomFloorFixtures = useMemo(
        () => [...new Set(room.paintings.map(painting => Number((painting.position[0] - room.centerX).toFixed(3))))],
        [room.centerX, room.paintings],
    )
    const roomFloorOccluders = useMemo(() => [
        ...room.benches.map(item => bakedFloorOccluder(item, room.centerX, room.centerZ, 0.14)),
        ...room.plants.map(item => bakedFloorOccluder(item, room.centerX, room.centerZ, 0.075)),
    ], [room.benches, room.centerX, room.centerZ, room.plants])
    const thresholdDepth = ROOM_SHELL_INSET + HALL_WALL_THICKNESS + 0.18
    const thresholdCenterX = room.innerX + (room.side * ((ROOM_SHELL_INSET - HALL_WALL_THICKNESS) / 2))
    const [readyPaintingIds, setReadyPaintingIds] = useState(() => new Set())
    const readyPaintingIdsRef = useRef(new Set())
    const readyFlushTimer = useRef(null)
    const [allowDetail, setAllowDetail] = useState(false)
    // Door architecture and the room shell must change in the same React
    // commit. Deferring residency through a timer let the open portal render
    // for one frame before its interior, which read as a black flash at the
    // threshold on fast machines and as an empty room on slower ones.
    const interiorResident = active
    const roomPaintingIds = useMemo(() => new Set(
        room.paintings.slice(0, Math.min(4, room.paintings.length)).map(painting => painting.id),
    ), [room.paintings])
    // The portal only opens once its entire entrance sightline is resident.
    // Permanent image failures still resolve to the authored fallback texture,
    // so this cannot strand a room while it does prevent a half-hung reveal.
    const requiredReadyCount = roomPaintingIds.size
    const entranceReadyCount = [...roomPaintingIds]
        .filter(id => readyPaintingIds.has(id)).length
    // Architecture and traversal must never depend on image networking. The
    // blurhash atlas is the deterministic visual fallback while covers stream.
    const roomReady = active
    useEffect(() => {
        if (!import.meta.env.DEV) return
        const current = JSON.parse(document.documentElement.dataset.museumRooms || '{}')
        current[room.id] = {
            active,
            interiorVisible: interiorResident,
            roomReady,
            ready: readyPaintingIds.size,
            entranceReady: entranceReadyCount,
            required: requiredReadyCount,
            readyIds: [...readyPaintingIds],
            requiredIds: [...roomPaintingIds],
        }
        document.documentElement.dataset.museumRooms = JSON.stringify(current)
    }, [active, entranceReadyCount, interiorResident, readyPaintingIds, requiredReadyCount, room.id, roomPaintingIds, roomReady])
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
        }
    }, [active, detailed, roomReady])
    useEffect(() => () => {
        window.clearTimeout(readyFlushTimer.current)
        readyFlushTimer.current = null
    }, [])
    const markPaintingReady = useCallback((paintingId) => {
        if (readyPaintingIdsRef.current.has(paintingId)) return
        readyPaintingIdsRef.current.add(paintingId)
        if (readyFlushTimer.current) return
        readyFlushTimer.current = window.setTimeout(() => {
            readyFlushTimer.current = null
            setReadyPaintingIds(new Set(readyPaintingIdsRef.current))
        }, 72)
    }, [])
    const roomVariant = useMemo(() => (
        [...room.id].reduce((total, character) => total + character.charCodeAt(0), 0) % 4
    ), [room.id])
    const roomTint = ['#d8cab8', '#c9cbbd', '#d3c2bb', '#c7bdaf'][roomVariant]
    return (
        <group>
            <group>
                <mesh position={[thresholdCenterX, -0.02, room.centerZ]} scale={[thresholdDepth, 0.16, MUSEUM_DIMENSIONS.doorwayWidth - 0.18]} receiveShadow>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <FloorMaterial materials={materials} color="#73573f" />
                </mesh>
                <mesh position={[thresholdCenterX, 0.055, room.centerZ]} scale={[thresholdDepth - 0.08, 0.025, MUSEUM_DIMENSIONS.doorwayWidth - 0.38]}>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
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
                        scale={[thresholdDepth, 2.68, 0.22]}
                    >
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshStandardMaterial color="#b9aa95" roughness={0.76} />
                    </mesh>
                ))}
            </group>
            {/* Keep every room resident but hide inactive interiors behind their
                closed physical portals. Frustum culling cannot infer occlusion,
                so rendering all nine concealed rooms made a hallway view more
                expensive than standing inside one. Visibility flips while the
                thick door is still closed; the portal then waits for its four
                entrance covers before opening, so visitors never see a shell
                pop into existence. */}
            <group visible={interiorResident}>
            <BakedIrradianceFloor
                position={[room.centerX, -0.11, room.centerZ]}
                size={[room.depth, roomWidth]}
                materials={materials}
                color="#73573f"
                fixtures={roomFloorFixtures}
                occluders={roomFloorOccluders}
            />
            <mesh position={[shellCenterX, 0.012, room.centerZ]} scale={[Math.max(1, shellDepth - 0.48), 0.028, 2.5]} receiveShadow>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshStandardMaterial color="#471f2a" roughness={0.92} />
            </mesh>
            {[-1, 1].map(direction => (
                <mesh
                    key={`room-runner-edge-${direction}`}
                    position={[shellCenterX, 0.031, room.centerZ + (direction * 1.18)]}
                    scale={[Math.max(1, shellDepth - 0.52), 0.018, 0.045]}
                >
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <meshPhysicalMaterial color="#a47a43" metalness={0.48} roughness={0.42} />
                </mesh>
            ))}
            <mesh position={[shellCenterX, ceilingY, room.centerZ]}>
                <boxGeometry args={[shellDepth, 0.18, roomWidth]} />
                <PlasterMaterial materials={materials} color="#e9e2d8" textured={false} />
            </mesh>
            {interiorResident && (
                <RoomCofferedCeiling
                    room={room}
                    shellCenterX={shellCenterX}
                    shellDepth={shellDepth}
                    ceilingY={ceilingY}
                    materials={materials}
                />
            )}
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
                    <mesh position={[shellCenterX, 0.16, room.centerZ + direction * ((roomWidth / 2) - 0.26)]} scale={[shellDepth, 0.32, 0.18]}>
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshStandardMaterial color="#887763" roughness={0.7} />
                    </mesh>
                    <mesh position={[shellCenterX, 0.035, room.centerZ + direction * ((roomWidth / 2) - 0.34)]}>
                        <boxGeometry args={[Math.max(0.5, shellDepth - 0.3), 0.055, 0.3]} />
                        <meshBasicMaterial color="#160f0c" transparent opacity={0.4} depthWrite={false} />
                    </mesh>
                    <mesh position={[shellCenterX, 5.56, room.centerZ + direction * ((roomWidth / 2) - 0.28)]} scale={[shellDepth, 0.18, 0.22]}>
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshStandardMaterial color="#b9aa95" roughness={0.72} />
                    </mesh>
                    <mesh position={[shellCenterX, 5.72, room.centerZ + direction * ((roomWidth / 2) - 0.48)]} scale={[Math.max(0.5, shellDepth - 0.8), 0.065, 0.08]}>
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshStandardMaterial color="#8d704e" metalness={0.62} roughness={0.45} />
                    </mesh>
                    <mesh position={[
                        outerWallX - (room.side * 0.15),
                        ceilingY / 2,
                        room.centerZ + direction * ((roomWidth / 2) - 0.16),
                    ]} scale={[0.16, ceilingY - 0.2, 0.2]}>
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshStandardMaterial color="#b9aa95" roughness={0.74} />
                    </mesh>
                </group>
            ))}
            <mesh position={[outerWallX - (room.side * 0.25), 0.17, room.centerZ]} scale={[0.18, 0.34, roomWidth]}>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshStandardMaterial color="#887763" roughness={0.7} />
            </mesh>
            <group position={[outerWallX - (room.side * 0.145), 3.08, room.centerZ]}>
                <mesh receiveShadow scale={[0.055, 2.28, 5.65]}>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <meshStandardMaterial color="#211a17" roughness={0.86} />
                </mesh>
                {[-1, 1].map(direction => (
                    <mesh key={`end-cap-horizontal-${direction}`} position={[-room.side * 0.035, direction * 1.12, 0]} scale={[0.075, 0.09, 5.78]}>
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshPhysicalMaterial color="#9b7747" metalness={0.58} roughness={0.35} />
                    </mesh>
                ))}
                {[-1, 1].map(direction => (
                    <mesh key={`end-cap-vertical-${direction}`} position={[-room.side * 0.035, 0, direction * 2.83]} scale={[0.075, 2.32, 0.09]}>
                        <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                        <meshPhysicalMaterial color="#9b7747" metalness={0.58} roughness={0.35} />
                    </mesh>
                ))}
            </group>
            <LabelPlane
                title={room.name}
                subtitle={`${room.albums.length} ${room.albums.length === 1 ? 'collection' : 'collections'}`}
                position={[outerWallX - (room.side * 0.29), 3.62, room.centerZ]}
                rotation={[0, endRotation, 0]}
                size={[4.25, 0.94]}
            />
            <GalleryFrameShells
                paintings={interiorResident ? room.paintings : []}
                materials={materials}
            />
            <CameraAwareRoomPaintings
                room={room}
                active={interiorResident}
                detailed={detailed}
                allowDetail={allowDetail}
                qualityLighting={qualityLighting}
                onTextureReady={markPaintingReady}
            />
            </group>
            {interiorResident && (
                <InstancedCeilingFixtures
                    positions={lightXs.map(x => [x, room.centerZ])}
                    ceilingY={ceilingY - 0.06}
                />
            )}
        </group>
    )
}

function MainHall({ layout, activeRoomId, activeRoomIds, materials, reflectionsEnabled, shadowsEnabled }) {
    const hallCenterZ = (MUSEUM_DIMENSIONS.lobbyFrontZ + layout.hallBackZ) / 2
    const bayCount = Math.max(1, Math.ceil(layout.rooms.length / 2))
    const bays = Array.from({ length: bayCount }, (_, index) => ({
        centerZ: MUSEUM_DIMENSIONS.firstBayZ - (index * MUSEUM_DIMENSIONS.baySpacing),
        left: layout.rooms.find(room => room.bay === index && room.side === -1),
        right: layout.rooms.find(room => room.bay === index && room.side === 1),
    }))
    const activeRooms = useMemo(() => new Set([
        ...(activeRoomIds || []),
        activeRoomId,
    ].filter(Boolean)), [activeRoomId, activeRoomIds])
    const activeRoomList = useMemo(() => layout.rooms
        .filter(room => activeRooms.has(room.id))
        // The room occupied by the visitor owns the first persistent fixture
        // slot. This prevents a merely-nearby room earlier in catalog order
        // from stealing the key light while crossing a portal.
        .sort((left, right) => Number(right.id === activeRoomId) - Number(left.id === activeRoomId))
        .slice(0, 1), [activeRoomId, activeRooms, layout.rooms])
    const residentRooms = useMemo(
        () => new Set(activeRoomList.map(room => room.id)),
        [activeRoomList],
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
    const hallSconcePlacements = useMemo(() => museumHallSconcePlacements(layout), [layout])
    const hallFloorFixtures = useMemo(
        () => [...new Set(hallSconcePlacements.map(placement => Number((placement.z - hallCenterZ).toFixed(3))))],
        [hallCenterZ, hallSconcePlacements],
    )
    const hallFloorOccluders = useMemo(() => [
        bakedFloorOccluder(layout.desk, 0, hallCenterZ, 0.16),
        ...layout.dressing.lobbyPlants.map(item => bakedFloorOccluder(item, 0, hallCenterZ, 0.075)),
        ...layout.dressing.hallPlants.map(item => bakedFloorOccluder(item, 0, hallCenterZ, 0.075)),
        bakedFloorOccluder(layout.dressing.terminalSculpture, 0, hallCenterZ, 0.15),
    ], [hallCenterZ, layout.desk, layout.dressing.hallPlants, layout.dressing.lobbyPlants, layout.dressing.terminalSculpture])
    return (
        <group>
            <BakedIrradianceFloor
                position={[0, -0.11, hallCenterZ]}
                size={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, layout.hallLength]}
                materials={materials}
                color="#73573f"
                mode="hall"
                fixtures={hallFloorFixtures}
                occluders={hallFloorOccluders}
            />
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
                        sconcePlacements={hallSconcePlacements}
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
                                sconcePlacements={hallSconcePlacements}
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
                        sconcePlacements={hallSconcePlacements}
                    />
                    <DistanceManagedDoorWall
                        side={1}
                        centerZ={bay.centerZ}
                        room={bay.right}
                        materials={materials}
                        forceNear={Boolean(bay.right && activeRooms.has(bay.right.id))}
                        sconcePlacements={hallSconcePlacements}
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
                    active={residentRooms.has(room.id)}
                    detailed={activeRoomId === room.id}
                    materials={materials}
                    qualityLighting={reflectionsEnabled}
                />
            ))}
            <FixedRoomLighting rooms={activeRoomList} qualityLighting={reflectionsEnabled} />
            <InstancedCeilingFixtures
                positions={ceilingLights.map(z => [0, z])}
                ceilingY={6.92}
            />
            {illuminatedHallLights.map(z => (
                <group key={`hall-light-${z}`}>
                    <StaticSpotlight
                        position={[0, 5.9, z]}
                        target={[0, 0, z]}
                        color="#ffd8aa"
                        intensity={reflectionsEnabled ? 120 : 92}
                        distance={18}
                        angle={0.5}
                        penumbra={0.82}
                        castShadow={false}
                        shadowKey={`hall-key-${z}`}
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
                shadowsEnabled={shadowsEnabled}
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
        if (distance > 6.8) continue
        const inverseDistance = distance > 0 ? 1 / distance : 0
        const alignment = (
            (direction.x * dx * inverseDistance)
            + (direction.y * dy * inverseDistance)
            + (direction.z * dz * inverseDistance)
        )
        if (alignment < 0.66) continue
        const [normalX = 0, normalY = 0, normalZ = 1] = painting.normal || []
        const frontFacing = -(
            (normalX * dx * inverseDistance)
            + (normalY * dy * inverseDistance)
            + (normalZ * dz * inverseDistance)
        )
        if (frontFacing < 0.12) continue
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

function NativePointerLockControls({ input, onLock, onUnlock }) {
    const { gl } = useThree()

    useEffect(() => {
        const handleLockChange = () => {
            if (document.pointerLockElement === gl.domElement) onLock()
            else onUnlock()
        }
        const handleMouseMove = (event) => {
            if (document.pointerLockElement !== gl.domElement) return
            input.current.lookX += event.movementX
            input.current.lookY += event.movementY
        }
        document.addEventListener('pointerlockchange', handleLockChange)
        document.addEventListener('mousemove', handleMouseMove)
        return () => {
            document.removeEventListener('pointerlockchange', handleLockChange)
            document.removeEventListener('mousemove', handleMouseMove)
        }
    }, [gl, input, onLock, onUnlock])

    return null
}

function createFootstepBank(context) {
    return [0, 1, 2, 3].map((variant) => {
        const carpet = variant >= 2
        const length = Math.round(context.sampleRate * (carpet ? 0.09 : 0.075))
        const buffer = context.createBuffer(1, length, context.sampleRate)
        const data = buffer.getChannelData(0)
        let seed = 1837 + (variant * 991)
        for (let index = 0; index < length; index += 1) {
            seed = (seed * 16807) % 2147483647
            const noise = ((seed / 2147483647) * 2) - 1
            const progress = index / length
            const envelope = Math.exp(-progress * (carpet ? 5.2 : 7.5))
            const heel = Math.sin(progress * Math.PI * (carpet ? 2.2 : 3.5)) * Math.exp(-progress * 12)
            data[index] = ((noise * (carpet ? 0.62 : 0.78)) + (heel * (carpet ? 0.22 : 0.36))) * envelope
        }
        return buffer
    })
}

function createMuseumFootstepReverb(context) {
    const length = Math.round(context.sampleRate * 0.18)
    const impulse = context.createBuffer(2, length, context.sampleRate)
    for (let channel = 0; channel < 2; channel += 1) {
        const data = impulse.getChannelData(channel)
        let seed = 9173 + (channel * 371)
        for (let index = 0; index < length; index += 1) {
            seed = (seed * 16807) % 2147483647
            const noise = ((seed / 2147483647) * 2) - 1
            data[index] = noise * Math.pow(1 - (index / length), 3.8) * 0.26
        }
    }
    const convolver = context.createConvolver()
    convolver.buffer = impulse
    return convolver
}

function playMuseumFootstep(audio, stepIndex, speedRatio, volume = 1, surface = 'carpet') {
    if (!audio?.context || audio.context.state !== 'running') return
    const { context, buffers, convolver } = audio
    const now = context.currentTime
    const source = context.createBufferSource()
    const filter = context.createBiquadFilter()
    const gain = context.createGain()
    const pan = context.createStereoPanner?.()
    let send = null
    const surfaceOffset = surface === 'wood' ? 0 : 2
    source.buffer = buffers[surfaceOffset + (Math.abs(stepIndex) % 2)]
    source.playbackRate.value = 0.88 + (Math.min(1.35, speedRatio) * 0.13)
    filter.type = 'bandpass'
    filter.frequency.value = (surface === 'wood' ? 980 : 590) + ((stepIndex % 2) * 80)
    filter.Q.value = surface === 'wood' ? 0.82 : 0.62
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, 0.032 * Math.max(0.35, speedRatio) * volume),
        now + 0.006,
    )
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.082)
    source.connect(filter)
    filter.connect(gain)
    if (pan) {
        pan.pan.value = stepIndex % 2 ? 0.08 : -0.08
        gain.connect(pan)
        pan.connect(context.destination)
    } else {
        gain.connect(context.destination)
    }
    if (convolver) {
        send = context.createGain()
        send.gain.value = surface === 'wood' ? 0.055 : 0.032
        gain.connect(send)
        send.connect(convolver)
    }
    source.onended = () => {
        // AudioNode connections are strong graph edges. Explicitly sever this
        // short-lived branch so an extended walk cannot retain one dry and
        // reverb-send chain for every footstep that has already finished.
        source.disconnect()
        filter.disconnect()
        gain.disconnect()
        pan?.disconnect()
        send?.disconnect()
    }
    source.start(now)
    source.stop(now + 0.09)
}

function PlayerController({ layout, enabled, touchMode, touchInput, preferences, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
    const { camera } = useThree()
    const keys = useRef(new Set())
    const lastRoom = useRef(null)
    const lastNearbyRooms = useRef('')
    const lastFocused = useRef(null)
    const lastSavedAt = useRef(0)
    const lastProbeAt = useRef(0)
    const gaitPhase = useRef(0)
    const lastFootstep = useRef(-1)
    const footstepAudio = useRef(null)
    const previousSpeed = useRef(0)
    const cameraPitchOffset = useRef(0)
    const cameraYawOffset = useRef(0)
    const touchEuler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), [])
    const forward = useMemo(() => new THREE.Vector3(), [])
    const right = useMemo(() => new THREE.Vector3(), [])
    const movement = useMemo(() => new THREE.Vector3(), [])
    const velocity = useMemo(() => new THREE.Vector3(), [])
    const focusDirection = useMemo(() => new THREE.Vector3(), [])
    const [reducedMotion, setReducedMotion] = useState(() => (
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false
    ))

    useEffect(() => {
        const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
        if (!preference) return undefined
        const update = () => setReducedMotion(preference.matches)
        preference.addEventListener?.('change', update)
        return () => preference.removeEventListener?.('change', update)
    }, [])

    useEffect(() => {
        if (!enabled || footstepAudio.current) return
        const AudioContext = window.AudioContext || window.webkitAudioContext
        if (!AudioContext) return
        const context = new AudioContext()
        const convolver = createMuseumFootstepReverb(context)
        const reverbWet = context.createGain()
        reverbWet.gain.value = 0.58
        convolver.connect(reverbWet)
        reverbWet.connect(context.destination)
        footstepAudio.current = {
            context,
            buffers: createFootstepBank(context),
            convolver,
            reverbWet,
        }
        context.resume?.().catch(() => {})
    }, [enabled])

    useEffect(() => () => {
        footstepAudio.current?.context?.close?.().catch(() => {})
        footstepAudio.current = null
    }, [])

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
        // Remove last frame's procedural pitch before applying mouse/touch
        // movement. This keeps the authored look direction stable while the
        // camera rig adds a non-accumulating walking cadence.
        const previousPitchOffset = cameraPitchOffset.current
        const previousYawOffset = cameraYawOffset.current
        camera.rotation.x -= previousPitchOffset
        camera.rotation.y -= previousYawOffset
        if (touchInput.current.lookX || touchInput.current.lookY) {
            touchEuler.setFromQuaternion(camera.quaternion)
            const lookSensitivity = (touchMode ? 0.0042 : 0.002) * preferences.sensitivity
            touchEuler.y -= touchInput.current.lookX * lookSensitivity
            touchEuler.x = THREE.MathUtils.clamp(
                touchEuler.x - (touchInput.current.lookY * (touchMode ? 0.0038 : lookSensitivity)),
                -0.52,
                0.52,
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
        const moving = movement.lengthSq() > 0.0001
        const movementScale = touchMode && touchMagnitude > 0 ? Math.max(0.18, touchMagnitude) : 1
        if (moving) movement.normalize().multiplyScalar(speed * movementScale)
        // A slightly heavier acceleration curve keeps first-person movement
        // from reading as a frictionless camera dolly while preserving precise
        // stopping at paintings and portal thresholds.
        const response = moving ? (touchMode ? 8.8 : 9.2) : 11.2
        velocity.x = THREE.MathUtils.damp(velocity.x, moving ? movement.x : 0, response, delta)
        velocity.z = THREE.MathUtils.damp(velocity.z, moving ? movement.z : 0, response, delta)
        const frameMovementX = velocity.x * delta
        const frameMovementZ = velocity.z * delta
        if (Math.abs(frameMovementX) + Math.abs(frameMovementZ) > 0.0001) {
            const next = moveMuseumPosition(
                layout,
                { x: camera.position.x, z: camera.position.z },
                { x: frameMovementX, z: frameMovementZ },
                0.35,
            )
            if (Math.abs(next.x - camera.position.x - frameMovementX) > 0.001) velocity.x *= 0.24
            if (Math.abs(next.z - camera.position.z - frameMovementZ) > 0.001) velocity.z *= 0.24
            camera.position.x = next.x
            camera.position.z = next.z
        }
        const actualSpeed = Math.hypot(velocity.x, velocity.z)
        const gaitStrength = reducedMotion ? 0 : THREE.MathUtils.clamp(actualSpeed / 3.25, 0, 1.35)
        gaitPhase.current += actualSpeed * delta * 2.35
        const footstepIndex = Math.floor(gaitPhase.current / Math.PI)
        if (actualSpeed > 0.48 && footstepIndex !== lastFootstep.current) {
            lastFootstep.current = footstepIndex
            playMuseumFootstep(
                footstepAudio.current,
                footstepIndex,
                actualSpeed / 3.25,
                preferences.footstepVolume,
                museumFloorSurface(layout, camera.position),
            )
        }
        const stepWave = Math.sin(gaitPhase.current * 2)
        const heelStrike = Math.pow(Math.max(0, stepWave), 8)
        const headBob = ((stepWave * 0.012) - (heelStrike * 0.004)) * gaitStrength * preferences.bobStrength
        const breathing = reducedMotion ? 0 : Math.sin(state.clock.elapsedTime * 1.2) * 0.0015
        camera.position.y = layout.spawn[1] + headBob + breathing
        const lateralVelocity = (velocity.x * right.x) + (velocity.z * right.z)
        const lateralLean = THREE.MathUtils.clamp(lateralVelocity / Math.max(1, speed), -1, 1)
        const targetRoll = moving && !reducedMotion
            ? ((Math.sin(gaitPhase.current) * 0.003 * gaitStrength) - (lateralLean * 0.002)) * preferences.bobStrength
            : 0
        camera.rotation.z = THREE.MathUtils.damp(camera.rotation.z, targetRoll, 9.5, delta)
        previousSpeed.current = actualSpeed
        const targetPitch = 0
        cameraPitchOffset.current = THREE.MathUtils.damp(
            previousPitchOffset,
            targetPitch,
            moving ? 12 : 8,
            delta,
        )
        camera.rotation.x = THREE.MathUtils.clamp(
            camera.rotation.x + cameraPitchOffset.current,
            -0.52,
            0.52,
        )
        // A restrained shoulder-to-shoulder yaw shift completes the gait arc.
        // It is removed before reading mouse input on the next frame, so the
        // animation never accumulates into the visitor's authored look angle.
        const targetYaw = 0
        cameraYawOffset.current = THREE.MathUtils.damp(
            previousYawOffset,
            targetYaw,
            moving ? 11 : 8,
            delta,
        )
        camera.rotation.y += cameraYawOffset.current
        const baseFov = touchMode ? Math.max(68, preferences.fov) : preferences.fov
        const targetFov = baseFov
        const nextFov = THREE.MathUtils.damp(camera.fov, targetFov, 7, delta)
        if (Math.abs(camera.fov - nextFov) > 0.01) {
            camera.fov = nextFov
            camera.updateProjectionMatrix()
        }

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
            const approachOffset = Math.min(1.5, Math.max(0.8, (room.width / 2) - 2.6))
            camera.position.set(
                room.side * (MUSEUM_DIMENSIONS.hallHalfWidth - 3.8),
                2.05,
                room.centerZ + approachOffset,
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
        const warmPinnedTextures = new Set()
        const startedAt = performance.now()
        let reportedProgress = 0
        const publishProgress = (value) => {
            if (cancelled) return
            reportedProgress = Math.max(reportedProgress, value)
            onProgress?.(reportedProgress)
        }
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
            .slice(0, 1)
        const warmAlbums = [...new Map(
            initialRooms
                // Only the authored entrance sightline blocks first entry.
                // Waiting for covers in all nine galleries caused Firefox to
                // appear frozen and then release a large main-thread upload
                // burst. Later rooms receive tiny bases immediately after this
                // compact visible set is resident, while their velvet gates
                // remain closed until the local entrance set is truly ready.
                .flatMap(room => room.paintings.slice(0, 2).map(painting => painting.album))
                .filter(Boolean)
                .map(album => [album.albumId, album]),
        ).values()]
        const coverJobs = warmAlbums.map((album, index) => ({
            album,
            width: LOW_RES_COVER_WIDTH,
            priority: 12000 + (warmAlbums.length - index),
        }))
        let didFinish = false
        const finish = () => {
            if (cancelled || didFinish) return
            didFinish = true
            publishStage('ready', { roomCount: initialRooms.length, coverCount: warmAlbums.length })
            publishProgress(1)
            onReady()
        }
        publishProgress(0.04)
        publishStage('decoding', { roomCount: initialRooms.length, coverCount: coverJobs.length })

        // Prepare the small, deterministic fallback and plaque atlases for
        // every room behind the opening veil. Doing this one room at a time
        // after entry caused 200ms+ main-thread stalls when the visitor started
        // walking. Only two photographic covers are network-warmed here, so
        // cold start stays bounded while every later room has a complete base.
        let settledCovers = 0
        const preparedRoomBatches = prepareRoomBatches(
            layout.rooms,
            ratio => publishProgress(0.08 + (ratio * 0.16)),
        )
        const preparedCovers = Promise.allSettled(coverJobs.map((job) => (
            createMuseumCoverTexture(job.album, job.width, job.priority).then((texture) => {
                if (cancelled) {
                    trimCoverTextureCache()
                } else {
                    // Warmup owns this temporary retain independently from the
                    // upload queue. Its finally/cleanup paths release every
                    // texture, including textures that were already resident.
                    pinnedCoverTextures.add(texture)
                    warmPinnedTextures.add(texture)
                }
                return texture
            }).finally(() => {
                settledCovers += 1
                publishProgress(0.24 + ((settledCovers / Math.max(1, coverJobs.length)) * 0.3))
            })
        )))

        Promise.all([preparedCovers, preparedRoomBatches]).then(async ([coverResults, roomBatches]) => {
            if (cancelled) return
            const { placeholderTextures, plaqueTextures } = roomBatches
            const coverTextures = coverResults
                .filter(result => result.status === 'fulfilled')
                .map(result => result.value)
            publishStage('uploading', { prepared: coverTextures.length, coverCount: coverJobs.length })
            // Give React and Firefox one committed paint for the final decode
            // progress before any synchronous WebGL texture promotion begins.
            await new Promise(resolve => window.setTimeout(resolve, 0))
            try {
                await promoteRevealTextures(
                    gl,
                    [...placeholderTextures, ...coverTextures, ...plaqueTextures],
                    ratio => publishProgress(0.56 + (ratio * 0.24)),
                )
            } finally {
                warmPinnedTextures.forEach(texture => pinnedCoverTextures.delete(texture))
                warmPinnedTextures.clear()
                trimCoverTextureCache()
            }
            // Compile after the resident textures and plaque atlases exist.
            // Running this concurrently compiled an earlier scene and deferred
            // the real shader/texture-bind spike until the veil lifted.
            publishStage('compiling', { prepared: coverTextures.length })
            publishProgress(0.82)
            // Shader compilation does not expose granular progress. Keep the
            // progress indicator visibly alive—especially on Windows Firefox—
            // while still withholding the final 100% until the real compile and
            // settling frames are complete.
            const compileProgressTimer = window.setInterval(() => {
                publishProgress(Math.min(0.975, reportedProgress + 0.006))
            }, 140)
            // Firefox/Windows was entering the gallery while its asynchronous
            // shader compile was still outstanding, then paying the entire
            // compile cost on the first step. Keep the opaque loading veil up
            // until that browser has genuinely finished. Chromium/Safari keep
            // a bounded fallback for drivers that never resolve the extension.
            try {
                const compile = gl.compileAsync?.(scene, camera) || Promise.resolve()
                await Promise.race([
                    compile,
                    new Promise(resolve => window.setTimeout(resolve, isFirefoxBrowser() ? 1100 : 1500)),
                ])
            } finally {
                window.clearInterval(compileProgressTimer)
            }
            publishProgress(0.98)
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
            warmPinnedTextures.forEach(texture => pinnedCoverTextures.delete(texture))
            warmPinnedTextures.clear()
            trimCoverTextureCache()
        }
    }, [camera, gl, invalidate, layout, onProgress, onReady, scene, touchMode, warmRoomIds])

    return null
}

function AnticipatoryRoomPreloader({ layout, activeRoomId, activeRoomIds, enabled }) {
    useEffect(() => {
        if (!enabled || !layout.rooms.length || navigator.connection?.saveData) return undefined

        let cancelled = false
        let scheduledHandle = null
        let scheduledWithIdleCallback = false
        const requestedRoomIds = [activeRoomId, ...(activeRoomIds || [])].filter(Boolean)
        const requestedIndex = layout.rooms.findIndex(room => requestedRoomIds.includes(room.id))
        const currentIndex = Math.max(0, requestedIndex)
        const currentRoom = layout.rooms[currentIndex]
        const candidateRooms = prioritizeMuseumPreloadRooms(layout.rooms, currentRoom.id, 3)
        const jobs = []

        candidateRooms.forEach((room, roomOffset) => {
            // Only the four works visible from the doorway need a readable
            // preview before the visitor arrives. The current room's remaining
            // frames receive a tiny photographic layer afterward. This keeps
            // Firefox from decoding the whole archive for many seconds while
            // making the next likely doorway feel already furnished.
            room.paintings.slice(0, roomOffset === 0 ? 4 : 3).forEach((painting, paintingIndex) => {
                if (!painting.album) return
                jobs.push({
                    album: painting.album,
                    width: LOW_RES_COVER_WIDTH,
                    priority: 7200 - (roomOffset * 600) - paintingIndex,
                })
            })
        })

        const uniqueJobs = [...new Map(
            jobs.map(job => [`${job.album.albumId}:${job.width}`, job]),
        ).values()]
        const pause = isFirefoxBrowser() ? 120 : 72
        const schedule = (callback, delay = 0) => {
            if (cancelled) return
            if (typeof window.requestIdleCallback === 'function') {
                scheduledWithIdleCallback = true
                scheduledHandle = window.requestIdleCallback(
                    deadline => callback(deadline),
                    { timeout: Math.max(700, delay + 700) },
                )
            } else {
                scheduledWithIdleCallback = false
                scheduledHandle = window.setTimeout(() => callback(null), Math.max(60, delay))
            }
        }
        const run = async (index = 0) => {
            if (cancelled || index >= uniqueJobs.length) return
            if (navigator.scheduling?.isInputPending?.()) {
                schedule(() => run(index), pause)
                return
            }
            const job = uniqueJobs[index]
            await createMuseumCoverTexture(job.album, job.width, job.priority).catch(() => undefined)
            if (cancelled) return
            schedule(() => run(index + 1), pause)
        }
        schedule(() => run(), 220)

        return () => {
            cancelled = true
            if (scheduledWithIdleCallback) window.cancelIdleCallback?.(scheduledHandle)
            else window.clearTimeout(scheduledHandle)
        }
    }, [activeRoomId, activeRoomIds, enabled, layout])

    return null
}

function DevelopmentPerformanceProbe() {
    const { gl } = useThree()
    const samples = useRef([])
    const lifetime = useRef({ maxMs: 0, over25: 0, over50: 0, total: 0 })
    const lastPublishedAt = useRef(0)
    useFrame((state, delta) => {
        const elapsedMs = delta * 1000
        samples.current.push(elapsedMs)
        if (samples.current.length > 180) samples.current.shift()
        lifetime.current.maxMs = Math.max(lifetime.current.maxMs, elapsedMs)
        lifetime.current.over25 += Number(elapsedMs > 25)
        lifetime.current.over50 += Number(elapsedMs > 50)
        lifetime.current.total += 1
        if (state.clock.elapsedTime - lastPublishedAt.current < 1 || samples.current.length < 30) return
        lastPublishedAt.current = state.clock.elapsedTime
        const ordered = [...samples.current].sort((left, right) => left - right)
        const pick = ratio => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))]
        const cacheBytes = [...coverTextureCache.values()].reduce(
            (total, texture) => total + Number(texture?.userData?.museumBytes || 0),
            0,
        )
        document.documentElement.dataset.museumPerf = JSON.stringify({
            medianMs: Number(pick(0.5).toFixed(2)),
            p95Ms: Number(pick(0.95).toFixed(2)),
            p99Ms: Number(pick(0.99).toFixed(2)),
            maxMs: Number(ordered.at(-1).toFixed(2)),
            lifetimeMaxMs: Number(lifetime.current.maxMs.toFixed(2)),
            lifetimeOver25: lifetime.current.over25,
            lifetimeOver50: lifetime.current.over50,
            lifetimeFrames: lifetime.current.total,
            calls: gl.info.render.calls,
            triangles: gl.info.render.triangles,
            textures: gl.info.memory.textures,
            coverCacheEntries: coverTextureCache.size,
            coverCacheMb: Number((cacheBytes / (1024 * 1024)).toFixed(1)),
            referencedCoverTextures: coverTextureReferences.size,
            queuedCoverLoads: coverLoadQueue.length,
            queuedCoverUploads: coverUploadQueue.length,
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
        traversalChecks: new Set(),
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

        if (tour.phase === 2) {
            const checkKey = `${tour.circuit}:${room.id}`
            if (!tour.traversalChecks.has(checkKey)) {
                const probe = moveMuseumPosition(
                    layout,
                    { x: entranceX, z: room.centerZ },
                    { x: insideX - entranceX, z: 0 },
                    0.35,
                )
                const enteredDepth = (probe.x - room.innerX) * room.side
                if (enteredDepth < 1.6) tour.portalFailures.push(`${tour.circuit + 1}:${room.id}:collision`)
                tour.traversalChecks.add(checkKey)
            }
        }
        target.set(...phase.position)

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
            roomResident: nearbyMuseumRoomIds(layout, position, 20).includes(room.id),
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

function RendererHealth({ onStatus }) {
    const { gl } = useThree()
    useEffect(() => {
        const canvas = gl.domElement
        const handleLost = (event) => {
            // Opt in to WebGL's restoration path and immediately cover the
            // browser's transparent/default framebuffer. Without this veil a
            // transient driver reset appears as a full-screen white flash.
            event.preventDefault()
            onStatus('recovering')
        }
        const handleRestored = () => {
            gl.resetState?.()
            window.requestAnimationFrame(() => onStatus('ok'))
        }
        canvas.addEventListener('webglcontextlost', handleLost, false)
        canvas.addEventListener('webglcontextrestored', handleRestored, false)
        return () => {
            canvas.removeEventListener('webglcontextlost', handleLost, false)
            canvas.removeEventListener('webglcontextrestored', handleRestored, false)
        }
    }, [gl, onStatus])
    return null
}

function MuseumScene({ layout, controlsEnabled, sceneReady, touchMode, touchInput, preferences, visualPreview, developmentTour, previewMode, previewRoomIndex, onSceneReady, onSceneProgress, onRendererStatus, onLock, onUnlock, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
    const materials = useMuseumMaterials()
    const cinematicShadows = !touchMode && !isFirefoxBrowser()
    return (
        <>
            <color attach="background" args={[INK]} />
            <fog attach="fog" args={['#151310', 30, 120]} />
            {/* Keep enough indirect exposure for accessibility, but let the
                actual architectural fixtures establish contrast. The previous
                high ambient/hemisphere pair flattened every room into the same
                brightness and made practical lights visually irrelevant. */}
            <ambientLight intensity={touchMode ? 0.235 : (cinematicShadows ? 0.215 : 0.22)} color="#e8d4bd" />
            <hemisphereLight args={['#b8ccd7', '#241712', touchMode ? 0.27 : (cinematicShadows ? 0.245 : 0.25)]} />
            <directionalLight
                position={[-6, 10, 12]}
                intensity={touchMode ? 0.2 : (cinematicShadows ? 0.11 : 0.155)}
                color="#dce8ef"
                castShadow={false}
            />
            <directionalLight position={[7, 6, -12]} intensity={0.055} color="#d69e6a" castShadow={false} />
            <MainHall
                layout={layout}
                activeRoomId={controlsEnabled.activeRoomId}
                activeRoomIds={controlsEnabled.activeRoomIds}
                materials={materials}
                // Firefox uses the stable two-picture-light path on every OS.
                // Its WebGL light/shader compilation behavior is the limiting
                // capability—not only the Windows user-agent combination.
                reflectionsEnabled={!touchMode && !isFirefoxBrowser()}
                shadowsEnabled={cinematicShadows}
            />
            <RendererHealth onStatus={onRendererStatus} />
            <SceneWarmup
                layout={layout}
                initialRoomIds={controlsEnabled.activeRoomIds}
                onReady={onSceneReady}
                onProgress={onSceneProgress}
                touchMode={touchMode}
            />
            <AnticipatoryRoomPreloader
                layout={layout}
                activeRoomId={controlsEnabled.activeRoomId}
                activeRoomIds={controlsEnabled.activeRoomIds}
                enabled={sceneReady}
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
                        preferences={preferences}
                        onActiveRoom={onActiveRoom}
                        onNearbyRooms={onNearbyRooms}
                        onFocusedPainting={onFocusedPainting}
                        onOpenAlbum={onOpenAlbum}
                    />
                    {!touchMode && <NativePointerLockControls input={touchInput} onLock={onLock} onUnlock={onUnlock} />}
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
    const [sceneProgress, setSceneProgress] = useState(0.02)
    const [rendererStatus, setRendererStatus] = useState('ok')
    const [touchMode, setTouchMode] = useState(() => forceTouchPreview || usesTouchControls())
    const [preferences, setPreferences] = useState(() => readMuseumPreferences(localStorage, PREFERENCES_KEY))
    const touchInput = useRef({ moveX: 0, moveY: 0, lookX: 0, lookY: 0 })

    useEffect(() => {
        persistMuseumPreferences(localStorage, PREFERENCES_KEY, preferences)
    }, [preferences])

    useEffect(() => {
        if (!sceneReady) return undefined
        const timer = window.setTimeout(() => setSceneVeilVisible(false), 160)
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
        () => initialMuseumRoomIds(
            layout,
            sessionStorage.getItem(RETURN_KEY) === 'true'
                ? safeSessionPosition(layout)
                : { x: layout.spawn[0], z: layout.spawn[2] },
            touchMode ? 15 : 20,
            1,
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
    const updatePreference = useCallback((key, value) => {
        setPreferences(current => ({ ...current, [key]: Number(value) }))
    }, [setPreferences])
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
                camera={{ fov: touchMode ? Math.max(68, preferences.fov) : preferences.fov, near: 0.08, far: 220, position: layout.spawn }}
                dpr={touchMode ? 0.78 : (isWindowsFirefoxBrowser() ? 0.7 : 0.9)}
                frameloop={locked || visualPreview || developmentTour || !sceneReady ? 'always' : 'demand'}
                performance={{ min: 0.45, max: 1, debounce: 240 }}
                // One frozen 512 px room key supplies genuine contact depth on
                // capable desktop browsers. Firefox and touch devices keep the
                // soft authored grounding path because their drivers exhibited
                // first-step stalls or full-frame shadow-map flashes.
                shadows={!touchMode && !isFirefoxBrowser()}
                gl={{
                    // Firefox on Windows frequently compiles MSAA variants only
                    // after the first camera movement. Browser compositing at a
                    // stable DPR is preferable to that severe cold-start hitch.
                    antialias: !isWindowsFirefoxBrowser(),
                    powerPreference: 'high-performance',
                    alpha: false,
                    stencil: false,
                }}
                onCreated={({ gl }) => {
                    gl.outputColorSpace = THREE.SRGBColorSpace
                    gl.toneMapping = THREE.ACESFilmicToneMapping
                    // Preserve practical-light highlights while lifting the
                    // room's broad dark surfaces with low-cost ambient bounce.
                    // This avoids the crushed-midtones/blown-floor split that
                    // made the prior pass feel flatter despite stronger lights.
                    gl.toneMappingExposure = touchMode ? 1.2 : 1.16
                    if (!touchMode && !isFirefoxBrowser()) {
                        gl.shadowMap.enabled = true
                        // `PCFSoftShadowMap` is deprecated in current Three.js and
                        // now aliases to PCF after issuing a warning every time a
                        // WebGL context is compiled. Select the effective mode
                        // directly so cold starts stay quiet and deterministic.
                        gl.shadowMap.type = THREE.PCFShadowMap
                        gl.shadowMap.autoUpdate = false
                        gl.shadowMap.needsUpdate = true
                    }
                }}
            >
                <Suspense fallback={null}>
                    <MuseumScene
                        layout={layout}
                        controlsEnabled={{ locked, activeRoomId: renderedActiveRoomId, activeRoomIds: renderedActiveRoomIds }}
                        sceneReady={sceneReady}
                        touchMode={touchMode}
                        touchInput={touchInput}
                        preferences={preferences}
                        visualPreview={visualPreview}
                        developmentTour={developmentTour}
                        previewMode={previewMode}
                        previewRoomIndex={previewRoomIndex}
                        onSceneReady={handleSceneReady}
                        onSceneProgress={setSceneProgress}
                        onRendererStatus={setRendererStatus}
                        onLock={() => setLocked(true)}
                        onUnlock={() => setLocked(false)}
                        onActiveRoom={setActiveRoomId}
                        onNearbyRooms={setActiveRoomIds}
                        onFocusedPainting={setFocused}
                        onOpenAlbum={openAlbum}
                    />
                </Suspense>
            </Canvas>
            {rendererStatus !== 'ok' && (
                <div className="museum-renderer-recovery" role="status" aria-live="polite">
                    <span className="museum-loading-mark">IT</span>
                    <p>Restoring the gallery…</p>
                </div>
            )}
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
                    <details className="museum-experience-settings">
                        <summary>Experience settings</summary>
                        <div>
                            <label>
                                <span>Look sensitivity</span>
                                <input type="range" min="0.45" max="1.8" step="0.05" value={preferences.sensitivity} onChange={event => updatePreference('sensitivity', event.target.value)} />
                            </label>
                            <label>
                                <span>Walking motion</span>
                                <input type="range" min="0" max="1" step="0.05" value={preferences.bobStrength} onChange={event => updatePreference('bobStrength', event.target.value)} />
                            </label>
                            <label>
                                <span>Field of view</span>
                                <input type="range" min="56" max="82" step="1" value={preferences.fov} onChange={event => updatePreference('fov', event.target.value)} />
                            </label>
                            <label>
                                <span>Footsteps</span>
                                <input type="range" min="0" max="1" step="0.05" value={preferences.footstepVolume} onChange={event => updatePreference('footstepVolume', event.target.value)} />
                            </label>
                        </div>
                    </details>
                </div>
            )}
        </div>
    )
}
