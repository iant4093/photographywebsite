/* eslint-disable react-hooks/immutability -- Three.js cameras are intentionally mutable scene objects. */
import { addAfterEffect, Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { decode as decodeBlurhash } from 'blurhash'
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { fetchAllAlbums } from '../utils/api'
import { albumCoverPreviewSrcSet, albumCoverUrl } from '../utils/mediaUrls'
import {
    buildMuseumCatalog,
    buildMuseumLayout,
    initialMuseumRoomIds,
    isMuseumPositionWalkable,
    MUSEUM_DIMENSIONS,
    MUSEUM_PORTAL,
    MUSEUM_VAULT,
    museumVaultHeightAt,
    museumDoorAssemblyPose,
    MUSEUM_ARTWORK_SURFACES,
    museumArtworkDetailWidth,
    museumArtworkLightIndex,
    museumCeilingLightPose,
    museumEndWallPlacardPose,
    museumFloorSurface,
    museumRoomGateOpen,
    museumRoomCeilingFixtureXs,
    museumRoomShell,
    museumRoomRibXs,
    moveMuseumPosition,
    nearbyMuseumRoomIds,
    nearestMuseumRoom,
    prioritizeMuseumPreloadRooms,
    retainMuseumRoomPresentation,
} from '../utils/museumLayout'
import {
    buildBakedFloorGrid,
    museumHallSconcePlacements,
    persistMuseumPreferences,
    readMuseumPreferences,
    sampleBakedWallIrradiance,
    sampleBakedVaultIrradiance,
} from '../utils/museumSupport'
import {
    MUSEUM_BASE_COVER_WIDTH,
    MUSEUM_NEAR_COVER_WIDTH,
    MUSEUM_VISIBLE_COVER_PRIORITY,
    MUSEUM_DETAIL_BLEND_SECONDS,
    museumArtworkFallbackWidths,
    museumArtworkPreviewCandidates,
    museumArtworkRequestWidth,
    museumArtworkTransitionProgress,
    museumCoverLoadAllowed,
    museumCoverUploadAllowed,
    museumPreloadPaintings,
} from '../utils/museumStreaming'
import { MuseumRoomArchitecture, MuseumCofferedCeiling, MuseumAtmosphere } from '../components/museum/MuseumAtmosphere'
import MuseumChandeliers from '../components/museum/MuseumChandeliers'
import { createMuseumFrameDriver } from '../utils/museumFrameDriver'
import { createMuseumArchBand } from '../utils/museumArchitecture'
import { MUSEUM_MATERIAL_TEXTURES, MUSEUM_MATERIAL_TILE_METERS } from '../utils/museumMaterialAssets'
import { createMuseumThresholdFloorGeometry, museumFloorTextureTransform, museumSurfaceTextureTransform } from '../utils/museumMaterialMapping'
import {
    advanceMuseumJump,
    createMuseumJumpState,
    museumKeyboardTargetsControl,
    museumLandingOffset,
    pressMuseumJump,
    releaseMuseumJump,
    resetMuseumJump,
} from '../utils/museumMovement'

const SESSION_KEY = 'ian-photography-museum-position-v2'
const RETURN_KEY = 'ian-photography-museum-return'
const PREFERENCES_KEY = 'ian-photography-museum-preferences-v3'
const MOTION_OVERRIDE_KEY = 'ian-photography-museum-motion-override-v1'
const HALL_PAINT = '#d8d0c4'
const ROOM_PAINT = '#d2c9bc'
// Decorative surfaces sit just inside the structural shell. A small, shared
// inset avoids z-fighting without letting wallpaper float
// through moulding at the end of a bay.
const WALL_SURFACE_GAP = MUSEUM_DIMENSIONS.wallSurfaceGap
const GOLD = '#9b7747'
const INK = '#171411'
const TEXTURE_ROOT = '/assets/museum/textures'
const MATERIAL_SOURCES = Object.freeze({
    ...MUSEUM_MATERIAL_TEXTURES,
    wallpaperColor: `${TEXTURE_ROOT}/museum_wallpaper_oxblood_authored_1024.jpg`,
})
const MATERIAL_SOURCE_ENTRIES = Object.entries(MATERIAL_SOURCES)
const MATERIAL_SOURCE_URLS = MATERIAL_SOURCE_ENTRIES.map(([, url]) => url)
const WALLPAPER_TILE_SIZE = 3.4
const HALL_WALL_THICKNESS = MUSEUM_DIMENSIONS.hallWallThickness
const ROOM_SHELL_INSET = MUSEUM_DIMENSIONS.roomShellInset
const EMPTY_FIXTURES = Object.freeze([])
const ARCHITECTURAL_ROUNDED_BOX = new RoundedBoxGeometry(1, 1, 1, 2, 0.045)
const THRESHOLD_FLOOR_GEOMETRY = createMuseumThresholdFloorGeometry(ARCHITECTURAL_ROUNDED_BOX)
const PORTAL_ARCH_STONE_GEOMETRY = createMuseumArchBand(0, MUSEUM_PORTAL.bandWidth, MUSEUM_PORTAL.depth)
const PORTAL_ARCH_REVEAL_GEOMETRY = createMuseumArchBand(0.035, 0.08, 0.018)
const PORTAL_CURTAIN_GEOMETRY = makePortalCurtainGeometry()
const MUSEUM_ARTWORK_PLANE_GEOMETRY = new THREE.PlaneGeometry(2.66, 1.76)
// Image decoding and GPU promotion are the only workloads in this scene that
// can create multi-frame stalls. Keep every authored frame photographic at a
// compact base tier, then selectively sharpen what the visitor can inspect.
const DEFAULT_COVER_LOAD_CONCURRENCY = 3
const BASE_COVER_WIDTH = MUSEUM_BASE_COVER_WIDTH
const NEAR_COVER_WIDTH = MUSEUM_NEAR_COVER_WIDTH
const LOW_POWER_INSPECTION_COVER_WIDTH = 960
const INSPECTION_COVER_WIDTH = 1440
const COVER_FRAME_ASPECT = 2.66 / 1.76
const MAX_NEAR_COVERS = 6
const MAX_ANTICIPATORY_BASE_COVERS = 76
const MUSEUM_MOVEMENT_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'ShiftLeft', 'ShiftRight',
])
const INTERACTION_SAFE_COVER_PRIORITY = MUSEUM_VISIBLE_COVER_PRIORITY
const DESKTOP_COVER_CACHE_BUDGET = 48 * 1024 * 1024
const LOW_POWER_COVER_CACHE_BUDGET = 30 * 1024 * 1024
const DESKTOP_COVER_CACHE_ENTRIES = 104
const LOW_POWER_COVER_CACHE_ENTRIES = 88
const coverTextureCache = new Map()
const coverTextureLoads = new Map()
const coverTextureReferences = new Map()
const coverTextureConsumers = new Map()
const coverPreviewCandidateCache = new Map()
const labelTextureCache = new Map()
const coverLoadQueue = []
const coverUploadQueue = []
const activeCoverLoadJobs = new Set()
const uploadedCoverTextures = new WeakMap()
const rendererUploadGenerations = new WeakMap()
const pendingCoverUploads = new WeakMap()
const pinnedCoverTextures = new Map()
const coverPipelineResumeWaiters = new Set()
let activeCoverLoads = 0
let coverLoadSequence = 0
let coverLoadWakeScheduled = false
let coverUploadSequence = 0
let coverUploadScheduled = false
let coverCacheTrimScheduled = false
let coverUploadPumpGeneration = 0
let coverPipelineEpoch = 0
let coverPipelinePaused = false
let activeMuseumFrameRequester = null
let pendingMuseumFrameRequests = 0
let museumInteractionBusyUntil = 0
let lastCoverUploadDuration = 0
let lastCoverUploadAt = -Infinity
let coverUploadsDuringInteraction = 0

function markMuseumInteractionBusy(duration = 420) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    museumInteractionBusyUntil = Math.max(museumInteractionBusyUntil, now + duration)
}

function museumInteractionIsBusy() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    return now < museumInteractionBusyUntil
}

function requestMuseumFrames(frames = 1) {
    pendingMuseumFrameRequests = Math.max(
        pendingMuseumFrameRequests,
        Math.max(1, Math.floor(Number(frames) || 1)),
    )
    activeMuseumFrameRequester?.(pendingMuseumFrameRequests)
}

function museumAbortError(message = 'Museum artwork loading restarted') {
    return new DOMException(message, 'AbortError')
}

function waitForMuseumFrame(signal) {
    return new Promise((resolve, reject) => {
        let frameId = 0
        let fallbackTimer = 0
        let settled = false
        const cleanup = () => {
            window.cancelAnimationFrame(frameId)
            window.clearTimeout(fallbackTimer)
            document.removeEventListener('visibilitychange', handleVisibility)
            signal?.removeEventListener('abort', handleAbort)
        }
        const finish = () => {
            if (settled) return
            settled = true
            cleanup()
            resolve()
        }
        const handleAbort = () => {
            if (settled) return
            settled = true
            cleanup()
            reject(signal?.reason || museumAbortError('Museum frame wait cancelled'))
        }
        const requestFrame = () => {
            if (settled || !museumDocumentIsVisible()) return
            window.cancelAnimationFrame(frameId)
            window.clearTimeout(fallbackTimer)
            frameId = window.requestAnimationFrame(finish)
            // Some browsers discard the callback that existed before a tab was
            // backgrounded. This fallback only yields the warmup task; renderer
            // health is acknowledged separately by RendererHealth.useFrame.
            fallbackTimer = window.setTimeout(finish, 180)
        }
        function handleVisibility() {
            if (museumDocumentIsVisible()) requestFrame()
        }
        if (signal?.aborted) {
            handleAbort()
            return
        }
        signal?.addEventListener('abort', handleAbort, { once: true })
        document.addEventListener('visibilitychange', handleVisibility)
        requestFrame()
    })
}

