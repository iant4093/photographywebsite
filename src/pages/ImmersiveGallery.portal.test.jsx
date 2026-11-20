import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const canvasState = vi.hoisted(() => ({ scene: null, camera: null, dpr: null, mounts: 0, unmounts: 0 }))
const api = vi.hoisted(() => ({
    fetchAlbumForViewing: vi.fn(), fetchAllAlbums: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))

vi.mock('@react-three/fiber', async () => {
    const { useEffect } = await import('react')
    return {
        Canvas: ({ children, className, camera, dpr }) => {
            canvasState.scene = children.props.children.props
            canvasState.camera = camera
            canvasState.dpr = dpr
            useEffect(() => {
                canvasState.mounts += 1
                return () => { canvasState.unmounts += 1 }
            }, [])
            return <div className={className}><canvas data-testid="retained-museum-canvas" /></div>
        },
        addAfterEffect: vi.fn(), useFrame: vi.fn(), useLoader: Object.assign(vi.fn(), { preload: vi.fn() }), useThree: vi.fn(),
    }
})
vi.mock('../utils/api', () => api)
vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/analytics', () => ({ trackAlbumView: vi.fn(), trackPhotoDownload: vi.fn(), trackZipRequest: vi.fn() }))

import ImmersiveGalleryDesktop from './ImmersiveGalleryDesktop'

const album = { albumId: 'a1', title: 'Coastal Light', createdAt: '2026-01-01', visibility: 'public' }
const image = { id: 'one', url: 'https://media.test/one.jpg', thumbnailUrl: 'https://media.test/one-thumb.jpg', width: 2400, height: 1600 }

function LocationProbe() {
    const location = useLocation()
    return <output data-testid="gallery-location">{location.pathname}{location.search}</output>
}

async function gallery({ touch = false } = {}) {
    const path = `/explore/immersive-gallery?museum-fixture=1${touch ? '&museum-touch=1' : ''}`
    window.history.replaceState({}, '', path)
    const result = render(<MemoryRouter initialEntries={[path]}><ImmersiveGalleryDesktop /><LocationProbe /></MemoryRouter>)
    act(() => { canvasState.scene.onSceneReady() })
    await screen.findByRole('button', { name: 'Begin walk-through' })
    return { ...result, path, canvas: screen.getByTestId('retained-museum-canvas'), camera: canvasState.camera }
}

beforeEach(() => {
    vi.clearAllMocks()
    canvasState.scene = null
    canvasState.camera = null
    canvasState.dpr = null
    canvasState.mounts = 0
    canvasState.unmounts = 0
    auth.getIdToken.mockResolvedValue(null)
    api.fetchAlbumForViewing.mockReset().mockResolvedValue({ album, images: [image] })
    localStorage.clear()
    sessionStorage.clear()
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, writable: true, value: null })
    Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: vi.fn(() => { document.pointerLockElement = null }) })
})

const painting = { id: album.albumId, album, position: [2, 2, -2], rotationY: 0 }

describe('desktop gallery entrance', () => {
    it.each([
        ['unavailable', undefined],
        ['denied', () => Promise.reject(new Error('Denied'))],
        ['pending', () => new Promise(() => {})],
        ['throws', () => { throw new Error('Unsupported') }],
    ])('can enter, pause and resume when mouse capture is %s', async (_, requestPointerLock) => {
        const { canvas } = await gallery()
        Object.defineProperty(canvas, 'requestPointerLock', { configurable: true, value: requestPointerLock })
        const enter = () => fireEvent.click(screen.getByRole('button', { name: 'Begin walk-through' }))
        enter()
        expect(screen.queryByRole('heading', { name: 'Enter the gallery' })).toBeNull()
        expect(canvasState.scene.controlsEnabled.locked).toBe(true)
        expect(canvas).toHaveFocus()
        expect(screen.getByText('Drag')).toBeInTheDocument()
        fireEvent.keyDown(canvas, { key: 'Escape' })
        expect(canvasState.scene.controlsEnabled.locked).toBe(false)
        enter()
        expect(canvasState.scene.controlsEnabled.locked).toBe(true)
    })

    it('releases a late mouse capture after pausing', async () => {
        const { canvas } = await gallery()
        fireEvent.click(screen.getByRole('button', { name: 'Begin walk-through' }))
        fireEvent.keyDown(canvas, { key: 'Escape' })
        document.pointerLockElement = canvas
        act(() => { canvasState.scene.onLock() })
        expect(document.exitPointerLock).toHaveBeenCalledOnce()
        expect(canvasState.scene.controlsEnabled.locked).toBe(false)
    })
})

