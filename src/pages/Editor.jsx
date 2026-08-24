import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COLOR_CHANNELS, freshAdjustments, freshGeometry, sanitizeAdjustments, sanitizeGeometry } from '../editor/adjustments'
import { BUILT_IN_PRESETS, applyPreset, parseSidecar, serializeSidecar } from '../editor/presets'
import { canvasToBlob, cropForAspect, drawGeometry, drawGeometryAtSize, fittedGeometryDimensions, outputDimensions } from '../editor/canvas'
import { decodeStandardFile, makePreviewSource } from '../editor/standardDecoder'
import { decodeRawFile, isRawFile } from '../editor/rawDecoder'
import { clearEditorSession, loadEditorSession, saveEditorSource, saveEditorState } from '../editor/sessionStore'
import { ColorWheel, ToneCurve } from '../editor/DirectControls'
import { anchoredPan } from '../editor/directControlMath'
import { createLivePreviewRenderer } from '../editor/livePreviewRenderer'
import { workerRequest } from '../editor/workerClient'
import './Editor.css'

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp,image/avif,.dng,.cr2,.cr3,.nef,.nrw,.arw,.raf,.rw2,.orf,.pef,.srw,.3fr,.fff,.iiq,.x3f,.raw'
const CUSTOM_PRESETS_KEY = 'ian-photo-editor-presets-v1'
const PREVIEW_QUALITY_KEY = 'ian-photo-editor-preview-quality-v1'
const DEFAULT_EXPORT_OPTIONS = Object.freeze({ format: 'jpeg', quality: 92, resizeMode: 'original', size: 2048, suffix: '-edited' })
const PREVIEW_QUALITIES = Object.freeze({
    faster: Object.freeze({ label: 'Faster', fullEdge: 800, liveEdge: 360 }),
    balanced: Object.freeze({ label: 'Balanced', fullEdge: 1200, liveEdge: 560 }),
    high: Object.freeze({ label: 'High', fullEdge: 1800, liveEdge: 800 }),
    maximum: Object.freeze({ label: 'Maximum', fullEdge: 2400, liveEdge: 1100 }),
})

const RANGE_GROUPS = [
    { title: 'Light', controls: [
        ['exposure', 'Exposure', -5, 5, 0.05], ['contrast', 'Contrast', -100, 100, 1],
        ['highlights', 'Highlights', -100, 100, 1], ['shadows', 'Shadows', -100, 100, 1],
        ['whites', 'Whites', -100, 100, 1], ['blacks', 'Blacks', -100, 100, 1], ['gamma', 'Gamma', 0.25, 3, 0.01],
    ] },
    { title: 'Color', controls: [
        ['temperature', 'Temperature', -100, 100, 1], ['tint', 'Tint', -100, 100, 1],
        ['vibrance', 'Vibrance', -100, 100, 1], ['saturation', 'Saturation', -100, 100, 1],
    ] },
    { title: 'Presence & detail', controls: [
        ['texture', 'Texture', -100, 100, 1], ['clarity', 'Clarity', -100, 100, 1],
        ['dehaze', 'Dehaze', -100, 100, 1], ['sharpening', 'Sharpening', 0, 100, 1],
        ['sharpeningRadius', 'Sharpen radius', 1, 3, 1], ['sharpeningDetail', 'Sharpen detail', 0, 100, 1],
        ['noiseLuminance', 'Luminance noise', 0, 100, 1], ['noiseColor', 'Color noise', 0, 100, 1],
        ['vignette', 'Vignette', -100, 100, 1], ['grain', 'Grain', 0, 100, 1],
    ] },
]

function RangeControl({ label, value, min, max, step, onChange, onLiveChange, onEditStart, onEditEnd, onReset }) {
    const startLiveEdit = () => onEditStart?.()
    const finishLiveEdit = () => onEditEnd?.()
    return (
        <label className="editor-range">
            <span>{label}</span>
            <input
                aria-label={label}
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onPointerDown={startLiveEdit}
                onPointerUp={finishLiveEdit}
                onPointerCancel={finishLiveEdit}
                onKeyUp={finishLiveEdit}
                onBlur={finishLiveEdit}
                onChange={(event) => {
                    startLiveEdit()
                    const changeHandler = onLiveChange || onChange
                    changeHandler(Number(event.target.value))
                }}
            />
            <input aria-label={`${label} value`} type="number" min={min} max={max} step={step} value={Number(value.toFixed?.(2) ?? value)} onChange={(event) => onChange(Number(event.target.value))} onDoubleClick={onReset} />
        </label>
    )
}

function Histogram({ histogram }) {
    const points = (values) => {
        if (!values) return ''
        const max = Math.max(1, ...values)
        return values.map((value, index) => `${(index / 63) * 100},${48 - (value / max) * 46}`).join(' ')
    }
    return (
        <div className="editor-histogram" aria-label="RGB and luminance histogram" role="img">
            <svg viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true">
                <polyline className="luma" points={points(histogram?.luma)} />
                <polyline className="red" points={points(histogram?.red)} />
                <polyline className="green" points={points(histogram?.green)} />
                <polyline className="blue" points={points(histogram?.blue)} />
            </svg>
        </div>
    )
}

function ControlSection({ title, children, defaultOpen = false }) {
    return (
        <details className="editor-control-section" open={defaultOpen}>
            <summary>{title}</summary>
            <div className="editor-control-body">{children}</div>
        </details>
    )
}

function formatMetadata(metadata) {
    return [
        metadata?.make && metadata?.model ? `${metadata.make} ${metadata.model}` : metadata?.model,
        metadata?.lens,
        metadata?.focalLength && `${metadata.focalLength}mm`,
        metadata?.aperture && `f/${metadata.aperture}`,
        metadata?.exposure && `${metadata.exposure}s`,
        metadata?.iso && `ISO ${metadata.iso}`,
    ].filter(Boolean).join(' · ')
}

function createCanvasFromPixels(pixels, width, height) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d', { alpha: false }).putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0)
    return canvas
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function restoreSnapshots(candidate) {
    if (!Array.isArray(candidate)) return []
    return candidate.slice(-40).flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        return [{
            adjustments: sanitizeAdjustments(item.adjustments),
            geometry: sanitizeGeometry(item.geometry),
        }]
    })
}