function scheduleMuseumVisibleTask(callback, delay = 0) {
    let timer = 0
    let cancelled = false
    const cleanup = () => {
        window.clearTimeout(timer)
        document.removeEventListener('visibilitychange', handleVisibility)
    }
    const arm = () => {
        window.clearTimeout(timer)
        if (cancelled || !museumDocumentIsVisible()) return
        timer = window.setTimeout(() => {
            if (!museumDocumentIsVisible()) return
            cancelled = true
            cleanup()
            callback()
        }, delay)
    }
    function handleVisibility() {
        if (museumDocumentIsVisible()) arm()
        else window.clearTimeout(timer)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    arm()
    return () => {
        cancelled = true
        cleanup()
    }
}

function scheduleCoverLoadWake(delay = 72) {
    if (coverPipelinePaused || coverLoadWakeScheduled || typeof window === 'undefined') return
    coverLoadWakeScheduled = true
    window.setTimeout(() => {
        coverLoadWakeScheduled = false
        runCoverLoadQueue()
    }, delay)
}

function rendererUploadGeneration(gl) {
    return rendererUploadGenerations.get(gl) || 0
}

function coverTextureWasUploaded(gl, texture) {
    return uploadedCoverTextures.get(texture)?.get(gl) === rendererUploadGeneration(gl)
}

function markCoverTextureUploaded(gl, texture) {
    let rendererEntries = uploadedCoverTextures.get(texture)
    if (!rendererEntries) {
        rendererEntries = new WeakMap()
        uploadedCoverTextures.set(texture, rendererEntries)
    }
    rendererEntries.set(gl, rendererUploadGeneration(gl))
}

function museumDocumentIsVisible() {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function museumDocumentIsForeground() {
    if (!museumDocumentIsVisible()) return false
    return typeof document === 'undefined'
        || typeof document.hasFocus !== 'function'
        || document.hasFocus()
}

function waitForMuseumForeground(signal) {
    if (!coverPipelinePaused && museumDocumentIsForeground()) return Promise.resolve()
    return new Promise((resolve, reject) => {
        let settled = false
        const cleanup = () => {
            coverPipelineResumeWaiters.delete(handleResume)
            signal?.removeEventListener('abort', handleAbort)
        }
        const finish = (fulfilled, value) => {
            if (settled) return
            settled = true
            cleanup()
            if (fulfilled) resolve(value)
            else reject(value)
        }
        const handleResume = () => {
            if (!coverPipelinePaused && museumDocumentIsForeground()) finish(true)
        }
        const handleAbort = () => finish(false, signal?.reason || museumAbortError())
        if (signal?.aborted) {
            handleAbort()
            return
        }
        coverPipelineResumeWaiters.add(handleResume)
        signal?.addEventListener('abort', handleAbort, { once: true })
        handleResume()
    })
}

function MuseumFrameDriver({ continuous }) {
    const advance = useThree(state => state.advance)
    const clock = useThree(state => state.clock)
    const driver = useRef(null)

    useLayoutEffect(() => {
        let foreground = museumDocumentIsForeground()
        const nextDriver = createMuseumFrameDriver({
            requestFrame: callback => window.requestAnimationFrame(callback),
            cancelFrame: frameId => window.cancelAnimationFrame(frameId),
            advance: logicalTime => advance(logicalTime, true),
            isVisible: () => foreground && museumDocumentIsVisible(),
            initialTime: clock.elapsedTime,
        })
        driver.current = nextDriver
        const requestFrames = (frames) => {
            pendingMuseumFrameRequests = 0
            nextDriver.request(frames)
        }
        activeMuseumFrameRequester = requestFrames
        if (pendingMuseumFrameRequests) requestFrames(pendingMuseumFrameRequests)

        const suspend = () => {
            foreground = false
            nextDriver.suspend()
        }
        const resume = () => {
            foreground = museumDocumentIsForeground()
            if (foreground) nextDriver.resume(3)
        }
        const handleVisibility = () => {
            if (museumDocumentIsVisible()) resume()
            else suspend()
        }

        document.addEventListener('visibilitychange', handleVisibility)
        document.addEventListener('freeze', suspend)
        window.addEventListener('blur', suspend)
        window.addEventListener('focus', resume)
        window.addEventListener('pagehide', suspend)
        window.addEventListener('pageshow', resume)
        nextDriver.resume(3)
        return () => {
            if (activeMuseumFrameRequester === requestFrames) activeMuseumFrameRequester = null
            nextDriver.destroy()
            driver.current = null
            document.removeEventListener('visibilitychange', handleVisibility)
            document.removeEventListener('freeze', suspend)
            window.removeEventListener('blur', suspend)
            window.removeEventListener('focus', resume)
            window.removeEventListener('pagehide', suspend)
            window.removeEventListener('pageshow', resume)
        }
    }, [advance, clock])

    useEffect(() => {
        driver.current?.setContinuous(continuous)
        if (!continuous) driver.current?.request(2)
    }, [continuous])

    return null
}

function useReducedMotionPreference() {
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

    return reducedMotion
}

function scheduleCoverUploadPump(delay = 0) {
    if (coverUploadScheduled || typeof window === 'undefined' || coverUploadQueue.length === 0) return
    if (coverPipelinePaused || !museumDocumentIsVisible()) return
    coverUploadScheduled = true
    const generation = coverUploadPumpGeneration
    window.setTimeout(() => {
        window.requestAnimationFrame(() => {
            if (generation !== coverUploadPumpGeneration) return
            runCoverUploadQueue()
        })
    }, delay)
}

function runCoverUploadQueue() {
    if (coverPipelinePaused || !museumDocumentIsVisible()) {
        coverUploadScheduled = false
        return
    }
    coverUploadQueue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
    const interactionBusy = museumInteractionIsBusy()
    const canUpload = (job) => museumCoverUploadAllowed({
        width: job.texture.userData.museumTargetWidth,
        priority: job.priority,
        interactionBusy: museumInteractionIsBusy(),
        inputPending: Boolean(navigator.scheduling?.isInputPending?.()),
        sinceLastUpload: performance.now() - lastCoverUploadAt,
        lastUploadDuration: lastCoverUploadDuration,
    })
    const nextIndex = coverUploadQueue.findIndex(canUpload)
    if (nextIndex < 0) {
        coverUploadScheduled = false
        scheduleCoverUploadPump(48)
        return
    }
    const [next] = coverUploadQueue.splice(nextIndex, 1)
    const uploadStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    let deferredForInteraction = false
    try {
        if (!coverTextureWasUploaded(next.gl, next.texture)) {
            if (next.gl.getContext?.().isContextLost?.()) {
                throw new Error('The WebGL context is temporarily unavailable')
            }
            if (!canUpload(next)) {
                // Input may arrive after the queue-level check but before the
                // synchronous GPU bind. Preserve the exact pending job and its
                // pin, then try again after the fresh interaction window.
                deferredForInteraction = true
                coverUploadQueue.unshift(next)
                return
            }
            next.gl.initTexture?.(next.texture)
            if (museumInteractionIsBusy() || navigator.scheduling?.isInputPending?.()) {
                coverUploadsDuringInteraction += 1
            }
            markCoverTextureUploaded(next.gl, next.texture)
        }
        next.resolve(next.texture)
    } catch (cause) {
        next.reject(cause)
    } finally {
        if (deferredForInteraction) {
            coverUploadScheduled = false
            scheduleCoverUploadPump(96)
        } else {
            const uploadFinishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
            lastCoverUploadDuration = Math.max(0, uploadFinishedAt - uploadStartedAt)
            lastCoverUploadAt = uploadFinishedAt
            unpinCoverTexture(next.texture)
            if (pendingCoverUploads.get(next.texture) === next.pending) {
                pendingCoverUploads.delete(next.texture)
            }
            coverUploadScheduled = false
            const measuredBackoff = lastCoverUploadDuration > 7
                ? Math.min(180, Math.ceil(lastCoverUploadDuration * 5))
                : 0
            scheduleCoverUploadPump(Math.max(interactionBusy ? 48 : 16, measuredBackoff))
        }
    }
}

function invalidateRendererCoverUploads(gl) {
    rendererUploadGenerations.set(gl, rendererUploadGeneration(gl) + 1)
    coverTextureCache.forEach(texture => {
        texture.needsUpdate = true
    })
    for (let index = coverUploadQueue.length - 1; index >= 0; index -= 1) {
        const job = coverUploadQueue[index]
        if (job.gl !== gl) continue
        coverUploadQueue.splice(index, 1)
        unpinCoverTexture(job.texture)
        if (pendingCoverUploads.get(job.texture) === job.pending) {
            pendingCoverUploads.delete(job.texture)
        }
        job.reject(new Error('The WebGL renderer restarted before the cover was uploaded'))
    }
    scheduleCoverUploadPump()
}

function settleCoverLoadJob(job, fulfilled, value) {
    if (job.settled) return
    job.settled = true
    window.clearTimeout(job.startTimer)
    job.startTimer = 0
    activeCoverLoadJobs.delete(job)
    if (job.active) activeCoverLoads = Math.max(0, activeCoverLoads - 1)
    job.active = false
    job.controller = null
    if (fulfilled) job.resolve(value)
    else job.reject(value)
    scheduleCoverLoadWake(fulfilled ? 32 : 0)
}

function cancelCoverLoadJob(job, reason = museumAbortError()) {
    if (job.settled) return
    job.attempt += 1
    job.controller?.abort(reason)
    settleCoverLoadJob(job, false, reason)
}

function requeueCoverLoadJob(job, reason = museumAbortError('Museum artwork loading paused')) {
    if (job.settled) return
    // Invalidate the physical attempt before aborting it. Its eventual
    // rejection is then ignored, while the original logical promise remains
    // pending and is retried with a fresh controller after focus returns.
    job.attempt += 1
    window.clearTimeout(job.startTimer)
    job.startTimer = 0
    job.controller?.abort(reason)
    job.controller = null
    activeCoverLoadJobs.delete(job)
    if (job.active) activeCoverLoads = Math.max(0, activeCoverLoads - 1)
    job.active = false
    job.enqueuedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (!coverLoadQueue.includes(job)) coverLoadQueue.push(job)
}

function suspendCoverPipelines() {
    coverPipelinePaused = true
    coverLoadWakeScheduled = false
    coverUploadPumpGeneration += 1
    coverUploadScheduled = false
    // Browsers may discard a pre-start timer or stall an image decoder while
    // occluded. Abort only that physical attempt and return its logical job to
    // the queue; critical warmup promises therefore cannot be mistaken for
    // completed work and no stale attempt can occupy a concurrency slot.
    for (const job of [...activeCoverLoadJobs]) requeueCoverLoadJob(job)
}

function cancelCoverPipelines() {
    coverPipelinePaused = true
    coverPipelineEpoch += 1
    coverLoadWakeScheduled = false
    for (const job of coverLoadQueue.splice(0)) cancelCoverLoadJob(job)
    for (const job of [...activeCoverLoadJobs]) cancelCoverLoadJob(job)
    for (const [key, pending] of coverTextureLoads) {
        if (pending.epoch < coverPipelineEpoch) coverTextureLoads.delete(key)
    }
}

function resumeCoverPipelines() {
    // A backgrounded browser is allowed to discard an outstanding animation
    // callback. Supersede that pump instead of trusting its global scheduled
    // flag, then resume both queues from their preserved jobs.
    if (!museumDocumentIsForeground()) {
        suspendCoverPipelines()
        return
    }
    coverUploadPumpGeneration += 1
    coverPipelinePaused = false
    coverUploadScheduled = false
    coverLoadWakeScheduled = false
    runCoverLoadQueue()
    scheduleCoverUploadPump()
    scheduleCoverCacheTrim()
    for (const handleResume of [...coverPipelineResumeWaiters]) handleResume()
}
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
    return isFirefoxBrowser() ? 1 : DEFAULT_COVER_LOAD_CONCURRENCY
}

function pinCoverTexture(texture) {
    if (!texture) return
    pinnedCoverTextures.set(texture, (pinnedCoverTextures.get(texture) || 0) + 1)
}

function unpinCoverTexture(texture) {
    if (!texture) return
    const nextCount = Math.max(0, (pinnedCoverTextures.get(texture) || 1) - 1)
    if (nextCount) pinnedCoverTextures.set(texture, nextCount)
    else pinnedCoverTextures.delete(texture)
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

function trimCoverTextureCache(maxEvictions = Number.POSITIVE_INFINITY) {
    const entries = [...coverTextureCache.entries()]
    const deviceMemory = typeof navigator === 'undefined' ? 8 : Number(navigator.deviceMemory || 8)
    const lowPower = usesTouchControls() || deviceMemory <= 4
    const budget = lowPower ? LOW_POWER_COVER_CACHE_BUDGET : DESKTOP_COVER_CACHE_BUDGET
    const entryBudget = lowPower ? LOW_POWER_COVER_CACHE_ENTRIES : DESKTOP_COVER_CACHE_ENTRIES
    let bytes = entries.reduce((total, [, texture]) => total + Number(texture?.userData?.museumBytes || 0), 0)
    let evicted = 0
    for (const [key, texture] of entries) {
        if (bytes <= budget && coverTextureCache.size <= entryBudget) break
        if ((coverTextureReferences.get(key) || 0) > 0 || (pinnedCoverTextures.get(texture) || 0) > 0) continue
        coverTextureCache.delete(key)
        bytes -= Number(texture?.userData?.museumBytes || 0)
        texture.userData.museumDisposed = true
        texture?.image?.close?.()
        texture?.dispose()
        evicted += 1
        if (evicted >= maxEvictions) break
    }
    return {
        evicted,
        overBudget: bytes > budget || coverTextureCache.size > entryBudget,
    }
}

function scheduleCoverCacheTrim(delay = 0) {
    if (coverCacheTrimScheduled || typeof window === 'undefined' || coverTextureCache.size === 0) return
    coverCacheTrimScheduled = true
    scheduleMuseumVisibleTask(() => {
        coverCacheTrimScheduled = false
        if (coverPipelinePaused) return
        if (museumInteractionIsBusy() || navigator.scheduling?.isInputPending?.()) {
            scheduleCoverCacheTrim(96)
            return
        }
        // Deleting several uploaded textures in one turn can be just as visible
        // as uploading one. Retire one unreferenced LRU entry per quiet frame.
        const result = trimCoverTextureCache(1)
        if (result.overBudget && result.evicted > 0) scheduleCoverCacheTrim(48)
    }, delay)
}

function enqueueCoverUpload(gl, texture, priority = 0) {
    if (!texture || coverTextureWasUploaded(gl, texture)) return Promise.resolve(texture)
    const pending = pendingCoverUploads.get(texture)
    if (pending) {
        if (pending.gl === gl) {
            // A speculative preview may become visible while its upload is
            // queued. Raise that exact job instead of leaving it idle-only.
            pending.priority = Math.max(pending.priority, priority)
            scheduleCoverUploadPump()
            return pending.promise
        }
        return pending.promise.catch(() => undefined).then(() => enqueueCoverUpload(gl, texture, priority))
    }
    pinCoverTexture(texture)
    let pendingRecord
    const upload = new Promise((resolve, reject) => {
        pendingRecord = { gl, texture, resolve, reject, priority, sequence: coverUploadSequence++ }
        pendingRecord.pending = pendingRecord
        coverUploadQueue.push(pendingRecord)
    })
    pendingRecord.promise = upload
    pendingCoverUploads.set(texture, pendingRecord)
    scheduleCoverUploadPump()
    return upload
}

async function promoteRevealTextures(gl, textures, onProgress, signal) {
    const pending = [...new Set(textures.filter(Boolean))]
    for (let index = 0; index < pending.length; index += 1) {
        if (signal?.aborted) throw signal.reason || museumAbortError()
        await waitForMuseumForeground(signal)
        const texture = pending[index]
        const queuedUpload = pendingCoverUploads.get(texture)
        if (queuedUpload?.gl === gl) {
            // A mounted painting may already own the GPU upload for the same
            // cached texture. Await that exact job instead of racing it and
            // deleting its promise/refcount bookkeeping out from underneath
            // the consumer.
            await queuedUpload.promise
        } else if (!coverTextureWasUploaded(gl, texture)) {
            if (queuedUpload) await queuedUpload.promise.catch(() => undefined)
            await waitForMuseumForeground(signal)
            if (gl.getContext?.().isContextLost?.()) {
                throw new Error('The WebGL context is temporarily unavailable')
            }
            // Startup assets are deliberately promoted while the opaque veil is
            // present. The normal idle queue is ideal during play, but its
            // 180 ms gaps made eight tiny uploads add more than a second to a
            // cold start. Two uploads per frame keeps progress smooth without
            // deferring the first real bind until after the reveal.
            gl.initTexture?.(texture)
            markCoverTextureUploaded(gl, texture)
        }
        onProgress?.((index + 1) / Math.max(1, pending.length))
        if (index % 2 === 1 && index < pending.length - 1) {
            await waitForMuseumFrame(signal)
        }
    }
}

async function prewarmMuseumRoomInteriors(gl, scene, camera, layout, onProgress, signal) {
    const interiorByRoomId = new Map()
    scene.traverse((object) => {
        const roomId = object.userData?.museumRoomInterior
        if (roomId) interiorByRoomId.set(roomId, object)
    })
    const entries = layout.rooms
        .map(room => ({ room, interior: interiorByRoomId.get(room.id) }))
        .filter(entry => entry.interior)
    if (!entries.length) {
        onProgress?.(1)
        return
    }

    const warmCamera = camera.clone()
    warmCamera.aspect = camera.aspect
    warmCamera.near = camera.near
    warmCamera.far = camera.far
    warmCamera.updateProjectionMatrix()

    try {
        for (let index = 0; index < entries.length; index += 1) {
            if (signal?.aborted) throw signal.reason || museumAbortError()
            await waitForMuseumForeground(signal)
            const { room, interior } = entries[index]
            // Snapshot after the foreground wait and restore before yielding
            // again. A React residency update can then never be overwritten by
            // a stale visibility value captured several warmup frames earlier.
            const iterationVisibility = new Map(
                entries.map(entry => [entry.interior, entry.interior.visible]),
            )

            // Force this concealed room's complete static presentation through
            // Three's render list exactly once. This uploads its plaque and
            // placeholder atlases plus cold geometry while the HTML veil is
            // still opaque instead of on the visitor's first step into the bay.
            try {
                entries.forEach(entry => {
                    entry.interior.visible = entry.interior === interior
                })
                const cullingState = []
                interior.traverse((object) => {
                    if (!object.isObject3D) return
                    cullingState.push([object, object.frustumCulled])
                    object.frustumCulled = false
                })
                try {
                    const warmDepth = Math.min(
                        Math.max(3.2, room.depth * 0.48),
                        Math.max(3.2, room.depth - 1.4),
                    )
                    warmCamera.position.set(
                        room.innerX + (room.side * warmDepth),
                        2.45,
                        room.centerZ,
                    )
                    warmCamera.lookAt(room.outerX - (room.side * 0.7), 2.35, room.centerZ)
                    warmCamera.updateMatrixWorld(true)
                    scene.updateMatrixWorld(true)
                    gl.render(scene, warmCamera)
                } finally {
                    cullingState.forEach(([object, frustumCulled]) => {
                        object.frustumCulled = frustumCulled
                    })
                }
            } finally {
                iterationVisibility.forEach((visible, roomInterior) => {
                    roomInterior.visible = visible
                })
                scene.updateMatrixWorld(true)
            }
            onProgress?.((index + 1) / entries.length)
            if (index < entries.length - 1) await waitForMuseumFrame(signal)
        }
    } finally {
        requestMuseumFrames(2)
    }
}

function usesTouchControls() {
    if (typeof window === 'undefined') return false
    return Boolean(window.matchMedia?.('(pointer: coarse)').matches)
        || (window.innerWidth < 900 && (navigator.maxTouchPoints || 0) > 0)
}

function preferredMuseumInspectionCoverWidth(touchMode = usesTouchControls()) {
    const deviceMemory = typeof navigator === 'undefined' ? 8 : Number(navigator.deviceMemory || 8)
    return touchMode || navigator.connection?.saveData || deviceMemory <= 4
        ? LOW_POWER_INSPECTION_COVER_WIDTH
        : INSPECTION_COVER_WIDTH
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

function configureTexture(source, { color = false, repeat = [1, 1], offset = [0, 0] } = {}) {
    const texture = source.clone()
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(...repeat)
    texture.offset.set(...offset)
    texture.anisotropy = 4
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
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
    // Decode sources without also eagerly uploading their unused default
    // sampler variants. Warmup uploads the configured, shared repeat textures.
    const loadedTextures = useLoader(THREE.TextureLoader, MATERIAL_SOURCE_URLS)
    const sources = useMemo(() => Object.fromEntries(
        MATERIAL_SOURCE_ENTRIES.map(([name], index) => [name, loadedTextures[index]]),
    ), [loadedTextures])
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
            normalMap: configureTexture(sources.plasterNormal, { repeat: [5, 3] }),
            roughnessMap: configureTexture(sources.plasterRoughness, { repeat: [5, 3] }),
            aoMap: plasterOcclusion,
        },
        floor: {
            map: configureTexture(sources.woodColor, { color: true, repeat: [1, 1] }),
            normalMap: configureTexture(sources.woodNormal, { repeat: [1, 1] }),
            roughnessMap: configureTexture(sources.woodRoughness, { repeat: [1, 1] }),
            aoMap: floorOcclusion,
        },
        joinery: {
            map: configureTexture(sources.joineryColor, { color: true }),
            normalMap: configureTexture(sources.joineryNormal),
            roughnessMap: configureTexture(sources.joineryRoughness),
            aoMap: joineryOcclusion,
        },
        wallpaper: {
            map: configureTexture(sources.wallpaperColor, { color: true }),
            normalMap: configureTexture(sources.fabricNormal),
            roughnessMap: configureTexture(sources.fabricRoughness),
            aoMap: wallpaperOcclusion,
        },
        brass: {
            roughnessMap: configureTexture(sources.brassRoughness, { repeat: [4, 4] }),
        },
        ceramic: {
            roughnessMap: configureTexture(sources.ceramicRoughness, { repeat: [3, 3] }),
        },
        fabric: {
            normalMap: configureTexture(sources.fabricNormal, { repeat: [12, 8] }),
            roughnessMap: configureTexture(sources.fabricRoughness, { repeat: [12, 8] }),
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
            normalScale={textured ? [0.23, 0.23] : undefined}
            aoMapIntensity={textured ? 0.58 : 0}
            side={side}
        />
    )
}

function applyBakedBounceToEmission(shader) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
        #include <emissivemap_fragment>
        #if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
            totalEmissiveRadiance *= vColor.rgb;
        #endif
    `)
}

function WallpaperMaterial({ materials, width, height, centerZ = 0, color = '#d8c8b4', side = THREE.FrontSide, shapeUv = false, phase = 0, reverseU = false, vertexColors = false }) {
    const surfaceMaps = useMemo(() => {
        const transform = museumSurfaceTextureTransform({ width, height, center: centerZ, shapeUv, reverseU, phase, tileSize: MUSEUM_MATERIAL_TILE_METERS.fabric })
        return {
            normalMap: configureTexture(materials.wallpaper.normalMap, transform),
            roughnessMap: configureTexture(materials.wallpaper.roughnessMap, transform),
        }
    }, [materials.wallpaper, width, height, centerZ, shapeUv, reverseU, phase])
    useEffect(() => () => Object.values(surfaceMaps).forEach(texture => texture.dispose()), [surfaceMaps])
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
            {...surfaceMaps}
            normalScale={[0.25, 0.25]}
            aoMap={materials.wallpaper.aoMap}
            aoMapIntensity={0.46}
            color={color}
            emissiveMap={map}
            emissive="#d6a27b"
            emissiveIntensity={0.43}
            roughness={0.84}
            metalness={0}
            sheen={0.16}
            sheenColor="#6d242d"
            sheenRoughness={0.88}
            side={side}
            vertexColors={vertexColors}
            onBeforeCompile={applyBakedBounceToEmission}
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
        const horizontalSegments = Math.max(12, Math.min(46, Math.ceil(width / (mode === 'hall' ? 1.15 : 0.9))))
        const verticalSegments = 12
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
        Object.entries(materials.plaster).filter(([name]) => name === 'normalMap' || name === 'roughnessMap').map(([name, source]) => [name, configureTexture(source, {
            color: name === 'map',
            repeat: [3.5, Math.max(2, hallLength / 5.5)],
        })]),
    ), [hallLength, materials.plaster])
    useEffect(() => () => Object.values(ceilingMaps).forEach(texture => texture.dispose()), [ceilingMaps])
    return (
        <meshStandardMaterial
            {...ceilingMaps}
            normalScale={[0.09, 0.09]}
            color="#d4c8b4"
            emissive="#a38d71"
            emissiveIntensity={0.065}
            vertexColors
            onBeforeCompile={applyBakedBounceToEmission}
            roughness={0.93}
            side={THREE.DoubleSide}
        />
    )
}

function FloorMaterial({ materials, color = '#a18a73', vertexColors = false, width = 1, depth = 1, centerX = 0, centerZ = 0 }) {
    const floorMaps = useMemo(() => {
        const transform = museumFloorTextureTransform({ width, depth, centerX, centerZ })
        return Object.fromEntries(['map', 'normalMap', 'roughnessMap'].map(name => [
            name, configureTexture(materials.floor[name], { ...transform, color: name === 'map' }),
        ]))
    }, [materials.floor, width, depth, centerX, centerZ])
    useEffect(() => () => Object.values(floorMaps).forEach(texture => texture.dispose()), [floorMaps])
    return (
        <meshPhysicalMaterial
            {...materials.floor}
            {...floorMaps}
            normalScale={[0.26, 0.26]}
            color={color}
            emissive="#3f2b20"
            emissiveIntensity={0.065}
            metalness={0}
            roughness={0.96}
            aoMapIntensity={0.5}
            clearcoat={0.12}
            clearcoatRoughness={0.48}
            vertexColors={vertexColors}
            onBeforeCompile={applyBakedBounceToEmission}
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
            <FloorMaterial materials={materials} color={color} vertexColors width={width} depth={depth} centerX={position[0]} centerZ={position[2]} />
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

function WoodMaterial({ materials, color = '#bba18b', roughness = 0.95 }) {
    return (
        <meshStandardMaterial
            {...materials.joinery}
            normalScale={[0.2, 0.2]}
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
    const glows = useRef(null)

    useEffect(() => {
        const position = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        const scale = new THREE.Vector3(1, 1, 1)
        const matrix = new THREE.Matrix4()
        // CircleGeometry faces +Z. Rotate that normal toward -Y so the visible
        // lens and halo face the room rather than the ceiling cavity.
        const lensRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
        positions.forEach(([x, z], index) => {
            rotation.identity()
            matrix.compose(position.set(x, ceilingY, z), rotation, scale)
            housings.current?.setMatrixAt(index, matrix)
            matrix.compose(position.set(x, ceilingY - 0.075, z), rotation, scale)
            reflectors.current?.setMatrixAt(index, matrix)
            matrix.compose(position.set(x, ceilingY - 0.142, z), lensRotation, scale)
            lenses.current?.setMatrixAt(index, matrix)
            matrix.compose(position.set(x, ceilingY - 0.153, z), lensRotation, scale.set(1.65, 1.65, 1.65))
            glows.current?.setMatrixAt(index, matrix)
            scale.set(1, 1, 1)
        })
        for (const mesh of [housings.current, reflectors.current, lenses.current, glows.current]) {
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
                    toneMapped={false}
                />
            </instancedMesh>
            <instancedMesh ref={glows} args={[undefined, undefined, positions.length]} renderOrder={8}>
                <circleGeometry args={[0.22, 16]} />
                <meshBasicMaterial
                    color="#ffd8a6"
                    transparent
                    opacity={0.16}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
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
    const border = Math.max(5, Math.round(height * 0.032))
    context.lineWidth = border
    context.strokeRect(border, border, width - (border * 2), height - (border * 2))
    context.fillStyle = dark ? '#f3ede1' : '#211d18'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const longest = Math.max(8, title.length)
    const fontSize = Math.max(
        Math.round(height * 0.18),
        Math.min(Math.round(height * 0.36), Math.floor((width * 1.25) / longest)),
    )
    context.font = `500 ${fontSize}px Georgia, serif`
    const horizontalPadding = Math.max(36, Math.round(width * 0.075))
    context.fillText(title, width / 2, subtitle ? height * 0.42 : height / 2, width - (horizontalPadding * 2))
    if (subtitle) {
        context.fillStyle = dark ? '#c4b6a3' : '#6f6256'
        context.font = `600 ${Math.max(18, Math.round(height * 0.11))}px Helvetica, Arial, sans-serif`
        context.fillText(subtitle.toUpperCase(), width / 2, height * 0.73, width - (horizontalPadding * 2))
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

function createRoomPlaqueBatch(paintings) {
    const columns = Math.min(4, Math.max(1, paintings.length))
    const rows = Math.max(1, Math.ceil(paintings.length / columns))
    // Plaques occupy only a few hundred screen pixels even at interaction
    // distance. A compact atlas avoids allocating and uploading several large
    // canvases synchronously during Firefox's first scene commit while keeping
    // lettering comfortably above its displayed resolution.
    const tileWidth = 384
    // Match the physical 1.72 × 0.38 plaque so names are not stretched nearly
    // twofold when the atlas tile is sampled on the wall plane.
    const tileHeight = 85
    const canvas = document.createElement('canvas')
    canvas.width = columns * tileWidth
    canvas.height = rows * tileHeight
    const context = canvas.getContext('2d')
    const parent = new THREE.Matrix4()
    // Keep the caption centered beneath the physical frame. Side-mounted
    // plaques inherited each painting's rotation and crossed the mat at
    // oblique viewing angles.
    const local = new THREE.Matrix4().makeTranslation(0, MUSEUM_ARTWORK_SURFACES.plaqueY, MUSEUM_ARTWORK_SURFACES.plaque)
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
    return { geometry, texture }
}

function RoomPlaqueBatch({ paintings }) {
    const batch = useMemo(() => (
        paintings.length ? createRoomPlaqueBatch(paintings) : null
    ), [paintings])
    useEffect(() => () => {
        batch?.geometry.dispose()
        batch?.texture.dispose()
    }, [batch])
    if (!batch) return null
    return (
        <mesh geometry={batch.geometry}>
            <meshBasicMaterial map={batch.texture} toneMapped={false} />
        </mesh>
    )
}

function museumPlaceholderColor(value, index = 0) {
    let hash = 2166136261
    for (const character of String(value || 'photograph')) {
        hash ^= character.charCodeAt(0)
        hash = Math.imul(hash, 16777619)
    }
    const palette = ['#8f7668', '#71858a', '#82758d', '#78866e', '#96736e', '#747889']
    return new THREE.Color(palette[Math.abs(hash + index) % palette.length])
}

function drawMuseumArtworkPlaceholder(context, painting, x, y, width, height, index) {
    const blurhash = painting?.album?.coverBlurhash
    if (blurhash) {
        try {
            // A 12 × 8 decode is enough for a deliberately soft continuity
            // layer. It keeps even archive-scale rooms cheap to prepare while
            // preserving each photograph's real palette and composition.
            const sampleWidth = 12
            const sampleHeight = 8
            const pixels = decodeBlurhash(blurhash, sampleWidth, sampleHeight, 0.85)
            const sample = document.createElement('canvas')
            sample.width = sampleWidth
            sample.height = sampleHeight
            sample.getContext('2d')?.putImageData(
                new ImageData(new Uint8ClampedArray(pixels), sampleWidth, sampleHeight),
                0,
                0,
            )
            context.imageSmoothingEnabled = true
            context.imageSmoothingQuality = 'low'
            context.drawImage(sample, x, y, width, height)
            context.fillStyle = 'rgba(238, 226, 210, 0.12)'
            context.fillRect(x, y, width, height)
            return
        } catch {
            // Malformed legacy hashes fall through to the deterministic wash.
        }
    }
    const base = museumPlaceholderColor(
        `${painting?.album?.category || ''}:${painting?.album?.title || painting?.id || index}`,
        index,
    )
    const start = `#${base.clone().offsetHSL(-0.025, 0.02, 0.12).getHexString()}`
    const end = `#${base.clone().offsetHSL(0.025, -0.03, -0.1).getHexString()}`
    const gradient = context.createLinearGradient(x, y, x + width, y + height)
    gradient.addColorStop(0, start)
    gradient.addColorStop(1, end)
    context.fillStyle = gradient
    context.fillRect(x, y, width, height)
}

function createRoomPlaceholderBatch(paintings) {
    const columns = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(paintings.length * 1.5))))
    const rows = Math.max(1, Math.ceil(paintings.length / columns))
    const tileWidth = 96
    const tileHeight = 64
    const canvas = document.createElement('canvas')
    canvas.width = columns * tileWidth
    canvas.height = rows * tileHeight
    const context = canvas.getContext('2d')
    const parent = new THREE.Matrix4()
    // The inner frame lip ends at 0.1765. The old placeholder at 0.158
    // was inside that solid slab, so visitors saw a blank frame while loading.
    const local = new THREE.Matrix4().makeTranslation(0, 0, MUSEUM_ARTWORK_SURFACES.placeholder)
    const world = new THREE.Matrix4()
    const rotation = new THREE.Quaternion()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const geometries = paintings.map((painting, index) => {
        const column = index % columns
        const row = Math.floor(index / columns)
        drawMuseumArtworkPlaceholder(
            context,
            painting,
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
    return { geometry, texture }
}

function RoomPlaceholderBatch({ paintings, visible = true }) {
    const batch = useMemo(() => (
        paintings.length ? createRoomPlaceholderBatch(paintings) : null
    ), [paintings])
    useEffect(() => () => {
        batch?.geometry.dispose()
        batch?.texture.dispose()
    }, [batch])
    if (!batch) return null
    return (
        <mesh geometry={batch.geometry} renderOrder={2} visible={visible}>
            <meshBasicMaterial map={batch.texture} toneMapped={false} />
        </mesh>
    )
}

function LabelPlane({ title, subtitle, position, rotation = [0, 0, 0], size = [3, 0.75], renderOrder = 0, depthTest = true }) {
    const labelWidth = 1024
    const physicalAspect = Math.max(1, size[0] / Math.max(0.01, size[1]))
    const labelHeight = Math.max(160, Math.min(512, Math.round(labelWidth / physicalAspect)))
    const texture = useLabelTexture(title, subtitle, { width: labelWidth, height: labelHeight })
    return (
        <mesh position={position} rotation={rotation} renderOrder={renderOrder}>
            <planeGeometry args={size} />
            <meshBasicMaterial map={texture} toneMapped={false} side={THREE.DoubleSide} depthTest={depthTest} />
        </mesh>
    )
}

function CategoryDoorSign({ room, side, centerZ, materials }) {
    const pose = museumDoorAssemblyPose(side, centerZ)
    // The back face touches the spandrel; every visible layer belongs to the
    // same shallow assembly, including when viewed from directly underneath.
    return (
        <group position={pose.sign} rotation={[0, pose.rotationY, 0]}>
            <mesh position={[0, 0, -0.14]} scale={[MUSEUM_PORTAL.signSurroundWidth, MUSEUM_PORTAL.signSurroundHeight, 0.1]}>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshStandardMaterial color="#eee5d6" roughness={0.72} />
            </mesh>
            <mesh position={[0, 0, -0.025]} scale={[3.24, 0.86, 0.13]} castShadow receiveShadow>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshPhysicalMaterial
                    {...materials.joinery}
                    color="#9b7747"
                    metalness={0.58}
                    roughness={0.34}
                    clearcoat={0.24}
                />
            </mesh>
            <mesh position={[0, 0, 0.05]} scale={[3.04, 0.68, 0.06]}>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshStandardMaterial color="#181411" roughness={0.74} />
            </mesh>
            <LabelPlane
                title={room.name}
                subtitle={`${room.albums.length} ${room.albums.length === 1 ? 'album' : 'albums'}`}
                position={[0, 0, 0.081]}
                size={[2.88, 0.66]}
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
    const canonicalCover = albumCoverUrl(album)
    const albumKey = [album.albumId, album.coverThumbnailUrl, album.coverThumbKey, album.coverImageUrl].join('|')
    let candidates = coverPreviewCandidateCache.get(albumKey)
    if (!candidates) {
        candidates = new Promise((resolve) => {
            let settled = false
            let timeout = 0
            const finish = (value) => {
                if (settled) return
                settled = true
                window.clearTimeout(timeout)
                resolve(value)
            }
            // Preview-manifest discovery is an optimization, never a reason to
            // strand one of the two cover-loading slots. Fall back to the
            // canonical/thumbnail URLs if an intermediary request stops settling.
            timeout = window.setTimeout(() => finish(''), 900)
            try {
                Promise.resolve(albumCoverPreviewSrcSet(album)).then(finish, () => finish(''))
            } catch {
                finish('')
            }
        })
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
    const generatedPreviews = (targetWidth <= BASE_COVER_WIDTH ? previews.slice(0, 1) : previews)
        .map(candidate => candidate.url)
    return [...new Set((targetWidth <= BASE_COVER_WIDTH ? [
        // Current albums share the immutable 640px response with their near
        // tier, so the compact base resize usually costs no second download.
        // Legacy thumbnails remain the guaranteed fallback when a generated
        // preview is unavailable.
        ...generatedPreviews,
        canonicalCover,
        album.coverThumbnailUrl,
        album.coverImageUrl,
    ] : [
        ...generatedPreviews,
        album.coverImageUrl,
        canonicalCover,
        album.coverThumbnailUrl,
    ]).filter(Boolean))]
}

function runCoverLoadQueue() {
    if (coverLoadQueue.length === 0) return
    // Browsers suspend animation and decoder work while a tab is backgrounded.
    // Leave queued work intact and let the visibility lifecycle restart it;
    // repeatedly arming timers here was both wasteful and prone to a stranded
    // "scheduled" flag after a long alt-tab.
    if (coverPipelinePaused || !museumDocumentIsVisible()) return
    // Allow only compact base work during movement. Larger detail decodes
    // wait for idle time, while photographs continue to arrive during a walk.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const oldestWait = coverLoadQueue.reduce(
        (longest, job) => Math.max(longest, now - (job.enqueuedAt || now)),
        0,
    )
    const interactionBusy = museumInteractionIsBusy()
    const inputPending = Boolean(navigator.scheduling?.isInputPending?.())
    const canLoad = job => museumCoverLoadAllowed({
        width: job.targetWidth,
        priority: job.priority,
        interactionBusy,
        inputPending,
    })
    const hasInteractionSafeWork = coverLoadQueue.some(canLoad)
    if (
        (inputPending || interactionBusy)
        && oldestWait < 850
        && !(interactionBusy && hasInteractionSafeWork)
    ) {
        scheduleCoverLoadWake(72)
        return
    }
    if (inputPending || (interactionBusy && !hasInteractionSafeWork)) {
        scheduleCoverLoadWake(72)
        return
    }
    while (activeCoverLoads < coverLoadConcurrency() && coverLoadQueue.length > 0) {
        // The room the visitor most recently approached should not sit behind
        // stale work left over from the previous end of the hall.
        // Detail work for the room being entered outranks background previews.
        // Within the same tier, preserve scene order so the first visible rooms
        // are never starved behind the far end of the museum.
        coverLoadQueue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
        const eligibleIndex = coverLoadQueue.findIndex(canLoad)
        if (eligibleIndex < 0) {
            scheduleCoverLoadWake(72)
            break
        }
        const [job] = coverLoadQueue.splice(eligibleIndex, 1)
        if (!job || job.settled) continue
        job.active = true
        activeCoverLoads += 1
        activeCoverLoadJobs.add(job)
        const attempt = job.attempt + 1
        job.attempt = attempt
        const controller = new AbortController()
        job.controller = controller
        const completeAttempt = (fulfilled, value) => {
            if (job.settled || job.attempt !== attempt) return
            settleCoverLoadJob(job, fulfilled, value)
        }
        // GPU uploads have their own frame budget. Only a tiny network-start
        // stagger is needed here; long per-image timers delayed entire rooms.
        job.startTimer = window.setTimeout(() => {
            job.startTimer = 0
            if (job.settled || job.attempt !== attempt || controller.signal.aborted) return
            Promise.resolve()
                .then(() => job.task(controller.signal))
                .then(
                    value => completeAttempt(true, value),
                    cause => completeAttempt(false, cause),
                )
        }, activeCoverLoads > 1 ? 12 : 0)
    }
}

function enqueueCoverLoad(task, priority = 0, targetWidth = 0) {
    let queuedJob = null
    const request = new Promise((resolve, reject) => {
        queuedJob = {
            task,
            resolve,
            reject,
            priority,
            targetWidth,
            sequence: coverLoadSequence++,
            enqueuedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
            controller: null,
            attempt: 0,
            active: false,
            settled: false,
            startTimer: 0,
        }
        coverLoadQueue.push(queuedJob)
        runCoverLoadQueue()
    })
    request.museumCoverLoadJob = queuedJob
    return request
}

function museumCoverCropRect(sourceWidth, sourceHeight) {
    const width = Math.max(1, Number(sourceWidth) || 1)
    const height = Math.max(1, Number(sourceHeight) || 1)
    const sourceAspect = width / height
    if (sourceAspect > COVER_FRAME_ASPECT) {
        const cropWidth = height * COVER_FRAME_ASPECT
        return {
            x: (width - cropWidth) / 2,
            y: 0,
            width: cropWidth,
            height,
        }
    }
    const cropHeight = width / COVER_FRAME_ASPECT
    return {
        x: 0,
        y: (height - cropHeight) / 2,
        width,
        height: cropHeight,
    }
}

function loadHtmlImage(url, highPriority = false, targetWidth = 0, signal) {
    return new Promise((resolve, reject) => {
        const image = new Image()
        let settled = false
        let cancelProcessing = () => {}
        const cleanup = () => {
            window.clearTimeout(timeout)
            cancelProcessing()
            signal?.removeEventListener('abort', handleAbort)
            image.onload = null
            image.onerror = null
        }
        const finish = (fulfilled, value) => {
            if (settled) return
            settled = true
            cleanup()
            if (fulfilled) resolve(value)
            else reject(value)
        }
        const handleAbort = () => {
            image.src = ''
            finish(false, signal?.reason || museumAbortError())
        }
        const timeout = window.setTimeout(() => {
            image.src = ''
            finish(false, new Error('Museum cover timed out while decoding'))
        }, 5200)
        if (signal?.aborted) {
            handleAbort()
            return
        }
        signal?.addEventListener('abort', handleAbort, { once: true })
        image.crossOrigin = 'anonymous'
        image.decoding = 'async'
        image.fetchPriority = highPriority ? 'high' : 'low'
        image.onload = () => {
            // Small base crops can finish while walking; defer larger canvas
            // copies on Firefox/Safari until input settles.
            window.clearTimeout(timeout)
            const processDecodedImage = () => {
                if (settled) return
                if (signal?.aborted) {
                    handleAbort()
                    return
                }
                if ((targetWidth > BASE_COVER_WIDTH && museumInteractionIsBusy()) || navigator.scheduling?.isInputPending?.()) {
                    cancelProcessing = scheduleMuseumVisibleTask(processDecodedImage, 96)
                    return
                }
                const sourceWidth = image.naturalWidth || image.width
                const sourceHeight = image.naturalHeight || image.height
                if (targetWidth > 0 && sourceWidth > 0 && sourceHeight > 0) {
                    // Crop before upload so portrait and panoramic sources do not
                    // retain pixels that the physical landscape frame can never
                    // display. Firefox uses this canvas path to keep the crop and
                    // resize work out of WebGL's first texture bind.
                    const crop = museumCoverCropRect(sourceWidth, sourceHeight)
                    const canvas = document.createElement('canvas')
                    canvas.width = Math.max(1, Math.round(Math.min(targetWidth, crop.width)))
                    canvas.height = Math.max(1, Math.round(canvas.width / COVER_FRAME_ASPECT))
                    canvas.getContext('2d', { alpha: false })?.drawImage(
                        image,
                        crop.x,
                        crop.y,
                        crop.width,
                        crop.height,
                        0,
                        0,
                        canvas.width,
                        canvas.height,
                    )
                    finish(true, canvas)
                    return
                }
                finish(true, image)
            }
            processDecodedImage()
        }
        image.onerror = () => {
            finish(false, new Error('Museum cover could not be decoded'))
        }
        image.src = developmentMediaUrl(url)
    })
}

async function loadDecodedImage(url, highPriority = false, targetWidth = 0, signal) {
    // Firefox can postpone a group of createImageBitmap decodes until the
    // compositor becomes idle, making a determinate loading bar appear frozen
    // before releasing one enormous upload burst. Its HTML image decoder is
    // independently scheduled and provides much steadier cold-start pacing.
    const firefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)
    if (firefox || typeof createImageBitmap !== 'function' || typeof fetch !== 'function') {
        return loadHtmlImage(url, highPriority, targetWidth, signal)
    }
    const controller = new AbortController()
    let decoded = null
    let timedOut = false
    let timeoutFailure = null
    let rejectInterrupt = () => {}
    const interrupted = new Promise((_, reject) => {
        rejectInterrupt = reject
    })
    const handleAbort = () => {
        const reason = signal?.reason || museumAbortError()
        controller.abort(reason)
        rejectInterrupt(reason)
    }
    if (signal?.aborted) throw signal.reason || museumAbortError()
    signal?.addEventListener('abort', handleAbort, { once: true })
    const timeout = window.setTimeout(() => {
        timedOut = true
        timeoutFailure = new Error('Museum cover timed out while decoding')
        controller.abort(timeoutFailure)
        rejectInterrupt(timeoutFailure)
    }, highPriority ? 6500 : 4500)
    try {
        const response = await Promise.race([
            fetch(developmentMediaUrl(url), {
                cache: 'force-cache',
                credentials: 'omit',
                priority: highPriority ? 'high' : 'low',
                signal: controller.signal,
            }),
            interrupted,
        ])
        if (!response.ok) throw new Error(`Museum cover request failed (${response.status})`)
        const blob = await Promise.race([response.blob(), interrupted])
        if (signal?.aborted) throw signal.reason || museumAbortError()
        const decodeRequest = createImageBitmap(blob, {
            // WebGL ignores Texture.flipY for ImageBitmap sources, so perform
            // the upload-space flip during off-thread decoding instead.
            imageOrientation: 'flipY',
            premultiplyAlpha: 'none',
        })
        decodeRequest.then((bitmap) => {
            if (timedOut || signal?.aborted) bitmap.close?.()
        }, () => {})
        decoded = await Promise.race([decodeRequest, interrupted])
        if (signal?.aborted) {
            decoded.close?.()
            decoded = null
            throw signal.reason || museumAbortError()
        }
        if (targetWidth > 0 && decoded.width > 0 && decoded.height > 0) {
            const crop = museumCoverCropRect(decoded.width, decoded.height)
            const resizeWidth = Math.max(1, Math.round(Math.min(targetWidth, crop.width)))
            const resizeRequest = createImageBitmap(
                decoded,
                crop.x,
                crop.y,
                crop.width,
                crop.height,
                {
                    resizeWidth,
                    resizeHeight: Math.max(1, Math.round(resizeWidth / COVER_FRAME_ASPECT)),
                    resizeQuality: 'high',
                },
            )
            resizeRequest.then((bitmap) => {
                if (timedOut || signal?.aborted) bitmap.close?.()
            }, () => {})
            const resized = await Promise.race([resizeRequest, interrupted])
            decoded.close?.()
            decoded = null
            return resized
        }
        const result = decoded
        decoded = null
        return result
    } catch (cause) {
        decoded?.close?.()
        if (signal?.aborted) throw signal.reason || museumAbortError()
        if (timedOut) throw timeoutFailure || new Error('Museum cover timed out while decoding')
        // A timed-out request or a real HTTP miss will not improve by issuing
        // the same request again through an <img>. Only use that path when the
        // browser rejected fetch/ImageBitmap for compatibility reasons (most
        // notably older Safari CORS implementations).
        if (cause?.name === 'AbortError') {
            throw new Error('Museum cover request was interrupted', { cause })
        }
        if (/request failed/.test(cause?.message || '')) {
            throw cause
        }
        // Safari and cross-origin endpoints do not all expose ImageBitmap in
        // the same way. The async HTML image path remains a robust fallback.
        return loadHtmlImage(url, highPriority, targetWidth, signal)
    } finally {
        window.clearTimeout(timeout)
        signal?.removeEventListener('abort', handleAbort)
    }
}

function requestMuseumCoverTexture(album, targetWidth = 960, priority = targetWidth) {
    const cacheKey = coverCacheKey(album, targetWidth)
    const cached = coverTextureCache.get(cacheKey)
    if (cached) return cached
    const pending = coverTextureLoads.get(cacheKey)
    if (pending?.epoch === coverPipelineEpoch) {
        if (pending.job && !pending.job.settled) {
            pending.job.priority = Math.max(pending.job.priority, priority)
            runCoverLoadQueue()
        }
        return pending.promise
    }
    if (pending) coverTextureLoads.delete(cacheKey)

    const requestEpoch = coverPipelineEpoch
    let requestRecord
    const queuedRequest = enqueueCoverLoad(async (signal) => {
        const urls = await optimizedCoverUrls(album, targetWidth)
        if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('museum-slow-covers') === '1') {
            await new Promise(resolve => window.setTimeout(resolve, 700))
        }
        let lastError = null
        for (const url of urls) {
            try {
                if (signal.aborted || requestEpoch !== coverPipelineEpoch) {
                    throw signal.reason || museumAbortError()
                }
                const image = await loadDecodedImage(url, targetWidth > BASE_COVER_WIDTH, targetWidth, signal)
                if (signal.aborted || requestEpoch !== coverPipelineEpoch) {
                    image?.close?.()
                    throw signal.reason || museumAbortError()
                }
                const texture = new THREE.Texture(image)
                texture.colorSpace = THREE.SRGBColorSpace
                // Generating mipmaps during a walk-through is a major source of
                // interaction-frame stalls. Linear filtering plus restrained
                // anisotropy stays crisp without that upload penalty.
                texture.minFilter = THREE.LinearFilter
                texture.magFilter = THREE.LinearFilter
                texture.generateMipmaps = false
                texture.anisotropy = targetWidth <= BASE_COVER_WIDTH ? 2 : 4
                texture.userData.museumCacheKey = cacheKey
                texture.userData.museumTargetWidth = targetWidth
                texture.userData.museumDisposed = false
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
                if (cause?.name === 'AbortError') throw cause
                lastError = cause
            }
        }
        throw lastError || new Error('Museum cover is unavailable')
    }, priority, targetWidth)
    const request = queuedRequest.finally(() => {
        if (coverTextureLoads.get(cacheKey) === requestRecord) coverTextureLoads.delete(cacheKey)
    })
    requestRecord = {
        epoch: requestEpoch,
        promise: request,
        job: queuedRequest.museumCoverLoadJob,
    }
    coverTextureLoads.set(cacheKey, requestRecord)
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
    scheduleCoverCacheTrim()
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

function developmentMuseumFixtureAlbums() {
    const covers = [
        { image: '/images/heroes/photo-1920.jpg', thumbnail: '/images/heroes/photo-640.jpg' },
        { image: '/images/heroes/video-1920.jpg', thumbnail: '/images/heroes/video-640.jpg' },
        { image: '/images/heroes/photo-1920.webp', thumbnail: '/images/heroes/photo-640.webp' },
        { image: '/images/heroes/video-1920.webp', thumbnail: '/images/heroes/video-640.webp' },
    ]
    // Mirror the current production maximum so visual/performance QA exercises
    // an archive-scale wall instead of stopping at the former 12-cover cap.
    return Array.from({ length: 32 }, (_, index) => {
        const cover = covers[index % covers.length]
        return {
            albumId: `museum-fixture-${index + 1}`,
            type: 'photo',
            title: `Gallery Study ${String(index + 1).padStart(2, '0')}`,
            description: 'Development-only visual QA fixture',
            category: index < 26 ? 'Hikes' : 'Portraits',
            createdAt: `2026-08-${String(31 - (index % 28)).padStart(2, '0')}T19:00:00.000Z`,
            visibility: 'public',
            imageCount: 12 + index,
            coverImageUrl: cover.image,
            coverThumbnailUrl: cover.thumbnail,
            galleryCategoryOrder: index < 26 ? 0 : 1,
        }
    })
}

function useCoverTexture(album, targetWidth, priority = targetWidth, onPermanentError) {
    const { gl } = useThree()
    const cacheKey = coverCacheKey(album, targetWidth)
    const pendingLease = useRef(null)
    const [loaded, setLoaded] = useState(() => (
        museumArtworkFallbackWidths(targetWidth).map(width => cachedCoverTexture(album, width))
            .find(texture => texture && coverTextureWasUploaded(gl, texture)) || null
    ))

    useEffect(() => {
        let cancelled = false
        let cancelRetry = () => {}
        let retainedTexture = null
        let effectPendingLease = null
        if (!targetWidth) return undefined
        coverTextureConsumers.set(cacheKey, (coverTextureConsumers.get(cacheKey) || 0) + 1)
        const load = (attempt = 0) => {
            createMuseumCoverTexture(album, targetWidth, priority)
                // A room can fall out of the camera residency set while its
                // image is still decoding. Do not promote that stale texture
                // to the GPU after the consumer has gone away.
                .then((texture) => {
                    if (!cancelled) {
                        // Retain the decode across GPU upload and the React
                        // commit that attaches it to a painting. Otherwise an
                        // eviction timer can dispose a newly loaded texture in
                        // that gap and leave the artwork unavailable permanently.
                        pinCoverTexture(texture)
                        retainedTexture = texture
                        return enqueueCoverUpload(gl, texture, priority).catch((cause) => {
                            // Cleanup may already have released this hook's
                            // temporary lease while the shared upload was still
                            // pending. Release only the lease this effect still
                            // owns; the upload queue balances its own pin.
                            if (retainedTexture === texture) {
                                unpinCoverTexture(texture)
                                retainedTexture = null
                            }
                            throw cause
                        })
                    }
                    scheduleCoverCacheTrim()
                    return texture
                })
                .then(texture => {
                    if (cancelled) {
                        if (retainedTexture === texture) {
                            unpinCoverTexture(texture)
                            retainedTexture = null
                        }
                        return
                    }
                    // Transfer the temporary decode/upload pin into the
                    // component-owned pending lease before asking React to
                    // commit it. A functional state updater can be deferred;
                    // keeping the transfer inside that updater left a narrow
                    // unmount window where neither cleanup path owned the pin.
                    if (pendingLease.current && pendingLease.current !== texture) {
                        unpinCoverTexture(pendingLease.current)
                    }
                    pendingLease.current = texture
                    effectPendingLease = texture
                    retainedTexture = null
                    setLoaded((current) => {
                        if (current === texture) {
                            if (pendingLease.current === texture) {
                                unpinCoverTexture(texture)
                                pendingLease.current = null
                                effectPendingLease = null
                            }
                            return current
                        }
                        return texture
                    })
                    requestMuseumFrames(3)
                })
                .catch((cause) => {
                    if (cancelled) return
                    const transientRestart = cause?.name === 'AbortError'
                    if (import.meta.env.DEV && !transientRestart) {
                        const errors = JSON.parse(document.documentElement.dataset.museumCoverErrors || '[]')
                        errors.push({
                            albumId: album.albumId,
                            targetWidth,
                            attempt,
                            message: cause?.message || String(cause),
                        })
                        document.documentElement.dataset.museumCoverErrors = JSON.stringify(errors.slice(-40))
                    }
                    if (!transientRestart && attempt >= 2) {
                        onPermanentError?.()
                        return
                    }
                    cancelRetry()
                    cancelRetry = scheduleMuseumVisibleTask(
                        () => load(transientRestart ? attempt : attempt + 1),
                        transientRestart ? 0 : 500 * (attempt + 1),
                    )
                })
        }
        load()

        return () => {
            cancelled = true
            cancelRetry()
            const consumers = Math.max(0, (coverTextureConsumers.get(cacheKey) || 1) - 1)
            if (consumers) coverTextureConsumers.set(cacheKey, consumers)
            else {
                coverTextureConsumers.delete(cacheKey)
                // Do not decode old closeups after the visitor has left them.
                // Compact bases remain useful to look-ahead and startup owners.
                const pending = coverTextureLoads.get(cacheKey)
                if (targetWidth > BASE_COVER_WIDTH && pending?.job && !pending.job.settled) {
                    if (coverTextureLoads.get(cacheKey) === pending) coverTextureLoads.delete(cacheKey)
                    const index = coverLoadQueue.indexOf(pending.job)
                    if (index >= 0) coverLoadQueue.splice(index, 1)
                    cancelCoverLoadJob(pending.job)
                }
            }
            if (retainedTexture) {
                unpinCoverTexture(retainedTexture)
                retainedTexture = null
            }
            if (effectPendingLease && pendingLease.current === effectPendingLease) {
                unpinCoverTexture(effectPendingLease)
                pendingLease.current = null
                effectPendingLease = null
            }
        }
    }, [album, cacheKey, gl, onPermanentError, priority, targetWidth])

    const activeLoaded = targetWidth && !loaded?.userData?.museumDisposed ? loaded : null

    useLayoutEffect(() => {
        const referenceKey = activeLoaded?.userData?.museumCacheKey
        if (!referenceKey) return undefined
        coverTextureReferences.set(referenceKey, (coverTextureReferences.get(referenceKey) || 0) + 1)
        if (pendingLease.current === activeLoaded) {
            unpinCoverTexture(activeLoaded)
            pendingLease.current = null
        }
        return () => {
            const nextCount = Math.max(0, (coverTextureReferences.get(referenceKey) || 1) - 1)
            if (nextCount) coverTextureReferences.set(referenceKey, nextCount)
            else coverTextureReferences.delete(referenceKey)
            scheduleCoverCacheTrim()
        }
    }, [activeLoaded])

    useEffect(() => () => {
        if (pendingLease.current) {
            unpinCoverTexture(pendingLease.current)
            pendingLease.current = null
        }
    }, [])

    return activeLoaded
}

function GalleryFrameShells({ paintings, materials, compact = false }) {
    const shadow = useRef(null)
    const backing = useRef(null)
    const plaqueBacking = useRef(null)
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
            [shadow.current, [0.09, -0.09, -0.116], [0, 0, 0], [3.46, 2.44, 1]],
            [plaqueBacking.current, [0, MUSEUM_ARTWORK_SURFACES.plaqueY, MUSEUM_ARTWORK_SURFACES.plaqueBacking], [0, 0, 0], [1.72, 0.38, MUSEUM_ARTWORK_SURFACES.plaqueBackingDepth]],
            [backing.current, [0, -0.025, MUSEUM_ARTWORK_SURFACES.backing], [0, 0, 0], [3.42, 2.52, MUSEUM_ARTWORK_SURFACES.backingDepth]],
            [frame.current, [0, 0, 0], [0, 0, 0], [3.24, 2.34, 0.14]],
            // The two nested profiles are shared instanced layers, not a set
            // of per-painting rails. They give the frame a convincing stepped
            // silhouette at walking distance for two fixed draw calls.
            [frameProfile.current, [0, 0, 0.085], [0, 0, 0], [3.13, 2.23, 0.075]],
            [mat.current, [0, 0, 0.125], [0, 0, 0], [2.96, 2.06, 0.07]],
            [innerLip.current, [0, 0, MUSEUM_ARTWORK_SURFACES.lip], [0, 0, 0], [2.8, 1.9, MUSEUM_ARTWORK_SURFACES.lipDepth]],
            [glazing.current, [0, 0, MUSEUM_ARTWORK_SURFACES.glass], [0, 0, 0], [2.7, 1.8, 1]],
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
            {!compact && <instancedMesh ref={shadow} args={[undefined, undefined, count]} renderOrder={1}>
                <planeGeometry args={[1, 1]} />
                <meshBasicMaterial
                    color="#120d09"
                    transparent
                    opacity={0.24}
                    depthWrite={false}
                />
            </instancedMesh>}
            {!compact && <instancedMesh ref={plaqueBacking} args={[undefined, undefined, count]}>
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial color="#493826" roughness={0.76} />
            </instancedMesh>}
            <instancedMesh ref={backing} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedBacking} attach="geometry" />
                <meshStandardMaterial color="#392b20" roughness={0.93} />
            </instancedMesh>
            <instancedMesh ref={frame} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedFrame} attach="geometry" />
                <meshPhysicalMaterial
                    {...materials.brass}
                    color={GOLD}
                    roughness={0.34}
                    metalness={0.66}
                    clearcoat={0.25}
                    clearcoatRoughness={0.5}
                />
            </instancedMesh>
            {!compact && <instancedMesh ref={frameProfile} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedFrame} attach="geometry" />
                <meshPhysicalMaterial
                    {...materials.brass}
                    color="#8f6736"
                    roughness={0.3}
                    metalness={0.72}
                    clearcoat={0.32}
                    clearcoatRoughness={0.42}
                />
            </instancedMesh>}
            <instancedMesh ref={mat} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedBacking} attach="geometry" />
                <meshStandardMaterial color="#eee7da" roughness={0.84} />
            </instancedMesh>
            {!compact && <instancedMesh ref={innerLip} args={[undefined, undefined, count]} castShadow receiveShadow>
                <primitive object={roundedFrame} attach="geometry" />
                <meshPhysicalMaterial
                    color="#c49a5c"
                    roughness={0.3}
                    metalness={0.68}
                    clearcoat={0.3}
                    clearcoatRoughness={0.44}
                />
            </instancedMesh>}
            {!compact && <instancedMesh ref={glazing} args={[undefined, undefined, count]} renderOrder={5}>
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
            </instancedMesh>}
        </>
    )
}

