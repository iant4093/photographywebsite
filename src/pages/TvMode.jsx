import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import useContainedImageSizes from '../hooks/useContainedImageSizes'
import { fetchAllFavoritePhotos } from '../utils/api'
import { mediaDisplayUrl, mediaId, mediaPreviewSrcSet } from '../utils/mediaUrls'
import {
    TV_INTERVALS, backdropUrl, createPreloader, fittedWidth, readTvSettings, saveTvSettings, shuffled,
    sizesFor, slideshowPhotos,
} from '../utils/tvSlideshow'
import { CAST_IDLE, canCast, createCastController, hasAirPlay, isAppleTouchDevice, loadCastSdk, watchAirPlay } from '../utils/tvCast'
import './TvMode.css'

export const FADE_MS = 1400
const IDLE_MS = 3000
const DECODE_AHEAD = 2
const WARM_AHEAD = 10

const Icon = {
    play: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z" fill="currentColor" /></svg>,
    pause: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" /></svg>,
    previous: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>,
    next: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>,
    settings: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>,
    fullscreen: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" /></svg>,
    windowed: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h5V3M21 8h-5V3M8 21v-5H3M16 21v-5h5" /></svg>,
    cast: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-6M3 13a8 8 0 0 1 8 8M3 17a4 4 0 0 1 4 4" /><path d="M3 21h.01" /></svg>,
    casting: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-6M3 13a8 8 0 0 1 8 8M3 17a4 4 0 0 1 4 4" /><path d="M3 21h.01" /><path d="M7 9h10v6h-2.5" fill="currentColor" /></svg>,
    airplay: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2" /><path d="m12 14 5 6H7Z" fill="currentColor" /></svg>,
    close: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>,
}

function cameraLine(photo) {
    const exif = photo?.exif || {}
    return [exif.model, exif.focalLength, exif.focalRatio, exif.shutterSpeed, exif.iso].filter(Boolean).join(' · ')
}

function Choice({ label, value, options, onChange }) {
    return (
        <div className="tv-setting">
            <span className="tv-setting-label">{label}</span>
            <div className="tv-choice" role="group" aria-label={label}>
                {options.map((option) => (
                    <button key={String(option.value)} type="button" aria-pressed={value === option.value}
                        onClick={() => onChange(option.value)}>
                        {option.label}
                    </button>
                ))}
            </div>
        </div>
    )
}

function Toggle({ label, checked, onChange }) {
    return (
        <label className="tv-toggle">
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
            <span aria-hidden="true" />
            {label}
        </label>
    )
}