function restoreExportOptions(candidate = {}) {
    const formats = new Set(['jpeg', 'png', 'webp'])
    const resizeModes = new Set(['original', 'longEdge', 'width', 'height'])
    return {
        format: formats.has(candidate.format) ? candidate.format : DEFAULT_EXPORT_OPTIONS.format,
        quality: Math.min(100, Math.max(1, Number(candidate.quality) || DEFAULT_EXPORT_OPTIONS.quality)),
        resizeMode: resizeModes.has(candidate.resizeMode) ? candidate.resizeMode : DEFAULT_EXPORT_OPTIONS.resizeMode,
        size: Math.min(20000, Math.max(1, Number(candidate.size) || DEFAULT_EXPORT_OPTIONS.size)),
        suffix: typeof candidate.suffix === 'string'
            ? candidate.suffix.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 80)
            : DEFAULT_EXPORT_OPTIONS.suffix,
    }
}

function storedPreviewQuality() {
    try {
        const stored = localStorage.getItem(PREVIEW_QUALITY_KEY)
        return PREVIEW_QUALITIES[stored] ? stored : 'balanced'
    } catch {
        return 'balanced'
    }
}

function previewPair(source, quality) {
    const profile = PREVIEW_QUALITIES[quality] || PREVIEW_QUALITIES.balanced
    const full = makePreviewSource(source, profile.fullEdge)
    return { full, fast: makePreviewSource(full, profile.liveEdge) }
}

