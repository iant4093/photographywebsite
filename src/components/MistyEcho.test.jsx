import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MistyEcho from './MistyEchoExperience'
import { installFooterOverscroll } from '../utils/footerOverscroll'
import { loadMistyEchoPhotos } from '../utils/mistyEchoPhotos'

vi.mock('../utils/footerOverscroll', () => ({ installFooterOverscroll: vi.fn() }))
vi.mock('../utils/mistyEchoPhotos', () => ({ loadMistyEchoPhotos: vi.fn() }))

let handlers
let dispose
let motion
const trigger = () => act(async () => { await handlers.onTrigger() })
beforeEach(() => {
    vi.useFakeTimers()
    dispose = vi.fn()
    motion = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.spyOn(window, 'matchMedia').mockReturnValue(motion)
    installFooterOverscroll.mockImplementation(callbacks => { handlers = callbacks; return dispose })
    loadMistyEchoPhotos.mockResolvedValue(['https://media.test/cat-thumb.jpg'])
})
afterEach(() => vi.useRealTimers())

describe('Misty echo lifecycle', () => {
    it('shows continuous pull progress and releases it when pulling stops', () => {
        render(<MistyEcho />)
        act(() => handlers.onProgress(0.6))
        expect(document.querySelector('.misty-pull')).toHaveStyle({ '--pull': '0.6' })
        expect(document.querySelector('.misty-pull')).toHaveTextContent('keep pulling…')
        act(() => handlers.onProgress(0))
        expect(document.querySelector('.misty-pull')).toHaveStyle({ '--pull': '0' })
    })
    it('stays idle until deliberate interaction, reuses previews, and cleans up after six seconds', async () => {
        const view = render(<MistyEcho />)
        expect(loadMistyEchoPhotos).not.toHaveBeenCalled()
        await trigger()
        expect(document.querySelector('.misty-echo')).toHaveAttribute('aria-hidden', 'true')
        const images = [...document.querySelectorAll('.misty-echo img')]
        expect(images.length).toBeLessThanOrEqual(60)
        expect(new Set(images.map(image => image.src))).toEqual(new Set(['https://media.test/cat-thumb.jpg']))
        expect(document.querySelectorAll('.misty-echo-copy span').length).toBe(images.length)
        await act(() => vi.advanceTimersByTimeAsync(6000))
        expect(document.querySelector('.misty-echo')).toBeNull()
        await trigger()
        expect(loadMistyEchoPhotos).toHaveBeenCalledTimes(1)
        await act(() => vi.advanceTimersByTimeAsync(30000))
        await trigger()
        expect(loadMistyEchoPhotos).toHaveBeenCalledTimes(2)
        view.unmount()
        expect(dispose).toHaveBeenCalled()
        expect(document.querySelector('.misty-echo')).toBeNull()
    })
    it('dismisses on Escape and aborts work when navigating away', async () => {
        const view = render(<MistyEcho />)
        await trigger()
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(document.querySelector('.misty-echo')).toBeNull()
        expect(loadMistyEchoPhotos.mock.calls[0][0].aborted).toBe(true)
        view.unmount()
        expect(dispose).toHaveBeenCalledTimes(1)
    })
    it('does not fetch or animate with reduced motion', async () => {
        motion.matches = true
        render(<MistyEcho />)
        act(() => handlers.onProgress(0.6))
        await trigger()
        expect(loadMistyEchoPhotos).not.toHaveBeenCalled()
        expect(document.querySelector('.misty-echo')).toBeNull()
        expect(document.querySelector('.misty-pull')).toHaveStyle({ '--pull': '0' })
    })
    it('silently skips unavailable Misty photos', async () => {
        loadMistyEchoPhotos.mockRejectedValue(new Error('Offline'))
        render(<MistyEcho />)
        await trigger()
        expect(document.querySelector('.misty-echo')).toBeNull()
    })
})
