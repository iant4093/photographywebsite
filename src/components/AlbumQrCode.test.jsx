import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import AlbumQrCode from './AlbumQrCode'

describe('AlbumQrCode', () => {
    it('renders nothing without a QR asset URL', () => {
        const { container } = render(<AlbumQrCode albumTitle="Album" qrCodeUrl="" />)
        expect(container).toBeEmptyDOMElement()
    })

    it('opens an accessible QR lightbox and restores focus when closed', () => {
        render(<AlbumQrCode albumTitle="Trail Album" qrCodeUrl="https://media.test/qr.svg" />)
        const trigger = screen.getByRole('button', { name: 'Show QR code for Trail Album' })
        trigger.focus()
        fireEvent.click(trigger)
        expect(screen.getByRole('dialog', { name: 'QR code for Trail Album' })).toBeInTheDocument()
        expect(screen.getByRole('img', { name: 'QR code linking to Trail Album' })).toHaveAttribute('src', 'https://media.test/qr.svg')
        expect(screen.getByText('Scan to open this album')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Close QR code' }))
        expect(screen.queryByRole('dialog', { name: 'QR code for Trail Album' })).toBeNull()
        expect(trigger).toHaveFocus()
    })

    it('delegates protected-link refresh when the QR asset expires', () => {
        const onLoadError = vi.fn()
        render(<AlbumQrCode albumTitle="Shared Album" qrCodeUrl="https://media.test/expired.svg" onLoadError={onLoadError} />)
        fireEvent.click(screen.getByRole('button', { name: 'Show QR code for Shared Album' }))
        fireEvent.error(screen.getByRole('img', { name: 'QR code linking to Shared Album' }))
        expect(onLoadError).toHaveBeenCalledOnce()
        expect(screen.queryByRole('dialog', { name: 'QR code for Shared Album' })).toBeNull()
    })
})