function InstancedPictureLights({ paintings }) {
    const canopies = useRef(null)
    const arms = useRef(null)
    const bars = useRef(null)
    const diffusers = useRef(null)

    useEffect(() => {
        const parent = new THREE.Matrix4()
        const local = new THREE.Matrix4()
        const matrix = new THREE.Matrix4()
        const position = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        const scale = new THREE.Vector3()
        const parentRotation = new THREE.Quaternion()
        const paintingScale = new THREE.Vector3()
        const setInstance = (mesh, index, localPosition, localRotation, localScale) => {
            if (!mesh) return
            rotation.setFromEuler(new THREE.Euler(...localRotation))
            local.compose(position.set(...localPosition), rotation, scale.set(...localScale))
            matrix.multiplyMatrices(parent, local)
            mesh.setMatrixAt(index, matrix)
        }
        paintings.forEach((painting, index) => {
            parentRotation.setFromEuler(new THREE.Euler(0, painting.rotationY, 0))
            paintingScale.set(...(painting.scale || [1, 1, 1]))
            parent.compose(position.set(...painting.position), parentRotation, paintingScale)
            setInstance(canopies.current, index, [0, 1.52, 0.085], [0, 0, 0], [1.92, 0.2, 0.12])
            for (const [armIndex, armX] of [-0.82, 0.82].entries()) {
                setInstance(
                    arms.current,
                    (index * 2) + armIndex,
                    [armX, 1.42, 0.3],
                    [0, 0, 0],
                    [0.085, 0.1, 0.42],
                )
            }
            setInstance(bars.current, index, [0, 1.31, 0.52], [0, 0, Math.PI / 2], [1, 1, 1])
            setInstance(diffusers.current, index, [0, 1.245, 0.52], [0, 0, 0], [2.08, 0.065, 0.07])
        })
        for (const mesh of [canopies.current, arms.current, bars.current, diffusers.current]) {
            if (!mesh) continue
            mesh.instanceMatrix.needsUpdate = true
            mesh.computeBoundingSphere?.()
        }
    }, [paintings])

    if (!paintings.length) return null
    return (
        <>
            <instancedMesh ref={canopies} args={[undefined, undefined, paintings.length]} castShadow>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshPhysicalMaterial color="#795831" metalness={0.7} roughness={0.3} clearcoat={0.24} />
            </instancedMesh>
            <instancedMesh ref={arms} args={[undefined, undefined, paintings.length * 2]} castShadow>
                <boxGeometry args={[1, 1, 1]} />
                <meshPhysicalMaterial color="#8f693b" metalness={0.72} roughness={0.28} clearcoat={0.2} />
            </instancedMesh>
            <instancedMesh ref={bars} args={[undefined, undefined, paintings.length]} castShadow>
                <cylinderGeometry args={[0.075, 0.075, 2.25, 12]} />
                <meshPhysicalMaterial color="#a9824d" metalness={0.74} roughness={0.27} clearcoat={0.25} />
            </instancedMesh>
            <instancedMesh ref={diffusers} args={[undefined, undefined, paintings.length]}>
                <boxGeometry args={[1, 1, 1]} />
                <meshBasicMaterial color="#ffd6a1" toneMapped={false} />
            </instancedMesh>
        </>
    )
}

