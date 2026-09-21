import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForCatalogBrowse } from './catalogBrowse'
import { loadCompleteCatalog } from './catalogState'

describe('automatic catalog browsing', () => {
    let target, top, notify, disconnect, visibility
    beforeEach(() => {
        document.body.innerHTML = '<section><h2>Albums</h2><button>Sort sections</button></section>'
        target = document.querySelector('h2')
        top = 3000
        notify = undefined
        visibility = 'visible'
        vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => ({ top }))
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
        disconnect = vi.fn()
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback) { notify = callback }
            observe() {}
            disconnect = disconnect
        })
    })
    afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

    it('fetches the first page immediately and finishes automatically when browsing approaches', async () => {
        const fetchPage = vi.fn()
            .mockResolvedValueOnce({ items: [{ albumId: 'first' }], nextCursor: 'two' })
            .mockResolvedValueOnce({ items: [{ albumId: 'second' }], nextCursor: 'three' })
            .mockResolvedValueOnce({ items: [{ albumId: 'last' }], nextCursor: null })
        const onPage = vi.fn()
        const beforeNextPage = vi.fn(() => waitForCatalogBrowse(target))
        const result = loadCompleteCatalog({ fetchPage, onPage, beforeNextPage })
        await Promise.resolve()
        expect(fetchPage).toHaveBeenCalledTimes(1)
        expect(onPage).toHaveBeenCalledTimes(1)
        top = 800
        notify()
        await expect(result).resolves.toMatchObject({ items: [{ albumId: 'first' }, { albumId: 'second' }, { albumId: 'last' }] })
        expect(beforeNextPage).toHaveBeenCalledTimes(1)
        expect(disconnect).toHaveBeenCalledTimes(1)
    })

    it.each(['focusin', 'pointerdown'])('also resumes on existing control interaction: %s', async event => {
        const result = waitForCatalogBrowse(target)
        document.querySelector('button').dispatchEvent(new Event(event, { bubbles: true }))
        await result
        expect(disconnect).toHaveBeenCalledTimes(1)
    })

    it('resumes when a scrollbar or history jump skips past the observed heading', async () => {
        const result = waitForCatalogBrowse(target)
        top = -2000
        window.dispatchEvent(new Event('scroll'))
        await result
        expect(disconnect).toHaveBeenCalledTimes(1)
    })

    it('defers a background catalog and checks proximity on return', async () => {
        visibility = 'hidden'
        top = 100
        let finished = false
        const result = waitForCatalogBrowse(target).then(() => { finished = true })
        notify()
        await Promise.resolve()
        expect(finished).toBe(false)
        visibility = 'visible'
        document.dispatchEvent(new Event('visibilitychange'))
        await result
        expect(finished).toBe(true)
    })

    it('cancels pending work and releases observers on navigation', async () => {
        const controller = new AbortController()
        const result = waitForCatalogBrowse(target, controller.signal)
        controller.abort()
        await expect(result).rejects.toMatchObject({ name: 'AbortError' })
        expect(disconnect).toHaveBeenCalledTimes(1)
        await expect(waitForCatalogBrowse(target, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('falls back to complete loading without observers and for an already-reached section', async () => {
        top = -100
        await waitForCatalogBrowse(target)
        expect(notify).toBeUndefined()
        vi.stubGlobal('IntersectionObserver', undefined)
        top = 3000
        await waitForCatalogBrowse(target)
        await waitForCatalogBrowse(null)
    })

    it('does not strand an empty first page behind the browse gate', async () => {
        const beforeNextPage = vi.fn()
        const fetchPage = vi.fn()
            .mockResolvedValueOnce({ items: [], nextCursor: 'two' })
            .mockResolvedValueOnce({ items: [{ albumId: 'first-result' }], nextCursor: null })
        await loadCompleteCatalog({ fetchPage, beforeNextPage })
        expect(fetchPage).toHaveBeenCalledTimes(2)
        expect(beforeNextPage).not.toHaveBeenCalled()
    })
})
