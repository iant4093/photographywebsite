import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SectionStats from './SectionStats'
import { fetchSectionStats } from '../utils/sectionStats'

vi.mock('../utils/sectionStats', () => ({ fetchSectionStats: vi.fn() }))
const stats = {
    albumCount: 2, photoCount: 54, firstDate: '2024-01-02', lastDate: '2026-08-27',
    cameras: ['Canon EOS R7'], lenses: [['Sirui Nightwalker 75mm T1.2', 32], ['YN33mm F/1.4R DA DSM', 22]],
}
beforeEach(() => { vi.clearAllMocks(); fetchSectionStats.mockResolvedValue(stats) })
afterEach(() => vi.useRealTimers())

describe('SectionStats', () => {
    it('loads on demand and closes with Escape, the close button, and the backdrop, restoring focus', async () => {
        render(<SectionStats category="Misty" />)
        const button = screen.getByRole('button', { name: 'Show Misty statistics' })
        expect(fetchSectionStats).not.toHaveBeenCalled()
        button.focus()
        fireEvent.click(button)
        expect(await screen.findByText('Sirui Nightwalker 75mm T1.2 (32)')).toBeInTheDocument()
        expect(screen.getByText('Jan 2, 2024 – Aug 27, 2026')).toBeInTheDocument()
        expect(screen.getByText('54')).toBeInTheDocument()
        const close = screen.getByRole('button', { name: 'Close section statistics' })
        expect(close).toHaveFocus()
        fireEvent.keyDown(window, { key: 'Tab' })
        expect(close).toHaveFocus()
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(button).toHaveFocus()
        fireEvent.click(button)
        await screen.findByText('54')
        fireEvent.click(screen.getByRole('button', { name: 'Close section statistics' }))
        fireEvent.click(button)
        await screen.findByText('54')
        fireEvent.mouseDown(screen.getByRole('dialog'))
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(fetchSectionStats).toHaveBeenCalledTimes(3)
    })

    it('refreshes additions and removals while open and aborts work when closed', async () => {
        vi.useFakeTimers()
        render(<SectionStats category="Misty" />)
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show Misty statistics' })))
        const signal = fetchSectionStats.mock.calls[0][1].signal
        fetchSectionStats.mockResolvedValue({ ...stats, photoCount: 10, lenses: [['New lens', 10]] })
        await act(async () => vi.advanceTimersByTimeAsync(60_000))
        expect(screen.getByText('New lens (10)')).toBeInTheDocument()
        expect(screen.queryByText(/Sirui/)).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Close section statistics' }))
        expect(signal.aborted).toBe(true)
        await act(async () => vi.advanceTimersByTimeAsync(60_000))
        expect(fetchSectionStats).toHaveBeenCalledTimes(2)
    })

    it('shows loading, retries errors, and handles an empty section', async () => {
        fetchSectionStats.mockRejectedValueOnce(new Error('Unavailable'))
        render(<SectionStats category="Misty" />)
        fireEvent.click(screen.getByRole('button', { name: 'Show Misty statistics' }))
        expect(screen.getByRole('status')).toHaveTextContent('Loading statistics')
        expect(await screen.findByRole('alert')).toHaveTextContent('Stats could not be loaded.')
        fetchSectionStats.mockResolvedValue({ albumCount: 0, photoCount: 0, cameras: [], lenses: [] })
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
        expect(screen.getAllByText('0')).toHaveLength(2)
        expect(screen.getAllByText('Not recorded')).toHaveLength(3)
    })
})
