import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { loadEditorSession, saveEditorSource, saveEditorState } from '../editor/sessionStore'

import Privacy from './Privacy'

describe('Privacy notice analytics controls', () => {
    beforeEach(() => localStorage.clear())
    afterEach(() => vi.unstubAllGlobals())

    it('discloses aggregate analytics and stores an opt-out choice', () => {
        render(<MemoryRouter><Privacy /></MemoryRouter>)
        expect(screen.getByRole('heading', { name: 'Aggregate website analytics' })).toBeInTheDocument()
        expect(screen.getByText(/Analytics records do not store cookies/i)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Opt out' }))
        expect(screen.getByText(/Current setting:/)).toHaveTextContent('Aggregate analytics disabled')
        expect(localStorage.getItem('ian-photography-analytics')).toBe('disabled')
    })

    it('clears the actual saved photo and edits without removing unrelated preferences', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory())
        vi.stubGlobal('Blob', NodeBlob)
        vi.stubGlobal('File', NodeFile)
        await saveEditorSource(new File(['photo'], 'private.jpg', { type: 'image/jpeg' }))
        await saveEditorState({ adjustments: { exposure: 2 } })
        localStorage.setItem('appearance', 'dark')
        render(<MemoryRouter><Privacy /></MemoryRouter>)
        fireEvent.click(screen.getByRole('button', { name: 'Clear saved editor session' }))
        expect(await screen.findByText(/saved editor session was cleared/)).toBeInTheDocument()
        await expect(loadEditorSession()).resolves.toBeNull()
        expect(localStorage.getItem('appearance')).toBe('dark')
    })

    it('does not claim deletion when browser storage is unavailable', async () => {
        vi.stubGlobal('indexedDB', undefined)
        render(<MemoryRouter><Privacy /></MemoryRouter>)
        fireEvent.click(screen.getByRole('button', { name: 'Clear saved editor session' }))
        expect(await screen.findByText(/saved session could not be cleared/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Clear saved editor session' })).toBeEnabled()
    })

    it('keeps GPC effective even after pressing allow', () => {
        vi.stubGlobal('navigator', Object.create(navigator, { globalPrivacyControl: { value: true } }))
        render(<MemoryRouter><Privacy /></MemoryRouter>)
        fireEvent.click(screen.getByRole('button', { name: 'Allow aggregate analytics' }))
        expect(screen.getByText(/Current setting:/)).toHaveTextContent('Aggregate analytics disabled')
        expect(screen.getByText(/Current setting:/)).toHaveTextContent('privacy signal is being honored')
    })
})
