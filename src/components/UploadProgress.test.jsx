import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import UploadProgress from './UploadProgress'

it('displays measured speed and ETA, handles stalls, and separates transfer completion from saving', () => {
    const base = { phase: 'uploading', loadedBytes: 5_000_000, totalBytes: 10_000_000, bytesPerSecond: 1_000_000, remainingSeconds: 5, completedFiles: 1, totalFiles: 2 }
    const { rerender } = render(<UploadProgress progress={base} />)
    expect(screen.getByText('1.0 MB/s')).toBeInTheDocument()
    expect(screen.getByText('About 5s')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    rerender(<UploadProgress progress={{ ...base, bytesPerSecond: 0, remainingSeconds: null }} />)
    expect(screen.getByText('0 B/s')).toBeInTheDocument()
    expect(screen.getByText('Waiting for transfer…')).toBeInTheDocument()
    rerender(<UploadProgress progress={{ ...base, loadedBytes: base.totalBytes }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Finishing uploads…')
    expect(screen.getByText('Confirming transfer…')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '99')
    rerender(<UploadProgress progress={{ ...base, phase: 'saving', completedFiles: 2 }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Saving album…')
    expect(screen.queryByText('About 5s')).toBeNull()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    rerender(<UploadProgress progress={{ ...base, bytesPerSecond: null, remainingSeconds: null }} />)
    expect(screen.getByText('Measuring…')).toBeInTheDocument()
    expect(screen.getByText('Calculating…')).toBeInTheDocument()
    rerender(<UploadProgress progress={null} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
})
