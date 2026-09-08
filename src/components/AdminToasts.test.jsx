import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AdminToasts from './AdminToasts'
import { useAdminToasts } from '../hooks/useAdminToasts'
function Harness() {
    const { toasts, notify, dismiss } = useAdminToasts()
    return <div style={{ transform: 'translateY(1px)' }}><button onClick={() => notify('Saved')}>Save</button><button onClick={() => notify('Failed', 'error')}>Fail</button><AdminToasts toasts={toasts} dismiss={dismiss} /></div>
}
afterEach(() => vi.useRealTimers())
it('portals outside the page and keeps newer successes for their own duration', () => {
    vi.useFakeTimers()
    const { container } = render(<Harness />)
    fireEvent.click(screen.getByText('Save'))
    expect(container.querySelector('[aria-label="Notifications"]')).toBeNull()
    expect(screen.getByLabelText('Notifications').className).toContain('fixed')
    act(() => vi.advanceTimersByTime(3000))
    fireEvent.click(screen.getByText('Save'))
    act(() => vi.advanceTimersByTime(1100))
    expect(screen.getAllByRole('status')).toHaveLength(1)
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.queryByRole('status')).toBeNull()
})
it('keeps errors until dismissed and pauses successes while focused', () => {
    vi.useFakeTimers()
    render(<Harness />)
    fireEvent.click(screen.getByText('Fail'))
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByRole('alert')).toHaveTextContent('Failed')
    fireEvent.click(screen.getByLabelText('Dismiss notification'))
    fireEvent.click(screen.getByText('Save'))
    fireEvent.focus(screen.getByLabelText('Dismiss notification'))
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByRole('status')).toBeInTheDocument()
})
