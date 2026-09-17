import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VideoControls from './VideoControls'
import VideoPlayer from './VideoPlayer'
import { selectChoice } from '../test/selectChoice'

function setup({ extended = false, captions = false } = {}) {
    const video = document.createElement('video')
    const player = document.createElement('div')
    const captionTrack = { kind: 'captions', mode: 'showing' }
    const tracks = Object.assign([captionTrack], {
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })
    if (captions) Object.defineProperty(video, 'textTracks', { value: tracks })
    Object.defineProperty(video, 'duration', { configurable: true, value: 125 })
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: true })
    video.play = vi.fn(async () => { video.paused = false; video.dispatchEvent(new Event('play')) })
    video.pause = vi.fn(() => { video.paused = true; video.dispatchEvent(new Event('pause')) })
    if (extended) {
        Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
        player.requestFullscreen = vi.fn(async () => {
            Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: player })
            document.dispatchEvent(new Event('fullscreenchange'))
        })
        document.exitFullscreen = vi.fn(async () => {
            Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
            document.dispatchEvent(new Event('fullscreenchange'))
        })
        video.requestPictureInPicture = vi.fn(async () => {
            Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: video })
        })
        document.exitPictureInPicture = vi.fn(async () => {
            Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: null })
        })
    }
    const parentKey = vi.fn()
    const view = render(<div onKeyDown={parentKey}><VideoControls videoRef={{ current: video }} playerRef={{ current: player }} captionKey={captions ? 'caption-track' : ''} /></div>)
    return { video, player, parentKey, captionTrack, tracks, ...view }
}

afterEach(() => {
    for (const property of ['fullscreenElement', 'pictureInPictureElement', 'pictureInPictureEnabled', 'exitFullscreen', 'exitPictureInPicture']) delete document[property]
})

