import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AlbumShareButton from './AlbumShareButton'

const sharing = vi.hoisted(() => ({ sharePage: vi.fn() }))
vi.mock('../utils/share', () => sharing)

describe('AlbumShareButton', () => {
    it('opens the native share flow for the current album', async () => {
        sharing.sharePage.mockResolvedValue('shared')
        render(<AlbumShareButton albumTitle="Mountain Light" />)
        fireEvent.click(screen.getByRole('button', { name: 'Share Mountain Light' }))
        await waitFor(() => expect(sharing.sharePage).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Mountain Light — Ian Truong Photography',
        })))
    })

    it('confirms the copied-link fallback', async () => {
        sharing.sharePage.mockResolvedValue('copied')
        render(<AlbumShareButton albumTitle="Mountain Light" />)
        fireEvent.click(screen.getByRole('button', { name: 'Share Mountain Light' }))
        expect(await screen.findByText('Link Copied')).toBeInTheDocument()
    })
})
