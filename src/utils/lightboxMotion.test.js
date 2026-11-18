import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLightboxMotion } from './lightboxMotion'
import { lightboxMotionControllers } from './lightboxMotionControl'
import { rememberLightboxTrigger } from './lightboxOrigin'

const thumbnail = [40, 60, 160, 120]
const fitted = [180, 110, 420, 480]
const sourceImage = '/photo.webp'

function setBounds(element, [left, top, width, height]) {
    element.getBoundingClientRect = () => new DOMRect(left, top, width, height)
    return element
}

describe('lightbox motion lifecycle', () => {
    let animations, releases

    function fixture(kind, markup, { originKind = kind, key = 'first', bounds = thumbnail, visual = '<img src="/thumb.webp">' } = {}) {
        document.body.innerHTML = `
            <div data-lightbox-grid>
                <button data-lightbox-item="first">${visual}</button>
                <button data-lightbox-item="second"><img src="/next.webp"></button>
            </div>
            <div role="dialog" style="background: rgba(24, 21, 19, .9); opacity: 1; --lightbox-controls-opacity: 1">
                <button class="linen-lightbox-close" style="opacity: 1">Close</button>
                ${markup}
            </div>`
        const dialog = document.querySelector('[role="dialog"]')
        const trigger = setBounds(document.querySelector('[data-lightbox-item="first"]'), bounds)
        const config = { kind, originKind, key, onOpened: vi.fn() }
        rememberLightboxTrigger(trigger, originKind, key)
        return {
            dialog, trigger, config,
            open() {
                const release = installLightboxMotion(dialog, () => config, trigger)
                releases.push(release)
                return release
            },
            close(callback = vi.fn()) {
                lightboxMotionControllers.get(dialog).requestClose(callback)
                return callback
            },
        }
    }

    function photo(options) {
        const scene = fixture('photo', `
            <div class="linen-lightbox-photo-frame is-loaded" style="box-shadow: 0 0 0 4px white; border-radius: 0px">
                <img class="linen-lightbox-photo" style="object-position: center" src="${sourceImage}">
            </div>`, options)
        const frame = setBounds(scene.dialog.querySelector('.linen-lightbox-photo-frame'), fitted)
        return { ...scene, frame }
    }

    const flight = () => document.querySelector('.lightbox-motion-flight')
    const animate = (element, property) => animations.findLast(entry => entry.element === element && property in entry.frames[0])

    beforeEach(() => {
        vi.useFakeTimers()
        vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false })
        animations = []
        releases = []
        Element.prototype.animate = function (frames, options) {
            let end
            let reject
            const finished = new Promise((resolve, fail) => {
                reject = fail
                end = setTimeout(resolve, (options.delay ?? 0) + options.duration)
            })
            const cancel = vi.fn(() => {
                clearTimeout(end)
                reject(new DOMException('Animation cancelled', 'AbortError'))
            })
            animations.push({ element: this, frames, options, cancel })
            return { finished, cancel }
        }
    })

    afterEach(() => {
        releases.forEach(release => release())
        document.body.replaceChildren()
        delete Element.prototype.animate
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('uses a fixed-size photo layer and crops without stretching the image', async () => {
        const { open, dialog, trigger, frame, config } = photo()
        trigger.style.borderRadius = '2px'
        rememberLightboxTrigger(trigger, 'photo', config.key)
        open()
        expect(dialog).toHaveAttribute('data-lightbox-awaiting')
        vi.advanceTimersToNextFrame()
        const shell = flight()
        expect(shell.style.width).toBe('420px')
        expect(shell.style.height).toBe('480px')
        expect(animate(shell, 'transform').frames).toEqual([
            { transform: `translate(-140px, -50px) scale(${160 / 420}, 0.25)` },
            { transform: 'translate(0px, 0px) scale(1, 1)' },
        ])
        const crop = shell.querySelector('.lightbox-motion-crop')
        expect(animate(crop.querySelector('img'), 'transform').frames).toHaveLength(17)
        expect(animate(crop, 'borderRadius').frames).toEqual([{ borderRadius: '2px' }, { borderRadius: '0px' }])
        expect(trigger).not.toHaveAttribute('data-lightbox-motion-source')
        expect(frame).toHaveClass('lightbox-motion-in-flight')
        await vi.advanceTimersByTimeAsync(570)
        expect(flight()).toBeNull()
        expect(frame).not.toHaveClass('lightbox-motion-in-flight')
        expect(config.onOpened).toHaveBeenCalledOnce()
    })

    it.each(['top', 'bottom'])('opens and returns to the full photo crop across the %s edge', async edge => {
        const top = edge === 'top' ? -35 : window.innerHeight - 50
        const { open, close, trigger } = photo({ bounds: [40, top, 160, 120] })
        setBounds(trigger.querySelector('img'), [44, top + 4, 152, 112])
        open()
        vi.advanceTimersToNextFrame()
        expect(animate(flight(), 'transform').frames[0].transform)
            .toBe(`translate(-140px, ${top - 110}px) scale(${160 / 420}, 0.25)`)
        expect(trigger).not.toHaveAttribute('data-lightbox-motion-source')
        await vi.advanceTimersByTimeAsync(570)
        const closed = close()
        expect(animate(flight(), 'width').frames.at(-1))
            .toMatchObject({ left: '44px', top: `${top + 4}px`, width: '152px', height: '112px' })
        expect(trigger).not.toHaveAttribute('data-lightbox-motion-source')
        await vi.advanceTimersByTimeAsync(440)
        expect(closed).toHaveBeenCalledOnce()
    })

    it('uses the viewer fade when a photo thumbnail is entirely outside the viewport', () => {
        const { open, dialog } = photo({ bounds: [40, window.innerHeight, 160, 120] })
        open()
        expect(dialog).not.toHaveAttribute('data-lightbox-awaiting')
        expect(flight()).toBeNull()
        expect(animate(dialog, 'opacity').frames).toEqual([{ opacity: 0 }, { opacity: 1 }])
    })

    it('returns to the newly selected thumbnail, with one close callback', async () => {
        const { open, close, frame, config } = photo()
        open()
        await vi.advanceTimersByTimeAsync(600)
        const other = setBounds(document.querySelector('[data-lightbox-item="second"]'), [24, 120, 165, 125])
        const otherImage = setBounds(other.querySelector('img'), [28, 124, 157, 117])
        otherImage.style.objectPosition = '60% 40%'
        config.key = 'second'
        const closed = close()
        const redundant = close()
        expect(animate(flight(), 'width').frames.at(-1)).toMatchObject({ left: '28px', top: '124px', width: '157px', height: '117px' })
        expect(animate(flight().querySelector('img'), 'objectPosition').frames.at(-1)).toEqual({ objectPosition: '60% 40%' })
        expect(frame).toHaveClass('lightbox-motion-in-flight')
        await vi.advanceTimersByTimeAsync(460)
        expect(closed).toHaveBeenCalledOnce()
        expect(redundant).not.toHaveBeenCalled()
    })

    it.each(['offscreen', 'outgoing', 'zoomed', 'original'])('dissolves when there is no clean landing for a %s photo', async state => {
        const { open, close, frame, trigger, dialog } = photo()
        open()
        await vi.advanceTimersByTimeAsync(600)
        if (state === 'offscreen') setBounds(trigger, [40, -120, 160, 120])
        if (state === 'zoomed') frame.classList.add('is-zoomed')
        if (state === 'original') frame.querySelector('img').classList.add('linen-lightbox-original')
        if (state === 'outgoing') {
            const outgoing = frame.cloneNode()
            outgoing.classList.add('is-outgoing')
            dialog.append(outgoing)
        }
        const closed = close()
        expect(flight()).toBeNull()
        expect(dialog).toHaveAttribute('data-lightbox-dissolving')
        expect(animate(dialog, 'opacity').options.duration).toBe(360)
        await vi.advanceTimersByTimeAsync(360)
        expect(closed).toHaveBeenCalledOnce()
    })

    it('keeps the original button available during a featured-photo entrance and exit', async () => {
        const { open, close, trigger } = photo({ originKind: 'button', key: undefined, visual: 'Featured Photos' })
        open()
        await vi.advanceTimersByTimeAsync(20)
        expect(flight().querySelector('span')).toBeNull()
        expect(trigger).not.toHaveAttribute('data-lightbox-motion-source')
        expect(animate(flight(), 'opacity').frames[0]).toEqual({ opacity: 0 })
        await vi.advanceTimersByTimeAsync(570)
        close()
        expect(animate(flight(), 'opacity').options).toMatchObject({ delay: 0, duration: 430 })
    })

    it('falls back if the photo fails to become ready and restores controls', async () => {
        const { open, frame, dialog, config } = photo()
        frame.classList.remove('is-loaded')
        open()
        await vi.advanceTimersByTimeAsync(1250)
        expect(dialog).not.toHaveAttribute('data-lightbox-awaiting')
        expect(flight()).toBeNull()
        expect(animate(dialog, 'opacity').frames).toEqual([{ opacity: 0 }, { opacity: 1 }])
        await vi.advanceTimersByTimeAsync(160)
        expect(config.onOpened).toHaveBeenCalledOnce()
    })

    it('uses the reduced-motion fade even when a photo fits both frames', async () => {
        const { open, close, dialog, config } = photo()
        vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true })
        open()
        expect(flight()).toBeNull()
        expect(animate(dialog, 'opacity').options.duration).toBe(110)
        await vi.advanceTimersByTimeAsync(110)
        expect(config.onOpened).toHaveBeenCalledOnce()
        close()
        expect(animate(dialog, 'opacity').options.duration).toBe(110)
    })

    it.each([true, false])('stages a section panel with shared text when labels match (%s)', async matches => {
        const { open, close, trigger, dialog } = fixture('panel', `
            <div data-lightbox-panel style="opacity: 1; box-shadow: none; border: 1px solid black">
                <h2 data-lightbox-label>${matches ? 'Section statistics' : 'Different title'}</h2>
                <div data-lightbox-copy>Photo statistics</div>
                <button class="section-stats-close" style="opacity: 1">Close section statistics</button>
            </div>`, { visual: '<span data-lightbox-label>Section statistics</span>' })
        const panel = setBounds(dialog.querySelector('[data-lightbox-panel]'), fitted)
        open()
        expect(animate(panel, 'clipPath').frames.at(-1)).toEqual({ clipPath: 'inset(0px)' })
        expect(trigger).toHaveAttribute('data-lightbox-motion-source')
        expect(Boolean(flight().querySelector('.lightbox-motion-shared-label'))).toBe(matches)
        await vi.advanceTimersByTimeAsync(340)
        const closed = close()
        expect(animate(panel, 'opacity').frames.at(-1)).toEqual({ opacity: 0 })
        await vi.advanceTimersByTimeAsync(245)
        expect(closed).toHaveBeenCalledOnce()
    })

    it('animates the real QR panel and fades the code before exit', async () => {
        const { open, close, trigger, dialog, config } = fixture('qr', `
            <div data-lightbox-panel style="transform: none; opacity: 1">
                <img data-lightbox-qr src="/qr.svg" style="opacity: 1">
            </div>`)
        const panel = setBounds(dialog.querySelector('[data-lightbox-panel]'), fitted)
        open()
        expect(dialog).toHaveAttribute('data-qr-opening')
        expect(flight()).toBeNull()
        expect(trigger).not.toHaveAttribute('data-lightbox-motion-source')
        expect(animate(panel, 'transform').frames[0].transform).toContain('scale(0.82)')
        await vi.advanceTimersByTimeAsync(330)
        expect(config.onOpened).toHaveBeenCalledOnce()
        const closed = close()
        const code = animate(panel.querySelector('img'), 'opacity')
        expect(code.frames.at(-1)).toEqual({ opacity: 0 })
        expect(code.options.duration).toBeLessThan(animate(panel, 'transform').options.duration)
        await vi.advanceTimersByTimeAsync(310)
        expect(closed).toHaveBeenCalledOnce()
    })

    it.each(['fully visible', 'partially visible'])('waits for video metadata and a decoded frame from a %s thumbnail', async visibility => {
        const bounds = visibility === 'fully visible' ? thumbnail : [40, window.innerHeight - 50, 160, 120]
        const { open, close, dialog, config } = fixture('video', `
            <div class="linen-lightbox-content" style="box-shadow: 0 0 0 4px white">
                <div class="site-video-player" style="background: black"><video poster="/still.webp"></video></div>
            </div>`, { bounds })
        const video = setBounds(dialog.querySelector('video'), fitted)
        open()
        await vi.advanceTimersByTimeAsync(20)
        expect(flight()).toBeNull()
        video.dataset.videoWidth = 1920
        video.dataset.videoHeight = 1080
        video.dispatchEvent(new Event('loadedmetadata'))
        await vi.advanceTimersByTimeAsync(460)
        const frames = animate(flight(), 'height').frames
        expect(frames[0]).toMatchObject({ top: `${bounds[1]}px`, height: '120px' })
        expect(frames.at(-1).height).toBe('236.25px')
        expect(config.onOpened).not.toHaveBeenCalled()
        video.dispatchEvent(new Event('loadeddata'))
        await vi.advanceTimersByTimeAsync(1)
        expect(animate(flight().querySelector('img'), 'filter').frames.at(-1).filter).toBe('blur(6px)')
        expect(animate(video, 'opacity').frames).toEqual([{ opacity: 1 }, { opacity: 1 }])
        await vi.advanceTimersByTimeAsync(380)
        expect(config.onOpened).toHaveBeenCalledOnce()
        expect(flight()).toBeNull()

        video.pause = vi.fn()
        const closed = close()
        expect(video.pause).toHaveBeenCalledOnce()
        expect(animate(flight(), 'height').frames.at(-1)).toMatchObject({ top: `${bounds[1]}px`, height: '120px' })
        await vi.advanceTimersByTimeAsync(420)
        expect(closed).toHaveBeenCalledOnce()
    })

    it('cancels the video handoff when the route unmounts before playback', async () => {
        const { open, dialog, config, trigger } = fixture('video', `
            <div class="site-video-player">
                <video poster="/still.webp" data-video-width="1920" data-video-height="1080"></video>
            </div>`)
        const video = setBounds(dialog.querySelector('video'), fitted)
        const release = open()
        await vi.advanceTimersByTimeAsync(480)
        expect(flight()).not.toBeNull()
        release()
        video.dispatchEvent(new Event('loadeddata'))
        await vi.advanceTimersByTimeAsync(500)
        expect(flight()).toBeNull()
        expect(trigger).not.toHaveAttribute('data-lightbox-motion-source')
        expect(lightboxMotionControllers.get(dialog)).toBeUndefined()
        expect(config.onOpened).not.toHaveBeenCalled()
    })
})
