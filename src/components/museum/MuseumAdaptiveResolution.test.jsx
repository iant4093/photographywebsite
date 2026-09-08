import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MuseumAdaptiveResolution from './MuseumAdaptiveResolution'

const fiber = vi.hoisted(() => ({
    frame: null,
    size: { width: 402, height: 874 },
    gl: { getPixelRatio: vi.fn() },
    setDpr: vi.fn(),
}))

vi.mock('@react-three/fiber', () => ({
    useThree: () => fiber,
    useFrame: (callback) => { fiber.frame = callback },
}))

const originalDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
const originalMemory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory')
let wallTime
let focused
let visibility
let requestFrames
let onDprChange

function frames(count, intervalMs) {
    act(() => {
        for (let index = 0; index < count; index += 1) {
            wallTime += intervalMs
            // The scene's simulation delta cannot expose a long real frame.
            fiber.frame({}, Math.min(intervalMs / 1000, 0.05))
        }
    })
}

function resolution(enabled = true) {
    return <MuseumAdaptiveResolution enabled={enabled} firefox={false} requestFrames={requestFrames} onDprChange={onDprChange} />
}

beforeEach(() => {
    fiber.size = { width: 402, height: 874 }
    fiber.frame = null
    fiber.setDpr.mockClear()
    let rendererDpr = 1.5
    fiber.gl.getPixelRatio.mockImplementation(() => rendererDpr)
    fiber.setDpr.mockImplementation((value) => { rendererDpr = value })
    wallTime = 0
    focused = true
    visibility = 'visible'
    requestFrames = vi.fn()
    onDprChange = vi.fn()
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: undefined })
    vi.spyOn(performance, 'now').mockImplementation(() => wallTime)
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})

afterEach(() => {
    if (originalDpr) Object.defineProperty(window, 'devicePixelRatio', originalDpr)
    else delete window.devicePixelRatio
    if (originalMemory) Object.defineProperty(navigator, 'deviceMemory', originalMemory)
    else delete navigator.deviceMemory
})

describe('museum adaptive resolution lifecycle', () => {
    it('updates the existing renderer from actual frame time and requests a settling render', () => {
        const view = render(resolution())
        expect(fiber.setDpr).toHaveBeenLastCalledWith(1.5)
        expect(onDprChange).toHaveBeenCalledExactlyOnceWith(1.5)
        expect(requestFrames).toHaveBeenLastCalledWith(2)

        frames(45, 100)
        expect(fiber.setDpr).toHaveBeenCalledTimes(2)
        expect(fiber.setDpr).toHaveBeenLastCalledWith(1.35)
        expect(onDprChange.mock.calls).toEqual(fiber.setDpr.mock.calls)
        expect(requestFrames).toHaveBeenCalledTimes(2)

        // Ordinary scene rerenders must not restore the initial resolution.
        view.rerender(resolution())
        expect(fiber.setDpr).toHaveBeenCalledTimes(2)
        expect(onDprChange).toHaveBeenCalledTimes(2)
    })

    it('keeps a stable 30 fps phone sharp instead of repeatedly reducing resolution', () => {
        render(resolution())
        frames(600, 1000 / 30)
        expect(fiber.setDpr).toHaveBeenCalledExactlyOnceWith(1.5)
        expect(onDprChange).toHaveBeenCalledExactlyOnceWith(1.5)
        expect(requestFrames).toHaveBeenCalledOnce()
    })

    it('ignores disabled frames and retains its learned resolution across album viewing or pause', () => {
        const view = render(resolution(false))
        frames(600, 100)
        expect(fiber.setDpr).toHaveBeenCalledExactlyOnceWith(1.5)

        view.rerender(resolution())
        frames(45, 100)
        expect(fiber.setDpr).toHaveBeenLastCalledWith(1.35)
        view.rerender(resolution(false))
        frames(600, 100)
        expect(fiber.setDpr).toHaveBeenCalledTimes(2)

        view.rerender(resolution())
        frames(15, 100)
        expect(fiber.setDpr).toHaveBeenCalledTimes(2)
        frames(30, 100)
        expect(fiber.setDpr).toHaveBeenCalledTimes(3)
        expect(fiber.setDpr.mock.lastCall[0]).toBeCloseTo(1.2)
    })

    it('excludes background wall time and starts a fresh warmup when the gallery regains focus', () => {
        render(resolution())
        frames(30, 100)
        visibility = 'hidden'
        focused = false
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
            window.dispatchEvent(new Event('blur'))
        })
        frames(400, 100)
        expect(fiber.setDpr).toHaveBeenCalledOnce()

        wallTime += 60_000
        visibility = 'visible'
        focused = true
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
            window.dispatchEvent(new Event('focus'))
        })
        frames(15, 100)
        expect(fiber.setDpr).toHaveBeenCalledOnce()
        frames(30, 100)
        expect(fiber.setDpr).toHaveBeenLastCalledWith(1.35)
    })

    it('reapplies the framebuffer budget when a mobile viewport grows to tablet dimensions', () => {
        const view = render(resolution())
        expect(fiber.setDpr).toHaveBeenLastCalledWith(1.5)
        fiber.size = { width: 1366, height: 1024 }
        view.rerender(resolution())
        const tabletDpr = fiber.setDpr.mock.lastCall[0]
        expect(tabletDpr).toBeLessThan(1)
        expect(1366 * 1024 * tabletDpr ** 2).toBeLessThanOrEqual(1_100_000.001)
        expect(onDprChange.mock.calls).toEqual(fiber.setDpr.mock.calls)
        expect(requestFrames).toHaveBeenCalledTimes(2)
        frames(45, 100)
        expect(fiber.setDpr).toHaveBeenLastCalledWith(tabletDpr)
    })

    it('retains a lowered resolution when Safari changes the address-bar height', () => {
        const view = render(resolution())
        frames(45, 100)
        expect(fiber.setDpr).toHaveBeenLastCalledWith(1.35)

        fiber.size = { width: 402, height: 780 }
        view.rerender(resolution())
        expect(fiber.setDpr).toHaveBeenLastCalledWith(1.35)
        expect(onDprChange.mock.calls).toEqual(fiber.setDpr.mock.calls)
        frames(15, 100)
        expect(fiber.setDpr).toHaveBeenCalledTimes(3)
    })
})
