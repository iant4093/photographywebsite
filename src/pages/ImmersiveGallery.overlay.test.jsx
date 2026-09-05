import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const canvasState = vi.hoisted(() => ({ scene: null, camera: null, mounts: 0, unmounts: 0 }))
const api = vi.hoisted(() => ({
    fetchAlbum: vi.fn(), fetchAllAlbums: vi.fn(), requestAlbumMediaDownload: vi.fn(),
    requestAlbumPrintSession: vi.fn(), requestAlbumZip: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))

vi.mock('@react-three/fiber', async () => {
    const { useEffect } = await import('react')
    return {
        Canvas: ({ children, className, camera }) => {
            canvasState.scene = children.props.children.props
            canvasState.camera = camera
            useEffect(() => {
                canvasState.mounts += 1
                return () => { canvasState.unmounts += 1 }
            }, [])
            return <div className={className}><canvas data-testid="retained-museum-canvas" /></div>
        },
        addAfterEffect: vi.fn(), useFrame: vi.fn(), useLoader: vi.fn(), useThree: vi.fn(),
    }
})
vi.mock('../utils/api', () => api)
vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/analytics', () => ({ trackAlbumView: vi.fn(), trackPhotoDownload: vi.fn(), trackZipRequest: vi.fn() }))
vi.mock('../components/ProgressiveImage', () => ({ default: ({ alt, src }) => <img alt={alt} src={src} /> }))

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
    canvasState.mounts = 0
    canvasState.unmounts = 0
    auth.getIdToken.mockResolvedValue(null)
    api.fetchAlbum.mockReset().mockResolvedValue({ album, images: [image] })
    localStorage.clear()
    sessionStorage.clear()
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, writable: true, value: null })
    Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: vi.fn(() => { document.pointerLockElement = null }) })
})