// A full-screen slideshow of every public favorite, framed like the lightbox.
export default function TvMode() {
    const navigate = useNavigate()
    const rootRef = useRef(null)
    const { containerRef, bounds } = useContainedImageSizes()
    const [base, setBase] = useState([])
    const [photos, setPhotos] = useState([])
    const [status, setStatus] = useState('loading')
    const [attempt, setAttempt] = useState(0)
    const [settings, setSettings] = useState(readTvSettings)
    const [position, setPosition] = useState(0)
    const [layers, setLayers] = useState([])
    const [ready, setReady] = useState(() => new Set())
    const [failed, setFailed] = useState(() => new Set())
    const [playing, setPlaying] = useState(true)
    const [controls, setControls] = useState(true)
    // '' (closed), 'settings' or 'airplay'.
    const [panel, setPanel] = useState('')
    const [cast, setCast] = useState(CAST_IDLE)
    // Shown on Safari until it reports that no AirPlay receiver is nearby.
    const [airPlay, setAirPlay] = useState(hasAirPlay)
    const castController = useRef(null)
    const [fullscreen, setFullscreen] = useState(false)
    const [now, setNow] = useState(() => new Date())
    const idleTimer = useRef(0)
    const swipe = useRef(null)

    const preloader = useMemo(() => createPreloader({
        onReady: (key, ok) => (ok ? setReady : setFailed)((current) => new Set(current).add(key)),
    }), [])
    useEffect(() => () => preloader.clear(), [preloader])

    useEffect(() => {
        let active = true
        fetchAllFavoritePhotos()
            .then((payload) => {
                if (!active) return
                const list = slideshowPhotos(payload.images)
                setBase(list)
                setPhotos(readTvSettings().order === 'shuffle' ? shuffled(list) : list)
                setPosition(0)
                setStatus(list.length ? 'ready' : 'empty')
            }, () => {
                if (active) setStatus('error')
            })
        return () => { active = false }
    }, [attempt])

    const count = photos.length
    const target = photos[position]
    const targetKey = target ? mediaId(target) : ''
    const current = layers.at(-1)

    // Show the target once it is decoded; skip one that cannot load.
    if (targetKey && ready.has(targetKey) && current?.id !== targetKey) {
        setLayers([...layers.slice(-1), { id: targetKey, photo: target, serial: (current?.serial || 0) + 1 }])
    } else if (targetKey && failed.has(targetKey) && failed.size < count) {
        setPosition((position + 1) % count)
    }

    // Decode the next few photos at the slide's own size, warm a few more.
    useEffect(() => {
        if (!count || !bounds.width) return
        const item = (offset, decode) => {
            const photo = photos[(position + offset + count) % count]
            return { key: mediaId(photo), image: photo, sizes: sizesFor(photo, bounds), decode }
        }
        const wanted = [item(0, true)]
        for (let offset = 1; offset <= DECODE_AHEAD; offset += 1) wanted.push(item(offset, true))
        if (count > 1) wanted.push(item(-1, true))
        for (let offset = DECODE_AHEAD + 1; offset <= WARM_AHEAD; offset += 1) wanted.push(item(offset, false))
        const unique = [...new Map(wanted.map((entry) => [entry.key, entry])).values()]
        // Keep what is on screen loaded while it fades out.
        for (const layer of layers) {
            if (!unique.some((entry) => entry.key === layer.id)) {
                unique.push({ key: layer.id, image: layer.photo, sizes: sizesFor(layer.photo, bounds), decode: true })
            }
        }
        preloader.want(unique)
    }, [bounds, count, layers, photos, position, preloader])

    // Drop the outgoing layer once its fade is over.
    useEffect(() => {
        if (layers.length < 2) return undefined
        const timer = window.setTimeout(() => setLayers((value) => value.slice(-1)), FADE_MS)
        return () => window.clearTimeout(timer)
    }, [layers])

    // Advance after the interval, counted from when the slide appeared.
    useEffect(() => {
        if (!playing || !current || count < 2) return undefined
        const timer = window.setTimeout(() => setPosition((value) => (value + 1) % count), settings.interval * 1000)
        return () => window.clearTimeout(timer)
    }, [count, current, playing, settings.interval])

    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 10_000)
        return () => window.clearInterval(timer)
    }, [])

    // Keep the screen awake while the slideshow plays.
    useEffect(() => {
        if (!playing || status !== 'ready' || !navigator.wakeLock?.request) return undefined
        let lock = null
        let active = true
        const acquire = () => {
            if (document.visibilityState !== 'visible') return
            navigator.wakeLock.request('screen').then((sentinel) => {
                if (active) lock = sentinel
                else sentinel.release?.()
            }, () => {})
        }
        acquire()
        document.addEventListener('visibilitychange', acquire)
        return () => {
            active = false
            document.removeEventListener('visibilitychange', acquire)
            lock?.release?.().catch?.(() => {})
        }
    }, [playing, status])

    useEffect(() => {
        const root = document.documentElement.style
        const previous = { overflow: root.overflow, scrollbarGutter: root.scrollbarGutter }
        // No page scroll, and no reserved scrollbar strip beside the slideshow.
        root.overflow = 'hidden'
        root.scrollbarGutter = 'auto'
        const syncFullscreen = () => setFullscreen(Boolean(document.fullscreenElement))
        document.addEventListener('fullscreenchange', syncFullscreen)
        return () => {
            Object.assign(root, previous)
            document.removeEventListener('fullscreenchange', syncFullscreen)
            window.clearTimeout(idleTimer.current)
            if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {})
        }
    }, [])

    const wake = useCallback(() => {
        setControls(true)
        window.clearTimeout(idleTimer.current)
        idleTimer.current = window.setTimeout(() => setControls(false), IDLE_MS)
    }, [])
    useEffect(() => {
        // Controls start visible; hide them if nothing happens.
        idleTimer.current = window.setTimeout(() => setControls(false), IDLE_MS)
        return () => window.clearTimeout(idleTimer.current)
    }, [])

    const step = useCallback((delta) => {
        if (count) setPosition((value) => (value + delta + count) % count)
    }, [count])

    const exit = useCallback(() => {
        if ((window.history.state?.idx || 0) > 0) navigate(-1)
        else navigate('/')
    }, [navigate])

    const toggleFullscreen = useCallback(() => {
        if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {})
        else rootRef.current?.requestFullscreen?.().catch?.(() => {})
    }, [])

    useEffect(() => {
        const onKey = (event) => {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
            const key = event.key
            if (key === 'Escape') {
                if (panel) setPanel('')
                else if (!document.fullscreenElement) exit()
            } else if (key === ' ' || key === 'k') {
                if (event.target?.closest?.('button, input')) return
                event.preventDefault()
                setPlaying((value) => !value)
            } else if (key === 'ArrowRight') step(1)
            else if (key === 'ArrowLeft') step(-1)
            else if (key === 'f') toggleFullscreen()
            else return
            wake()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [exit, panel, step, toggleFullscreen, wake])

    function change(key, value) {
        const next = { ...settings, [key]: value }
        setSettings(next)
        saveTvSettings(next)
        if (key === 'order' && value !== settings.order) {
            const ordered = value === 'shuffle' ? shuffled(base) : base
            setPhotos(ordered)
            setPosition(Math.max(0, ordered.findIndex((photo) => mediaId(photo) === current?.id)))
        }
    }

    const castReady = Boolean(current)
    // Load the Cast SDK only once the first photo is up, so it never competes with it.
    useEffect(() => {
        if (!castReady || !canCast()) return undefined
        let active = true
        loadCastSdk().then((loaded) => {
            if (loaded && active) castController.current = createCastController(setCast)
        })
        return () => {
            active = false
            // Leaving TV mode stops the TV too.
            castController.current?.dispose({ stop: true })
            castController.current = null
        }
    }, [castReady])

    // Chromecast shows whatever this screen shows, in step with it.
    const castPhoto = cast.connected ? current?.photo : null
    useEffect(() => {
        if (castPhoto) castController.current?.show(castPhoto, { caption: settings.caption })
    }, [castPhoto, settings.caption])

    useEffect(() => watchAirPlay(setAirPlay) || undefined, [])

    const showControls = controls || panel || !playing
    const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    const caption = current?.photo
    const camera = cameraLine(caption)

    return (
        <div
            ref={rootRef}
            className={`tv-mode${showControls ? ' is-awake' : ''}${settings.motion ? ' has-motion' : ''}${playing ? '' : ' is-paused'}`}
            style={{ '--tv-interval': `${settings.interval}s`, '--tv-fade': `${FADE_MS}ms` }}
            role="region"
            aria-roledescription="slideshow"
            aria-label="Favorite photos slideshow"
            onPointerMove={(event) => { if (event.pointerType !== 'touch') wake() }}
            onPointerDown={(event) => {
                swipe.current = { x: event.clientX, y: event.clientY, awake: controls }
                if (event.pointerType !== 'touch') wake()
            }}
            onPointerUp={(event) => {
                const start = swipe.current
                swipe.current = null
                if (!start || event.target.closest?.('button, input, label, .tv-panel')) return
                const dx = event.clientX - start.x
                if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(event.clientY - start.y)) {
                    step(dx < 0 ? 1 : -1)
                    wake()
                } else if (event.pointerType === 'touch') {
                    // A tap shows the controls, and a second tap hides them.
                    if (start.awake && !panel) setControls(false)
                    else wake()
                }
            }}
        >
            {layers.map((layer) => {
                const width = fittedWidth(layer.photo, bounds)
                const ratio = Number(layer.photo.height) / Number(layer.photo.width)
                const height = width && ratio > 0 ? Math.round(width * ratio) : undefined
                return (
                    <div key={layer.serial} className={`tv-layer${layer === current ? ' is-current' : ' is-leaving'}`}
                        aria-hidden={layer === current ? undefined : 'true'}>
                        {settings.background === 'blur' && (
                            <img className="tv-backdrop" src={backdropUrl(layer.photo)} alt="" aria-hidden="true" decoding="async" />
                        )}
                        <div className="tv-stage">
                            <div className={`tv-frame tv-drift-${layer.serial % 4}`}>
                                <img
                                    src={mediaDisplayUrl(layer.photo)}
                                    srcSet={mediaPreviewSrcSet(layer.photo) || undefined}
                                    sizes={sizesFor(layer.photo, bounds)}
                                    width={width || undefined}
                                    height={height}
                                    style={width ? { width, height } : undefined}
                                    alt={layer.photo.altText || `${layer.photo.albumTitle || 'Favorite'} photo`}
                                    decoding="async"
                                    draggable={false}
                                />
                            </div>
                        </div>
                    </div>
                )
            })}
            {/* Measures the area a photo may fill; sizes and preloads follow it. */}
            <div ref={containerRef} className="tv-bounds" aria-hidden="true" />

            {status !== 'ready' || !current ? (
                <div className="tv-message" role="status">
                    {status === 'error' ? (
                        <>
                            <p>The slideshow could not load.</p>
                            <button type="button" className="tv-text-button" onClick={() => { setStatus('loading'); setAttempt((value) => value + 1) }}>Try again</button>
                        </>
                    ) : status === 'empty' ? (
                        <p>There are no favorite photos to show yet.</p>
                    ) : (
                        <>
                            <span className="tv-spinner" aria-hidden="true" />
                            <p>{count ? `Preparing ${count} favorite photos…` : 'Gathering favorite photos…'}</p>
                        </>
                    )}
                </div>
            ) : null}

            {current && settings.clock && (
                <div className="tv-clock" aria-hidden="true">
                    <span className="tv-clock-time">{time}</span>
                    <span className="tv-clock-date">{date}</span>
                </div>
            )}
            {current && settings.caption && (
                <div className="tv-caption">
                    <span className="tv-caption-title">{caption.albumTitle || 'Favorites'}</span>
                    {camera && <span className="tv-caption-camera">{camera}</span>}
                </div>
            )}
            {current && settings.progress && count > 1 && (
                <div className="tv-progress" aria-hidden="true"><span key={current.serial} /></div>
            )}

            <div className="tv-top" aria-hidden={showControls ? undefined : 'true'}>
                <span className="tv-count">
                    {current ? `${position + 1} / ${count}` : ''}
                    {cast.connected && <span className="tv-casting">{cast.device ? `Casting to ${cast.device}` : 'Casting'}</span>}
                </span>
                <div className="tv-top-buttons">
                    {(cast.available || cast.connected) && (
                        <button type="button" className={`tv-button${cast.connected ? ' is-on' : ''}`}
                            aria-label={cast.connected ? 'Casting: change or stop' : 'Cast to a TV'} aria-pressed={cast.connected}
                            disabled={cast.connecting} onClick={() => castController.current?.open()}
                            tabIndex={showControls ? 0 : -1}>{cast.connected ? Icon.casting : Icon.cast}</button>
                    )}
                    {airPlay && (
                        <button type="button" className="tv-button" aria-label="Show on Apple TV with AirPlay" aria-expanded={panel === 'airplay'}
                            onClick={() => setPanel((value) => (value === 'airplay' ? '' : 'airplay'))}
                            tabIndex={showControls ? 0 : -1}>{Icon.airplay}</button>
                    )}
                    <button type="button" className="tv-button" aria-label="Slideshow settings" aria-expanded={panel === 'settings'}
                        onClick={() => setPanel((value) => (value === 'settings' ? '' : 'settings'))} tabIndex={showControls ? 0 : -1}>{Icon.settings}</button>
                    {document.fullscreenEnabled && (
                        <button type="button" className="tv-button" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
                            onClick={toggleFullscreen} tabIndex={showControls ? 0 : -1}>{fullscreen ? Icon.windowed : Icon.fullscreen}</button>
                    )}
                    <button type="button" className="tv-button" aria-label="Close slideshow" onClick={exit}
                        tabIndex={showControls ? 0 : -1}>{Icon.close}</button>
                </div>
            </div>

            <div className="tv-transport" aria-hidden={showControls ? undefined : 'true'}>
                <button type="button" className="tv-button" aria-label="Previous photo" onClick={() => step(-1)}
                    disabled={count < 2} tabIndex={showControls ? 0 : -1}>{Icon.previous}</button>
                <button type="button" className="tv-button is-primary" aria-label={playing ? 'Pause slideshow' : 'Play slideshow'}
                    onClick={() => setPlaying((value) => !value)} tabIndex={showControls ? 0 : -1}>{playing ? Icon.pause : Icon.play}</button>
                <button type="button" className="tv-button" aria-label="Next photo" onClick={() => step(1)}
                    disabled={count < 2} tabIndex={showControls ? 0 : -1}>{Icon.next}</button>
            </div>

            {panel === 'airplay' && (
                <div className="tv-panel" role="dialog" aria-label="Show on Apple TV">
                    <div className="tv-setting">
                        <span className="tv-setting-label">Show on Apple TV</span>
                        <ol className="tv-steps">
                            {isAppleTouchDevice() ? (
                                <>
                                    <li>Open Control Center.</li>
                                    <li>Tap <strong>Screen Mirroring</strong> and choose your Apple TV or AirPlay TV.</li>
                                    <li>Hold your iPhone or iPad sideways so the slideshow fills the TV.</li>
                                </>
                            ) : (
                                <>
                                    <li>Click <strong>Control Center</strong> in the menu bar.</li>
                                    <li>Click <strong>Screen Mirroring</strong> and choose your Apple TV or AirPlay TV.</li>
                                    <li>Press <strong>F</strong> for full screen.</li>
                                </>
                            )}
                        </ol>
                    </div>
                    <p className="tv-hint">The slideshow keeps this screen awake while it plays.</p>
                </div>
            )}

            {panel === 'settings' && (
                <div className="tv-panel" role="dialog" aria-label="Slideshow settings">
                    <Choice label="Each photo" value={settings.interval} onChange={(value) => change('interval', value)}
                        options={TV_INTERVALS.map((value) => ({ value, label: value < 60 ? `${value}s` : '1m' }))} />
                    <Choice label="Order" value={settings.order} onChange={(value) => change('order', value)}
                        options={[{ value: 'shuffle', label: 'Shuffle' }, { value: 'newest', label: 'Newest first' }]} />
                    <Choice label="Background" value={settings.background} onChange={(value) => change('background', value)}
                        options={[{ value: 'blur', label: 'Soft glow' }, { value: 'dark', label: 'Dark' }]} />
                    <div className="tv-setting">
                        <span className="tv-setting-label">Show</span>
                        <div className="tv-toggles">
                            <Toggle label="Slow zoom" checked={settings.motion} onChange={(value) => change('motion', value)} />
                            <Toggle label="Clock" checked={settings.clock} onChange={(value) => change('clock', value)} />
                            <Toggle label="Album & camera" checked={settings.caption} onChange={(value) => change('caption', value)} />
                            <Toggle label="Progress bar" checked={settings.progress} onChange={(value) => change('progress', value)} />
                        </div>
                    </div>
                    <p className="tv-hint">
                        {cast.connected ? 'Keep this page open while casting; the TV follows it. ' : ''}
                        Space pauses · ← → move · F full screen · Esc closes
                    </p>
                </div>
            )}
        </div>
    )
}