function FixtureSpotLight({ pose, color, intensity, distance, angle, penumbra }) {
    const { scene } = useThree()
    const light = useRef(null)
    const target = useMemo(() => new THREE.Object3D(), [])

    useLayoutEffect(() => {
        target.position.set(...pose.target)
        scene.add(target)
        if (light.current) {
            light.current.target = target
            light.current.position.set(...pose.source)
            light.current.updateMatrixWorld()
            target.updateMatrixWorld()
        }
        requestMuseumFrames(3)
        return () => scene.remove(target)
    }, [pose, scene, target])

    return (
        <spotLight
            ref={light}
            position={pose.source}
            color={color}
            intensity={intensity}
            distance={distance}
            decay={2}
            angle={angle}
            penumbra={penumbra}
            castShadow={false}
        />
    )
}

function RoomCeilingPracticalLights({ fixtureXs, fixtureCeilingY, room, qualityLighting, enabled }) {
    const liveSlots = useMemo(() => {
        const requested = qualityLighting ? 2 : 1
        return Array.from({ length: requested }, (_, slot) => {
            const fixtureIndex = museumArtworkLightIndex(fixtureXs.length, slot, requested)
            const selectedX = fixtureXs[fixtureIndex]
            const x = Number.isFinite(selectedX) ? selectedX : room.centerX
            return {
                enabled: enabled && Number.isFinite(selectedX),
                slot,
                pose: museumCeilingLightPose(x, room.centerZ, fixtureCeilingY),
            }
        })
    }, [enabled, fixtureCeilingY, fixtureXs, qualityLighting, room.centerX, room.centerZ])

    return liveSlots.map(({ enabled: slotEnabled, slot, pose }) => (
        <FixtureSpotLight
            key={`ceiling-practical-${slot}`}
            pose={pose}
            color="#f1cba2"
            intensity={slotEnabled ? (qualityLighting ? 48 : 34) : 0}
            distance={7.2}
            angle={0.74}
            penumbra={0.9}
        />
    ))
}

function BasePainting({ painting, active, priority, onTextureReady, onTexturePending, readinessVersion = 0 }) {
    const [baseFailed, setBaseFailed] = useState(false)
    const markBaseFailed = useCallback(() => setBaseFailed(true), [])
    const baseMaterial = useRef(null)
    const baseTexture = useCoverTexture(
        painting.album,
        active ? BASE_COVER_WIDTH : 0,
        priority,
        markBaseFailed,
    )
    const unavailableTexture = useUnavailableArtworkTexture(painting.album.title, baseFailed)
    const displayedBaseTexture = baseTexture || (baseFailed ? unavailableTexture : null)
    const reportedReadiness = useRef(null)

    useLayoutEffect(() => {
        const readinessKey = `${painting.id}:${readinessVersion}`
        if (!active || !displayedBaseTexture) {
            reportedReadiness.current = null
            onTexturePending?.(painting.id)
            return
        }
        if (reportedReadiness.current === readinessKey) return
        reportedReadiness.current = readinessKey
        onTextureReady?.(painting.id)
    }, [active, displayedBaseTexture, onTexturePending, onTextureReady, painting.id, readinessVersion])
    useLayoutEffect(() => {
        if (!displayedBaseTexture || !baseMaterial.current) return
        // The merged blurhash/colour placeholder remains directly behind every
        // frame, so a late compact cover can resolve as a short photographic
        // sharpen instead of visibly popping onto the wall.
        baseMaterial.current.opacity = 0
        requestMuseumFrames(3)
    }, [displayedBaseTexture])
    useFrame((_, delta) => {
        if (!displayedBaseTexture || !baseMaterial.current || baseMaterial.current.opacity >= 1) return
        baseMaterial.current.opacity = Math.min(
            1,
            baseMaterial.current.opacity + (Math.min(delta, 0.05) * 4),
        )
        requestMuseumFrames(2)
    })

    return (
        <group
            visible={Boolean(displayedBaseTexture)}
            position={painting.position}
            rotation={[0, painting.rotationY, 0]}
            scale={painting.scale || [1, 1, 1]}
        >
            <mesh visible={Boolean(displayedBaseTexture)} position={[0, 0, MUSEUM_ARTWORK_SURFACES.base]} renderOrder={3}>
                <primitive object={MUSEUM_ARTWORK_PLANE_GEOMETRY} attach="geometry" />
                <meshBasicMaterial
                    ref={baseMaterial}
                    map={displayedBaseTexture}
                    color="#ffffff"
                    toneMapped={false}
                    transparent
                    depthWrite={false}
                    opacity={0}
                />
            </mesh>
        </group>
    )
}

