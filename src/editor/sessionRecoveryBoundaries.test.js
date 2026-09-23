import { IDBFactory } from 'fake-indexeddb'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { beforeEach, expect, it, vi } from 'vitest'
import { clearEditorSession, loadEditorSession, saveEditorSource, saveEditorState } from './sessionStore'

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('Blob', NodeBlob)
    vi.stubGlobal('File', NodeFile)
})

it('preserves newer edits against a recovered tab autosave and stale Close photo', async () => {
    const id = await saveEditorSource(new File(['photo'], 'photo.png'))
    const original = { adjustments: { exposure: 0 } }
    const first = await saveEditorState(original, id)
    const tabB = await loadEditorSession()
    expect(tabB.revision).toBe(first)
    // Opening an idle second tab cannot claim a revision from the active tab.
    expect(await saveEditorState(original, id, { expectedRevision: first })).toBe(first)
    const next = await saveEditorState({ adjustments: { exposure: 2 } }, id, { expectedRevision: first })
    expect(next).toBe(first + 1)
    expect(await saveEditorState(original, id, { expectedRevision: tabB.revision })).toBe(false)
    await clearEditorSession(id, tabB.revision)
    expect((await loadEditorSession()).state.adjustments.exposure).toBe(2)
    await clearEditorSession(id, next)
    expect(await loadEditorSession()).toBeNull()
})

it('only allows one competing edit from the same recovered revision', async () => {
    const id = await saveEditorSource(new File(['photo'], 'photo.png'))
    const results = await Promise.all([
        saveEditorState({ exposure: 2 }, id), saveEditorState({ exposure: 3 }, id),
    ])
    expect(results.filter(value => value !== false)).toHaveLength(1)
    expect((await loadEditorSession()).revision).toBe(1)
})

it('cancels an unfinished source write without resurrecting a closed photo', async () => {
    const controller = new AbortController()
    const saving = saveEditorSource(new File(['photo'], 'closed.png'), { signal: controller.signal })
    controller.abort()
    await expect(saving).rejects.toMatchObject({ name: 'AbortError' })
    expect(await loadEditorSession()).toBeNull()
})

it('cancels stale queued state without damaging a newer photo', async () => {
    const a = await saveEditorSource(new File(['a'], 'a.png'))
    const controller = new AbortController()
    const saving = saveEditorState({ exposure: 2 }, a, { signal: controller.signal })
    controller.abort()
    await expect(saving).rejects.toMatchObject({ name: 'AbortError' })
    const b = await saveEditorSource(new File(['b'], 'b.png'))
    await clearEditorSession(a, 0)
    expect((await loadEditorSession()).sourceId).toBe(b)
})

it('upgrades existing recovery state without a revision without discarding it', async () => {
    const id = await saveEditorSource(new File(['old'], 'old.png'))
    await new Promise((resolve, reject) => {
        const open = indexedDB.open('ian-truong-photo-editor', 1)
        open.onsuccess = () => {
            const db = open.result, tx = db.transaction('session', 'readwrite')
            tx.objectStore('session').put({ schema: 'ian-truong-photo-editor/session-v1', sourceId: id, state: { exposure: 1 } }, 'state')
            tx.oncomplete = () => { db.close(); resolve() }
            tx.onerror = () => reject(tx.error)
        }
    })
    const legacy = await loadEditorSession()
    expect(legacy.revision).toBe(0)
    expect(legacy.state).toEqual({ exposure: 1 })
    expect(await saveEditorState({ exposure: 2 }, id, { expectedRevision: legacy.revision })).toBe(1)
})