describe('museum album overlay integration', () => {
    it('retains the canvas and camera through nested photo viewing, then closes to a paused gallery', async () => {
        const { canvas, camera, path } = await gallery({ touch: true })
        fireEvent.click(screen.getByRole('button', { name: 'Begin walk-through' }))
        expect(canvasState.scene.controlsEnabled.locked).toBe(true)
        act(() => { canvasState.scene.onOpenAlbum(album) })
        await screen.findByRole('heading', { name: 'Coastal Light' })
        expect(canvasState.scene.albumOpen).toBe(true)
        expect(canvasState.scene.controlsEnabled.locked).toBe(false)
        expect(screen.getByTestId('retained-museum-canvas')).toBe(canvas)
        expect(canvasState.camera).toBe(camera)
        expect(canvasState.mounts).toBe(1)
        expect(canvasState.unmounts).toBe(0)

        fireEvent.click(screen.getByRole('button', { name: 'Open item 1 from Coastal Light' }))
        expect(screen.getByRole('dialog', { name: 'Photo viewer for Coastal Light' })).toBeInTheDocument()
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByRole('dialog', { name: 'Photo viewer for Coastal Light' })).toBeNull()
        expect(screen.getByRole('dialog', { name: 'Coastal Light album' })).toBeInTheDocument()
        expect(canvasState.scene.albumOpen).toBe(true)
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(canvasState.scene.albumOpen).toBe(false)
        expect(canvasState.scene.controlsEnabled.locked).toBe(false)
        expect(screen.getByTestId('retained-museum-canvas')).toBe(canvas)
        expect(canvasState.camera).toBe(camera)
        expect(canvasState.mounts).toBe(1)
        expect(screen.getByTestId('gallery-location')).toHaveTextContent(path)
        expect(window.location.pathname + window.location.search).toBe(path)
    })

    it('returns to touch controls without recreating the scene', async () => {
        const { canvas, camera } = await gallery({ touch: true })
        fireEvent.click(screen.getByRole('button', { name: 'Begin walk-through' }))
        act(() => { canvasState.scene.onOpenAlbum(album) })
        await screen.findByRole('heading', { name: 'Coastal Light' })
        fireEvent.click(screen.getByRole('button', { name: '← Return to gallery' }))
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(canvasState.scene.controlsEnabled.locked).toBe(true)
        expect(screen.getByRole('button', { name: 'Jump' })).toBeInTheDocument()
        expect(screen.getByTestId('retained-museum-canvas')).toBe(canvas)
        expect(canvasState.camera).toBe(camera)
        expect(canvasState.mounts).toBe(1)
    })

    it('requests desktop pointer lock only after the modal has released the canvas, and handles denial', async () => {
        const { canvas, camera } = await gallery()
        let canvasWasInert
        const requestPointerLock = vi.fn(() => {
            canvasWasInert = Boolean(canvas.closest('[inert]'))
            return Promise.reject(new Error('Pointer lock declined'))
        })
        Object.defineProperty(canvas, 'requestPointerLock', { configurable: true, value: requestPointerLock })
        act(() => { canvasState.scene.onOpenAlbum(album) })
        await screen.findByRole('heading', { name: 'Coastal Light' })
        expect(canvas.closest('[inert]')).not.toBeNull()
        fireEvent.click(screen.getByRole('button', { name: '← Return to gallery' }))
        await waitFor(() => expect(requestPointerLock).toHaveBeenCalledOnce())
        expect(canvasWasInert).toBe(false)
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(canvasState.scene.controlsEnabled.locked).toBe(false)
        expect(screen.getByRole('button', { name: 'Begin walk-through' })).toBeInTheDocument()
        expect(screen.getByTestId('retained-museum-canvas')).toBe(canvas)
        expect(canvasState.camera).toBe(camera)
        expect(canvasState.mounts).toBe(1)
    })

    it('releases a delayed pointer-lock promise that completes after another album opens', async () => {
        const { canvas, camera } = await gallery()
        let resolveLock
        const pendingLock = new Promise(resolve => { resolveLock = resolve })
        Object.defineProperty(canvas, 'requestPointerLock', { configurable: true, value: vi.fn(() => pendingLock) })
        act(() => { canvasState.scene.onOpenAlbum(album) })
        await screen.findByRole('heading', { name: 'Coastal Light' })
        fireEvent.click(screen.getByRole('button', { name: '← Return to gallery' }))
        expect(canvas.requestPointerLock).toHaveBeenCalledOnce()

        act(() => { canvasState.scene.onOpenAlbum(album) })
        await screen.findByRole('heading', { name: 'Coastal Light' })
        await act(async () => {
            document.pointerLockElement = canvas
            resolveLock()
            await pendingLock
        })
        expect(document.pointerLockElement).toBeNull()
        expect(document.exitPointerLock).toHaveBeenCalledOnce()
        expect(canvasState.scene.albumOpen).toBe(true)
        expect(canvasState.scene.controlsEnabled.locked).toBe(false)
        expect(screen.getByRole('dialog', { name: 'Coastal Light album' })).toBeInTheDocument()
        expect(screen.getByTestId('retained-museum-canvas')).toBe(canvas)
        expect(canvasState.camera).toBe(camera)
        expect(canvasState.mounts).toBe(1)
    })

    it('rejects a native lock notification racing the album-opening commit', async () => {
        const { canvas } = await gallery()
        const beforeOpen = canvasState.scene
        act(() => {
            beforeOpen.onOpenAlbum(album)
            // The native event can arrive before React has committed the
            // album-open state; the old callback must still reject this lock.
            document.pointerLockElement = canvas
            beforeOpen.onLock()
        })
        await screen.findByRole('heading', { name: 'Coastal Light' })
        expect(document.pointerLockElement).toBeNull()
        expect(document.exitPointerLock).toHaveBeenCalledOnce()
        expect(canvasState.scene.albumOpen).toBe(true)
        expect(canvasState.scene.controlsEnabled.locked).toBe(false)
        expect(screen.getByRole('button', { name: 'Close album' })).toBeInTheDocument()
        expect(canvasState.mounts).toBe(1)
    })
})
