import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { installFooterOverscroll } from '../utils/footerOverscroll'
import './MistyEcho.css'

const DURATION_MS = 6000
const COOLDOWN_MS = 30000
const FONTS = ['"Comic Sans MS", "Chalkboard SE", cursive', '"Impact", "Arial Black", sans-serif',
    '"Playfair Display Variable", Georgia, serif', '"Courier New", monospace', '"Marker Felt", "Bradley Hand", cursive']
const COLORS = ['#fff0bd', '#ffb8cb', '#c8edff', '#d4ffce', '#e0c5ff']

function makeEchoes(photos) {
    const columns = window.innerWidth < 640 ? 3 : 5
    return Array.from({ length: columns * 4 }, (_, index) => ({
        photo: photos[index % photos.length],
        x: ((index % columns + 0.25 + Math.random() * 0.5) / columns - 0.5) * 100,
        y: ((Math.floor(index / columns) + 0.25 + Math.random() * 0.5) / 4 - 0.5) * 100,
        turn: `${(Math.random() - 0.5) * 34}deg`,
        delay: `${Math.random() * 0.8}s`,
        size: `${0.75 + Math.random() * 0.35}`,
        font: FONTS[index % FONTS.length],
        color: COLORS[index % COLORS.length],
        word: ['meow', 'meow!', 'MEOW', 'meow~'][index % 4],
    }))
}

export default function MistyEchoExperience() {
    const [echoes, setEchoes] = useState(null)
    const [pull, setPull] = useState(0)

    useEffect(() => {
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
        let controller = null
        let loading = null
        let finishTimer
        let loadTimer
        let cooldownUntil = 0
        let active = false
        let disposed = false

        const stop = () => {
            controller?.abort()
            controller = null
            loading = null
            clearTimeout(loadTimer)
            clearTimeout(finishTimer)
            active = false
            if (!disposed) { setEchoes(null); setPull(0) }
        }
        const prepare = () => {
            if (motion.matches || active || performance.now() < cooldownUntil) return null
            if (loading) return loading
            controller = new AbortController()
            const signal = controller.signal
            // Never let a slow request surprise someone long after the gesture.
            loadTimer = setTimeout(stop, 8000)
            loading = import('../utils/mistyEchoPhotos')
                .then(({ loadMistyEchoPhotos }) => loadMistyEchoPhotos(signal))
                .catch(() => [])
                .then(photos => signal.aborted ? [] : photos)
            return loading
        }
        const trigger = async () => {
            const request = prepare()
            if (!request) return
            active = true
            cooldownUntil = performance.now() + COOLDOWN_MS
            const photos = await request
            if (request !== loading) return
            if (disposed || !active || motion.matches || !photos.length) {
                if (!disposed && active) stop()
                return
            }
            clearTimeout(loadTimer)
            setEchoes(makeEchoes(photos))
            finishTimer = setTimeout(stop, DURATION_MS)
        }
        const onProgress = (value) => {
            if (disposed) return
            setPull(motion.matches || active || performance.now() < cooldownUntil ? 0 : Math.round(value * 50) / 50)
        }
        const disposeTrigger = installFooterOverscroll({ onAttempt: prepare, onTrigger: trigger, onProgress })
        const onKeyDown = (event) => { if (event.key === 'Escape') stop() }
        const onVisibility = () => { if (document.hidden) stop() }
        const onScroll = () => {
            const root = document.scrollingElement || document.documentElement
            if (root.scrollHeight - window.innerHeight - window.scrollY > 24) stop()
        }
        const onMotion = () => { if (motion.matches) stop() }
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('scroll', onScroll, { passive: true })
        document.addEventListener('visibilitychange', onVisibility)
        motion.addEventListener('change', onMotion)
        return () => {
            disposed = true
            stop()
            disposeTrigger()
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('scroll', onScroll)
            document.removeEventListener('visibilitychange', onVisibility)
            motion.removeEventListener('change', onMotion)
        }
    }, [])

    return createPortal(
        <>
            <div className="misty-pull" aria-hidden="true" style={{ '--pull': pull }}>
                <svg viewBox="0 0 40 40" width="36" height="36" fill="none">
                    <circle className="misty-pull-track" cx="20" cy="20" r="18" />
                    <circle className="misty-pull-progress" cx="20" cy="20" r="18" strokeDasharray="113.1" strokeDashoffset={113.1 * (1 - pull)} />
                    <g fill="currentColor">
                        <ellipse cx="13" cy="16" rx="2.5" ry="3.2" transform="rotate(-25 13 16)" />
                        <ellipse cx="19" cy="12.5" rx="2.5" ry="3.2" />
                        <ellipse cx="25" cy="15" rx="2.5" ry="3.2" transform="rotate(25 25 15)" />
                        <path d="M12 26c0-3 5-8 8-8s8 5 8 8c0 5-5 2-8 2s-8 3-8-2Z" />
                    </g>
                </svg>
                <span>keep pulling…</span>
            </div>
            {echoes && (
                <div className="misty-echo" aria-hidden="true">
                    <div className="misty-echo-glow" />
                    {echoes.map((echo, index) => (
                        <div key={index} className="misty-echo-path" style={{
                            '--echo-x': `${echo.x}vw`, '--echo-y': `${echo.y}vh`, '--echo-turn': echo.turn,
                            '--echo-delay': echo.delay, '--echo-size': echo.size,
                            '--echo-font': echo.font, '--echo-color': echo.color,
                        }}>
                            {[0, 1, 2].map(copy => (
                                <div key={copy} className="misty-echo-copy" style={{ '--echo-copy': copy }}>
                                    <img src={echo.photo} alt="" decoding="async" draggable="false" width="144" height="112" />
                                    <span>{echo.word}</span>
                                </div>
                            ))}
                        </div>
                    ))}
                    <div className="misty-echo-signoff">you found Misty. <span>meow.</span></div>
                </div>
            )}
        </>,
        document.body,
    )
}