describe('museum painting portals', () => {
    it('plays both passages in the same canvas, retains touch controls and renders the album photos', async () => {
        const { canvas, camera, path } = await gallery({ touch: true })
        fireEvent.click(screen.getByRole('button', { name: 'Begin walk-through' }))
        act(() => { canvasState.scene.onFocusedPainting(painting) })
        act(() => { canvasState.scene.onResolutionChange(1.1) })
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Jump into Coastal Light' })) })
        expect(api.fetchAlbumForViewing).toHaveBeenCalledWith(album.albumId, auth.getIdToken, { signal: expect.any(AbortSignal) })
        expect(canvasState.scene.trip.phase).toBe('jump')
        expect(canvasState.scene.wing).toBe(null)
        act(() => { canvasState.scene.onCross() })
        expect(canvasState.scene.trip.phase).toBe('reveal')
        act(() => { canvasState.scene.onArrive() })
        const wing = canvasState.scene.wing
        expect(wing.bays[1].prints[0].image).toBe(image)
        expect(screen.getByText('1 photograph')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Jump', exact: true })).toBeInTheDocument()

        act(() => { canvasState.scene.onFocusedPainting(wing.portals[0]) })
        fireEvent.click(screen.getByRole('button', { name: 'Return to gallery' }))
        act(() => { canvasState.scene.onCross() })
        act(() => { canvasState.scene.onArrive() })
        expect(canvasState.scene.wing).toBeNull()
        expect(canvasState.scene.controlsEnabled.locked).toBe(true)
        expect(canvasState.camera).toBe(camera)
        expect(canvasState.dpr).toBe(1.1)
        expect(screen.getByTestId('retained-museum-canvas')).toBe(canvas)
        expect(canvasState.mounts).toBe(1)
        expect(canvasState.unmounts).toBe(0)
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(screen.getByTestId('gallery-location')).toHaveTextContent(path)
    })

    it('drops a cancelled load even if the response arrives after unlocking', async () => {
        let resolve
        api.fetchAlbumForViewing.mockImplementationOnce(() => new Promise(done => { resolve = done }))
        const { canvas } = await gallery()
        fireEvent.click(screen.getByRole('button', { name: 'Begin walk-through' }))
        act(() => { canvasState.scene.onLock() })
        document.pointerLockElement = canvas
        act(() => { void canvasState.scene.onOpenAlbum(painting) })
        expect(screen.getByText('Opening the album…')).toBeInTheDocument()
        expect(document.exitPointerLock).not.toHaveBeenCalled()
        act(() => { canvasState.scene.onUnlock() })
        expect(api.fetchAlbumForViewing.mock.calls[0][2].signal.aborted).toBe(true)
        await act(async () => { resolve({ album, images: [image] }) })
        expect(canvasState.scene.trip).toBeNull()
        expect(canvasState.scene.wing).toBeNull()
        expect(canvasState.scene.portalBusy).toBe(false)
    })

    it('lets visitors retry a failed painting and leave an empty album', async () => {
        api.fetchAlbumForViewing.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ album, images: [] })
        await gallery()
        await act(async () => { await canvasState.scene.onOpenAlbum(painting) })
        expect(screen.getByRole('alert')).toHaveTextContent('This album could not load')
        expect(canvasState.scene.portalBusy).toBe(false)
        await act(async () => { await canvasState.scene.onOpenAlbum(painting) })
        act(() => { canvasState.scene.onCross() })
        act(() => { canvasState.scene.onArrive() })
        expect(screen.getByText('0 photographs')).toBeInTheDocument()
        expect(canvasState.scene.wing.portals).toHaveLength(2)
        expect(screen.queryByRole('alert')).toBeNull()
    })
})
