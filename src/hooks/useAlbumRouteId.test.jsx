import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchAlbum: vi.fn() }))
vi.mock('../utils/api', () => api)

import useAlbumRouteId from './useAlbumRouteId'

const ID = '11111111-1111-4111-8111-111111111111'

function Probe() {
    const { handle } = useParams()
    const location = useLocation()
    const albumId = useAlbumRouteId(handle, 'album')
    return <p data-testid="probe">{`${location.pathname}${location.search} -> ${albumId || 'resolving'}`}</p>
}

function mounted(path) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <Routes><Route path="/album/:handle" element={<Probe />} /></Routes>
        </MemoryRouter>,
    )
}

const probe = () => screen.getByTestId('probe').textContent

describe('useAlbumRouteId', () => {
    beforeEach(() => api.fetchAlbum.mockReset())

    it('resolves a readable URL to its album id', async () => {
        api.fetchAlbum.mockResolvedValue({ album: { albumId: ID, slug: 'prague' } })
        mounted('/album/prague?photo=abc')
        expect(probe()).toBe('/album/prague?photo=abc -> resolving')
        await waitFor(() => expect(probe()).toBe(`/album/prague?photo=abc -> ${ID}`))
        expect(api.fetchAlbum).toHaveBeenCalledWith('prague')
    })

    it('moves an id link to the readable URL, keeping the shared photo', async () => {
        api.fetchAlbum.mockResolvedValue({ album: { albumId: ID, slug: 'prague-2' } })
        mounted(`/album/${ID}?photo=abc`)
        expect(probe()).toBe(`/album/${ID}?photo=abc -> ${ID}`)
        await waitFor(() => expect(probe()).toBe(`/album/prague-2?photo=abc -> ${ID}`))
    })

    it('keeps id links for albums without a slug, and private ones', async () => {
        api.fetchAlbum.mockResolvedValueOnce({ album: { albumId: ID } })
        const first = mounted(`/album/${ID}`)
        await waitFor(() => expect(api.fetchAlbum).toHaveBeenCalledTimes(1))
        expect(probe()).toBe(`/album/${ID} -> ${ID}`)
        first.unmount()
        api.fetchAlbum.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }))
        mounted(`/album/${ID}`)
        await waitFor(() => expect(api.fetchAlbum).toHaveBeenCalledTimes(2))
        expect(probe()).toBe(`/album/${ID} -> ${ID}`)
    })

    it('lets the page show not-found for an unknown slug or a malformed handle', async () => {
        api.fetchAlbum.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }))
        const first = mounted('/album/no-such-album')
        await waitFor(() => expect(probe()).toBe('/album/no-such-album -> no-such-album'))
        first.unmount()
        api.fetchAlbum.mockResolvedValueOnce({ album: {} })
        const second = mounted('/album/odd-response')
        await waitFor(() => expect(probe()).toBe('/album/odd-response -> odd-response'))
        second.unmount()
        mounted('/album/Not%20A%20Slug')
        expect(probe()).toBe('/album/Not%20A%20Slug -> Not A Slug')
        expect(api.fetchAlbum).toHaveBeenCalledTimes(2)
    })
})
