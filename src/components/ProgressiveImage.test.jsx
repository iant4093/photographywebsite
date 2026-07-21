import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProgressiveImage from './ProgressiveImage'

describe('ProgressiveImage responsive fallback', () => {
    it('retries the legacy src without srcset before surfacing an error', () => {
        const onError = vi.fn()
        const { rerender } = render(
            <ProgressiveImage
                eager
                src="https://media.example.test/legacy.jpg"
                srcSet="https://media.example.test/preview-640.webp 640w, https://media.example.test/preview-1280.webp 1280w"
                sizes="100vw"
                alt="Preview"
                onError={onError}
            />,
        )

        fireEvent.error(screen.getByRole('img', { name: 'Preview' }))
        expect(onError).not.toHaveBeenCalled()
        expect(screen.getByRole('img', { name: 'Preview' })).not.toHaveAttribute('srcset')

        fireEvent.error(screen.getByRole('img', { name: 'Preview' }))
        expect(onError).toHaveBeenCalledOnce()

        rerender(
            <ProgressiveImage
                eager
                src="https://media.example.test/legacy.jpg"
                srcSet="https://media.example.test/new-640.webp 640w, https://media.example.test/new-1280.webp 1280w"
                sizes="100vw"
                alt="Preview"
                onError={onError}
            />,
        )
        expect(screen.getByRole('img', { name: 'Preview' })).toHaveAttribute('srcset')
    })
})
