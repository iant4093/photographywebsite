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
    it('lifts the actual footer with the paw and restores it when pulling stops', () => {
        render(<><footer className="linen-footer" /><MistyEcho /></>)
        const footer = document.querySelector('.linen-footer')
        act(() => handlers.onProgress(0.6))
        expect(document.querySelector('.misty-pull')).toHaveStyle({ '--pull': '0.6' })
        expect(document.querySelector('.misty-pull')).toHaveTextContent('keep pulling…')
        expect(footer).toHaveClass('misty-footer-lift')
        expect(footer).toHaveAttribute('data-misty-pulling')
        const firstLift = parseFloat(footer.style.getPropertyValue('--misty-lift'))
        expect(firstLift).toBeGreaterThan(50)
        act(() => handlers.onProgress(0.9))
        expect(parseFloat(footer.style.getPropertyValue('--misty-lift'))).toBeGreaterThan(firstLift)
        act(() => handlers.onProgress(0))
        expect(document.querySelector('.misty-pull')).toHaveStyle({ '--pull': '0' })
        expect(footer).toHaveStyle({ '--misty-lift': '0px' })
        expect(footer).not.toHaveAttribute('data-misty-pulling')
    })
    it('removes the footer lift when navigating away during a pull', () => {
        render(<footer className="linen-footer" />)
        const footer = document.querySelector('.linen-footer')
        const view = render(<MistyEcho />)
        act(() => handlers.onProgress(0.7))
        view.unmount()
        expect(footer).not.toHaveClass('misty-footer-lift')
        expect(footer).not.toHaveAttribute('data-misty-pulling')
        expect(footer.style.getPropertyValue('--misty-lift')).toBe('')
        expect(document.querySelector('.misty-pull')).toBeNull()
    })
    it('stays idle until deliberate interaction, reuses previews, and cleans up after six seconds', async () => {
        const view = render(<MistyEcho />)
        expect(loadMistyEchoPhotos).not.toHaveBeenCalled()
        await trigger()
        expect(document.querySelector('.misty-echo')).toHaveAttribute('aria-hidden', 'true')
        expect(document.querySelector('.misty-echo')).not.toHaveTextContent(/you found Misty/i)
        const images = [...document.querySelectorAll('.misty-echo img')]
        expect(images.length).toBeLessThanOrEqual(60)
        expect(new Set(images.map(image => image.src))).toEqual(new Set(['https://media.test/cat-thumb.jpg']))
        expect(document.querySelectorAll('.misty-echo-copy span').length).toBe(images.length)
        await act(() => vi.advanceTimersByTimeAsync(6000))
        expect(document.querySelector('.misty-echo')).toBeNull()
        await trigger()
        expect(loadMistyEchoPhotos).toHaveBeenCalledTimes(1)
        await act(() => vi.advanceTimersByTimeAsync(6000))
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
    it('lets reduced-motion visitors discover a still version of Misty', async () => {
        motion.matches = true
        render(<MistyEcho />)
        act(() => handlers.onProgress(0.6))
        await trigger()
        expect(loadMistyEchoPhotos).toHaveBeenCalledTimes(1)
        expect(document.querySelector('.misty-echo')).toHaveClass('misty-echo-still')
        expect(document.querySelector('.misty-pull')).toHaveStyle({ '--pull': '0' })
    })
    it('silently skips unavailable Misty photos', async () => {
        loadMistyEchoPhotos.mockRejectedValue(new Error('Offline'))
        render(<MistyEcho />)
        await trigger()
        expect(document.querySelector('.misty-echo')).toBeNull()
        loadMistyEchoPhotos.mockResolvedValue(['https://media.test/cat-thumb.jpg'])
        await trigger()
        expect(document.querySelector('.misty-echo')).not.toBeNull()
    })
    it('keeps the paw visible while the triggered previews are loading', async () => {
        let finishLoading
        loadMistyEchoPhotos.mockImplementation(() => new Promise(resolve => { finishLoading = resolve }))
        render(<MistyEcho />)
        let pending
        await act(async () => { pending = handlers.onTrigger(); await vi.advanceTimersByTimeAsync(0) })
        expect(document.querySelector('.misty-pull')).toHaveTextContent('Misty is waking up…')
        act(() => handlers.onProgress(0))
        expect(document.querySelector('.misty-pull')).toHaveStyle({ '--pull': '1' })
        await act(async () => { finishLoading(['https://media.test/cat-thumb.jpg']); await pending })
        expect(document.querySelector('.misty-echo')).not.toBeNull()
        expect(document.querySelector('.misty-pull')).toHaveStyle({ '--pull': '0' })
    })
    it('cancels pending cats when the page becomes unsettled', async () => {
        let finishLoading
        loadMistyEchoPhotos.mockImplementation(() => new Promise(resolve => { finishLoading = resolve }))
        render(<MistyEcho />)
        let pending
        await act(async () => { pending = handlers.onTrigger(); await vi.advanceTimersByTimeAsync(0) })
        act(() => handlers.onCancel())
        await act(async () => { finishLoading(['https://media.test/cat-thumb.jpg']); await pending })
        expect(document.querySelector('.misty-echo')).toBeNull()
        expect(document.querySelector('.misty-pull')).toHaveStyle({ '--pull': '0' })
    })
})
