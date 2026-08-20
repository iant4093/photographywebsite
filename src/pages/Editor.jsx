import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COLOR_CHANNELS, freshAdjustments, freshGeometry, sanitizeAdjustments, sanitizeGeometry } from '../editor/adjustments'
import { BUILT_IN_PRESETS, applyPreset, parseSidecar, serializeSidecar } from '../editor/presets'
import { canvasToBlob, cropForAspect, drawGeometry, outputDimensions } from '../editor/canvas'
import { decodeStandardFile, makePreviewSource } from '../editor/standardDecoder'
import { decodeRawFile, isRawFile } from '../editor/rawDecoder'
import './Editor.css'

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp,image/avif,.dng,.cr2,.cr3,.nef,.nrw,.arw,.raf,.rw2,.orf,.pef,.srw,.3fr,.fff,.iiq,.x3f,.raw'
const CUSTOM_PRESETS_KEY = 'ian-photo-editor-presets-v1'

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

function RangeControl({ label, value, min, max, step, onChange, onReset }) {
    return (
        <label className="editor-range">
            <span>{label}</span>
            <input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
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

function workerRequest(worker, source, adjustments, clipping = false) {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        const listener = ({ data }) => {
            if (data.id !== id) return
            worker.removeEventListener('message', listener)
            if (data.error) reject(new Error(data.error))
            else resolve(data)
        }
        worker.addEventListener('message', listener)
        const pixels = new Uint8ClampedArray(source.pixels)
        worker.postMessage({ id, pixels: pixels.buffer, width: source.width, height: source.height, adjustments, clipping }, [pixels.buffer])
    })
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function Editor() {
    const fileInputRef = useRef(null)
    const sidecarInputRef = useRef(null)
    const stageRef = useRef(null)
    const afterCanvasRef = useRef(null)
    const beforeCanvasRef = useRef(null)
    const workerRef = useRef(null)
    const renderIdRef = useRef(0)
    const panStartRef = useRef(null)
    const [source, setSource] = useState(null)
    const [preview, setPreview] = useState(null)
    const [filename, setFilename] = useState('')
    const [adjustments, setAdjustments] = useState(freshAdjustments)
    const [geometry, setGeometry] = useState(freshGeometry)
    const [history, setHistory] = useState([])
    const [future, setFuture] = useState([])
    const [status, setStatus] = useState('Choose a photo to begin')
    const [error, setError] = useState('')
    const [histogram, setHistogram] = useState(null)
    const [isDragging, setIsDragging] = useState(false)
    const [isProcessing, setIsProcessing] = useState(false)
    const [showClipping, setShowClipping] = useState(false)
    const [compare, setCompare] = useState(false)
    const [comparePosition, setComparePosition] = useState(50)
    const [zoom, setZoom] = useState('fit')
    const [pan, setPan] = useState({ x: 0, y: 0 })
    const [customPresets, setCustomPresets] = useState(() => {
        try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '{}') } catch { return {} }
    })
    const [exportOptions, setExportOptions] = useState({ format: 'jpeg', quality: 92, resizeMode: 'original', size: 2048, suffix: '-edited' })
    const [exportState, setExportState] = useState({ active: false, progress: 0, label: '' })
    const exportWorkerRef = useRef(null)

    useEffect(() => {
        workerRef.current = new Worker(new URL('../editor/editorWorker.js', import.meta.url), { type: 'module' })
        return () => workerRef.current?.terminate()
    }, [])

    const snapshot = useCallback(() => ({ adjustments: structuredClone(adjustments), geometry: structuredClone(geometry) }), [adjustments, geometry])
    const commit = useCallback((nextAdjustments = adjustments, nextGeometry = geometry) => {
        setHistory((items) => [...items.slice(-39), snapshot()])
        setFuture([])
        setAdjustments(sanitizeAdjustments(nextAdjustments))
        setGeometry(sanitizeGeometry(nextGeometry))
    }, [adjustments, geometry, snapshot])

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

    const drawCanvases = useCallback((processedCanvas) => {
        if (!preview || !afterCanvasRef.current || !beforeCanvasRef.current) return
        drawGeometry(processedCanvas, afterCanvasRef.current, geometry, 1800, 1200)
        drawGeometry(createCanvasFromPixels(preview.pixels, preview.width, preview.height), beforeCanvasRef.current, geometry, 1800, 1200)
    }, [geometry, preview])

    useEffect(() => {
        if (!preview || !workerRef.current) return undefined
        const renderId = ++renderIdRef.current
        const timer = window.setTimeout(async () => {
            setIsProcessing(true)
            try {
                const result = await workerRequest(workerRef.current, preview, adjustments, showClipping)
                if (renderId !== renderIdRef.current) return
                const processedCanvas = createCanvasFromPixels(result.pixels, preview.width, preview.height)
                drawCanvases(processedCanvas)
                setHistogram(result.histogram)
                setStatus(`${preview.width} × ${preview.height} working preview`)
            } catch (processingError) {
                if (renderId === renderIdRef.current) setError(processingError.message)
            } finally {
                if (renderId === renderIdRef.current) setIsProcessing(false)
            }
        }, 45)
        return () => window.clearTimeout(timer)
    }, [adjustments, drawCanvases, preview, showClipping])

    const openFile = useCallback(async (file) => {
        if (!file) return
        if (!file.type.startsWith('image/') && !isRawFile(file)) {
            setError('Choose a supported photo or camera RAW file.')
            return
        }
        setError('')
        setStatus(isRawFile(file) ? 'Preparing RAW file' : 'Reading photo')
        setIsProcessing(true)
        try {
            const decoded = isRawFile(file)
                ? await decodeRawFile(file, setStatus)
                : await decodeStandardFile(file)
            setSource(decoded)
            setPreview(makePreviewSource(decoded))
            setFilename(file.name.replace(/\.[^.]+$/, ''))
            setAdjustments(freshAdjustments())
            setGeometry(freshGeometry())
            setHistory([])
            setFuture([])
            setZoom('fit')
            setPan({ x: 0, y: 0 })
            setStatus(`${decoded.width} × ${decoded.height}${decoded.metadata.raw ? ' RAW' : ''} loaded locally`)
        } catch (loadError) {
            setSource(null)
            setPreview(null)
            setError(loadError instanceof Error ? loadError.message : 'This photo could not be opened.')
            setStatus('Choose another photo')
        } finally {
            setIsProcessing(false)
        }
    }, [])

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
        exportWorkerRef.current = worker
        try {
            const result = await workerRequest(worker, source, adjustments, false)
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
            if (exportError.message !== 'cancelled') setError(exportError.message)
            setExportState({ active: false, progress: 0, label: '' })
        } finally {
            worker.terminate()
            exportWorkerRef.current = null
        }
    }

    const cancelExport = () => {
        exportWorkerRef.current?.terminate()
        exportWorkerRef.current = null
        setExportState({ active: false, progress: 0, label: 'Export cancelled' })
        setStatus('Export cancelled')
    }

    const scale = zoom === 'fit' ? 1 : Number(zoom) / 100
    const metadataLine = useMemo(() => formatMetadata(source?.metadata), [source])

    return (
        <div className="editor-page">
            <header className="editor-heading">
                <p className="editor-kicker">Browser darkroom</p>
                <h1>Photo Editor</h1>
                <p>Edit standard photos and camera RAW files entirely on this device. Nothing is uploaded or stored by the website.</p>
            </header>

            <section className="editor-shell" aria-label="Photo editor workspace">
                <div className="editor-toolbar">
                    <div className="editor-toolbar-group">
                        <button type="button" className="editor-primary" onClick={() => fileInputRef.current?.click()}>Open photo</button>
                        <input ref={fileInputRef} className="sr-only" type="file" accept={ACCEPTED_TYPES} onChange={(event) => void openFile(event.target.files?.[0])} />
                        <button type="button" onClick={undo} disabled={!history.length}>Undo</button>
                        <button type="button" onClick={redo} disabled={!future.length}>Redo</button>
                        <button type="button" onClick={() => commit(freshAdjustments(), freshGeometry())} disabled={!source}>Reset all</button>
                    </div>
                    <div className="editor-toolbar-group">
                        <button type="button" className={compare ? 'is-active' : ''} onClick={() => setCompare((value) => !value)} disabled={!source}>Before / after</button>
                        <button type="button" className={showClipping ? 'is-active' : ''} onClick={() => setShowClipping((value) => !value)} disabled={!source}>Clipping</button>
                        <button type="button" onClick={() => stageRef.current?.requestFullscreen?.()} disabled={!source}>Fullscreen</button>
                    </div>
                </div>

                <div className="editor-main">
                    <div
                        ref={stageRef}
                        className={`editor-stage${isDragging ? ' is-dragging' : ''}`}
                        onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }}
                        onDragOver={(event) => event.preventDefault()}
                        onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false) }}
                        onDrop={(event) => { event.preventDefault(); setIsDragging(false); void openFile(event.dataTransfer.files?.[0]) }}
                        onWheel={(event) => {
                            if (!source) return
                            event.preventDefault()
                            const current = zoom === 'fit' ? 100 : Number(zoom)
                            setZoom(Math.min(400, Math.max(25, current + (event.deltaY < 0 ? 10 : -10))))
                        }}
                        onPointerDown={(event) => {
                            if (!source) return
                            panStartRef.current = { x: event.clientX, y: event.clientY, pan }
                            event.currentTarget.setPointerCapture(event.pointerId)
                        }}
                        onPointerMove={(event) => {
                            if (!panStartRef.current || zoom === 'fit') return
                            setPan({ x: panStartRef.current.pan.x + event.clientX - panStartRef.current.x, y: panStartRef.current.pan.y + event.clientY - panStartRef.current.y })
                        }}
                        onPointerUp={() => { panStartRef.current = null }}
                    >
                        {!source ? (
                            <button type="button" className="editor-dropzone" onClick={() => fileInputRef.current?.click()}>
                                <span className="editor-drop-mark">+</span>
                                <strong>Drop a photo or RAW file here</strong>
                                <small>or choose a file, or paste an image from the clipboard</small>
                                <small>JPEG · PNG · WebP · AVIF · DNG · CR2 · CR3 · NEF · ARW · RAF and more</small>
                            </button>
                        ) : (
                            <div className="editor-canvas-transform" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}>
                                <canvas ref={afterCanvasRef} className="editor-image-canvas" aria-label="Edited photo preview" />
                                <canvas ref={beforeCanvasRef} className="editor-image-canvas editor-before-canvas" aria-label="Original photo preview" style={{ clipPath: compare ? `inset(0 ${100 - comparePosition}% 0 0)` : 'inset(0 100% 0 0)' }} />
                                {compare && <div className="editor-compare-line" style={{ left: `${comparePosition}%` }} />}
                            </div>
                        )}
                        {isProcessing && <div className="editor-processing" role="status">Processing locally…</div>}
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
                                    <RangeControl key={key} label={label} value={adjustments[key]} min={min} max={max} step={step} onChange={(value) => changeAdjustment(key, value)} onReset={() => resetAdjustment(key)} />
                                ))}
                            </ControlSection>
                        ))}

                        <ControlSection title="Tone curve">
                            <div className="editor-curve-preview" aria-hidden="true"><svg viewBox="0 0 100 100"><polyline points={adjustments.curve.map((value, index) => `${index * 25},${100 - value}`).join(' ')} /></svg></div>
                            {['Black point', 'Shadows', 'Midtones', 'Highlights', 'White point'].map((label, index) => (
                                <RangeControl key={label} label={label} value={adjustments.curve[index]} min={0} max={100} step={1} onChange={(value) => { const curve = [...adjustments.curve]; curve[index] = value; changeAdjustment('curve', curve) }} onReset={() => changeAdjustment('curve', freshAdjustments().curve)} />
                            ))}
                        </ControlSection>

                        <ControlSection title="Color mixer">
                            {COLOR_CHANNELS.map((channel) => (
                                <details key={channel} className="editor-subsection">
                                    <summary>{channel}</summary>
                                    {['hue', 'saturation', 'luminance'].map((property) => (
                                        <RangeControl key={property} label={property} value={adjustments.hsl[channel][property]} min={-100} max={100} step={1} onChange={(value) => commit({ ...adjustments, hsl: { ...adjustments.hsl, [channel]: { ...adjustments.hsl[channel], [property]: value } } }, geometry)} onReset={() => {}} />
                                    ))}
                                </details>
                            ))}
                        </ControlSection>

                        <ControlSection title="Color grading">
                            {Object.entries(adjustments.grading).map(([range, values]) => (
                                <div className="editor-grading-row" key={range}>
                                    <strong>{range}</strong>
                                    <RangeControl label={`${range} hue`} value={values.hue} min={0} max={359} step={1} onChange={(value) => commit({ ...adjustments, grading: { ...adjustments.grading, [range]: { ...values, hue: value } } }, geometry)} onReset={() => {}} />
                                    <RangeControl label={`${range} saturation`} value={values.saturation} min={0} max={100} step={1} onChange={(value) => commit({ ...adjustments, grading: { ...adjustments.grading, [range]: { ...values, saturation: value } } }, geometry)} onReset={() => {}} />
                                </div>
                            ))}
                        </ControlSection>

                        <ControlSection title="Black & white">
                            <label className="editor-check"><input type="checkbox" checked={adjustments.blackAndWhite} onChange={(event) => changeAdjustment('blackAndWhite', event.target.checked)} /> Enable black and white</label>
                            {COLOR_CHANNELS.map((channel) => <RangeControl key={channel} label={channel} value={adjustments.bwMixer[channel]} min={-100} max={100} step={1} onChange={(value) => commit({ ...adjustments, bwMixer: { ...adjustments.bwMixer, [channel]: value } }, geometry)} onReset={() => {}} />)}
                        </ControlSection>

                        <ControlSection title="Crop & geometry">
                            <label className="editor-select">Aspect ratio<select value={geometry.aspect} onChange={(event) => setAspect(event.target.value)}><option value="free">Free</option><option value="original">Original</option><option value="1:1">1 : 1</option><option value="4:3">4 : 3</option><option value="3:2">3 : 2</option><option value="16:9">16 : 9</option><option value="5:4">5 : 4</option></select></label>
                            {Object.entries(geometry.crop).map(([key, value]) => <RangeControl key={key} label={`Crop ${key}`} value={Math.round(value * 100)} min={key === 'x' || key === 'y' ? 0 : 1} max={100} step={1} onChange={(nextValue) => commit(adjustments, { ...geometry, crop: { ...geometry.crop, [key]: nextValue / 100 }, aspect: 'free' })} onReset={() => {}} />)}
                            <RangeControl label="Straighten" value={geometry.rotation} min={-45} max={45} step={0.1} onChange={(value) => commit(adjustments, { ...geometry, rotation: value })} onReset={() => commit(adjustments, { ...geometry, rotation: 0 })} />
                            <RangeControl label="Vertical perspective" value={geometry.vertical} min={-30} max={30} step={0.5} onChange={(value) => commit(adjustments, { ...geometry, vertical: value })} onReset={() => {}} />
                            <RangeControl label="Horizontal perspective" value={geometry.horizontal} min={-30} max={30} step={0.5} onChange={(value) => commit(adjustments, { ...geometry, horizontal: value })} onReset={() => {}} />
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
                            <label className="editor-select">Format<select value={exportOptions.format} onChange={(event) => setExportOptions({ ...exportOptions, format: event.target.value })}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select></label>
                            <RangeControl label="Quality" value={exportOptions.quality} min={1} max={100} step={1} onChange={(quality) => setExportOptions({ ...exportOptions, quality })} onReset={() => setExportOptions({ ...exportOptions, quality: 92 })} />
                            <label className="editor-select">Dimensions<select value={exportOptions.resizeMode} onChange={(event) => setExportOptions({ ...exportOptions, resizeMode: event.target.value })}><option value="original">Original size</option><option value="longEdge">Long edge</option><option value="width">Width</option><option value="height">Height</option></select></label>
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
                    <span>{status}</span>
                    <div>
                        <button type="button" onClick={() => { setZoom('fit'); setPan({ x: 0, y: 0 }) }} className={zoom === 'fit' ? 'is-active' : ''}>Fit</button>
                        <button type="button" onClick={() => setZoom(100)} className={zoom === 100 ? 'is-active' : ''}>100%</button>
                        <button type="button" onClick={() => setZoom(Math.max(25, (zoom === 'fit' ? 100 : Number(zoom)) - 25))}>−</button>
                        <button type="button" onClick={() => setZoom(Math.min(400, (zoom === 'fit' ? 100 : Number(zoom)) + 25))}>+</button>
                    </div>
                </div>
            </section>

            <section className="editor-privacy-note">
                <strong>Private by design</strong>
                <p>The editor has no upload endpoint. Your original, edits, history, and exported files remain in this browser session or in files you explicitly save.</p>
            </section>
        </div>
    )
}
