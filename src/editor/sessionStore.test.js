import { IDBFactory } from 'fake-indexeddb'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearEditorSession, loadEditorSession, saveEditorSource, saveEditorState } from './sessionStore'

describe('editor session storage', () => {
    beforeEach(() => {
        vi.stubGlobal('indexedDB', new IDBFactory())
        vi.stubGlobal('Blob', NodeBlob)
        vi.stubGlobal('File', NodeFile)
    })

    it('round-trips a local source file and its recoverable editor state', async () => {
        const file = new File(['photo bytes'], 'mountain.jpg', {
            type: 'image/jpeg',
            lastModified: 123456,
        })
        const state = {
            adjustments: { exposure: 1.25 },
            geometry: { quarterTurns: 1 },
            zoom: 125,
        }

        await saveEditorSource(file)
        await saveEditorState(state)
        const restored = await loadEditorSession()

        expect(restored.file).toBeInstanceOf(File)
        expect(restored.file.name).toBe('mountain.jpg')
        expect(restored.file.type).toBe('image/jpeg')
        expect(restored.file.lastModified).toBe(123456)
        expect(await restored.file.text()).toBe('photo bytes')
        expect(restored.state).toEqual(state)
        expect(restored.savedAt).toBeGreaterThan(0)
    })

    it('never carries state from the previous photo to a replacement source', async () => {
        await saveEditorSource(new File(['first'], 'first.jpg', { type: 'image/jpeg' }))
        await saveEditorState({ adjustments: { exposure: 4 } })
        await saveEditorSource(new File(['second'], 'second.png', { type: 'image/png' }))

        const restored = await loadEditorSession()
        expect(restored.file.name).toBe('second.png')
        expect(restored.state).toBeNull()
    })

    it('clears both the source and state records', async () => {
        await saveEditorSource(new File(['photo'], 'photo.webp', { type: 'image/webp' }))
        await saveEditorState({ compare: true })
        await clearEditorSession()

        await expect(loadEditorSession()).resolves.toBeNull()
    })

    it('rejects invalid sources and reports browsers without IndexedDB', async () => {
        await expect(saveEditorSource('not a file')).rejects.toThrow(/local image file/)
        vi.stubGlobal('indexedDB', undefined)
        await expect(loadEditorSession()).rejects.toThrow(/unavailable/)
        await expect(saveEditorState({})).rejects.toThrow(/unavailable/)
    })
})