export default function Editor() {
    const fileInputRef = useRef(null)
    const sidecarInputRef = useRef(null)
    const shellRef = useRef(null)
    const stageRef = useRef(null)
    const afterCanvasRef = useRef(null)
    const beforeCanvasRef = useRef(null)
    const workerRef = useRef(null)
    const renderIdRef = useRef(0)
    const previewSourceVersionRef = useRef(0)
    const previewRenderRef = useRef({ busy: false, pending: null, active: null, controller: null })
    const drainPreviewQueueRef = useRef(null)
    const liveRendererRef = useRef(null)
    const liveRenderFrameRef = useRef(null)
    const originalPreviewCanvasRef = useRef({ preview: null, canvas: null })
    const panStartRef = useRef(null)
    const suppressImageClickRef = useRef(false)
    const liveEditStartRef = useRef(null)
    const openGenerationRef = useRef(0)
    const restorePromiseRef = useRef(null)
    const [source, setSource] = useState(null)
    const [preview, setPreview] = useState(null)
    const [fastPreview, setFastPreview] = useState(null)
    const [filename, setFilename] = useState('')
    const [adjustments, setAdjustments] = useState(freshAdjustments)
    const [geometry, setGeometry] = useState(freshGeometry)
    const [history, setHistory] = useState([])
    const [future, setFuture] = useState([])
    const [status, setStatus] = useState('Choose a photo to begin')
    const [error, setError] = useState('')
    const [histogram, setHistogram] = useState(null)
    const [isDragging, setIsDragging] = useState(false)
    const [isPanning, setIsPanning] = useState(false)
    const [isLiveEditing, setIsLiveEditing] = useState(false)
    const [livePreviewEngine, setLivePreviewEngine] = useState('worker')
    const [isFullscreen, setIsFullscreen] = useState(false)
    const [isProcessing, setIsProcessing] = useState(false)
    const [showClipping, setShowClipping] = useState(false)
    const [compare, setCompare] = useState(false)
    const [comparePosition, setComparePosition] = useState(50)
    const [zoom, setZoom] = useState('fit')
    const [pan, setPan] = useState({ x: 0, y: 0 })
    const [displaySize, setDisplaySize] = useState({ width: 1, height: 1 })
    const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 })
    const [sessionSourceReady, setSessionSourceReady] = useState(false)
    const [sessionStatus, setSessionStatus] = useState('No saved session')
    const [previewQuality, setPreviewQuality] = useState(storedPreviewQuality)
    const [customPresets, setCustomPresets] = useState(() => {
        try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '{}') } catch { return {} }
    })
    const [exportOptions, setExportOptions] = useState(() => ({ ...DEFAULT_EXPORT_OPTIONS }))
    const [exportState, setExportState] = useState({ active: false, progress: 0, label: '' })
    const exportWorkerRef = useRef(null)
    const exportControllerRef = useRef(null)

    const restartPreviewWorker = useCallback(() => {
        workerRef.current?.terminate()
        workerRef.current = new Worker(new URL('../editor/editorWorker.js', import.meta.url), { type: 'module' })
    }, [])

    useEffect(() => {
        const previewQueue = previewRenderRef.current
        restartPreviewWorker()
        return () => {
            previewQueue.pending = null
            previewQueue.controller?.abort()
            workerRef.current?.terminate()
        }
    }, [restartPreviewWorker])

    useEffect(() => {
        liveRendererRef.current = createLivePreviewRenderer()
        setLivePreviewEngine(liveRendererRef.current ? 'gpu' : 'worker')
        return () => {
            if (liveRenderFrameRef.current) window.cancelAnimationFrame(liveRenderFrameRef.current)
            liveRendererRef.current?.dispose()
            liveRendererRef.current = null
        }
    }, [])

    useEffect(() => {
        const stage = stageRef.current
        if (!stage) return undefined
        const updateViewport = () => setViewportSize({
            width: Math.max(1, stage.clientWidth),
            height: Math.max(1, stage.clientHeight),
        })
        const frame = window.requestAnimationFrame(updateViewport)
        if (!globalThis.ResizeObserver) return () => window.cancelAnimationFrame(frame)
        const observer = new ResizeObserver(updateViewport)
        observer.observe(stage)
        return () => {
            window.cancelAnimationFrame(frame)
            observer.disconnect()
        }
    }, [])

    useEffect(() => {
        const updateFullscreenState = () => setIsFullscreen(document.fullscreenElement === shellRef.current)
        document.addEventListener('fullscreenchange', updateFullscreenState)
        return () => document.removeEventListener('fullscreenchange', updateFullscreenState)
    }, [])

    const snapshot = useCallback(() => ({ adjustments: structuredClone(adjustments), geometry: structuredClone(geometry) }), [adjustments, geometry])
    const commit = useCallback((nextAdjustments = adjustments, nextGeometry = geometry) => {
        setHistory((items) => [...items.slice(-39), snapshot()])
        setFuture([])
        setAdjustments(sanitizeAdjustments(nextAdjustments))
        setGeometry(sanitizeGeometry(nextGeometry))
    }, [adjustments, geometry, snapshot])

    const beginLiveEdit = useCallback(() => {
        if (!liveEditStartRef.current) liveEditStartRef.current = snapshot()
        setIsLiveEditing(true)
    }, [snapshot])

    const updateAdjustmentsLive = useCallback((nextAdjustments) => {
        setAdjustments(sanitizeAdjustments(nextAdjustments))
    }, [])

    const finishLiveEdit = useCallback(() => {
        setIsLiveEditing(false)
        if (!liveEditStartRef.current) return
        const startingSnapshot = liveEditStartRef.current
        liveEditStartRef.current = null
        setHistory((items) => [...items.slice(-39), startingSnapshot])
        setFuture([])
    }, [])

    const updateGeometryLive = useCallback((nextGeometry) => {
        setGeometry(sanitizeGeometry(nextGeometry))
    }, [])

    useEffect(() => {
        if (!isLiveEditing) return undefined
        const finish = () => finishLiveEdit()
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        return () => {
            window.removeEventListener('pointerup', finish)
            window.removeEventListener('pointercancel', finish)
        }
    }, [finishLiveEdit, isLiveEditing])

    const undo = useCallback(() => {
        if (!history.length) return
        const previous = history.at(-1)
        setFuture((items) => [snapshot(), ...items].slice(0, 40))
        setHistory((items) => items.slice(0, -1))
        setAdjustments(previous.adjustments)
        setGeometry(previous.geometry)
    }, [history, snapshot])

    const redo = useCallback(() => {
        if (!future.length) return
        const next = future[0]
        setHistory((items) => [...items.slice(-39), snapshot()])
        setFuture((items) => items.slice(1))
        setAdjustments(next.adjustments)
        setGeometry(next.geometry)
    }, [future, snapshot])

    useEffect(() => {
        const keydown = (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
                event.preventDefault()
                if (event.shiftKey) redo(); else undo()
            }
            if (event.key === '\\') setCompare(true)
            if (event.key === '0' && !event.metaKey && !event.ctrlKey) setZoom('fit')
            if (event.key === '1' && !event.metaKey && !event.ctrlKey) setZoom(100)
        }
        const keyup = (event) => { if (event.key === '\\') setCompare(false) }
        window.addEventListener('keydown', keydown)
        window.addEventListener('keyup', keyup)
        return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup) }
    }, [redo, undo])

    const paintPreview = useCallback((processedSource, task, nextHistogram) => {
        if (task.renderId !== renderIdRef.current || !afterCanvasRef.current || !beforeCanvasRef.current) return false
        if (originalPreviewCanvasRef.current.preview !== task.fullPreview) {
            originalPreviewCanvasRef.current = {
                preview: task.fullPreview,
                canvas: createCanvasFromPixels(task.fullPreview.pixels, task.fullPreview.width, task.fullPreview.height),
            }
        }
        const dimensions = fittedGeometryDimensions(task.fullPreview.width, task.fullPreview.height, task.geometry)
        drawGeometryAtSize(processedSource, afterCanvasRef.current, task.geometry, dimensions.width, dimensions.height)
        drawGeometryAtSize(originalPreviewCanvasRef.current.canvas, beforeCanvasRef.current, task.geometry, dimensions.width, dimensions.height)
        setDisplaySize(dimensions)
        if (nextHistogram) setHistogram(nextHistogram)
        setError('')
        setStatus(`${task.fullPreview.width} × ${task.fullPreview.height} working preview`)
        return true
    }, [])

    const drainPreviewQueue = useCallback(async () => {
        const queue = previewRenderRef.current
        if (queue.busy || !workerRef.current) return
        queue.busy = true
        setIsProcessing(true)
        try {
            while (queue.pending) {
                const task = queue.pending
                queue.pending = null
                queue.active = task
                const controller = new AbortController()
                queue.controller = controller
                try {
                    const result = await workerRequest(workerRef.current, task.workingPreview, task.adjustments, task.showClipping, {
                        signal: controller.signal,
                        timeoutMs: task.quality === 'fast' ? 4000 : 12000,
                        sourceId: task.sourceId,
                        includeHistogram: task.quality === 'full',
                        outputType: 'bitmap',
                    })
                    const processedSource = result.bitmap || createCanvasFromPixels(
                        result.pixels,
                        result.width || task.workingPreview.width,
                        result.height || task.workingPreview.height,
                    )
                    paintPreview(processedSource, task, result.histogram)
                    result.bitmap?.close()
                } catch (processingError) {
                    if (processingError.name === 'AbortError') continue
                    restartPreviewWorker()
                    if (task.renderId === renderIdRef.current && !task.retried && !queue.pending) {
                        queue.pending = { ...task, retried: true }
                    } else if (task.renderId === renderIdRef.current && !queue.pending) {
                        setError(`${processingError.message} Try moving the control again.`)
                    }
                } finally {
                    if (queue.controller === controller) queue.controller = null
                    if (queue.active === task) queue.active = null
                }
            }
        } finally {
            queue.busy = false
            queue.active = null
            queue.controller = null
            setIsProcessing(false)
            if (queue.pending) window.queueMicrotask(() => drainPreviewQueueRef.current?.())
        }
    }, [paintPreview, restartPreviewWorker])

    useEffect(() => {
        drainPreviewQueueRef.current = drainPreviewQueue
    }, [drainPreviewQueue])

    useEffect(() => {
        if (!preview || !fastPreview || !workerRef.current) return
        const renderId = ++renderIdRef.current
        const queue = previewRenderRef.current
        const quality = isLiveEditing ? 'fast' : 'full'
        const task = {
            renderId,
            quality,
            workingPreview: quality === 'fast' ? fastPreview : preview,
            fullPreview: preview,
            sourceId: `${previewSourceVersionRef.current}:${quality}`,
            adjustments,
            geometry,
            showClipping,
            retried: false,
        }
        if (quality === 'fast' && liveRendererRef.current) {
            queue.pending = null
            if (queue.active) {
                queue.controller?.abort()
                restartPreviewWorker()
            }
            if (liveRenderFrameRef.current) window.cancelAnimationFrame(liveRenderFrameRef.current)
            liveRenderFrameRef.current = window.requestAnimationFrame(() => {
                liveRenderFrameRef.current = null
                if (task.renderId !== renderIdRef.current || !liveRendererRef.current) return
                try {
                    const rendered = liveRendererRef.current.render(task.workingPreview, task.adjustments, task.showClipping)
                    paintPreview(rendered, task, null)
                    setIsProcessing(false)
                } catch {
                    liveRendererRef.current?.dispose()
                    liveRendererRef.current = null
                    setLivePreviewEngine('worker')
                    queue.pending = task
                    void drainPreviewQueue()
                }
            })
            return () => {
                if (liveRenderFrameRef.current) {
                    window.cancelAnimationFrame(liveRenderFrameRef.current)
                    liveRenderFrameRef.current = null
                }
            }
        }
        queue.pending = task
        if (quality === 'fast' && queue.active?.quality === 'full') {
            queue.controller?.abort()
            restartPreviewWorker()
        }
        void drainPreviewQueue()
    }, [adjustments, drainPreviewQueue, fastPreview, geometry, isLiveEditing, paintPreview, preview, restartPreviewWorker, showClipping])

    const openFile = useCallback(async (file, { restoredState = null, fromRecovery = false } = {}) => {
        if (!file) return
        if (!file.type.startsWith('image/') && !isRawFile(file)) {
            setError('Choose a supported photo or camera RAW file.')
            return
        }
        if (fromRecovery && openGenerationRef.current > 0) return
        const generation = ++openGenerationRef.current
        setError('')
        setStatus(isRawFile(file) ? 'Preparing RAW file' : 'Reading photo')
        setSessionSourceReady(false)
        setSessionStatus(fromRecovery ? 'Recovering local session…' : 'Saving local session…')
        setIsProcessing(true)
        const queue = previewRenderRef.current
        queue.pending = null
        queue.controller?.abort()
        restartPreviewWorker()
        try {
            const decoded = isRawFile(file)
                ? await decodeRawFile(file, setStatus)
                : await decodeStandardFile(file)
            if (generation !== openGenerationRef.current) return
            const nextAdjustments = restoredState ? sanitizeAdjustments(restoredState.adjustments) : freshAdjustments()
            const nextGeometry = restoredState ? sanitizeGeometry(restoredState.geometry) : freshGeometry()
            const nextZoom = !restoredState || restoredState.zoom === 'fit'
                ? 'fit'
                : Math.min(400, Math.max(25, Number(restoredState?.zoom) || 100))
            const nextPan = {
                x: Number.isFinite(Number(restoredState?.pan?.x)) ? Number(restoredState.pan.x) : 0,
                y: Number.isFinite(Number(restoredState?.pan?.y)) ? Number(restoredState.pan.y) : 0,
            }
            const nextPreviews = previewPair(decoded, previewQuality)
            previewSourceVersionRef.current += 1
            setSource(decoded)
            setPreview(nextPreviews.full)
            setFastPreview(nextPreviews.fast)
            originalPreviewCanvasRef.current = { preview: null, canvas: null }
            setFilename(file.name.replace(/\.[^.]+$/, ''))
            setAdjustments(nextAdjustments)
            setGeometry(nextGeometry)
            setHistory(restoreSnapshots(restoredState?.history))
            setFuture(restoreSnapshots(restoredState?.future))
            setShowClipping(Boolean(restoredState?.showClipping))
            setCompare(Boolean(restoredState?.compare))
            setComparePosition(Number.isFinite(Number(restoredState?.comparePosition))
                ? Math.min(100, Math.max(0, Number(restoredState.comparePosition)))
                : 50)
            setZoom(nextZoom)
            setPan(nextPan)
            setExportOptions(restoreExportOptions(restoredState?.exportOptions))
            setStatus(`${decoded.width} × ${decoded.height}${decoded.metadata.raw ? ' RAW' : ''} ${fromRecovery ? 'recovered' : 'loaded'} locally`)
            if (fromRecovery) {
                setSessionSourceReady(true)
                setSessionStatus('Recovered locally')
            } else {
                try {
                    await saveEditorSource(file)
                    if (generation !== openGenerationRef.current) return
                    await saveEditorState({
                        adjustments: nextAdjustments,
                        geometry: nextGeometry,
                        history: [],
                        future: [],
                        exportOptions: restoreExportOptions(),
                        showClipping: false,
                        compare: false,
                        comparePosition: 50,
                        zoom: 'fit',
                        pan: { x: 0, y: 0 },
                    })
                    if (generation !== openGenerationRef.current) return
                    setSessionSourceReady(true)
                    setSessionStatus('Saved locally')
                } catch {
                    if (generation === openGenerationRef.current) {
                        await clearEditorSession().catch(() => {})
                        setSessionStatus('Local recovery unavailable')
                    }
                }
            }
        } catch (loadError) {
            if (generation !== openGenerationRef.current) return
            setSource(null)
            setPreview(null)
            setFastPreview(null)
            setError(loadError instanceof Error ? loadError.message : 'This photo could not be opened.')
            setStatus('Choose another photo')
            setSessionSourceReady(false)
            setSessionStatus('No saved session')
            if (fromRecovery) await clearEditorSession().catch(() => {})
        } finally {
            if (generation === openGenerationRef.current) setIsProcessing(previewRenderRef.current.busy)
        }
    }, [previewQuality, restartPreviewWorker])

    useEffect(() => {
        if (!restorePromiseRef.current) restorePromiseRef.current = loadEditorSession()
        let active = true
        restorePromiseRef.current
            .then((session) => {
                if (active && session) void openFile(session.file, { restoredState: session.state, fromRecovery: true })
            })
            .catch(() => {
                if (active) setSessionStatus('Local recovery unavailable')
            })
        return () => { active = false }
    }, [openFile])

    useEffect(() => {
        if (!source || !sessionSourceReady) return undefined
        const recoverableState = {
            adjustments,
            geometry,
            history,
            future,
            exportOptions,
            showClipping,
            compare,
            comparePosition,
            zoom,
            pan,
        }
        const saveState = () => saveEditorState(recoverableState)
        const timer = window.setTimeout(() => {
            saveState().then(() => setSessionStatus('Saved locally'))
                .catch(() => setSessionStatus('Local recovery unavailable'))
        }, 450)
        const flushSession = () => { void saveState() }
        window.addEventListener('pagehide', flushSession)
        return () => {
            window.clearTimeout(timer)
            window.removeEventListener('pagehide', flushSession)
        }
    }, [adjustments, compare, comparePosition, exportOptions, future, geometry, history, pan, sessionSourceReady, showClipping, source, zoom])

    useEffect(() => {
        const paste = (event) => {
            const file = [...(event.clipboardData?.files || [])].find((item) => item.type.startsWith('image/'))
            if (file) void openFile(file)
        }
        window.addEventListener('paste', paste)
        return () => window.removeEventListener('paste', paste)
    }, [openFile])

    const changeAdjustment = (key, value) => commit({ ...adjustments, [key]: value }, geometry)
    const resetAdjustment = (key) => changeAdjustment(key, freshAdjustments()[key])

    const setAspect = (aspect) => {
        if (!source) return
        commit(adjustments, { ...geometry, aspect, crop: cropForAspect(source.width, source.height, aspect) })
    }

    const savePreset = () => {
        const name = window.prompt('Name this preset')?.trim()
        if (!name) return
        const next = { ...customPresets, [name]: adjustments }
        setCustomPresets(next)
        localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(next))
    }

    const copySettings = async () => {
        await navigator.clipboard.writeText(serializeSidecar(adjustments, geometry, filename))
        setStatus('Settings copied')
    }

    const pasteSettings = async () => {
        try {
            const sidecar = parseSidecar(await navigator.clipboard.readText())
            commit(sidecar.adjustments, sidecar.geometry)
            setStatus('Settings pasted')
        } catch (clipboardError) { setError(clipboardError.message) }
    }

    const exportSidecar = () => downloadBlob(new Blob([serializeSidecar(adjustments, geometry, filename)], { type: 'application/json' }), `${filename || 'photo'}.ianedit.json`)

    const importSidecar = async (file) => {
        try {
            const sidecar = parseSidecar(await file.text())
            commit(sidecar.adjustments, sidecar.geometry)
            setStatus('Sidecar applied')
        } catch (sidecarError) { setError(sidecarError.message) }
    }

    const exportImage = async () => {
        if (!source || exportState.active) return
        setExportState({ active: true, progress: 8, label: 'Preparing full-resolution pixels' })
        setError('')
        const worker = new Worker(new URL('../editor/editorWorker.js', import.meta.url), { type: 'module' })
        const controller = new AbortController()
        exportWorkerRef.current = worker
        exportControllerRef.current = controller
        try {
            const result = await workerRequest(worker, source, adjustments, false, {
                signal: controller.signal,
                timeoutMs: 180_000,
                timeoutMessage: 'The full-resolution export took too long. Try a smaller output size or lower preview quality, then export again.',
                reportProgress: true,
                onProgress: (progress) => setExportState({
                    active: true,
                    progress: 8 + Math.round(progress * 62),
                    label: 'Applying edits at full resolution',
                }),
            })
            setExportState({ active: true, progress: 72, label: 'Rendering geometry' })
            const processed = createCanvasFromPixels(result.pixels, source.width, source.height)
            const dimensions = outputDimensions(source.width, source.height, geometry, { mode: exportOptions.resizeMode, value: exportOptions.size })
            const output = document.createElement('canvas')
            drawGeometry(processed, output, geometry, dimensions.width, dimensions.height)
            setExportState({ active: true, progress: 90, label: 'Encoding file' })
            const type = `image/${exportOptions.format}`
            const blob = await canvasToBlob(output, type, exportOptions.quality / 100)
            const extension = exportOptions.format === 'jpeg' ? 'jpg' : exportOptions.format
            downloadBlob(blob, `${filename || 'photo'}${exportOptions.suffix}.${extension}`)
            setExportState({ active: false, progress: 100, label: 'Export complete' })
            setStatus(`Exported ${output.width} × ${output.height} ${extension.toUpperCase()} in sRGB with metadata removed`)
        } catch (exportError) {
            if (exportError.name !== 'AbortError') setError(exportError.message)
            setExportState({ active: false, progress: 0, label: '' })
        } finally {
            worker.terminate()
            if (exportWorkerRef.current === worker) exportWorkerRef.current = null
            if (exportControllerRef.current === controller) exportControllerRef.current = null
        }
    }

    const cancelExport = () => {
        exportControllerRef.current?.abort()
        exportControllerRef.current = null
        exportWorkerRef.current?.terminate()
        exportWorkerRef.current = null
        setExportState({ active: false, progress: 0, label: 'Export cancelled' })
        setStatus('Export cancelled')
    }

    const closePhoto = async () => {
        ++openGenerationRef.current
        ++renderIdRef.current
        previewRenderRef.current.pending = null
        previewRenderRef.current.controller?.abort()
        if (liveRenderFrameRef.current) {
            window.cancelAnimationFrame(liveRenderFrameRef.current)
            liveRenderFrameRef.current = null
        }
        restartPreviewWorker()
        exportControllerRef.current?.abort()
        exportControllerRef.current = null
        exportWorkerRef.current?.terminate()
        exportWorkerRef.current = null
        setSource(null)
        setPreview(null)
        setFastPreview(null)
        setFilename('')
        setAdjustments(freshAdjustments())
        setGeometry(freshGeometry())
        setHistory([])
        setFuture([])
        setHistogram(null)
        setShowClipping(false)
        setCompare(false)
        setComparePosition(50)
        setZoom('fit')
        setPan({ x: 0, y: 0 })
        setIsPanning(false)
        setIsLiveEditing(false)
        liveEditStartRef.current = null
        originalPreviewCanvasRef.current = { preview: null, canvas: null }
        setDisplaySize({ width: 1, height: 1 })
        setExportOptions({ ...DEFAULT_EXPORT_OPTIONS })
        setExportState({ active: false, progress: 0, label: '' })
        setIsProcessing(false)
        setError('')
        setStatus('Choose a photo to begin')
        setSessionSourceReady(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
        try {
            await clearEditorSession()
            setSessionStatus('No saved session')
        } catch {
            setSessionStatus('Local recovery unavailable')
        }
    }

    const fitScale = Math.min(
        1,
        Math.max(0.01, (viewportSize.width - 28) / Math.max(1, displaySize.width)),
        Math.max(0.01, (viewportSize.height - 28) / Math.max(1, displaySize.height)),
    )
    const scale = zoom === 'fit' ? fitScale : Number(zoom) / 100
    const minimumZoom = Math.max(10, Math.min(100, fitScale * 100))

    const clampPan = (candidate, nextZoom = zoom) => {
        const nextScale = nextZoom === 'fit' ? fitScale : Number(nextZoom) / 100
        const horizontalLimit = Math.max(0, (displaySize.width * nextScale - viewportSize.width) / 2)
        const verticalLimit = Math.max(0, (displaySize.height * nextScale - viewportSize.height) / 2)
        return {
            x: Math.min(horizontalLimit, Math.max(-horizontalLimit, candidate.x)),
            y: Math.min(verticalLimit, Math.max(-verticalLimit, candidate.y)),
        }
    }

    const changeZoom = (nextZoom) => {
        const normalizedZoom = nextZoom === 'fit'
            ? 'fit'
            : Math.min(400, Math.max(minimumZoom, Number(nextZoom)))
        setZoom(normalizedZoom)
        setPan((current) => clampPan(current, normalizedZoom))
    }

    const zoomAtPoint = (nextZoom, clientX, clientY) => {
        const normalizedZoom = Math.min(400, Math.max(minimumZoom, Number(nextZoom)))
        const nextScale = normalizedZoom / 100
        const rect = stageRef.current?.getBoundingClientRect()
        if (!rect) {
            changeZoom(normalizedZoom)
            return
        }
        const nextPan = anchoredPan({
            cursorX: clientX,
            cursorY: clientY,
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2,
            currentPan: pan,
            currentScale: scale,
            nextScale,
        })
        setZoom(normalizedZoom)
        setPan(clampPan(nextPan, normalizedZoom))
    }

    const toggleImageZoom = (clientX, clientY) => {
        if (zoom === 'fit') zoomAtPoint(fitScale >= 0.99 ? 200 : 100, clientX, clientY)
        else {
            setPan({ x: 0, y: 0 })
            changeZoom('fit')
        }
    }

    const changePreviewQuality = (nextQuality) => {
        if (!PREVIEW_QUALITIES[nextQuality]) return
        setPreviewQuality(nextQuality)
        try { localStorage.setItem(PREVIEW_QUALITY_KEY, nextQuality) } catch { /* Preference persistence is optional. */ }
        if (!source) return
        ++renderIdRef.current
        const queue = previewRenderRef.current
        queue.pending = null
        queue.controller?.abort()
        restartPreviewWorker()
        const nextPreviews = previewPair(source, nextQuality)
        previewSourceVersionRef.current += 1
        originalPreviewCanvasRef.current = { preview: null, canvas: null }
        setPreview(nextPreviews.full)
        setFastPreview(nextPreviews.fast)
        setPan({ x: 0, y: 0 })
        setZoom('fit')
    }

    const toggleFullscreen = async () => {
        if (document.fullscreenElement === shellRef.current) {
            await document.exitFullscreen?.()
            return
        }
        await shellRef.current?.requestFullscreen?.()
    }

    const metadataLine = useMemo(() => formatMetadata(source?.metadata), [source])

    return (
        <div className="editor-page">
            <header className="editor-heading">
                <h1>Photo Editor</h1>
                <p>Edit standard photos and camera RAW files entirely on your device. Nothing is uploaded or stored by the website.</p>
            </header>

            <section ref={shellRef} className="editor-shell" data-preview-engine={livePreviewEngine} aria-label="Photo editor workspace">
                <div className="editor-toolbar">
                    <div className="editor-toolbar-group">
                        <button type="button" className="editor-primary" onClick={() => fileInputRef.current?.click()}>Open photo</button>
                        <input ref={fileInputRef} className="sr-only" type="file" accept={ACCEPTED_TYPES} onChange={(event) => void openFile(event.target.files?.[0])} />
                        <button type="button" onClick={undo} disabled={!history.length}>Undo</button>
                        <button type="button" onClick={redo} disabled={!future.length}>Redo</button>
                        <button type="button" onClick={() => commit(freshAdjustments(), freshGeometry())} disabled={!source}>Reset all</button>
                        <button type="button" onClick={() => void closePhoto()} disabled={!source}>Close photo</button>
                    </div>
                    <div className="editor-toolbar-group">
                        <button type="button" className={compare ? 'is-active' : ''} onClick={() => setCompare((value) => !value)} disabled={!source}>Before / after</button>
                        <button type="button" className={showClipping ? 'is-active' : ''} onClick={() => setShowClipping((value) => !value)} disabled={!source}>Clipping</button>
                        <label className="editor-toolbar-select">
                            <span>Preview quality</span>
                            <select aria-label="Preview quality" value={previewQuality} onChange={(event) => changePreviewQuality(event.target.value)}>
                                {Object.entries(PREVIEW_QUALITIES).map(([value, profile]) => <option key={value} value={value}>{profile.label} · {profile.fullEdge}px</option>)}
                            </select>
                        </label>
                        <button type="button" className={isFullscreen ? 'is-active' : ''} onClick={() => void toggleFullscreen()} disabled={!source}>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button>
                    </div>
                </div>

                <div className="editor-main">
                    <div
                        ref={stageRef}
                        className={`editor-stage${isDragging ? ' is-dragging' : ''}${zoom !== 'fit' ? ' is-zoomed' : ''}${isPanning ? ' is-panning' : ''}`}
                        onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }}
                        onDragOver={(event) => event.preventDefault()}
                        onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false) }}
                        onDrop={(event) => { event.preventDefault(); setIsDragging(false); void openFile(event.dataTransfer.files?.[0]) }}
                        onWheel={(event) => {
                            if (!source) return
                            event.preventDefault()
                            const current = zoom === 'fit' ? fitScale * 100 : Number(zoom)
                            zoomAtPoint(current + (event.deltaY < 0 ? 12 : -12), event.clientX, event.clientY)
                        }}
                        onPointerDown={(event) => {
                            if (!source) return
                            const isImage = event.target instanceof Element && Boolean(event.target.closest('.editor-canvas-transform'))
                            if (!isImage) return
                            panStartRef.current = { x: event.clientX, y: event.clientY, pan, moved: false, isImage }
                            if (zoom !== 'fit') setIsPanning(true)
                            event.currentTarget.setPointerCapture?.(event.pointerId)
                        }}
                        onPointerMove={(event) => {
                            if (!panStartRef.current) return
                            const deltaX = event.clientX - panStartRef.current.x
                            const deltaY = event.clientY - panStartRef.current.y
                            if (Math.hypot(deltaX, deltaY) > 3) panStartRef.current.moved = true
                            if (zoom === 'fit') return
                            setPan(clampPan({ x: panStartRef.current.pan.x + deltaX, y: panStartRef.current.pan.y + deltaY }))
                        }}
                        onPointerUp={(event) => {
                            const interaction = panStartRef.current
                            panStartRef.current = null
                            setIsPanning(false)
                            event.currentTarget.releasePointerCapture?.(event.pointerId)
                            suppressImageClickRef.current = Boolean(interaction?.moved)
                            if (interaction?.moved) {
                                window.requestAnimationFrame(() => { suppressImageClickRef.current = false })
                            }
                        }}
                        onPointerCancel={() => {
                            panStartRef.current = null
                            suppressImageClickRef.current = false
                            setIsPanning(false)
                        }}
                    >
                        {!source ? (
                            <button type="button" className="editor-dropzone" onClick={() => fileInputRef.current?.click()}>
                                <span className="editor-drop-mark">+</span>
                                <strong>Drop a photo or RAW file here</strong>
                                <small>or choose a file, or paste an image from the clipboard</small>
                                <small>JPEG · PNG · WebP · AVIF · DNG · CR2 · CR3 · NEF · ARW · RAF and more</small>
                            </button>
                        ) : (
                            <div
                                className="editor-canvas-transform"
                                style={{
                                    width: `${displaySize.width}px`,
                                    height: `${displaySize.height}px`,
                                    marginLeft: `${displaySize.width / -2}px`,
                                    marginTop: `${displaySize.height / -2}px`,
                                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                                }}
                                onClick={(event) => {
                                    if (suppressImageClickRef.current) {
                                        suppressImageClickRef.current = false
                                        return
                                    }
                                    toggleImageZoom(event.clientX, event.clientY)
                                }}
                            >
                                <canvas ref={afterCanvasRef} className="editor-image-canvas" aria-label="Edited photo preview" />
                                <canvas ref={beforeCanvasRef} className="editor-image-canvas editor-before-canvas" aria-label="Original photo preview" style={{ clipPath: compare ? `inset(0 ${100 - comparePosition}% 0 0)` : 'inset(0 100% 0 0)' }} />
                                {compare && <div className="editor-compare-line" style={{ left: `${comparePosition}%` }} />}
                            </div>
                        )}
                        {isProcessing && <div className="editor-processing" role="status">Processing...</div>}
                    </div>

                    <aside className="editor-sidebar" aria-label="Editing controls">
                        <Histogram histogram={histogram} />
                        <div className="editor-status" aria-live="polite">
                            <strong>{filename || 'No photo open'}</strong>
                            <span>{status}</span>
                            {metadataLine && <span>{metadataLine}</span>}
                            {error && <span className="editor-error">{error}</span>}
                        </div>

                        {compare && <RangeControl label="Comparison split" value={comparePosition} min={0} max={100} step={1} onChange={setComparePosition} onReset={() => setComparePosition(50)} />}

                        <ControlSection title="Presets" defaultOpen>
                            <div className="editor-preset-grid">
                                {[...Object.keys(BUILT_IN_PRESETS), ...Object.keys(customPresets)].map((name) => (
                                    <button key={name} type="button" onClick={() => commit(applyPreset(name, adjustments, customPresets), geometry)}>{name}</button>
                                ))}
                            </div>
                            <button type="button" onClick={savePreset} disabled={!source}>Save current preset</button>
                        </ControlSection>

                        {RANGE_GROUPS.map((group, groupIndex) => (
                            <ControlSection key={group.title} title={group.title} defaultOpen={groupIndex === 0}>
                                {group.controls.map(([key, label, min, max, step]) => (
                                    <RangeControl
                                        key={key}
                                        label={label}
                                        value={adjustments[key]}
                                        min={min}
                                        max={max}
                                        step={step}
                                        onChange={(value) => changeAdjustment(key, value)}
                                        onLiveChange={(value) => updateAdjustmentsLive({ ...adjustments, [key]: value })}
                                        onEditStart={beginLiveEdit}
                                        onEditEnd={finishLiveEdit}
                                        onReset={() => resetAdjustment(key)}
                                    />
                                ))}
                            </ControlSection>
                        ))}

                        <ControlSection title="Tone curve">
                            <ToneCurve
                                points={adjustments.curve}
                                onEditStart={beginLiveEdit}
                                onChange={(curve) => updateAdjustmentsLive({ ...adjustments, curve })}
                                onEditEnd={finishLiveEdit}
                                onReset={() => commit({ ...adjustments, curve: freshAdjustments().curve }, geometry)}
                            />
                        </ControlSection>

                        <ControlSection title="Color mixer">
                            {COLOR_CHANNELS.map((channel) => (
                                <details key={channel} className="editor-subsection">
                                    <summary>{channel}</summary>
                                    {['hue', 'saturation', 'luminance'].map((property) => (
                                        <RangeControl
                                            key={property}
                                            label={property}
                                            value={adjustments.hsl[channel][property]}
                                            min={-100}
                                            max={100}
                                            step={1}
                                            onChange={(value) => commit({ ...adjustments, hsl: { ...adjustments.hsl, [channel]: { ...adjustments.hsl[channel], [property]: value } } }, geometry)}
                                            onLiveChange={(value) => updateAdjustmentsLive({ ...adjustments, hsl: { ...adjustments.hsl, [channel]: { ...adjustments.hsl[channel], [property]: value } } })}
                                            onEditStart={beginLiveEdit}
                                            onEditEnd={finishLiveEdit}
                                            onReset={() => {}}
                                        />
                                    ))}
                                </details>
                            ))}
                        </ControlSection>

                        <ControlSection title="Color grading">
                            {Object.entries(adjustments.grading).map(([range, values]) => (
                                <div className="editor-grading-row" key={range}>
                                    <strong>{range}</strong>
                                    <ColorWheel
                                        label={range}
                                        hue={values.hue}
                                        saturation={values.saturation}
                                        onEditStart={beginLiveEdit}
                                        onChange={(next) => updateAdjustmentsLive({ ...adjustments, grading: { ...adjustments.grading, [range]: next } })}
                                        onEditEnd={finishLiveEdit}
                                    />
                                    <RangeControl label={`${range} hue`} value={values.hue} min={0} max={359} step={1} onChange={(value) => commit({ ...adjustments, grading: { ...adjustments.grading, [range]: { ...values, hue: value } } }, geometry)} onLiveChange={(value) => updateAdjustmentsLive({ ...adjustments, grading: { ...adjustments.grading, [range]: { ...values, hue: value } } })} onEditStart={beginLiveEdit} onEditEnd={finishLiveEdit} onReset={() => {}} />
                                    <RangeControl label={`${range} saturation`} value={values.saturation} min={0} max={100} step={1} onChange={(value) => commit({ ...adjustments, grading: { ...adjustments.grading, [range]: { ...values, saturation: value } } }, geometry)} onLiveChange={(value) => updateAdjustmentsLive({ ...adjustments, grading: { ...adjustments.grading, [range]: { ...values, saturation: value } } })} onEditStart={beginLiveEdit} onEditEnd={finishLiveEdit} onReset={() => {}} />
                                </div>
                            ))}
                        </ControlSection>

                        <ControlSection title="Black & white">
                            <label className="editor-check"><input type="checkbox" checked={adjustments.blackAndWhite} onChange={(event) => changeAdjustment('blackAndWhite', event.target.checked)} /> Enable black and white</label>
                            {COLOR_CHANNELS.map((channel) => <RangeControl key={channel} label={channel} value={adjustments.bwMixer[channel]} min={-100} max={100} step={1} onChange={(value) => commit({ ...adjustments, bwMixer: { ...adjustments.bwMixer, [channel]: value } }, geometry)} onLiveChange={(value) => updateAdjustmentsLive({ ...adjustments, bwMixer: { ...adjustments.bwMixer, [channel]: value } })} onEditStart={beginLiveEdit} onEditEnd={finishLiveEdit} onReset={() => {}} />)}
                        </ControlSection>

                        <ControlSection title="Crop & geometry">
                            <label className="editor-select">Aspect ratio<select value={geometry.aspect} onChange={(event) => setAspect(event.target.value)}><option value="free">Free</option><option value="original">Original</option><option value="1:1">1 : 1</option><option value="4:3">4 : 3</option><option value="3:2">3 : 2</option><option value="16:9">16 : 9</option><option value="5:4">5 : 4</option></select></label>
                            {Object.entries(geometry.crop).map(([key, value]) => <RangeControl key={key} label={`Crop ${key}`} value={Math.round(value * 100)} min={key === 'x' || key === 'y' ? 0 : 1} max={100} step={1} onChange={(nextValue) => commit(adjustments, { ...geometry, crop: { ...geometry.crop, [key]: nextValue / 100 }, aspect: 'free' })} onLiveChange={(nextValue) => updateGeometryLive({ ...geometry, crop: { ...geometry.crop, [key]: nextValue / 100 }, aspect: 'free' })} onEditStart={beginLiveEdit} onEditEnd={finishLiveEdit} onReset={() => {}} />)}
                            <RangeControl label="Straighten" value={geometry.rotation} min={-45} max={45} step={0.1} onChange={(value) => commit(adjustments, { ...geometry, rotation: value })} onLiveChange={(value) => updateGeometryLive({ ...geometry, rotation: value })} onEditStart={beginLiveEdit} onEditEnd={finishLiveEdit} onReset={() => commit(adjustments, { ...geometry, rotation: 0 })} />
                            <RangeControl label="Vertical perspective" value={geometry.vertical} min={-30} max={30} step={0.5} onChange={(value) => commit(adjustments, { ...geometry, vertical: value })} onLiveChange={(value) => updateGeometryLive({ ...geometry, vertical: value })} onEditStart={beginLiveEdit} onEditEnd={finishLiveEdit} onReset={() => {}} />
                            <RangeControl label="Horizontal perspective" value={geometry.horizontal} min={-30} max={30} step={0.5} onChange={(value) => commit(adjustments, { ...geometry, horizontal: value })} onLiveChange={(value) => updateGeometryLive({ ...geometry, horizontal: value })} onEditStart={beginLiveEdit} onEditEnd={finishLiveEdit} onReset={() => {}} />
                            <div className="editor-button-row">
                                <button type="button" onClick={() => commit(adjustments, { ...geometry, quarterTurns: geometry.quarterTurns - 1 })}>Rotate left</button>
                                <button type="button" onClick={() => commit(adjustments, { ...geometry, quarterTurns: geometry.quarterTurns + 1 })}>Rotate right</button>
                                <button type="button" onClick={() => commit(adjustments, { ...geometry, flipX: !geometry.flipX })}>Flip H</button>
                                <button type="button" onClick={() => commit(adjustments, { ...geometry, flipY: !geometry.flipY })}>Flip V</button>
                            </div>
                        </ControlSection>

                        <ControlSection title="Settings & sidecar">
                            <div className="editor-button-grid">
                                <button type="button" onClick={() => void copySettings()} disabled={!source}>Copy settings</button>
                                <button type="button" onClick={() => void pasteSettings()}>Paste settings</button>
                                <button type="button" onClick={exportSidecar} disabled={!source}>Download sidecar</button>
                                <button type="button" onClick={() => sidecarInputRef.current?.click()}>Import sidecar</button>
                                <input ref={sidecarInputRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void importSidecar(event.target.files?.[0])} />
                            </div>
                        </ControlSection>

                        <ControlSection title="Export" defaultOpen>
                            <div className="editor-export-options">
                                <label className="editor-select">Format<select value={exportOptions.format} onChange={(event) => setExportOptions({ ...exportOptions, format: event.target.value })}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select></label>
                                <label className="editor-select">Dimensions<select value={exportOptions.resizeMode} onChange={(event) => setExportOptions({ ...exportOptions, resizeMode: event.target.value })}><option value="original">Original size</option><option value="longEdge">Long edge</option><option value="width">Width</option><option value="height">Height</option></select></label>
                            </div>
                            <RangeControl label="Quality" value={exportOptions.quality} min={1} max={100} step={1} onChange={(quality) => setExportOptions({ ...exportOptions, quality })} onReset={() => setExportOptions({ ...exportOptions, quality: 92 })} />
                            {exportOptions.resizeMode !== 'original' && <label className="editor-text-field">Pixels<input type="number" min="1" max="20000" value={exportOptions.size} onChange={(event) => setExportOptions({ ...exportOptions, size: Number(event.target.value) })} /></label>}
                            <label className="editor-text-field">Filename suffix<input value={exportOptions.suffix} onChange={(event) => setExportOptions({ ...exportOptions, suffix: event.target.value.replace(/[^a-zA-Z0-9-_]/g, '') })} /></label>
                            <p className="editor-export-note">Exports use sRGB and remove camera and location metadata by default.</p>
                            {exportState.active ? (
                                <div className="editor-export-progress" role="status"><progress max="100" value={exportState.progress} /><span>{exportState.label}</span><button type="button" onClick={cancelExport}>Cancel</button></div>
                            ) : <button type="button" className="editor-export-button" onClick={() => void exportImage()} disabled={!source}>Export photo</button>}
                        </ControlSection>
                    </aside>
                </div>

                <div className="editor-viewbar">
                    <div className="editor-viewbar-status">
                        <span>{status}</span>
                        <span>{sessionStatus}</span>
                    </div>
                    <div>
                        <button type="button" onClick={() => { setPan({ x: 0, y: 0 }); changeZoom('fit') }} className={zoom === 'fit' ? 'is-active' : ''}>Fit</button>
                        <button type="button" onClick={() => changeZoom(100)} className={zoom === 100 ? 'is-active' : ''}>100%</button>
                        <button type="button" onClick={() => changeZoom((zoom === 'fit' ? fitScale * 100 : Number(zoom)) - 25)}>−</button>
                        <button type="button" onClick={() => changeZoom((zoom === 'fit' ? fitScale * 100 : Number(zoom)) + 25)}>+</button>
                    </div>
                </div>
            </section>

        </div>
    )
}