describe('custom video controls', () => {
    it('toggles caption visibility and follows native text-track changes', () => {
        const { captionTrack, tracks, unmount } = setup({ captions: true })
        const toggle = screen.getByRole('button', { name: 'Captions' })
        expect(toggle).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(toggle)
        expect(captionTrack.mode).toBe('hidden')
        expect(toggle).toHaveAttribute('aria-pressed', 'false')
        fireEvent.click(toggle)
        expect(captionTrack.mode).toBe('showing')
        act(() => {
            captionTrack.mode = 'disabled'
            tracks.addEventListener.mock.calls[0][1]()
        })
        expect(toggle).toHaveAttribute('aria-pressed', 'false')
        unmount()
        expect(tracks.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    })

    it('loads authored captions locally, exposes a transcript, and releases replaced tracks', () => {
        const original = Object.getOwnPropertyDescriptor(HTMLTrackElement.prototype, 'track')
        const track = { mode: 'disabled' }
        Object.defineProperty(HTMLTrackElement.prototype, 'track', { configurable: true, get: () => track })
        const createUrl = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
        vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }))
        const captionVtt = 'WEBVTT\n\n00:00.000 --> 00:02.000\nBirdsong.'
        try {
            const view = render(<VideoPlayer videoInfo={{ captionVtt, captionLanguage: 'en', transcript: 'A bird sings.', altText: 'A bird on a branch' }} />)
            expect(view.container.querySelector('track')).toHaveAttribute('src', 'blob:first')
            expect(track.mode).toBe('showing')
            expect(screen.getByLabelText('A bird on a branch')).toBeInTheDocument()
            expect(screen.getByText('Transcript & visual description')).toBeInTheDocument()
            expect(screen.getByText('A bird sings.')).toBeInTheDocument()
            fireEvent.error(view.container.querySelector('track'))
            expect(screen.getByRole('status')).toHaveTextContent('Captions could not load')
            view.rerender(<VideoPlayer videoInfo={{ captionVtt: captionVtt.replace('Birdsong.', 'Wind.'), captionLanguage: 'en' }} />)
            expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first')
            expect(screen.queryByRole('status')).toBeNull()
            view.unmount()
            expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second')
        } finally {
            if (original) Object.defineProperty(HTMLTrackElement.prototype, 'track', original)
            else delete HTMLTrackElement.prototype.track
            vi.unstubAllGlobals()
        }
    })

    it('plays, pauses, seeks, and shows media time without triggering gallery shortcuts', async () => {
        const { video, parentKey } = setup()
        expect(screen.getByText('0:00 / 2:05')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Play video' }))
        expect(await screen.findByRole('button', { name: 'Pause video' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Pause video' }))
        expect(video.pause).toHaveBeenCalledOnce()
        const seek = screen.getByRole('slider', { name: 'Video position' })
        fireEvent.change(seek, { target: { value: '65' } })
        expect(video.currentTime).toBe(65)
        expect(seek).toHaveAttribute('aria-valuetext', '1:05 of 2:05')
        fireEvent.keyDown(seek, { key: 'ArrowRight' })
        fireEvent.keyDown(screen.getByRole('combobox'), { key: ' ' })
        expect(parentKey).not.toHaveBeenCalled()
        act(() => {
            Object.defineProperty(video, 'duration', { configurable: true, value: Infinity })
            video.dispatchEvent(new Event('emptied'))
        })
        expect(seek).toBeDisabled()
    })

    it('changes volume, mute, and playback speed through custom choices', async () => {
        const { video } = setup()
        const volume = screen.getByRole('slider', { name: 'Video volume' })
        fireEvent.change(volume, { target: { value: '.4' } })
        await waitFor(() => expect(volume).toHaveAttribute('aria-valuetext', '40 percent'))
        expect(video.volume).toBe(.4)
        fireEvent.click(screen.getByRole('button', { name: 'Mute video' }))
        await screen.findByRole('button', { name: 'Unmute video' })
        expect(video.muted).toBe(true)
        fireEvent.change(volume, { target: { value: '.7' } })
        await screen.findByRole('button', { name: 'Mute video' })
        expect(video.muted).toBe(false)
        selectChoice(screen.getByRole('combobox', { name: 'Playback speed' }), '1.5')
        await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('1.5×'))
        expect(video.playbackRate).toBe(1.5)
        expect(document.querySelector('select, datalist')).toBeNull()
    })

    it('offers fullscreen and picture in picture only when supported and toggles both', async () => {
        const basic = setup()
        expect(screen.queryByRole('button', { name: 'Fullscreen video' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Picture in picture' })).toBeNull()
        basic.unmount()
        const { player, video } = setup({ extended: true })
        fireEvent.click(screen.getByRole('button', { name: 'Fullscreen video' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Exit fullscreen video' }))
        await screen.findByRole('button', { name: 'Fullscreen video' })
        expect(player.requestFullscreen).toHaveBeenCalledOnce()
        expect(document.exitFullscreen).toHaveBeenCalledOnce()
        fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }))
        await waitFor(() => expect(document.pictureInPictureElement).toBe(video))
        fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }))
        await waitFor(() => expect(document.exitPictureInPicture).toHaveBeenCalledOnce())
    })

    it('reports playback or browser feature failures without an unhandled rejection', async () => {
        const { video, player } = setup({ extended: true })
        video.play.mockRejectedValueOnce(new Error('Denied'))
        fireEvent.click(screen.getByRole('button', { name: 'Play video' }))
        expect(await screen.findByRole('status')).toHaveTextContent('Playback could not start')
        player.requestFullscreen.mockRejectedValueOnce(new Error('Denied'))
        fireEvent.click(screen.getByRole('button', { name: 'Fullscreen video' }))
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Fullscreen is unavailable'))
        video.requestPictureInPicture.mockRejectedValueOnce(new Error('Denied'))
        fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }))
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Picture in picture is unavailable'))
    })

    it('keeps inline previews control-free and uses site controls for the full player', () => {
        const view = render(<VideoPlayer videoInfo={{}} controls={false} />)
        expect(view.container.querySelector('video')).not.toHaveAttribute('controls')
        expect(screen.queryByRole('combobox')).toBeNull()
        view.rerender(<VideoPlayer videoInfo={{}} controls />)
        expect(view.container.querySelector('video')).not.toHaveAttribute('controls')
        expect(screen.getByRole('combobox', { name: 'Playback speed' })).toBeInTheDocument()
    })
})
