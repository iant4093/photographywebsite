import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { installFooterOverscroll } from '../utils/footerOverscroll'
import './MistyEcho.css'

const DURATION_MS = 6000
const COOLDOWN_MS = 12000
const FONTS = ['"Comic Sans MS", "Chalkboard SE", cursive', '"Impact", "Arial Black", sans-serif',
    '"Playfair Display Variable", Georgia, serif', '"Courier New", monospace', '"Marker Felt", "Bradley Hand", cursive']
const COLORS = ['#fff0bd', '#ffb8cb', '#c8edff', '#d4ffce', '#e0c5ff']
const liftForPull = value => `${Math.round(112 * (1 - (1 - value) ** 1.3))}px`

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
    const [waking, setWaking] = useState(false)
    const [still, setStill] = useState(false)

    useEffect(() => {
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
        const footer = document.querySelector('.linen-footer')
        footer?.classList.add('misty-footer-lift')
        let controller = null
        let loading = null
        let finishTimer
        let loadTimer
        let cooldownUntil = 0
        let active = false
        let disposed = false

        const updatePull = value => {
            footer?.style.setProperty('--misty-lift', liftForPull(value))
            footer?.toggleAttribute('data-misty-pulling', value > 0)
            setPull(value)
        }

        const stop = () => {
            controller?.abort()
            controller = null
            loading = null
            clearTimeout(loadTimer)
            clearTimeout(finishTimer)
            active = false
            if (!disposed) { setEchoes(null); updatePull(0); setWaking(false) }
        }
        const prepare = () => {
            if (active || performance.now() < cooldownUntil) return null
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
            setWaking(true)
            updatePull(1)
            const photos = await request
            if (request !== loading) return
            if (disposed || !active || !photos.length) {
                if (!disposed && active) stop()
                return
            }
            clearTimeout(loadTimer)
            cooldownUntil = performance.now() + COOLDOWN_MS
            setWaking(false)
            updatePull(0)
            setStill(motion.matches)
            setEchoes(makeEchoes(photos))
            finishTimer = setTimeout(stop, DURATION_MS)
        }
        const onProgress = (value) => {
            if (disposed || active) return
            updatePull(performance.now() < cooldownUntil ? 0 : Math.round(value * 50) / 50)
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
            footer?.classList.remove('misty-footer-lift')
            footer?.style.removeProperty('--misty-lift')
            footer?.removeAttribute('data-misty-pulling')
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('scroll', onScroll)
            document.removeEventListener('visibilitychange', onVisibility)
            motion.removeEventListener('change', onMotion)
        }
    }, [])

    return createPortal(
        <>
            <div className="misty-pull" data-pulling={pull > 0} aria-hidden="true" style={{ '--pull': pull, '--misty-lift': liftForPull(pull) }}>
                <div className="misty-pull-pocket">
                    <svg className="misty-pull-paw" viewBox="0 0 32 32" width="28" height="28" fill="currentColor">
                        <ellipse cx="6" cy="13" rx="3" ry="4" transform="rotate(-25 6 13)" />
                        <ellipse cx="12" cy="7" rx="3" ry="4" />
                        <ellipse cx="20" cy="7" rx="3" ry="4" />
                        <ellipse cx="26" cy="13" rx="3" ry="4" transform="rotate(25 26 13)" />
                        <path d="M8 25c-2-4 4-11 8-11s10 7 8 11c-2 4-5 1-8 1s-6 3-8-1Z" />
                    </svg>
                    <span>{waking ? 'Misty is waking up…' : 'keep pulling…'}</span>
                </div>
            </div>
            {echoes && (
                <div className={`misty-echo${still ? ' misty-echo-still' : ''}`} aria-hidden="true">
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
