import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import AlbumStats from './AlbumStats'

const photo = (model, lens) => ({ exif: { model, lens } })
const stats = () => within(screen.getByLabelText('Album statistics'))

describe('AlbumStats', () => {
    it('counts every photo, lists distinct cameras, and groups lenses by use', () => {
        render(<AlbumStats images={[
            photo('Canon EOS R7', 'Sigma 18-50mm F2.8'),
            photo(' Canon EOS R7 ', ' Sigma  18-50mm F2.8 '),
            photo('Fujifilm X-T5', 'XF 35mm F2'),
            photo('Canon EOS R7', 'Sigma 18-50mm F2.8'),
            {},
        ]} />)

        expect(stats().getByText('5')).toBeInTheDocument()
        expect(stats().getByText('Cameras used')).toBeInTheDocument()
        expect(stats().getByText('Canon EOS R7 · Fujifilm X-T5')).toBeInTheDocument()
        expect(stats().getAllByRole('listitem').map(item => item.textContent)).toEqual([
            'Sigma 18-50mm F2.8 (3)', 'XF 35mm F2 (1)',
        ])
    })

    it('updates counts after additions and removals and removes the final use of a lens', () => {
        const standard = photo('Canon EOS R7', 'Sigma 18-50mm F2.8')
        const telephoto = photo('Canon EOS R7', 'RF 100-400mm')
        const newCamera = photo('Fujifilm X-T5', 'XF 35mm F2')
        const { rerender } = render(<AlbumStats images={[standard, standard, telephoto]} />)
        expect(stats().getByText('3')).toBeInTheDocument()
        expect(stats().getByText('Sigma 18-50mm F2.8 (2)')).toBeInTheDocument()
        expect(stats().getByText('RF 100-400mm (1)')).toBeInTheDocument()

        rerender(<AlbumStats images={[standard, telephoto]} />)
        expect(stats().getByText('2')).toBeInTheDocument()
        expect(stats().getByText('Sigma 18-50mm F2.8 (1)')).toBeInTheDocument()

        rerender(<AlbumStats images={[standard]} />)
        expect(stats().getByText('1')).toBeInTheDocument()
        expect(stats().queryByText(/RF 100-400mm/)).toBeNull()

        rerender(<AlbumStats images={[standard, standard, newCamera]} />)
        expect(stats().getByText('3')).toBeInTheDocument()
        expect(stats().getByText('Sigma 18-50mm F2.8 (2)')).toBeInTheDocument()
        expect(stats().getByText('XF 35mm F2 (1)')).toBeInTheDocument()
        expect(stats().getByText('Canon EOS R7 · Fujifilm X-T5')).toBeInTheDocument()

        rerender(<AlbumStats images={[]} />)
        expect(stats().getByText('0')).toBeInTheDocument()
        expect(stats().queryByRole('list')).toBeNull()
        expect(stats().queryByText(/Canon|Fujifilm|Sigma|XF 35mm/)).toBeNull()
    })

    it('handles empty albums and photos with missing or malformed EXIF without inventing equipment', () => {
        const { rerender } = render(<AlbumStats />)
        expect(stats().getByText('0')).toBeInTheDocument()
        expect(stats().getAllByText('Not recorded')).toHaveLength(2)

        rerender(<AlbumStats images={[{}, { exif: null }, photo('  ', ''), photo(123, {})]} />)
        expect(stats().getByText('4')).toBeInTheDocument()
        expect(stats().getAllByText('Not recorded')).toHaveLength(2)
    })
})
