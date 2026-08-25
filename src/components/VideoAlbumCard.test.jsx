import { fireEvent, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ prefetchPublicAlbum: vi.fn().mockResolvedValue({ images: [] }) }))
const hover = vi.hoisted(() => ({ start: vi.fn() }))

vi.mock('../utils/api', () => api)
vi.mock('../utils/albumVideoHoverPreview', () => hover)
vi.mock('./AlbumCard', () => ({
    default: ({ album }) => (
        <a href={`/video/${album.albumId}`}>
            <div className="album-card-image">
                <div><span className="album-play">Play</span></div>
            </div>
        </a>
    ),
}))

import VideoAlbumCard from './VideoAlbumCard'

describe('VideoAlbumCard', () => {
    it('hides the play control only while the lightweight preview is playing', async () => {
        const stop = vi.fn()
        hover.start.mockReturnValue({ stop })
        const { container } = render(<VideoAlbumCard album={{ albumId: 'video-one' }} />)
        const wrapper = container.firstElementChild
        const overlay = container.querySelector('.album-play').parentElement

        expect(wrapper).toHaveClass('h-full')
        fireEvent.mouseEnter(wrapper)
        await waitFor(() => expect(hover.start).toHaveBeenCalledOnce())
        const options = hover.start.mock.calls[0][0]
        expect(options.container).toBe(container.querySelector('.album-card-image'))
        await options.loadDetail()
        expect(api.prefetchPublicAlbum).toHaveBeenCalledWith('video-one')

        options.onPlaybackStart()
        expect(overlay.style.opacity).toBe('0')
        options.onPlaybackEnd()
        expect(overlay.style.opacity).toBe('')

        fireEvent.mouseLeave(wrapper)
        expect(stop).toHaveBeenCalledOnce()
        expect(overlay.style.opacity).toBe('')
    })
})