function prepareMuseumArtworkMaterial(shader, blendUniforms) {
    Object.assign(shader.uniforms, blendUniforms)
    shader.fragmentShader = `uniform sampler2D museumPreviousMap;
uniform float museumDetailBlend;
${shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
// One draw for every tier. The extra sample runs only during the transition.
if (museumDetailBlend < 1.0) {
    vec3 previousColor = texture2D(museumPreviousMap, vMapUv).rgb;
    diffuseColor.rgb = mix(previousColor, diffuseColor.rgb, museumDetailBlend);
}`)}`
}

function MuseumArtworkShaderWarmup() {
    const texture = useMemo(() => {
        const pixel = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
        pixel.colorSpace = THREE.SRGBColorSpace
        pixel.needsUpdate = true
        return pixel
    }, [])
    const uniforms = useMemo(() => ({
        museumPreviousMap: { value: texture },
        museumDetailBlend: { value: 1 },
    }), [texture])
    const prepareMaterial = useCallback(shader => prepareMuseumArtworkMaterial(shader, uniforms), [uniforms])
    useEffect(() => () => texture.dispose(), [texture])
    // Three.compile traverses hidden meshes. Holding this one material for the
    // scene lifetime keeps its program cached after the opaque startup veil,
    // so the first photograph promotion never compiles a new visible program.
    return (
        <mesh visible={false}>
            <primitive object={MUSEUM_ARTWORK_PLANE_GEOMETRY} attach="geometry" />
            <meshBasicMaterial
                map={texture}
                onBeforeCompile={prepareMaterial}
                customProgramCacheKey={() => 'museum-artwork-blend-v1'}
                color="#ffffff"
                toneMapped={false}
                transparent
                depthWrite={false}
                opacity={0}
            />
        </mesh>
    )
}

function DetailPainting({ painting, targetWidth }) {
    const { gl } = useThree()
    const [preparedWidth, setPreparedWidth] = useState(() => (
        [targetWidth, NEAR_COVER_WIDTH].find(width => {
            const texture = cachedCoverTexture(painting.album, width)
            return texture && coverTextureWasUploaded(gl, texture)
        }) || 0
    ))
    const requestWidth = museumArtworkRequestWidth(targetWidth, preparedWidth)
    // Foreground detail outranks speculative archive bases only while idle.
    // Load eligibility uses width independently, so this priority cannot let a
    // larger decode or GPU upload slip onto a navigation frame.
    const detailTexture = useCoverTexture(painting.album, requestWidth, 9700 + (requestWidth / 10))
    const detailMaterial = useRef(null)
    const transition = useRef({ displayed: null, previous: null, elapsed: MUSEUM_DETAIL_BLEND_SECONDS, revealElapsed: 0 })
    const blendUniforms = useMemo(() => ({
        museumPreviousMap: { value: null },
        museumDetailBlend: { value: 1 },
    }), [])
    const prepareMaterial = useCallback(shader => prepareMuseumArtworkMaterial(shader, blendUniforms), [blendUniforms])
    const loadedWidth = Number(detailTexture?.userData?.museumTargetWidth) || 0
    const displayTexture = loadedWidth > BASE_COVER_WIDTH ? detailTexture : null

    useEffect(() => {
        if (loadedWidth <= preparedWidth) return undefined
        return scheduleMuseumVisibleTask(() => setPreparedWidth(loadedWidth), 0)
    }, [loadedWidth, preparedWidth])
    useLayoutEffect(() => {
        if (!displayTexture || !detailMaterial.current) return
        const current = transition.current
        if (current.displayed === displayTexture) return
        if (current.previous) unpinCoverTexture(current.previous)
        // Hold the actual previous tier until its blend completes. The hook
        // releases its reference when a new texture attaches; this short lease
        // prevents cache eviction from turning the old sampler black mid-fade.
        current.previous = current.displayed?.userData.museumDisposed ? null : current.displayed
        if (current.previous) pinCoverTexture(current.previous)
        blendUniforms.museumPreviousMap.value = current.previous || displayTexture
        blendUniforms.museumDetailBlend.value = current.previous ? 0 : 1
        // Keep the first reveal progressing if a cached sharp texture arrives
        // mid-reveal; promoting it must not suddenly make the layer opaque.
        current.displayed = displayTexture
        current.elapsed = 0
        requestMuseumFrames(3)
    }, [blendUniforms, displayTexture])
    useEffect(() => () => {
        const current = transition.current
        if (current.previous) unpinCoverTexture(current.previous)
        current.previous = null
        blendUniforms.museumPreviousMap.value = null
    }, [blendUniforms])
    useEffect(() => {
        if (!import.meta.env.DEV || !displayTexture) return undefined
        const current = JSON.parse(document.documentElement.dataset.museumDetailTextures || '{}')
        current[painting.id] = {
            targetWidth,
            sourceWidth: Number(displayTexture.image?.width || displayTexture.image?.naturalWidth || 0),
            sourceHeight: Number(displayTexture.image?.height || displayTexture.image?.naturalHeight || 0),
        }
        document.documentElement.dataset.museumDetailTextures = JSON.stringify(current)
        return () => {
            const latest = JSON.parse(document.documentElement.dataset.museumDetailTextures || '{}')
            if (latest[painting.id]?.targetWidth === targetWidth) delete latest[painting.id]
            document.documentElement.dataset.museumDetailTextures = JSON.stringify(latest)
        }
    }, [displayTexture, painting.id, targetWidth])
    useFrame((_, delta) => {
        const current = transition.current
        if (!displayTexture || !detailMaterial.current || current.elapsed >= MUSEUM_DETAIL_BLEND_SECONDS) return
        const progress = museumArtworkTransitionProgress(current.elapsed, current.revealElapsed, delta)
        current.elapsed = progress.elapsed
        current.revealElapsed = progress.revealElapsed
        detailMaterial.current.opacity = progress.opacity
        const blend = progress.blend
        if (current.previous) blendUniforms.museumDetailBlend.value = blend
        if (blend >= 1 && current.previous) {
            unpinCoverTexture(current.previous)
            current.previous = null
            blendUniforms.museumPreviousMap.value = current.displayed
        }
        requestMuseumFrames(2)
    })

    if (!displayTexture) return null
    return (
        <group
            position={painting.position}
            rotation={[0, painting.rotationY, 0]}
            scale={painting.scale || [1, 1, 1]}
        >
            <mesh position={[0, 0, MUSEUM_ARTWORK_SURFACES.detail]} renderOrder={4}>
                <primitive object={MUSEUM_ARTWORK_PLANE_GEOMETRY} attach="geometry" />
                <meshBasicMaterial
                    ref={detailMaterial}
                    map={displayTexture}
                    onBeforeCompile={prepareMaterial}
                    customProgramCacheKey={() => 'museum-artwork-blend-v1'}
                    color="#ffffff"
                    toneMapped={false}
                    transparent
                    depthWrite={false}
                    opacity={0}
                />
            </mesh>
        </group>
    )
}

function CameraAwareRoomPaintings({ room, paintings = room.paintings, active, foreground, allowDetail, inspectionWidth, onTexturePending, onTextureReady, readinessVersion }) {
    const { camera } = useThree()
    const [detailSelection, setDetailSelection] = useState([])
    const detailSelectionRef = useRef([])
    const selectionKey = useRef('')
    const detailFocus = useRef({ candidateId: null, since: 0, inspectionId: null })
    const lastProbe = useRef(-1)
    const projection = useMemo(() => new THREE.Matrix4(), [])
    const frustum = useMemo(() => new THREE.Frustum(), [])
    const sphere = useMemo(() => new THREE.Sphere(new THREE.Vector3(), 2.5), [])
    const viewDirection = useMemo(() => new THREE.Vector3(), [])
    const toPainting = useMemo(() => new THREE.Vector3(), [])

    useEffect(() => {
        detailFocus.current = { candidateId: null, since: 0, inspectionId: null }
        if (active && foreground && allowDetail) return undefined
        return scheduleMuseumVisibleTask(() => {
            selectionKey.current = ''
            detailSelectionRef.current = []
            setDetailSelection([])
        }, 0)
    }, [active, allowDetail, foreground])
    useEffect(() => {
        if (!import.meta.env.DEV) return
        const current = JSON.parse(document.documentElement.dataset.museumSelections || '{}')
        current[room.id] = {
            active,
            baseCount: active ? paintings.length : 0,
            detailCount: detailSelection.length,
            detailWidths: detailSelection.map(item => item.targetWidth),
            ids: detailSelection.map(item => item.painting.id),
        }
        document.documentElement.dataset.museumSelections = JSON.stringify(current)
    }, [active, detailSelection, paintings.length, room.id])

    useFrame((state) => {
        if (!active || !foreground || !allowDetail) return
        if (state.clock.elapsedTime - lastProbe.current < 0.16) return
        lastProbe.current = state.clock.elapsedTime
        camera.updateMatrixWorld()
        projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        frustum.setFromProjectionMatrix(projection)
        camera.getWorldDirection(viewDirection)

        const candidates = museumArtworkPreviewCandidates(paintings.map((painting) => {
            sphere.center.set(...painting.position)
            toPainting.copy(sphere.center).sub(camera.position)
            const distance = toPainting.length()
            const facing = distance > 0 ? viewDirection.dot(toPainting.multiplyScalar(1 / distance)) : 1
            const visible = frustum.intersectsSphere(sphere) && facing > -0.12
            return { painting, distance, facing, visible }
        }), new Set(detailSelectionRef.current.map(item => item.painting.id)))

        const focusCandidate = candidates.find(({ distance, facing, visible }) => (
            visible && distance < 5.2 && facing > 0.68
        ))
        const focus = detailFocus.current
        if (focusCandidate?.painting.id !== focus.candidateId) {
            focus.candidateId = focusCandidate?.painting.id || null
            focus.since = state.clock.elapsedTime
        }
        if (focusCandidate && state.clock.elapsedTime - focus.since >= 0.48) {
            focus.inspectionId = focusCandidate.painting.id
        }
        const retainedInspection = candidates.find(({ painting, distance, facing }) => (
            painting.id === focus.inspectionId && distance <= 6.2 && facing > 0.5
        ))
        if (!retainedInspection) {
            focus.inspectionId = null
        }
        const currentWidths = new Map(detailSelectionRef.current.map(item => [
            item.painting.id,
            item.targetWidth,
        ]))
        const ranked = candidates
            .map(({ painting, distance }) => ({
                painting,
                targetWidth: museumArtworkDetailWidth(distance, {
                    focused: painting.id === focus.inspectionId,
                    currentWidth: currentWidths.get(painting.id) || 0,
                    inspectionWidth,
                }),
            }))
            .filter(item => item.targetWidth >= NEAR_COVER_WIDTH)
        const next = [
            ...ranked.filter(item => item.painting.id === focus.inspectionId),
            ...ranked.filter(item => item.painting.id !== focus.inspectionId),
        ]
            .slice(0, MAX_NEAR_COVERS)
            .sort((left, right) => paintings.indexOf(left.painting) - paintings.indexOf(right.painting))
        const nextKey = next.map(item => `${item.painting.id}:${item.targetWidth}`).join('|')
        if (nextKey === selectionKey.current) return
        selectionKey.current = nextKey
        detailSelectionRef.current = next
        setDetailSelection(next)
    })

    return (
        <>
            {paintings.map((painting) => {
                const paintingIndex = paintings.indexOf(painting)
                return (
                    <BasePainting
                        key={painting.id}
                        painting={painting}
                        active={active}
                        priority={10000 + (paintings.length - paintingIndex)}
                        onTextureReady={onTextureReady}
                        onTexturePending={onTexturePending}
                        readinessVersion={readinessVersion}
                    />
                )
            })}
            {detailSelection.map(({ painting, targetWidth }) => (
                <DetailPainting
                    key={`detail-${painting.id}`}
                    painting={painting}
                    targetWidth={targetWidth}
                />
            ))}
        </>
    )
}

function RoomWallpaperSurfaces({ room, paintings = room.paintings, shellCenterX, shellDepth, ceilingY, materials, wallThickness, color = '#d8cab8' }) {
    const outerRotationY = room.side < 0 ? Math.PI / 2 : -Math.PI / 2
    const roomPhase = useMemo(() => (
        [...room.id].reduce((total, character) => total + character.charCodeAt(0), 0) % 17
    ) / 17, [room.id])
    const pictureLightCoordinates = useMemo(() => Object.fromEntries(
        [-1, 1].map(direction => [direction, paintings
            .filter(painting => Math.sign(painting.normal?.[2] || 1) === -direction)
            .map(painting => painting.position[0] - shellCenterX)]),
    ), [paintings, shellCenterX])
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
        const springHeight = MUSEUM_PORTAL.springHeight
        const archRise = MUSEUM_PORTAL.rise
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

function makePortalCurtainGeometry() {
    // Sample each full fold at multiple vertices. Fourteen segments landed the
    // dominant sine wave exactly on its zero crossings and flattened the cloth
    // back into the two rectangles this treatment was meant to replace.
    const geometry = new THREE.PlaneGeometry(1, 1, 42, 16)
    const positions = geometry.getAttribute('position')
    const vertex = new THREE.Vector3()
    for (let index = 0; index < positions.count; index += 1) {
        vertex.fromBufferAttribute(positions, index)
        const normalizedX = vertex.x + 0.5
        const fold = (
            Math.sin(normalizedX * Math.PI * 14) * 0.042
            + Math.sin(normalizedX * Math.PI * 7) * 0.018
        )
        const scallop = vertex.y < -0.49
            ? (0.018 + (Math.cos(normalizedX * Math.PI * 8) * 0.018))
            : 0
        positions.setXYZ(index, vertex.x, vertex.y + scallop, fold)
    }
    positions.needsUpdate = true
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
}

function DoorWall({ side, centerZ, room, materials, sconcePlacements = EMPTY_FIXTURES }) {
    const wallX = side * MUSEUM_DIMENSIONS.hallHalfWidth
    const thickness = HALL_WALL_THICKNESS
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    const spandrelShape = useArchSpandrelShape()
    const doorwayPose = museumDoorAssemblyPose(side, centerZ)
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
                            side * (MUSEUM_DIMENSIONS.hallHalfWidth + (thickness / 2)),
                            0,
                            centerZ,
                        ]}
                        rotation={[0, rotationY, 0]}
                    >
                        <extrudeGeometry args={[spandrelShape, {
                            depth: thickness,
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
                    <group position={doorwayPose.trim} rotation={[0, rotationY, 0]}>
                        <mesh geometry={PORTAL_ARCH_STONE_GEOMETRY} castShadow receiveShadow>
                            <PlasterMaterial materials={materials} color="#b8aa96" textured={false} />
                        </mesh>
                        <mesh position={[0, 0, MUSEUM_PORTAL.depth]} geometry={PORTAL_ARCH_REVEAL_GEOMETRY}>
                            <meshPhysicalMaterial color="#927044" metalness={0.4} roughness={0.42} />
                        </mesh>
                        {[-1, 1].map(direction => (
                            <group key={direction} position={[direction * (archRadius + MUSEUM_PORTAL.bandWidth / 2), 0, MUSEUM_PORTAL.depth / 2]}>
                                {/* Bases and capitals meet at shared elevations. The
                                    arch starts exactly at the capital's top face. */}
                                {MUSEUM_PORTAL.pierSections.map(section => (
                                    <mesh key={section.name} position={[0, section.y, 0]} scale={[section.width, section.height, section.depth]} castShadow receiveShadow>
                                        <boxGeometry args={[1, 1, 1]} />
                                        <meshStandardMaterial color={section.color} roughness={0.72} />
                                    </mesh>
                                ))}
                                <mesh position={[0, 1.38, MUSEUM_PORTAL.depth / 2 + 0.004]} scale={[0.045, 2.02, 0.012]}>
                                    <boxGeometry args={[1, 1, 1]} />
                                    <meshPhysicalMaterial color="#927044" metalness={0.4} roughness={0.42} />
                                </mesh>
                            </group>
                        ))}
                    </group>
                    <CategoryDoorSign room={room} side={side} centerZ={centerZ} materials={materials} />
                </>
            )}
        </group>
    )
}

function FarDoorWall({ side, centerZ, materials, sconcePlacements = EMPTY_FIXTURES }) {
    const wallX = side * MUSEUM_DIMENSIONS.hallHalfWidth

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
        </group>
    )
}

function DistanceManagedDoorWall({ side, centerZ, room, materials, sconcePlacements = EMPTY_FIXTURES }) {
    if (!room) return <FarDoorWall side={side} centerZ={centerZ} materials={materials} sconcePlacements={sconcePlacements} />
    return <DoorWall side={side} centerZ={centerZ} room={room} materials={materials} sconcePlacements={sconcePlacements} />
}

function AnimatedPortalGate({ roomId, side, centerZ, open, onPassabilityChange, onClosedChange }) {
    const leftPanel = useRef(null)
    const rightPanel = useRef(null)
    const progress = useRef(open ? 1 : 0)
    const passable = useRef(false)
    const closed = useRef(!open)
    const rotationY = side < 0 ? Math.PI / 2 : -Math.PI / 2
    const panelWidth = (MUSEUM_DIMENSIONS.doorwayWidth / 2) + 0.1
    const closedOffset = (panelWidth / 2) - 0.025
    const bunchedScale = 0.17
    const openOffset = (MUSEUM_DIMENSIONS.doorwayWidth / 2) - ((panelWidth * bunchedScale) / 2) - 0.1

    const reportPassability = useCallback((value) => {
        if (passable.current === value) return
        passable.current = value
        onPassabilityChange?.(roomId, value)
    }, [onPassabilityChange, roomId])
    const reportClosed = useCallback((value) => {
        if (closed.current === value) return
        closed.current = value
        onClosedChange?.(roomId, value)
    }, [onClosedChange, roomId])
    useLayoutEffect(() => {
        onClosedChange?.(roomId, progress.current === 0)
    }, [onClosedChange, roomId])
    useEffect(() => {
        if (!open) reportPassability(false)
        else reportClosed(false)
        requestMuseumFrames(4)
    }, [open, reportClosed, reportPassability])
    useEffect(() => () => onPassabilityChange?.(roomId, false), [onPassabilityChange, roomId])
    useFrame((_, frameDelta) => {
        const target = open ? 1 : 0
        if (progress.current === target) {
            reportPassability(open && progress.current >= 0.9)
            reportClosed(!open && progress.current === 0)
            return
        }
        progress.current = THREE.MathUtils.damp(
            progress.current,
            target,
            open ? 4.8 : 7.5,
            Math.min(frameDelta, 0.05),
        )
        if (Math.abs(progress.current - target) < 0.001) progress.current = target
        else requestMuseumFrames(2)
        const eased = progress.current * progress.current * (3 - (2 * progress.current))
        for (const [panel, direction] of [[leftPanel.current, -1], [rightPanel.current, 1]]) {
            if (!panel) continue
            panel.position.x = direction * THREE.MathUtils.lerp(closedOffset, openOffset, eased)
            panel.scale.x = THREE.MathUtils.lerp(1, bunchedScale, eased)
        }
        reportPassability(open && progress.current >= 0.9)
        reportClosed(!open && progress.current === 0)
    })

    const renderPanel = (direction, ref) => (
        <group ref={ref} position={[direction * closedOffset, 2.075, 0]}>
            <mesh geometry={PORTAL_CURTAIN_GEOMETRY} scale={[panelWidth, 4.16, 1]} receiveShadow>
                <meshPhysicalMaterial
                    color="#4a1d2b"
                    roughness={0.82}
                    metalness={0.01}
                    sheen={0.72}
                    sheenColor="#8d5261"
                    sheenRoughness={0.68}
                    side={THREE.DoubleSide}
                />
            </mesh>
            <mesh position={[-direction * ((panelWidth / 2) - 0.045), 0, 0.07]} scale={[0.045, 4.08, 0.055]}>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshPhysicalMaterial color="#a7804e" metalness={0.62} roughness={0.38} />
            </mesh>
            <mesh position={[0, -2.015, 0.075]} scale={[panelWidth - 0.08, 0.055, 0.05]}>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshPhysicalMaterial color="#87643a" metalness={0.52} roughness={0.44} />
            </mesh>
        </group>
    )

    return (
        <group
            position={[
                side * (MUSEUM_DIMENSIONS.hallHalfWidth + (HALL_WALL_THICKNESS / 2) + 0.09),
                0,
                centerZ,
            ]}
            rotation={[0, rotationY, 0]}
        >
            <mesh position={[0, 4.2, -0.01]} scale={[MUSEUM_DIMENSIONS.doorwayWidth + 0.22, 0.16, 0.18]} castShadow>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshPhysicalMaterial color="#765630" metalness={0.58} roughness={0.38} />
            </mesh>
            {renderPanel(-1, leftPanel)}
            {renderPanel(1, rightPanel)}
        </group>
    )
}

function VaultedCeiling({ layout, centerZ, materials, fixtures }) {
    const { geometry, ribCurve } = useMemo(() => {
        const radius = MUSEUM_VAULT.radius
        const start = Math.acos(MUSEUM_DIMENSIONS.hallHalfWidth / radius)
        const end = Math.PI - start
        const count = 24
        const frontZ = centerZ + (layout.hallLength / 2)
        // Stop the vault just in front of the terminal wall. Ending on the
        // exact same plane produced the striped/hatched z-fighting visible at
        // the back of the corridor.
        const backZ = centerZ - (layout.hallLength / 2) + 0.14
        const positions = []
        const uvs = []
        const colors = []
        const indices = []
        const depthSegments = Math.min(96, Math.max(8, Math.ceil(layout.hallLength / 1.8)))
        for (let row = 0; row <= depthSegments; row += 1) {
            const z = frontZ + (backZ - frontZ) * row / depthSegments
            for (let index = 0; index <= count; index += 1) {
                const ratio = index / count
                const angle = start + (ratio * (end - start))
                const x = radius * Math.cos(angle)
                positions.push(x, museumVaultHeightAt(x), z)
                colors.push(...sampleBakedVaultIrradiance({ x, z, halfWidth: MUSEUM_DIMENSIONS.hallHalfWidth, fixtures }))
                uvs.push(ratio, row / depthSegments)
                if (row < depthSegments && index < count) {
                    const current = row * (count + 1) + index
                    const next = current + count + 1
                    indices.push(current, current + 1, next, current + 1, next + 1, next)
                }
            }
        }
        const shell = new THREE.BufferGeometry()
        shell.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        shell.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
        shell.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
        shell.setIndex(indices)
        shell.computeVertexNormals()
        const points = Array.from({ length: 29 }, (_, index) => {
            const angle = start + ((index / 28) * (end - start))
            const x = radius * Math.cos(angle)
            return new THREE.Vector3(x, museumVaultHeightAt(x), 0)
        })
        return {
            geometry: shell,
            ribCurve: new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5),
        }
    }, [centerZ, fixtures, layout.hallLength])
    useEffect(() => () => geometry.dispose(), [geometry])
    const ribZs = useMemo(() => {
        const values = [MUSEUM_DIMENSIONS.lobbyFrontZ - 0.3]
        for (let z = MUSEUM_DIMENSIONS.firstBayZ + (MUSEUM_DIMENSIONS.baySpacing / 2); z > layout.hallBackZ; z -= MUSEUM_DIMENSIONS.baySpacing) {
            values.push(z)
        }
        values.push(layout.hallBackZ + 0.3)
        return values
    }, [layout.hallBackZ])
    const ribs = useRef(null)
    const ribGeometry = useMemo(() => new THREE.TubeGeometry(ribCurve, 30, MUSEUM_VAULT.ribRadius, 6, false), [ribCurve])
    useEffect(() => () => ribGeometry.dispose(), [ribGeometry])
    useLayoutEffect(() => {
        const matrix = new THREE.Matrix4()
        ribZs.forEach((z, index) => ribs.current.setMatrixAt(index, matrix.makeTranslation(0, 0, z)))
        ribs.current.instanceMatrix.needsUpdate = true
        ribs.current.computeBoundingSphere()
    }, [ribZs])

    return (
        <group>
            <mesh geometry={geometry} receiveShadow>
                <CeilingMaterial materials={materials} hallLength={layout.hallLength} />
            </mesh>
            <instancedMesh ref={ribs} args={[ribGeometry, undefined, ribZs.length]}>
                <meshStandardMaterial color="#b9ab97" roughness={0.7} />
            </instancedMesh>
            {[-1, 1].map(side => (
                <mesh key={side} position={[side * (MUSEUM_DIMENSIONS.hallHalfWidth - 0.06), MUSEUM_VAULT.corniceY, centerZ + 0.14]} scale={[0.16, 0.22, Math.max(1, layout.hallLength - 0.28)]}>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <meshStandardMaterial color="#b8aa95" roughness={0.72} />
                </mesh>
            ))}
        </group>
    )
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

function CategoryRoom({ room, active, gateRequested, detailed, materials, inspectionWidth, onGatePassabilityChange }) {
    const roomWidth = room.width
    const outerWallX = room.outerX
    const wallThickness = MUSEUM_DIMENSIONS.roomWallThickness
    const ceilingY = MUSEUM_DIMENSIONS.roomCeilingY
    const ceilingFixtureY = MUSEUM_DIMENSIONS.roomFixtureY
    const lightXs = useMemo(() => museumRoomCeilingFixtureXs(room, 4), [room])
    const endPlacardPose = useMemo(() => museumEndWallPlacardPose(room), [room])
    const { depth: shellDepth, centerX: shellCenterX } = museumRoomShell(room)
    const runnerMaps = useMemo(() => Object.fromEntries(
        Object.entries(materials.fabric).map(([name, texture]) => [name, configureTexture(texture, {
            repeat: [Math.max(1, shellDepth - 0.48) / MUSEUM_MATERIAL_TILE_METERS.fabric, 2.5 / MUSEUM_MATERIAL_TILE_METERS.fabric],
        })]),
    ), [materials.fabric, shellDepth])
    useEffect(() => () => Object.values(runnerMaps).forEach(texture => texture.dispose()), [runnerMaps])
    const ribXs = useMemo(() => museumRoomRibXs(room), [room])
    const roomFloorFixtures = useMemo(
        () => lightXs.map(x => Number((x - room.centerX).toFixed(3))),
        [lightXs, room.centerX],
    )
    const roomFloorOccluders = useMemo(() => [
        ...room.benches.map(item => bakedFloorOccluder(item, room.centerX, room.centerZ, 0.14)),
        ...room.plants.map(item => bakedFloorOccluder(item, room.centerX, room.centerZ, 0.075)),
        ...(room.displays || EMPTY_FIXTURES).map(item => bakedFloorOccluder(item, room.centerX, room.centerZ, 0.15)),
    ], [room.benches, room.centerX, room.centerZ, room.displays, room.plants])
    const thresholdDepth = ROOM_SHELL_INSET + HALL_WALL_THICKNESS + 0.18
    const thresholdCenterX = room.innerX + (room.side * ((ROOM_SHELL_INSET - HALL_WALL_THICKNESS) / 2))
    const roomPaintingIds = useMemo(
        () => new Set(room.paintings.map(painting => painting.id)),
        [room.paintings],
    )
    const readinessResetId = room.paintings[0]?.id
    const readinessRef = useRef({ active: false, ids: new Set() })
    const baseReadyRef = useRef(false)
    const [baseReady, setBaseReady] = useState(false)
    const readinessVersion = active ? 1 : 0
    const [allowDetail, setAllowDetail] = useState(false)
    const [gateClosed, setGateClosed] = useState(true)
    const handleGateClosedChange = useCallback((roomId, value) => {
        if (roomId === room.id) setGateClosed(value)
    }, [room.id])
    // Door architecture and the room shell must change in the same React
    // commit. Deferring residency through a timer let the open portal render
    // for one frame before its interior, which read as a black flash at the
    // threshold on fast machines and as an empty room on slower ones.
    // Fully inactive interiors stay behind an opaque physical gate and do not
    // enter the render list. A retiring room remains furnished only through
    // its short closing interval, preventing an empty doorway without paying
    // the long-session cost of rendering every concealed room.
    const interiorResident = retainMuseumRoomPresentation(active, gateClosed)
    const baseReadyCount = baseReady ? roomPaintingIds.size : 0
    const roomReady = active && baseReady
    const gateOpen = museumRoomGateOpen({ active, requested: gateRequested })
    const publishBaseReady = useCallback((nextReady) => {
        if (baseReadyRef.current === nextReady) return
        baseReadyRef.current = nextReady
        setBaseReady(nextReady)
    }, [])
    const resetPaintingReadiness = useCallback(() => {
        const current = readinessRef.current
        if (!current.active && current.ids.size === 0 && !baseReadyRef.current) return
        readinessRef.current = { active: false, ids: new Set() }
        publishBaseReady(false)
    }, [publishBaseReady])
    const markPaintingReady = useCallback((paintingId) => {
        if (!active) {
            if (paintingId === readinessResetId) resetPaintingReadiness()
            return
        }
        if (!roomPaintingIds.has(paintingId)) return
        let current = readinessRef.current
        if (!current.active) {
            current = { active: true, ids: new Set() }
            readinessRef.current = current
        }
        if (current.ids.has(paintingId)) return
        // The set belongs exclusively to this room readiness cycle. Mutating it
        // avoids cloning and rerendering the entire room once for every cover;
        // React only needs the single transition when all base covers are ready.
        current.ids.add(paintingId)
        if (current.ids.size >= roomPaintingIds.size) publishBaseReady(true)
    }, [active, publishBaseReady, readinessResetId, resetPaintingReadiness, roomPaintingIds])
    const markPaintingPending = useCallback((paintingId) => {
        if (!active) {
            if (paintingId === readinessResetId) resetPaintingReadiness()
            return
        }
        let current = readinessRef.current
        if (!current.active) {
            current = { active: true, ids: new Set() }
            readinessRef.current = current
        }
        if (current.ids.delete(paintingId) || baseReadyRef.current) publishBaseReady(false)
    }, [active, publishBaseReady, readinessResetId, resetPaintingReadiness])
    useEffect(() => {
        if (!import.meta.env.DEV) return
        const current = JSON.parse(document.documentElement.dataset.museumRooms || '{}')
        current[room.id] = {
            active,
            gateRequested,
            gateOpen,
            interiorVisible: interiorResident,
            roomReady,
            baseReady: baseReadyCount,
            required: roomPaintingIds.size,
        }
        document.documentElement.dataset.museumRooms = JSON.stringify(current)
    }, [active, baseReadyCount, gateOpen, gateRequested, interiorResident, room.id, roomPaintingIds.size, roomReady])
    useEffect(() => {
        if (!active || !detailed) {
            return scheduleMuseumVisibleTask(() => setAllowDetail(false), 0)
        }
        // Queue medium previews during the approach instead of waiting for the
        // visitor to stand inside. The shared decoder/upload queues still hold
        // every larger texture until navigation input has settled.
        return scheduleMuseumVisibleTask(() => setAllowDetail(true), 120)
    }, [active, detailed])
    const roomVariant = useMemo(() => (
        [...room.id].reduce((total, character) => total + character.charCodeAt(0), 0) % 4
    ), [room.id])
    const roomTint = ['#d8cab8', '#c9cbbd', '#d3c2bb', '#c7bdaf'][roomVariant]
    const roomInteriorUserData = useMemo(() => ({ museumRoomInterior: room.id }), [room.id])
    // Every static batch is authored once during initial scene construction.
    // Activating a large room then changes visibility and starts compact cover
    // work instead of synchronously rebuilding walls, frames, plaques, lights,
    // and placeholder atlases on the visitor's movement frame.
    const presentationPaintings = room.paintings
    return (
        <group>
            <group>
                <mesh position={[thresholdCenterX, -0.02, room.centerZ]} scale={[thresholdDepth, 0.16, MUSEUM_DIMENSIONS.doorwayWidth - 0.18]} receiveShadow>
                    <primitive object={THRESHOLD_FLOOR_GEOMETRY} attach="geometry" />
                    <FloorMaterial materials={materials} color="#a18a73" width={thresholdDepth} depth={MUSEUM_DIMENSIONS.doorwayWidth - 0.18} centerX={thresholdCenterX} centerZ={room.centerZ} />
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
            {/* Static presentation remains constructed but leaves the render
                list while concealed. A retiring room stays visible until its
                physical curtain is fully closed. */}
            <group visible={interiorResident} userData={roomInteriorUserData}>
                <BakedIrradianceFloor
                    position={[room.centerX, -0.11, room.centerZ]}
                    size={[room.depth, roomWidth]}
                    materials={materials}
                    color="#a18a73"
                    fixtures={roomFloorFixtures}
                    occluders={roomFloorOccluders}
                />
            <mesh position={[shellCenterX, 0.012, room.centerZ]} scale={[Math.max(1, shellDepth - 0.48), 0.028, 2.5]} receiveShadow>
                <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                <meshStandardMaterial {...runnerMaps} normalScale={[0.26, 0.26]} color="#471f2a" roughness={0.96} />
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
            <MuseumRoomArchitecture room={room} shellCenterX={shellCenterX} shellDepth={shellDepth} ribXs={ribXs} />
            <MuseumCofferedCeiling room={room} shellCenterX={shellCenterX} shellDepth={shellDepth} />
            <mesh position={[outerWallX, ceilingY / 2, room.centerZ]}>
                <boxGeometry args={[wallThickness, ceilingY, roomWidth]} />
                <PlasterMaterial materials={materials} color={ROOM_PAINT} />
            </mesh>
            <RoomWallpaperSurfaces
                room={room}
                paintings={presentationPaintings}
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
            <group position={endPlacardPose.backing}>
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
                position={endPlacardPose.label}
                rotation={[0, endPlacardPose.rotationY, 0]}
                size={[4.25, 0.94]}
            />
            <GalleryFrameShells
                paintings={presentationPaintings}
                materials={materials}
            />
            <RoomPlaqueBatch paintings={presentationPaintings} />
            <RoomPlaceholderBatch paintings={presentationPaintings} />
            <InstancedPictureLights paintings={presentationPaintings} />
            <CameraAwareRoomPaintings
                room={room}
                paintings={presentationPaintings}
                active={interiorResident}
                foreground={detailed}
                allowDetail={allowDetail}
                inspectionWidth={inspectionWidth}
                onTexturePending={markPaintingPending}
                onTextureReady={markPaintingReady}
                readinessVersion={readinessVersion}
            />
            <InstancedCeilingFixtures
                positions={lightXs.map(x => [x, room.centerZ])}
                ceilingY={ceilingFixtureY}
            />
            </group>
            <AnimatedPortalGate
                roomId={room.id}
                side={room.side}
                centerZ={room.centerZ}
                open={gateOpen}
                onPassabilityChange={onGatePassabilityChange}
                onClosedChange={handleGateClosedChange}
            />
        </group>
    )
}

function MainHall({ layout, activeRoomId, activeRoomIds, materials, reflectionsEnabled, shadowsEnabled, inspectionWidth, onGatePassabilityChange }) {
    const hallCenterZ = (MUSEUM_DIMENSIONS.lobbyFrontZ + layout.hallBackZ) / 2
    const bayCount = Math.max(1, Math.ceil(layout.rooms.length / 2))
    const bays = useMemo(() => Array.from({ length: bayCount }, (_, index) => ({
        centerZ: MUSEUM_DIMENSIONS.firstBayZ - (index * MUSEUM_DIMENSIONS.baySpacing),
        left: layout.rooms.find(room => room.bay === index && room.side === -1),
        right: layout.rooms.find(room => room.bay === index && room.side === 1),
    })), [bayCount, layout.rooms])
    const activeRoomList = useMemo(() => {
        const roomById = new Map(layout.rooms.map(room => [room.id, room]))
        return [...new Set([activeRoomId, ...(activeRoomIds || [])].filter(Boolean))]
            .map(id => roomById.get(id))
            .filter(Boolean)
            // Prepare both doors in the current bay. Only activeRoomId is
            // allowed to request its curtain; the paired room remains ready
            // and closed until the visitor actually approaches it.
            .slice(0, 2)
    }, [activeRoomId, activeRoomIds, layout.rooms])
    const residentRooms = useMemo(
        () => new Set(activeRoomList.map(room => room.id)),
        [activeRoomList],
    )
    const detailedRoom = useMemo(
        () => layout.rooms.find(room => room.id === activeRoomId) || null,
        [activeRoomId, layout.rooms],
    )
    // Keep a fixed light count in Three's renderer. Mounting spotlights only as
    // a room became detailed changed shader defines during a walking frame and
    // forced every lit material to compile a new program on the spot.
    const practicalRoom = detailedRoom || layout.rooms[0]
    const practicalFixtureXs = useMemo(
        () => (practicalRoom ? museumRoomCeilingFixtureXs(practicalRoom, 4) : EMPTY_FIXTURES),
        [practicalRoom],
    )
    const firstWallEndZ = MUSEUM_DIMENSIONS.firstBayZ + (MUSEUM_DIMENSIONS.baySpacing / 2)
    const lobbyWallLength = MUSEUM_DIMENSIONS.lobbyFrontZ - firstWallEndZ
    const lobbyWallCenterZ = firstWallEndZ + (lobbyWallLength / 2)
    const lastBayZ = bays.at(-1)?.centerZ ?? MUSEUM_DIMENSIONS.firstBayZ
    const tailFrontZ = lastBayZ - (MUSEUM_DIMENSIONS.baySpacing / 2)
    const tailLength = Math.max(0, tailFrontZ - layout.hallBackZ)
    // Keep fixtures between the transverse ceiling ribs. Their matching light
    // sources are stationary so illumination cannot jump or flash while walking.
    const ceilingLights = useMemo(() => [7, ...bays.map(bay => bay.centerZ)]
        .filter(z => z > layout.hallBackZ), [bays, layout.hallBackZ])
    const chandelierPositions = useMemo(() => ceilingLights.map(z => [0, z]), [ceilingLights])
    const hallSconcePlacements = useMemo(() => museumHallSconcePlacements(layout), [layout])
    const hallFloorFixtures = useMemo(
        () => ceilingLights.map(z => z - hallCenterZ),
        [ceilingLights, hallCenterZ],
    )
    const hallFloorOccluders = useMemo(() => [
        bakedFloorOccluder(layout.desk, 0, hallCenterZ, 0.16),
        ...layout.dressing.lobbyPlants.map(item => bakedFloorOccluder(item, 0, hallCenterZ, 0.075)),
        ...layout.dressing.hallPlants.map(item => bakedFloorOccluder(item, 0, hallCenterZ, 0.075)),
        ...layout.dressing.displays.filter(item => !item.roomId).map(item => bakedFloorOccluder(item, 0, hallCenterZ, 0.15)),
    ], [hallCenterZ, layout.desk, layout.dressing.displays, layout.dressing.hallPlants, layout.dressing.lobbyPlants])
    return (
        <group>
            <BakedIrradianceFloor
                position={[0, -0.11, hallCenterZ]}
                size={[MUSEUM_DIMENSIONS.hallHalfWidth * 2, layout.hallLength]}
                materials={materials}
                color="#a18a73"
                mode="hall"
                fixtures={hallFloorFixtures}
                occluders={hallFloorOccluders}
            />
            <VaultedCeiling layout={layout} centerZ={hallCenterZ} materials={materials} fixtures={ceilingLights} />
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
                        sconcePlacements={hallSconcePlacements}
                    />
                    <DistanceManagedDoorWall
                        side={1}
                        centerZ={bay.centerZ}
                        room={bay.right}
                        materials={materials}
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
            <group position={[0, 3.82, layout.hallBackZ + 0.205]}>
                <mesh position={[0, 0, -0.025]} scale={[5.35, 1.16, 0.11]} castShadow receiveShadow>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <meshPhysicalMaterial
                        {...materials.joinery}
                        color="#9b7747"
                        metalness={0.54}
                        roughness={0.38}
                        clearcoat={0.2}
                    />
                </mesh>
                <mesh position={[0, 0, 0.055]} scale={[5.08, 0.9, 0.055]}>
                    <primitive object={ARCHITECTURAL_ROUNDED_BOX} attach="geometry" />
                    <meshStandardMaterial color="#181411" roughness={0.74} />
                </mesh>
                <LabelPlane
                    title="Ian Truong Photography"
                    subtitle="The virtual archive"
                    position={[0, 0, 0.12]}
                    size={[4.82, 0.76]}
                    renderOrder={22}
                />
            </group>
            {layout.rooms.map(room => (
                <CategoryRoom
                    key={room.id}
                    room={room}
                    active={residentRooms.has(room.id)}
                    gateRequested={activeRoomId === room.id}
                    detailed={activeRoomId === room.id}
                    materials={materials}
                    inspectionWidth={inspectionWidth}
                    onGatePassabilityChange={onGatePassabilityChange}
                />
            ))}
            {practicalRoom && (
                <RoomCeilingPracticalLights
                    fixtureXs={practicalFixtureXs}
                    fixtureCeilingY={MUSEUM_DIMENSIONS.roomFixtureY}
                    room={practicalRoom}
                    qualityLighting={reflectionsEnabled}
                    enabled={Boolean(detailedRoom)}
                />
            )}
            <MuseumChandeliers
                positions={chandelierPositions}
                ceilingY={museumVaultHeightAt(0)}
                materials={materials}
            />
            <MuseumDressing
                layout={layout}
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
    for (const room of layout.rooms) {
        for (const painting of room.paintings) {
            const dx = painting.position[0] - camera.position.x
            const dy = painting.position[1] - camera.position.y
            const dz = painting.position[2] - camera.position.z
            const distance = Math.hypot(dx, dy, dz)
            // Interaction should feel like stepping up to inspect a print, not
            // triggering a dialog from halfway across the room.
            if (distance > 2.9) continue
            const inverseDistance = distance > 0 ? 1 / distance : 0
            const alignment = (
                (direction.x * dx * inverseDistance)
                + (direction.y * dy * inverseDistance)
                + (direction.z * dz * inverseDistance)
            )
            if (alignment < 0.8) continue
            const [normalX = 0, normalY = 0, normalZ = 1] = painting.normal || []
            const frontFacing = -(
                (normalX * dx * inverseDistance)
                + (normalY * dy * inverseDistance)
                + (normalZ * dz * inverseDistance)
            )
            if (frontFacing < 0.08) continue
            const score = distance + ((1 - alignment) * 7)
            if (score < bestScore) {
                best = painting
                bestScore = score
            }
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
        markMuseumInteractionBusy()
        if (knob.current) knob.current.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }

    useEffect(() => () => {
        input.current.moveX = 0
        input.current.moveY = 0
        input.current.lookX = 0
        input.current.lookY = 0
        resetMuseumJump(input.current.jump)
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
                    markMuseumInteractionBusy()
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
            <button
                className="museum-touch-jump"
                type="button"
                aria-label="Jump"
                onPointerDown={(event) => {
                    event.preventDefault()
                    event.currentTarget.setPointerCapture(event.pointerId)
                    pressMuseumJump(input.current.jump)
                    markMuseumInteractionBusy()
                }}
                onPointerUp={() => releaseMuseumJump(input.current.jump)}
                onPointerCancel={() => releaseMuseumJump(input.current.jump)}
                onLostPointerCapture={() => releaseMuseumJump(input.current.jump)}
                onClick={(event) => {
                    // Keyboard and assistive activation have no pointer-down.
                    if (event.detail !== 0) return
                    pressMuseumJump(input.current.jump)
                    releaseMuseumJump(input.current.jump)
                }}
            >
                <span aria-hidden="true">↑</span>
                Jump
            </button>
            <button className="museum-touch-pause" type="button" onClick={onPause}>Pause</button>
        </div>
    )
}

function NativePointerLockControls({ input, onLock, onUnlock }) {
    const { gl } = useThree()

    useEffect(() => {
        let lockedAt = 0
        const handleLockChange = () => {
            input.current.lookX = 0
            input.current.lookY = 0
            if (document.pointerLockElement === gl.domElement) {
                lockedAt = performance.now()
                onLock()
            }
            else onUnlock()
        }
        const handleMouseMove = (event) => {
            if (document.pointerLockElement !== gl.domElement) return
            // Safari and Firefox can emit a synthetic relative-mouse burst
            // immediately after pointer lock. Dropping that short handshake
            // window prevents the one-event 90-degree camera snap.
            if (performance.now() - lockedAt < 70) return
            // Safari and Firefox can emit one enormous relative delta when
            // pointer lock begins, resumes, or crosses a compositor boundary.
            // Clamp both the individual sample and the unconsumed frame total
            // so a single browser glitch can never spin or invert the camera.
            const rawX = Number(event.movementX) || 0
            const rawY = Number(event.movementY) || 0
            if (rawX || rawY) markMuseumInteractionBusy()
            // Ignore pathological focus/driver bursts without throttling normal
            // high-DPI mouse motion. Even at maximum sensitivity the accumulated
            // cap stays below a disorienting instant half-turn.
            const deltaX = THREE.MathUtils.clamp(rawX, -96, 96)
            const deltaY = THREE.MathUtils.clamp(rawY, -96, 96)
            input.current.lookX = THREE.MathUtils.clamp(input.current.lookX + deltaX, -240, 240)
            input.current.lookY = THREE.MathUtils.clamp(input.current.lookY + deltaY, -240, 240)
        }
        const handleLockError = () => {
            input.current.lookX = 0
            input.current.lookY = 0
            onUnlock()
        }
        document.addEventListener('pointerlockchange', handleLockChange)
        document.addEventListener('pointerlockerror', handleLockError)
        document.addEventListener('mousemove', handleMouseMove)
        return () => {
            document.removeEventListener('pointerlockchange', handleLockChange)
            document.removeEventListener('pointerlockerror', handleLockError)
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

function PlayerController({ layout, enabled, passableRoomIds, touchMode, touchInput, preferences, motionSuppressed, developmentJump, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
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
    const lookYaw = useRef(0)
    const lookPitch = useRef(0)
    const cameraRoll = useRef(0)
    const cameraPitchOffset = useRef(0)
    const cameraYawOffset = useRef(0)
    const previousSpeed = useRef(0)
    const lookReady = useRef(false)
    const jumpProbe = useRef({ elapsed: 0, peak: 0, takeoffs: 0, landings: 0, steps: 0, lastReport: -1 })
    const touchEuler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), [])
    const forward = useMemo(() => new THREE.Vector3(), [])
    const right = useMemo(() => new THREE.Vector3(), [])
    const movement = useMemo(() => new THREE.Vector3(), [])
    const velocity = useMemo(() => new THREE.Vector3(), [])
    const focusDirection = useMemo(() => new THREE.Vector3(), [])
    useEffect(() => {
        if (!enabled) return
        if (footstepAudio.current) {
            footstepAudio.current.context?.resume?.().catch(() => {})
            return
        }
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
        // Publish the restored residency before controls are enabled. A return
        // from an album can place the camera deep inside a large room, where
        // waiting for the first input frame would otherwise prepare only the
        // entrance behind the visitor and then visibly upgrade the room.
        const restoredRoom = nearestMuseumRoom(layout, restored)
        const restoredNearbyRooms = nearbyMuseumRoomIds(layout, restored, touchMode ? 15 : 20)
        lastRoom.current = restoredRoom
        lastNearbyRooms.current = restoredNearbyRooms.join('|')
        onActiveRoom(restoredRoom)
        onNearbyRooms(restoredNearbyRooms)
    }, [camera, layout, onActiveRoom, onNearbyRooms, touchMode])

    useEffect(() => {
        if (!enabled) {
            // The previous rendered frame contains procedural gait pitch/yaw.
            // Restore the visitor-authored look before clearing those offsets so
            // repeated pause/background cycles cannot absorb sway into the view.
            // Skip this on the initial disabled mount, where the authored lobby
            // camera.lookAt should remain untouched.
            if (lookReady.current) {
                camera.rotation.set(lookPitch.current, lookYaw.current, 0, 'YXZ')
            }
            lookReady.current = false
            touchInput.current.lookX = 0
            touchInput.current.lookY = 0
            keys.current.clear()
            resetMuseumJump(touchInput.current.jump)
            velocity.set(0, 0, 0)
            previousSpeed.current = 0
            cameraPitchOffset.current = 0
            cameraYawOffset.current = 0
            cameraRoll.current = 0
            camera.position.y = layout.spawn[1]
            return
        }
        touchEuler.setFromQuaternion(camera.quaternion, 'YXZ')
        lookYaw.current = touchEuler.y
        lookPitch.current = THREE.MathUtils.clamp(touchEuler.x, -0.58, 0.58)
        cameraRoll.current = 0
        cameraPitchOffset.current = 0
        cameraYawOffset.current = 0
        previousSpeed.current = 0
        camera.rotation.order = 'YXZ'
        camera.rotation.set(lookPitch.current, lookYaw.current, 0, 'YXZ')
        touchInput.current.lookX = 0
        touchInput.current.lookY = 0
        lookReady.current = true
    }, [camera, enabled, layout.spawn, touchEuler, touchInput, velocity])

    useEffect(() => {
        const onKeyDown = (event) => {
            if (!enabled || event.defaultPrevented || event.isComposing || museumKeyboardTargetsControl(event)) return
            keys.current.add(event.code)
            if (event.code === 'Space') {
                event.preventDefault()
                if (!event.repeat) {
                    pressMuseumJump(touchInput.current.jump)
                    markMuseumInteractionBusy()
                }
            }
            if (!event.repeat && MUSEUM_MOVEMENT_KEYS.has(event.code)) markMuseumInteractionBusy()
            if (event.code === 'KeyE' && enabled) {
                const painting = focusedPainting(layout, camera, focusDirection)
                if (painting) onOpenAlbum(painting.album)
            }
        }
        const onKeyUp = (event) => {
            keys.current.delete(event.code)
            if (event.code === 'Space') releaseMuseumJump(touchInput.current.jump)
        }
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('keyup', onKeyUp)
        return () => {
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('keyup', onKeyUp)
        }
    }, [camera, enabled, focusDirection, layout, onOpenAlbum, touchInput])

    useFrame((state, frameDelta) => {
        if (!enabled) return
        const delta = Math.min(frameDelta, 0.05)
        const jump = touchInput.current.jump
        if (import.meta.env.DEV && developmentJump) {
            // Exercise the actual input latch and controller, including holding
            // through contact and retrying in air, without native pointer lock.
            const probe = jumpProbe.current
            probe.elapsed += delta
            const t = probe.elapsed
            const pressed = (t >= 0.15 && t < 1.2)
                || (t >= 1.3 && t < 1.4)
                || (t >= 1.5 && t < 1.6)
                || (t >= 2.2 && t < 2.3)
            if (pressed) pressMuseumJump(jump)
            else releaseMuseumJump(jump)
        }
        advanceMuseumJump(jump, delta)
        if (!lookReady.current) {
            touchEuler.setFromQuaternion(camera.quaternion, 'YXZ')
            lookYaw.current = touchEuler.y
            lookPitch.current = THREE.MathUtils.clamp(touchEuler.x, -0.58, 0.58)
            lookReady.current = true
        }
        const lookSensitivity = (touchMode ? 0.003 : 0.0024) * preferences.sensitivity
        const frameLookX = THREE.MathUtils.clamp(touchInput.current.lookX, -720, 720)
        const frameLookY = THREE.MathUtils.clamp(touchInput.current.lookY, -720, 720)
        lookYaw.current -= frameLookX * lookSensitivity
        lookYaw.current = THREE.MathUtils.euclideanModulo(lookYaw.current + Math.PI, Math.PI * 2) - Math.PI
        lookPitch.current = THREE.MathUtils.clamp(
            lookPitch.current - (frameLookY * lookSensitivity),
            -0.58,
            0.58,
        )
        touchInput.current.lookX = 0
        touchInput.current.lookY = 0
        camera.rotation.set(lookPitch.current, lookYaw.current, cameraRoll.current, 'YXZ')
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
        const previousPositionX = camera.position.x
        const previousPositionZ = camera.position.z
        if (Math.abs(frameMovementX) + Math.abs(frameMovementZ) > 0.0001) {
            const next = moveMuseumPosition(
                layout,
                { x: camera.position.x, z: camera.position.z },
                { x: frameMovementX, z: frameMovementZ },
                0.35,
                passableRoomIds.current,
            )
            if (Math.abs(next.x - camera.position.x - frameMovementX) > 0.001) velocity.x *= 0.24
            if (Math.abs(next.z - camera.position.z - frameMovementZ) > 0.001) velocity.z *= 0.24
            camera.position.x = next.x
            camera.position.z = next.z
        }
        const actualSpeed = Math.hypot(
            camera.position.x - previousPositionX,
            camera.position.z - previousPositionZ,
        ) / Math.max(delta, 1 / 240)
        if (actualSpeed > 0.12 || !jump.grounded || Math.abs(frameLookX) + Math.abs(frameLookY) > 0.5) {
            markMuseumInteractionBusy()
        }
        const gaitStrength = motionSuppressed || !jump.grounded ? 0 : THREE.MathUtils.clamp(actualSpeed / 3.25, 0, 1.35)
        const motionStrength = gaitStrength * preferences.bobStrength
        if (jump.grounded) gaitPhase.current += actualSpeed * delta * 2.35
        const footstepIndex = Math.floor(gaitPhase.current / Math.PI)
        if (jump.grounded && (jump.landed || (actualSpeed > 0.48 && footstepIndex !== lastFootstep.current))) {
            lastFootstep.current = footstepIndex
            playMuseumFootstep(
                footstepAudio.current,
                footstepIndex,
                jump.landed ? 0.75 : actualSpeed / 3.25,
                preferences.footstepVolume * (jump.landed ? 0.8 : 1),
                museumFloorSurface(layout, camera.position),
            )
            if (import.meta.env.DEV && developmentJump) jumpProbe.current.steps += 1
        }
        const stepWave = Math.sin(gaitPhase.current * 2)
        const heelStrike = Math.pow(Math.max(0, stepWave), 8)
        const headBob = ((stepWave * 0.052) - (heelStrike * 0.018)) * motionStrength
        const breathing = motionSuppressed || !jump.grounded
            ? 0
            : Math.sin(state.clock.elapsedTime * 1.45) * 0.004 * preferences.bobStrength
        const landing = museumLandingOffset(jump, motionSuppressed ? 0 : preferences.bobStrength)
        camera.position.y = layout.spawn[1] + jump.height + headBob + breathing + landing
        const lateralVelocity = (velocity.x * right.x) + (velocity.z * right.z)
        const lateralLean = THREE.MathUtils.clamp(lateralVelocity / Math.max(1, speed), -1, 1)
        const targetRoll = moving && jump.grounded && !motionSuppressed
            ? ((Math.sin(gaitPhase.current) * 0.019 * gaitStrength) - (lateralLean * 0.013)) * preferences.bobStrength
            : 0
        cameraRoll.current = THREE.MathUtils.damp(cameraRoll.current, targetRoll, 9.5, delta)
        const acceleration = delta > 0
            ? THREE.MathUtils.clamp((actualSpeed - previousSpeed.current) / delta, -8, 8)
            : 0
        previousSpeed.current = actualSpeed
        const targetPitch = moving && jump.grounded && !motionSuppressed
            ? ((Math.sin((gaitPhase.current * 2) + 0.7) * 0.012 * gaitStrength) - (acceleration * 0.00115))
                * preferences.bobStrength
            : 0
        cameraPitchOffset.current = THREE.MathUtils.damp(
            cameraPitchOffset.current,
            targetPitch,
            moving ? 12 : 8,
            delta,
        )
        const targetYaw = moving && jump.grounded && !motionSuppressed
            ? ((Math.sin(gaitPhase.current) * 0.011) + (lateralLean * 0.0055))
                * gaitStrength
                * preferences.bobStrength
            : 0
        cameraYawOffset.current = THREE.MathUtils.damp(
            cameraYawOffset.current,
            targetYaw,
            moving ? 11 : 8,
            delta,
        )
        camera.rotation.set(
            THREE.MathUtils.clamp(lookPitch.current + cameraPitchOffset.current, -0.58, 0.58),
            lookYaw.current + cameraYawOffset.current,
            cameraRoll.current,
            'YXZ',
        )
        const baseFov = touchMode ? Math.max(68, preferences.fov) : preferences.fov
        const targetFov = baseFov + (speed > 4 ? 2 * gaitStrength : 0)
        const nextFov = THREE.MathUtils.damp(camera.fov, targetFov, 7, delta)
        if (Math.abs(camera.fov - nextFov) > 0.01) {
            camera.fov = nextFov
            camera.updateProjectionMatrix()
        }

        if (import.meta.env.DEV && developmentJump) {
            const probe = jumpProbe.current
            probe.peak = Math.max(probe.peak, jump.height)
            if (jump.tookOff) probe.takeoffs += 1
            if (jump.landed) probe.landings += 1
            if (probe.elapsed - probe.lastReport >= 0.1 && probe.lastReport < 3.5) {
                probe.lastReport = probe.elapsed
                document.documentElement.dataset.museumJumpProbe = JSON.stringify({
                    status: probe.elapsed >= 3.4 ? 'complete' : 'running',
                    elapsed: probe.elapsed,
                    peak: probe.peak,
                    height: jump.height,
                    eyeHeight: camera.position.y,
                    grounded: jump.grounded,
                    takeoffs: probe.takeoffs,
                    landings: probe.landings,
                    steps: probe.steps,
                    motionSuppressed,
                })
            }
        }

        if (state.clock.elapsedTime - lastProbeAt.current > 0.05) {
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
        if (mode === 'inspect' && room?.paintings.length) {
            const painting = room.paintings[0]
            const [normalX = 0, , normalZ = 1] = painting.normal || []
            camera.position.set(
                painting.position[0] + (normalX * 2.25),
                layout.spawn[1],
                painting.position[2] + (normalZ * 2.25),
            )
            camera.lookAt(...painting.position)
        } else if (mode === 'plaques' && room) {
            const painting = room.paintings[0]
            camera.position.set(painting.position[0] - room.side * 1.8, 1.65, painting.position[2] + 1.2)
            camera.lookAt(painting.position[0] + room.side * 11, 1.8, painting.position[2])
        } else if (mode === 'arch' && room) {
            camera.position.set(room.innerX - room.side * 1.45, 1.8, room.centerZ + 2.65)
            camera.lookAt(room.innerX, 3, room.centerZ + 2.3)
        } else if (mode === 'sign' && room) {
            camera.position.set(0, 1.7, room.centerZ + 0.65)
            camera.lookAt(room.innerX - room.side * 0.18, MUSEUM_PORTAL.signHeight, room.centerZ)
        } else if (mode === 'plant' && room) {
            const plant = room.plants[0]
            camera.position.set(plant.position[0] - room.side * 1.6, 1.7, plant.position[2] + 1.45)
            camera.lookAt(plant.position[0], 0.95, plant.position[2])
        } else if (mode === 'display' || mode === 'sculpture') {
            const display = layout.dressing.displays.find(item => !item.roomId && item.kind === (mode === 'sculpture' ? 'sculpture' : 'console'))
            if (display) {
                const side = Math.sign(display.position[0])
                camera.position.set(display.position[0] - side * 2.8, 1.7, display.position[2] + 2.3)
                camera.lookAt(display.position[0], 1.1, display.position[2])
            }
        } else if (mode === 'room' && room) {
            const x = room.innerX + (room.side * 4.2)
            camera.position.set(x, 2.25, room.centerZ - 4.15)
            camera.lookAt(x + (room.side * 5.5), 2.5, room.centerZ + 1.35)
        } else if (mode === 'join' && room) {
            camera.position.set(room.innerX + room.side * 1.8, 1.65, room.centerZ + room.width / 2 - 1.3)
            camera.lookAt(room.innerX + room.side * 0.12, 1.5, room.centerZ + room.width / 2 - 0.14)
        } else if (mode === 'end' && room) {
            const placard = museumEndWallPlacardPose(room)
            camera.position.set(
                room.outerX - (room.side * 5.2),
                2.5,
                room.centerZ,
            )
            camera.lookAt(...placard.label)
        } else if (mode === 'portal' && room) {
            const approachOffset = Math.min(1.5, Math.max(0.8, (room.width / 2) - 2.6))
            camera.position.set(
                room.side * (MUSEUM_DIMENSIONS.hallHalfWidth - 3.8),
                2.05,
                room.centerZ + approachOffset,
            )
            camera.lookAt(room.innerX + (room.side * 1.1), 2.15, room.centerZ)
        } else if (mode === 'entrance') {
            camera.position.set(0, 2.1, 9.4)
            camera.lookAt(0, 4.8, MUSEUM_DIMENSIONS.lobbyFrontZ)
        } else if (mode === 'reception') {
            camera.position.set(3.05, 2.5, 8.5)
            camera.lookAt(0, 1.5, layout.desk.position[2])
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

function CameraPreferenceSync({ preferences, touchMode }) {
    const { camera } = useThree()
    useEffect(() => {
        const nextFov = touchMode ? Math.max(68, preferences.fov) : preferences.fov
        if (Math.abs(camera.fov - nextFov) < 0.01) return
        camera.fov = nextFov
        camera.updateProjectionMatrix()
        requestMuseumFrames(2)
    }, [camera, preferences.fov, touchMode])
    return null
}

function SceneWarmup({ layout, initialRoomIds, onReady, onProgress, onRendererStatus, touchMode }) {
    const { camera, gl, scene } = useThree()
    const [warmRoomIds] = useState(() => initialRoomIds)

    useEffect(() => {
        let cancelled = false
        const controller = new AbortController()
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
        const roomById = new Map(layout.rooms.map(room => [room.id, room]))
        const nearbyInitialRooms = [...new Set(warmRoomIds)]
            .map(id => roomById.get(id))
            .filter(Boolean)
        const initialRooms = (nearbyInitialRooms.length ? nearbyInitialRooms : layout.rooms)
            .slice(0, 2)
        const entry = sessionStorage.getItem(RETURN_KEY) === 'true'
            ? safeSessionPosition(layout)
            : { x: camera.position.x, z: camera.position.z }
        const warmAlbums = [...new Map(
            initialRooms
                // Warm the actual first viewing area, including restored deep
                // positions. Distant frames stream without extending startup
                // in proportion to the largest archive's album count.
                .flatMap(room => [...room.paintings]
                    .sort((left, right) => (
                        Math.hypot(left.position[0] - entry.x, left.position[2] - entry.z)
                        - Math.hypot(right.position[0] - entry.x, right.position[2] - entry.z)
                    ))
                    .slice(0, 8)
                    .map(painting => painting.album))
                .filter(Boolean)
                .map(album => [album.albumId, album]),
        ).values()]
        const coverJobs = warmAlbums.map((album, index) => ({
            album,
            width: BASE_COVER_WIDTH,
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

        // The veil owns the entry photographs; the budgeted queue handles the
        // rest without requiring a pause in visitor input.
        let settledCovers = 0
        const preparedCovers = Promise.allSettled(coverJobs.map((job) => (
            createMuseumCoverTexture(job.album, job.width, job.priority).then((texture) => {
                if (cancelled) {
                    trimCoverTextureCache()
                } else {
                    // Warmup owns this temporary retain independently from the
                    // upload queue. Its finally/cleanup paths release every
                    // texture, including textures that were already resident.
                    pinCoverTexture(texture)
                    warmPinnedTextures.add(texture)
                }
                return texture
            }).finally(() => {
                settledCovers += 1
                publishProgress(0.08 + ((settledCovers / Math.max(1, coverJobs.length)) * 0.46))
            })
        )))

        preparedCovers.then(async (coverResults) => {
            if (cancelled) return
            await waitForMuseumForeground(controller.signal)
            if (cancelled) return
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
                    coverTextures,
                    ratio => publishProgress(0.56 + (ratio * 0.18)),
                    controller.signal,
                )
            } finally {
                warmPinnedTextures.forEach(unpinCoverTexture)
                warmPinnedTextures.clear()
                trimCoverTextureCache()
            }
            publishStage('preparing-rooms', { roomCount: layout.rooms.length })
            await prewarmMuseumRoomInteriors(
                gl,
                scene,
                camera,
                layout,
                ratio => publishProgress(0.74 + (ratio * 0.16)),
                controller.signal,
            )
            // Compile after the resident reveal textures exist.
            // Running this concurrently compiled an earlier scene and deferred
            // the real shader/texture-bind spike until the veil lifted.
            publishStage('compiling', { prepared: coverTextures.length })
            publishProgress(0.91)
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
                await waitForMuseumForeground(controller.signal)
                const compile = gl.compileAsync?.(scene, camera) || Promise.resolve()
                await Promise.race([
                    compile,
                    new Promise(resolve => window.setTimeout(resolve, isFirefoxBrowser() ? 1100 : 1500)),
                ])
            } finally {
                window.clearInterval(compileProgressTimer)
            }
            await waitForMuseumForeground(controller.signal)
            publishProgress(0.98)
            requestMuseumFrames(2)
            // Let two visible settling turns place camera-aware artwork and
            // the first portal while the loading veil still hides the canvas.
            await waitForMuseumFrame(controller.signal)
            requestMuseumFrames(2)
            await waitForMuseumFrame(controller.signal)
            if (cancelled) return
            finish()
        }).catch((cause) => {
            if (cancelled || cause?.name === 'AbortError') return
            publishStage('failed', { message: cause?.message || String(cause) })
            onRendererStatus?.('restart')
        })

        return () => {
            cancelled = true
            controller.abort(museumAbortError('Museum warmup unmounted'))
            warmPinnedTextures.forEach(unpinCoverTexture)
            warmPinnedTextures.clear()
            trimCoverTextureCache()
        }
    }, [camera, gl, layout, onProgress, onReady, onRendererStatus, scene, touchMode, warmRoomIds])

    return <MuseumArtworkShaderWarmup />
}

function AnticipatoryRoomPreloader({ layout, activeRoomId, activeRoomIds, enabled }) {
    const { gl } = useThree()
    useEffect(() => {
        if (!enabled || !layout.rooms.length || navigator.connection?.saveData) return undefined

        let cancelled = false
        let cancelScheduled = () => {}
        const currentRoom = layout.rooms.find(room => room.id === activeRoomId)
            || layout.rooms.find(room => (activeRoomIds || []).includes(room.id))
            || layout.rooms[0]
        // Work outward from the visitor through a cache-bounded archive window.
        // Compact bases can continue at a measured cadence during movement;
        // detail upgrades retain their idle-only policy. The current archive fits in one window;
        // larger future catalogs reprioritize the nearest 76 on each room move.
        const candidateRooms = prioritizeMuseumPreloadRooms(
            layout.rooms,
            currentRoom.id,
            layout.rooms.length,
        )
        const jobs = museumPreloadPaintings(candidateRooms, MAX_ANTICIPATORY_BASE_COVERS)
            .map((painting, index) => ({
                album: painting.album,
                width: BASE_COVER_WIDTH,
                priority: INTERACTION_SAFE_COVER_PRIORITY + 500 - index,
            }))

        const uniqueJobs = [...new Map(
            jobs.map(job => [`${job.album.albumId}:${job.width}`, job]),
        ).values()].slice(0, MAX_ANTICIPATORY_BASE_COVERS).filter((job) => {
            const cached = cachedCoverTexture(job.album, job.width)
            return !cached || !coverTextureWasUploaded(gl, cached)
        })
        const pause = isFirefoxBrowser() ? 80 : 24
        const schedule = (callback, delay = 0) => {
            if (cancelled) return
            cancelScheduled()
            cancelScheduled = scheduleMuseumVisibleTask(
                () => callback(null),
                Math.max(16, delay),
            )
        }
        const runCovers = async (index = 0) => {
            if (cancelled || index >= uniqueJobs.length) return
            const job = uniqueJobs[index]
            await createMuseumCoverTexture(job.album, job.width, job.priority)
                .then(texture => cancelled ? undefined : enqueueCoverUpload(gl, texture, job.priority))
                .catch(() => undefined)
            if (cancelled) return
            schedule(() => runCovers(index + 1), pause)
        }
        schedule(() => runCovers(), 220)

        return () => {
            cancelled = true
            cancelScheduled()
        }
    }, [activeRoomId, activeRoomIds, enabled, gl, layout])

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
            interactionBusy: museumInteractionIsBusy(),
            lastCoverUploadMs: Number(lastCoverUploadDuration.toFixed(2)),
            coverUploadsDuringInteraction,
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
        focusFailures: [],
        maxTextures: 0,
        maxCalls: 0,
        maxTriangles: 0,
        traversalChecks: new Set(),
        activeRoomId: undefined,
        nearbyKey: '',
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
                focusFailures: tour.focusFailures,
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
        const focusPainting = room.paintings[Math.min(1, Math.max(0, room.paintings.length - 1))]
        const focusNormal = focusPainting?.normal || [0, 0, 1]
        const focusPosition = focusPainting
            ? [
                focusPainting.position[0] + (focusNormal[0] * 2.35),
                layout.spawn[1],
                focusPainting.position[2] + (focusNormal[2] * 2.35),
            ]
            : [insideX, layout.spawn[1], room.centerZ - 1.1]
        const phases = [
            { duration: 0.62, position: [hallX, layout.spawn[1], room.centerZ + 1.1] },
            { duration: 0.52, position: [entranceX, layout.spawn[1], room.centerZ] },
            { duration: 0.9, position: [insideX, layout.spawn[1], room.centerZ] },
            { duration: 0.8, position: [deepX, layout.spawn[1], room.centerZ + 1.3] },
            { duration: 0.76, position: focusPosition },
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
                    new Set([room.id]),
                )
                const enteredDepth = (probe.x - room.innerX) * room.side
                if (enteredDepth < 1.6) tour.portalFailures.push(`${tour.circuit + 1}:${room.id}:collision`)
                tour.traversalChecks.add(checkKey)
            }
        }
        target.set(...phase.position)

        const progress = THREE.MathUtils.smoothstep(Math.min(1, elapsed / phase.duration), 0, 1)
        camera.position.lerpVectors(tour.phaseStart, target, progress)
        if (progress < 0.995) markMuseumInteractionBusy()
        if (tour.phase <= 1) {
            lookAt.set(room.innerX + (room.side * 2.5), 2.4, room.centerZ)
        } else if (tour.phase <= 3) {
            lookAt.set(room.outerX - (room.side * 0.8), 2.45, room.centerZ)
        } else if (tour.phase === 4 && focusPainting) {
            lookAt.set(...focusPainting.position)
        } else {
            lookAt.set(0, 2.25, room.centerZ)
        }
        camera.lookAt(lookAt)

        if (tour.phase === 4 && focusPainting && elapsed > phase.duration * 0.94) {
            const checkKey = `${tour.circuit}:${room.id}:focus`
            if (!tour.traversalChecks.has(checkKey)) {
                const resolved = focusedPainting(layout, camera, lookAt)
                const resolvedInRoom = resolved && room.paintings.some(painting => painting.id === resolved.id)
                if (!resolvedInRoom) {
                    tour.focusFailures.push(`${tour.circuit + 1}:${room.id}:${resolved?.id || 'none'}`)
                }
                tour.traversalChecks.add(checkKey)
            }
        }

        const position = { x: camera.position.x, z: camera.position.z }
        const nextActiveRoomId = nearestMuseumRoom(layout, position)
        if (nextActiveRoomId !== tour.activeRoomId) {
            tour.activeRoomId = nextActiveRoomId
            onActiveRoom(nextActiveRoomId)
        }
        const nearbyRooms = nearbyMuseumRoomIds(layout, position, 20)
        const nearbyKey = nearbyRooms.join('|')
        if (nearbyKey !== tour.nearbyKey) {
            tour.nearbyKey = nearbyKey
            onNearbyRooms(nearbyRooms)
        }
        tour.maxTextures = Math.max(tour.maxTextures, gl.info.memory.textures)
        tour.maxCalls = Math.max(tour.maxCalls, gl.info.render.calls)
        tour.maxTriangles = Math.max(tour.maxTriangles, gl.info.render.triangles)
        document.documentElement.dataset.museumTour = JSON.stringify({
            status: 'running',
            circuit: tour.circuit + 1,
            room: room.name,
            roomIndex: tour.roomIndex,
            phase: tour.phase,
            roomResident: nearbyRooms.includes(room.id),
            portalFailures: tour.portalFailures,
            focusFailures: tour.focusFailures,
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

function RendererHealth({ input, onPause, onStatus }) {
    const { gl } = useThree()
    const resumePending = useRef(false)
    const resumeStartFrame = useRef(-1)
    const resumeWatchdog = useRef(0)
    const resumeKickTimer = useRef(0)
    const forcedRecovery = useRef(false)

    useEffect(() => addAfterEffect(() => {
        if (
            !resumePending.current
            || forcedRecovery.current
            || gl.getContext?.().isContextLost?.()
        ) return
        // Global after-effects run only after R3F's gl.render() returned. Pair
        // that completion point with this renderer's counter so another canvas
        // cannot accidentally acknowledge our own stalled resume probe.
        if ((gl.info?.render?.frame ?? -1) <= resumeStartFrame.current) return
        resumePending.current = false
        resumeStartFrame.current = -1
        window.clearTimeout(resumeWatchdog.current)
        window.clearTimeout(resumeKickTimer.current)
        // The parent is already healthy during a normal focus resume. Avoid
        // writing an optimistic status here: a simultaneous warmup failure may
        // have requested a renderer restart during this same completed frame.
    }), [gl])

    useEffect(() => {
        const canvas = gl.domElement
        const cancelResumeProbe = () => {
            resumePending.current = false
            resumeStartFrame.current = -1
            window.clearTimeout(resumeWatchdog.current)
            window.clearTimeout(resumeKickTimer.current)
        }
        const resetInput = () => {
            input.current.moveX = 0
            input.current.moveY = 0
            input.current.lookX = 0
            input.current.lookY = 0
            resetMuseumJump(input.current.jump)
        }
        const resume = () => {
            if (!museumDocumentIsForeground() || forcedRecovery.current) return
            resetInput()
            resumeCoverPipelines()
            if (gl.getContext?.().isContextLost?.()) {
                cancelResumeProbe()
                forcedRecovery.current = true
                onStatus('recovering')
                return
            }
            try {
                gl.resetState?.()
            } catch {
                cancelResumeProbe()
                forcedRecovery.current = true
                onStatus('restart')
                return
            }
            cancelResumeProbe()
            resumeStartFrame.current = gl.info?.render?.frame ?? -1
            resumePending.current = true
            resumeWatchdog.current = window.setTimeout(() => {
                if (!resumePending.current) return
                resumePending.current = false
                forcedRecovery.current = true
                onStatus('restart')
            }, 900)
            requestMuseumFrames(3)
            resumeKickTimer.current = window.setTimeout(() => requestMuseumFrames(2), 40)
        }
        const handleVisibility = () => {
            if (!museumDocumentIsVisible()) {
                cancelResumeProbe()
                resetInput()
                suspendCoverPipelines()
                onPause()
                return
            }
            resume()
        }
        const handleBlur = () => {
            cancelResumeProbe()
            resetInput()
            suspendCoverPipelines()
            onPause()
        }
        const handlePageSuspend = () => {
            cancelResumeProbe()
            resetInput()
            suspendCoverPipelines()
            onPause()
        }
        const handlePageShow = () => {
            // Pointer lock is not preserved through BFCache/page restoration.
            // Reconcile the React control state before restarting render/I/O.
            onPause()
            resume()
        }
        const handleLost = (event) => {
            // Opt in to WebGL's restoration path and immediately cover the
            // browser's transparent/default framebuffer. Without this veil a
            // transient driver reset appears as a full-screen white flash.
            event.preventDefault()
            cancelResumeProbe()
            forcedRecovery.current = true
            resetInput()
            onPause()
            suspendCoverPipelines()
            invalidateRendererCoverUploads(gl)
            onStatus('recovering')
        }
        const handleRestored = () => {
            cancelResumeProbe()
            forcedRecovery.current = true
            invalidateRendererCoverUploads(gl)
            // PMREM targets and driver-owned texture handles are not reliable
            // after a context restoration. Remount the renderer and rebuild
            // the exact saved viewpoint instead of declaring a partial restore
            // healthy after an unrelated browser animation callback.
            onStatus('restart')
        }
        canvas.addEventListener('webglcontextlost', handleLost, false)
        canvas.addEventListener('webglcontextrestored', handleRestored, false)
        document.addEventListener('visibilitychange', handleVisibility)
        document.addEventListener('freeze', handlePageSuspend)
        window.addEventListener('blur', handleBlur)
        window.addEventListener('focus', resume)
        window.addEventListener('pagehide', handlePageSuspend)
        window.addEventListener('pageshow', handlePageShow)
        resume()
        return () => {
            cancelResumeProbe()
            forcedRecovery.current = false
            canvas.removeEventListener('webglcontextlost', handleLost, false)
            canvas.removeEventListener('webglcontextrestored', handleRestored, false)
            document.removeEventListener('visibilitychange', handleVisibility)
            document.removeEventListener('freeze', handlePageSuspend)
            window.removeEventListener('blur', handleBlur)
            window.removeEventListener('focus', resume)
            window.removeEventListener('pagehide', handlePageSuspend)
            window.removeEventListener('pageshow', handlePageShow)
            suspendCoverPipelines()
            invalidateRendererCoverUploads(gl)
        }
    }, [gl, input, onPause, onStatus])
    return null
}

const MuseumScene = memo(function MuseumScene({ layout, controlsEnabled, sceneReady, touchMode, touchInput, preferences, motionSuppressed, visualPreview, developmentTour, developmentJump, developmentPerf, previewMode, previewRoomIndex, onSceneReady, onSceneProgress, onRendererStatus, onPause, onLock, onUnlock, onActiveRoom, onNearbyRooms, onFocusedPainting, onOpenAlbum }) {
    const materials = useMuseumMaterials()
    const cinematicShadows = !touchMode && !isFirefoxBrowser()
    const inspectionWidth = useMemo(
        () => preferredMuseumInspectionCoverWidth(touchMode),
        [touchMode],
    )
    const passableRoomIds = useRef(new Set())
    const handleGatePassabilityChange = useCallback((roomId, passable) => {
        if (passable) passableRoomIds.current.add(roomId)
        else passableRoomIds.current.delete(roomId)
    }, [])
    return (
        <>
            <MuseumFrameDriver
                continuous={controlsEnabled.locked || visualPreview || developmentTour || developmentJump || !sceneReady}
            />
            <color attach="background" args={[INK]} />
            <fog attach="fog" args={['#151310', 30, 120]} />
            {/* Keep enough indirect exposure for accessibility, but let the
                actual architectural fixtures establish contrast. The previous
                high ambient/hemisphere pair flattened every room into the same
                brightness and made practical lights visually irrelevant. */}
            <ambientLight intensity={touchMode ? 0.20 : 0.18} color="#efd4ac" />
            <hemisphereLight args={['#cfbfa7', '#241713', touchMode ? 0.34 : 0.31]} />
            <directionalLight
                position={[-6, 10, 12]}
                intensity={touchMode ? 0.32 : 0.30}
                color="#ead8bd"
                castShadow={false}
            />
            <directionalLight position={[7, 6, -12]} intensity={0.12} color="#b4cadb" castShadow={false} />
            <MainHall
                layout={layout}
                activeRoomId={controlsEnabled.activeRoomId}
                activeRoomIds={controlsEnabled.activeRoomIds}
                materials={materials}
                // Firefox uses the lower-cost reflection path on every OS. Its
                // WebGL shader compilation behavior is the limiting capability,
                // not only the Windows user-agent combination.
                reflectionsEnabled={!touchMode && !isFirefoxBrowser()}
                shadowsEnabled={cinematicShadows}
                inspectionWidth={inspectionWidth}
                onGatePassabilityChange={handleGatePassabilityChange}
            />
            <MuseumAtmosphere layout={layout} roomId={controlsEnabled.activeRoomId} motionSuppressed={motionSuppressed || touchMode} />
            <RendererHealth input={touchInput} onPause={onPause} onStatus={onRendererStatus} />
            <CameraPreferenceSync preferences={preferences} touchMode={touchMode} />
            <SceneWarmup
                layout={layout}
                initialRoomIds={controlsEnabled.activeRoomIds}
                onReady={onSceneReady}
                onProgress={onSceneProgress}
                onRendererStatus={onRendererStatus}
                touchMode={touchMode}
            />
            <AnticipatoryRoomPreloader
                layout={layout}
                activeRoomId={controlsEnabled.activeRoomId}
                activeRoomIds={controlsEnabled.activeRoomIds}
                enabled={sceneReady}
            />
            {developmentPerf && <DevelopmentPerformanceProbe />}
            {visualPreview && <PreviewCamera mode={previewMode} roomIndex={previewRoomIndex} layout={layout} />}
            {import.meta.env.DEV && developmentTour && sceneReady && (
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
                        enabled={controlsEnabled.locked || (developmentJump && sceneReady)}
                        passableRoomIds={passableRoomIds}
                        touchMode={touchMode}
                        touchInput={touchInput}
                        preferences={preferences}
                        motionSuppressed={motionSuppressed}
                        developmentJump={developmentJump}
                        onActiveRoom={onActiveRoom}
                        onNearbyRooms={onNearbyRooms}
                        onFocusedPainting={onFocusedPainting}
                        onOpenAlbum={onOpenAlbum}
                    />
                    {!touchMode && !developmentJump && <NativePointerLockControls input={touchInput} onLock={onLock} onUnlock={onUnlock} />}
                </>
            )}
        </>
    )
})

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
    const useDevelopmentFixture = import.meta.env.DEV && previewParams?.get('museum-fixture') === '1'
    const [albums, setAlbums] = useState(() => (
        useDevelopmentFixture ? developmentMuseumFixtureAlbums() : null
    ))
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
    const [rendererVersion, setRendererVersion] = useState(0)
    const [touchMode, setTouchMode] = useState(() => forceTouchPreview || usesTouchControls())
    const [preferences, setPreferences] = useState(() => readMuseumPreferences(localStorage, PREFERENCES_KEY))
    const reducedMotion = useReducedMotionPreference()
    const [motionOverride, setMotionOverride] = useState(() => {
        try {
            return localStorage.getItem(MOTION_OVERRIDE_KEY) === 'true'
        } catch {
            return false
        }
    })
    const touchInput = useRef({ moveX: 0, moveY: 0, lookX: 0, lookY: 0, jump: createMuseumJumpState() })

    useEffect(() => {
        resumeCoverPipelines()
        return () => cancelCoverPipelines()
    }, [])

    const pauseGallery = useCallback(() => {
        if (document.pointerLockElement) document.exitPointerLock?.()
        touchInput.current.moveX = 0
        touchInput.current.moveY = 0
        touchInput.current.lookX = 0
        touchInput.current.lookY = 0
        resetMuseumJump(touchInput.current.jump)
        setLocked(false)
        setFocused(null)
    }, [setFocused, setLocked])
    const handleLock = useCallback(() => setLocked(true), [setLocked])
    const handleUnlock = useCallback(() => setLocked(false), [setLocked])

    useEffect(() => {
        persistMuseumPreferences(localStorage, PREFERENCES_KEY, preferences)
    }, [preferences])

    useEffect(() => {
        if (!sceneReady) return undefined
        const timer = window.setTimeout(() => setSceneVeilVisible(false), 160)
        return () => window.clearTimeout(timer)
    }, [sceneReady])

    useEffect(() => {
        if (rendererStatus === 'ok') return undefined
        return scheduleMuseumVisibleTask(() => {
            // PlayerController consumes this one-shot marker to restore the
            // last saved position when the Canvas is rebuilt after a driver
            // reset. Without it, recovery teleported the camera to the lobby
            // while room residency still described the old location.
            sessionStorage.setItem(RETURN_KEY, 'true')
            pauseGallery()
            setSceneReady(false)
            setSceneVeilVisible(true)
            setSceneProgress(0.02)
            setRendererVersion(version => version + 1)
            setRendererStatus('ok')
        }, rendererStatus === 'restart' ? 40 : 1200)
    }, [pauseGallery, rendererStatus])

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
        if (useDevelopmentFixture) return undefined
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
    }, [loadVersion, useDevelopmentFixture])

    const catalog = useMemo(() => buildMuseumCatalog(albums || []), [albums])
    const layout = useMemo(() => buildMuseumLayout(catalog), [catalog])
    const previewMode = previewParams?.get('museum-preview') || ''
    const previewRoomIndex = Number.parseInt(previewParams?.get('museum-room') || '0', 10) || 0
    const developmentTour = import.meta.env.DEV && previewParams?.get('museum-tour') === '1'
    const developmentJump = import.meta.env.DEV && previewParams?.get('museum-jump') === '1'
    const developmentPerf = import.meta.env.DEV && previewParams?.get('museum-perf') === '1'
    const roomPreviewModes = useMemo(() => ['room', 'inspect', 'portal', 'end', 'join', 'plaques', 'arch', 'sign', 'plant'], [])
    const visualPreview = import.meta.env.DEV && ['lobby', 'hall', 'entrance', 'reception', 'display', 'sculpture', ...roomPreviewModes].includes(previewMode)
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
    const renderedActiveRoomIds = useMemo(() => (
        visualPreview
            ? (roomPreviewModes.includes(previewMode) ? [layout.rooms[previewRoomIndex]?.id].filter(Boolean) : [])
            : (activeRoomIds ?? initialActiveRoomIds)
    ), [activeRoomIds, initialActiveRoomIds, layout.rooms, previewMode, previewRoomIndex, roomPreviewModes, visualPreview])
    const renderedActiveRoomId = visualPreview && roomPreviewModes.includes(previewMode)
        ? layout.rooms[previewRoomIndex]?.id
        : activeRoomId
    const openAlbum = useCallback((album) => {
        sessionStorage.setItem(RETURN_KEY, 'true')
        navigate(`/album/${encodeURIComponent(album.albumId)}`, { state: { fromImmersiveGallery: true } })
    }, [navigate])
    const handleSceneReady = useCallback(() => setSceneReady(true), [setSceneReady])
    const updatePreference = useCallback((key, value) => {
        if (key === 'bobStrength') {
            const override = Number(value) > 0
            setMotionOverride(override)
            try {
                localStorage.setItem(MOTION_OVERRIDE_KEY, override ? 'true' : 'false')
            } catch {
                // Storage can be denied in private browsing; the live setting
                // still applies for this gallery session.
            }
        }
        setPreferences(current => ({ ...current, [key]: Number(value) }))
    }, [setMotionOverride, setPreferences])
    const beginWalkThrough = useCallback(() => {
        if (touchMode) {
            setLocked(true)
            return
        }
        const canvas = document.querySelector('.museum-canvas canvas')
        if (!canvas?.requestPointerLock) return
        if (document.pointerLockElement === canvas) {
            setLocked(true)
            return
        }
        try {
            const request = canvas.requestPointerLock()
            if (request && typeof request.then === 'function') {
                request.then(() => {
                    if (document.pointerLockElement === canvas) setLocked(true)
                    else pauseGallery()
                }).catch(pauseGallery)
            }
        } catch {
            pauseGallery()
        }
    }, [pauseGallery, setLocked, touchMode])
    const controlsEnabled = useMemo(() => ({
        locked,
        activeRoomId: renderedActiveRoomId,
        activeRoomIds: renderedActiveRoomIds,
    }), [locked, renderedActiveRoomId, renderedActiveRoomIds])
    const motionSuppressed = reducedMotion && !motionOverride
    const canvasCamera = useMemo(() => ({
        fov: touchMode ? Math.max(68, preferences.fov) : preferences.fov,
        near: 0.08,
        far: 220,
        position: layout.spawn,
    }), [layout.spawn, preferences.fov, touchMode])
    const canvasPerformance = useMemo(() => ({ min: 0.45, max: 1, debounce: 240 }), [])
    const canvasGl = useMemo(() => ({
        // Firefox frequently compiles MSAA variants only after the first camera
        // movement. Browser compositing at a stable DPR is preferable to that
        // severe cold-start hitch.
        antialias: !touchMode && !isFirefoxBrowser(),
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
    }), [touchMode])
    const handleCanvasCreated = useCallback(({ gl }) => {
        gl.outputColorSpace = THREE.SRGBColorSpace
        gl.toneMapping = THREE.ACESFilmicToneMapping
        // Preserve practical-light highlights while lifting the room's broad
        // dark surfaces with low-cost ambient bounce.
        gl.toneMappingExposure = touchMode ? 1.2 : 1.16
    }, [touchMode])
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
                key={rendererVersion}
                className="museum-canvas"
                camera={canvasCamera}
                dpr={touchMode ? 0.68 : (isWindowsFirefoxBrowser() ? 0.68 : 0.8)}
                // The gallery owns its RAF lifecycle so a browser-discarded
                // hidden-tab callback can never strand Fiber's module-global
                // loop. MuseumFrameDriver advances continuously only during
                // play/warmup and otherwise renders short settling bursts.
                frameloop="never"
                performance={canvasPerformance}
                shadows={false}
                gl={canvasGl}
                onCreated={handleCanvasCreated}
            >
                <Suspense fallback={null}>
                    <MuseumScene
                        layout={layout}
                        controlsEnabled={controlsEnabled}
                        sceneReady={sceneReady}
                        touchMode={touchMode}
                        touchInput={touchInput}
                        preferences={preferences}
                        motionSuppressed={motionSuppressed}
                        visualPreview={visualPreview}
                        developmentTour={developmentTour}
                        developmentJump={developmentJump}
                        developmentPerf={developmentPerf}
                        previewMode={previewMode}
                        previewRoomIndex={previewRoomIndex}
                        onSceneReady={handleSceneReady}
                        onSceneProgress={setSceneProgress}
                        onRendererStatus={setRendererStatus}
                        onPause={pauseGallery}
                        onLock={handleLock}
                        onUnlock={handleUnlock}
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
                    <span><kbd>Space</kbd> Jump</span>
                    <span><kbd>Esc</kbd> Pause</span>
                </div>
            )}
            {sceneReady && touchMode && locked && !visualPreview && !developmentJump && (
                <MuseumTouchControls input={touchInput} onPause={() => setLocked(false)} />
            )}
            {sceneReady && !locked && !visualPreview && !developmentTour && !developmentJump && (
                <div className="museum-entry-panel">
                    <span className="museum-entry-number">The virtual archive</span>
                    <h1>{activeRoomId ? 'Gallery paused' : 'Enter the gallery'}</h1>
                    <p>
                        Walk through rooms generated from the live photography archive. Look toward a framed album and {touchMode ? 'tap Open to enter it.' : 'press E to open it.'}
                    </p>
                    <button
                        id="museum-enter"
                        type="button"
                        onClick={beginWalkThrough}
                    >
                        {activeRoomId ? 'Continue exploring' : 'Begin walk-through'}
                    </button>
                    <div>{touchMode ? 'Joystick to move · Drag to look · Tap Jump to hop' : <><kbd>WASD</kbd> to move · <kbd>Mouse</kbd> to look · <kbd>Space</kbd> to jump · <kbd>Esc</kbd> to pause</>}</div>
                    <details className="museum-experience-settings">
                        <summary>Experience settings</summary>
                        <div>
                            <label>
                                <span>Look sensitivity <output>{Math.round(preferences.sensitivity * 100)}%</output></span>
                                <input type="range" min="0.45" max="1.8" step="0.05" value={preferences.sensitivity} onChange={event => updatePreference('sensitivity', event.target.value)} />
                            </label>
                            <label>
                                <span>
                                    Walking motion <output>{reducedMotion && !motionOverride
                                        ? 'Off — system setting'
                                        : `${Math.round(preferences.bobStrength * 100)}%`}</output>
                                </span>
                                <input type="range" min="0" max="1" step="0.01" value={preferences.bobStrength} onChange={event => updatePreference('bobStrength', event.target.value)} />
                            </label>
                            <label>
                                <span>Field of view <output>{preferences.fov}°</output></span>
                                <input type="range" min="56" max="82" step="1" value={preferences.fov} onChange={event => updatePreference('fov', event.target.value)} />
                            </label>
                            <label>
                                <span>Footsteps <output>{Math.round(preferences.footstepVolume * 100)}%</output></span>
                                <input type="range" min="0" max="1" step="0.05" value={preferences.footstepVolume} onChange={event => updatePreference('footstepVolume', event.target.value)} />
                            </label>
                        </div>
                    </details>
                </div>
            )}
        </div>
    )
}
