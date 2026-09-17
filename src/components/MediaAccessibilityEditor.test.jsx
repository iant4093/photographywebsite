import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MediaAccessibilityEditor from './MediaAccessibilityEditor'

describe('media accessibility authoring', () => {
    it('imports captions and saves the video language and transcript together', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()
        render(<MediaAccessibilityEditor image={{}} isVideo onSave={onSave} onClose={onClose} />)
        const text = 'WEBVTT\n\n00:00.000 --> 00:01.500\n[Waves crashing]'
        fireEvent.change(screen.getByLabelText('Import a WebVTT caption file'), { target: { files: [{ size: text.length, text: async () => text }] } })
        await waitFor(() => expect(screen.getByLabelText('Timed captions (WebVTT)')).toHaveValue(text))
        fireEvent.change(screen.getByLabelText('Short video description'), { target: { value: 'Waves on the Oregon coast' } })
        fireEvent.change(screen.getByLabelText('Transcript & visual description'), { target: { value: 'Waves crash against dark rocks.' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save accessibility text' }))
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
        expect(onSave).toHaveBeenCalledWith({ altText: 'Waves on the Oregon coast', captionVtt: text, captionLanguage: 'en', transcript: 'Waves crash against dark rocks.' })
    })

    it('keeps edits available when saving fails and rejects an oversized import', async () => {
        const onClose = vi.fn()
        render(<MediaAccessibilityEditor image={{ altText: 'Existing description' }} isVideo onSave={vi.fn().mockRejectedValue(new Error('Please sign in again'))} onClose={onClose} />)
        fireEvent.click(screen.getByRole('button', { name: 'Save accessibility text' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Please sign in again')
        expect(onClose).not.toHaveBeenCalled()
        expect(screen.getByLabelText('Short video description')).toHaveValue('Existing description')
        fireEvent.change(screen.getByLabelText('Import a WebVTT caption file'), { target: { files: [{ size: 25000, text: vi.fn() }] } })
        expect(await screen.findByRole('alert')).toHaveTextContent('under 24 KB')
        expect(screen.getByLabelText('Timed captions (WebVTT)')).toHaveValue('')
    })
})
