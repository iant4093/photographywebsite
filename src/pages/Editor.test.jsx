import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    decodeStandardFile: vi.fn(),
    decodeRawFile: vi.fn(),
    isRawFile: vi.fn((file) => file?.name?.toLowerCase().endsWith('.cr3')),
    drawGeometry: vi.fn((_source, target) => {
        target.width = 2
        target.height = 1
        return target
    }),
    drawGeometryAtSize: vi.fn((_source, target, _geometry, width, height) => {
        target.width = width
        target.height = height
        return target
    }),
    loadEditorSession: vi.fn(),
    saveEditorSource: vi.fn(),
    saveEditorState: vi.fn(),
    clearEditorSession: vi.fn(),
    workerMessages: [],
    workerFailures: 0,
    workerInstances: 0,
    workerTerminations: 0,
    holdWorkerResponses: false,
    gpuEnabled: false,
    gpuRender: vi.fn(),
    gpuPrepare: vi.fn(),
    gpuDispose: vi.fn(),
}))

vi.mock('../editor/standardDecoder', () => ({
    decodeStandardFile: mocks.decodeStandardFile,
    makePreviewSource: (source, maxEdge = 1800) => {
        const scale = Math.min(1, maxEdge / Math.max(source.width, source.height))
        return {
            ...source,
            width: Math.max(1, Math.round(source.width * scale)),
            height: Math.max(1, Math.round(source.height * scale)),
            pixels: new Uint8ClampedArray(source.pixels),
        }
    },
}))

vi.mock('../editor/rawDecoder', () => ({ decodeRawFile: mocks.decodeRawFile, isRawFile: mocks.isRawFile }))

vi.mock('../editor/livePreviewRenderer', () => ({
    createLivePreviewRenderer: () => mocks.gpuEnabled ? {
        render: mocks.gpuRender,
        prepare: mocks.gpuPrepare,
        dispose: mocks.gpuDispose,
    } : null,
}))

vi.mock('../editor/sessionStore', () => ({
    loadEditorSession: mocks.loadEditorSession,
    saveEditorSource: mocks.saveEditorSource,
    saveEditorState: mocks.saveEditorState,
    clearEditorSession: mocks.clearEditorSession,
}))

vi.mock('../editor/canvas', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        drawGeometry: mocks.drawGeometry,
        drawGeometryAtSize: mocks.drawGeometryAtSize,
        canvasToBlob: vi.fn().mockResolvedValue(new Blob(['edited'], { type: 'image/jpeg' })),
    }
})

class ImageDataStub {
    constructor(data, width, height) {
        this.data = data
        this.width = width
        this.height = height
    }
}

class WorkerStub {
    constructor() {
        this.listeners = new Map()
        mocks.workerInstances += 1
    }
    addEventListener(type, listener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener])
    }
    removeEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener))
    }
    emit(type, event) {
        for (const listener of this.listeners.get(type) || []) listener(event)
    }
    postMessage(message) {
        mocks.workerMessages.push(message)
        if (mocks.holdWorkerResponses) return
        if (mocks.workerFailures > 0) {
            mocks.workerFailures -= 1
            queueMicrotask(() => this.emit('error', { message: 'simulated worker crash' }))
            return
        }
        const result = {
            id: message.id,
            pixels: message.pixels,
            histogram: { red: [1], green: [1], blue: [1], luma: [1] },
        }
        queueMicrotask(() => this.emit('message', { data: result }))
    }
    terminate() { mocks.workerTerminations += 1 }
}

const decodedPhoto = {
    pixels: new Uint8ClampedArray([20, 30, 40, 255, 200, 210, 220, 255]),
    width: 2,
    height: 1,
    metadata: { make: 'Canon', model: 'EOS R7', lens: 'Test lens', iso: 100 },
}

function canvasContext() {
    return {
        putImageData: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(decodedPhoto.pixels) })),
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        rotate: vi.fn(),
        transform: vi.fn(),
        set fillStyle(_value) {},
    }
}

import Editor from './Editor'

describe('Photo Editor page', () => {
    beforeEach(() => {
        localStorage.clear()
        mocks.decodeStandardFile.mockReset().mockResolvedValue(decodedPhoto)
        mocks.decodeRawFile.mockReset().mockResolvedValue({ ...decodedPhoto, metadata: { ...decodedPhoto.metadata, raw: true } })
        mocks.isRawFile.mockClear()
        mocks.drawGeometry.mockClear()
        mocks.drawGeometryAtSize.mockClear()
        mocks.loadEditorSession.mockReset().mockResolvedValue(null)
        mocks.saveEditorSource.mockReset().mockResolvedValue()
        mocks.saveEditorState.mockReset().mockResolvedValue()
        mocks.clearEditorSession.mockReset().mockResolvedValue()
        mocks.workerMessages.length = 0
        mocks.workerFailures = 0
        mocks.workerInstances = 0
        mocks.workerTerminations = 0
        mocks.holdWorkerResponses = false
        mocks.gpuEnabled = false
        mocks.gpuRender.mockReset().mockImplementation(() => document.createElement('canvas'))
        mocks.gpuPrepare.mockReset()
        mocks.gpuDispose.mockReset()
        vi.stubGlobal('Worker', WorkerStub)
        vi.stubGlobal('ImageData', ImageDataStub)
        vi.stubGlobal('PointerEvent', MouseEvent)
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(canvasContext)
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: vi.fn().mockResolvedValue(), readText: vi.fn().mockResolvedValue('') },
        })
    })

    it('opens a standard image, edits, compares, navigates history, and exports', async () => {
        const user = userEvent.setup()
        const { container } = render(<Editor />)
        expect(screen.getByRole('heading', { name: 'Photo Editor' })).toBeInTheDocument()
        expect(screen.getByText(/entirely on your device/)).toBeInTheDocument()
        expect(screen.getByText(/Nothing is uploaded or stored/)).toBeInTheDocument()
        const file = new File(['jpeg'], 'mountain.jpg', { type: 'image/jpeg' })
        await user.upload(container.querySelector('input[type="file"]'), file)

        expect(await screen.findByText('mountain')).toBeInTheDocument()
        expect(mocks.decodeStandardFile).toHaveBeenCalledWith(file)
        expect(mocks.saveEditorSource).toHaveBeenCalledWith(file)
        expect((await screen.findAllByText(/working preview/)).length).toBeGreaterThan(0)
        expect(screen.getByText(/Canon EOS R7/)).toBeInTheDocument()

        const editorShell = screen.getByRole('region', { name: 'Photo editor workspace' })
        const requestFullscreen = vi.fn().mockResolvedValue()
        Object.defineProperty(editorShell, 'requestFullscreen', { configurable: true, value: requestFullscreen })
        await user.click(screen.getByRole('button', { name: 'Fullscreen' }))
        expect(requestFullscreen).toHaveBeenCalledOnce()

        fireEvent.click(container.querySelector('.editor-canvas-transform'))
        await waitFor(() => expect(screen.getByRole('button', { name: '100%' })).toHaveClass('is-active'))

        fireEvent.change(screen.getByRole('spinbutton', { name: 'Exposure value' }), { target: { value: '1.2' } })
        expect(screen.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue(1.2)
        await waitFor(() => expect(mocks.saveEditorState).toHaveBeenCalledWith(expect.objectContaining({
            adjustments: expect.objectContaining({ exposure: 1.2 }),
        })), { timeout: 1200 })
        expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
        await user.click(screen.getByRole('button', { name: 'Undo' }))
        expect(screen.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue(0)
        await user.click(screen.getByRole('button', { name: 'Redo' }))
        expect(screen.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue(1.2)

        await user.click(screen.getByRole('button', { name: 'Before / after' }))
        expect(screen.getByRole('slider', { name: 'Comparison split' })).toHaveValue('50')
        await user.click(screen.getByRole('button', { name: 'Clipping' }))
        await user.click(screen.getByRole('button', { name: 'Kodak Portra 400' }))
        expect(screen.getByRole('spinbutton', { name: 'Temperature value' })).toHaveValue(7)

        await user.selectOptions(screen.getByRole('combobox', { name: 'Dimensions' }), 'longEdge')
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Pixels' }), { target: { value: '1200' } })
        await user.click(screen.getByRole('button', { name: 'Export photo' }))
        expect((await screen.findAllByText(/Exported 2 × 1 JPG/)).length).toBeGreaterThan(0)
    })

    it('loads RAW files, settings tools, geometry, presets, and error paths', async () => {
        const user = userEvent.setup()
        const writeClipboard = vi.spyOn(navigator.clipboard, 'writeText')
        const readClipboard = vi.spyOn(navigator.clipboard, 'readText')
        const { container } = render(<Editor />)
        const raw = new File(['raw'], 'camera.CR3', { type: 'application/octet-stream' })
        await user.upload(container.querySelector('input[type="file"]'), raw)
        expect(await screen.findByText('camera')).toBeInTheDocument()
        expect(mocks.decodeRawFile).toHaveBeenCalledWith(raw, expect.any(Function))

        const geometrySummary = screen.getByText('Crop & geometry')
        await user.click(geometrySummary)
        await user.selectOptions(screen.getByRole('combobox', { name: 'Aspect ratio' }), '1:1')
        await user.click(screen.getByRole('button', { name: 'Rotate right' }))
        await user.click(screen.getByRole('button', { name: 'Flip H' }))
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Straighten value' }), { target: { value: '4' } })

        const settingsSummary = screen.getByText('Settings & sidecar')
        await user.click(settingsSummary)
        await user.click(screen.getByRole('button', { name: 'Copy settings' }))
        expect(writeClipboard).toHaveBeenCalledWith(expect.stringContaining('ian-truong-photo-editor/v1'))
        readClipboard.mockResolvedValueOnce(JSON.stringify({ schema: 'ian-truong-photo-editor/v1', adjustments: { contrast: 12 }, geometry: {} }))
        await user.click(screen.getByRole('button', { name: 'Paste settings' }))
        await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Contrast value' })).toHaveValue(12))
        await user.click(screen.getByRole('button', { name: 'Download sidecar' }))

        vi.spyOn(window, 'prompt').mockReturnValue('My preset')
        await user.click(screen.getByRole('button', { name: 'Save current preset' }))
        expect(screen.getByRole('button', { name: 'My preset' })).toBeInTheDocument()

        mocks.decodeRawFile.mockRejectedValueOnce(new Error('Unsupported camera file'))
        const broken = new File(['bad'], 'broken.cr3', { type: 'application/octet-stream' })
        await user.upload(container.querySelector('input[type="file"]'), broken)
        expect(await screen.findByText('Unsupported camera file')).toBeInTheDocument()
        expect(screen.getAllByText('Choose another photo').length).toBeGreaterThan(0)

        const invalid = new File(['text'], 'notes.txt', { type: 'text/plain' })
        fireEvent.drop(container.querySelector('.editor-stage'), { dataTransfer: { files: [invalid] } })
        expect(await screen.findByText('Choose a supported photo or camera RAW file.')).toBeInTheDocument()
    })

    it('exposes every adjustment group without requiring a photo', async () => {
        const user = userEvent.setup()
        render(<Editor />)
        for (const title of ['Color', 'Presence & detail', 'Tone curve', 'Color mixer', 'Color grading', 'Black & white']) {
            await user.click(screen.getByText(title))
        }
        expect(screen.getByRole('spinbutton', { name: 'Temperature value' })).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: 'Grain value' })).toBeInTheDocument()
        expect(screen.getByRole('slider', { name: 'Tone curve point 3' })).toHaveAttribute('aria-valuetext', 'Input 50, output 50')
        const midtoneWheel = screen.getByRole('slider', { name: 'midtones color wheel' })
        vi.spyOn(midtoneWheel, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) })
        fireEvent.pointerDown(midtoneWheel, { clientX: 200, clientY: 100, pointerId: 4 })
        fireEvent.pointerUp(midtoneWheel, { pointerId: 4 })
        expect(screen.getByRole('spinbutton', { name: 'midtones hue value' })).toHaveValue(90)
        expect(screen.getByRole('spinbutton', { name: 'midtones saturation value' })).toHaveValue(100)
        expect(screen.getByRole('checkbox', { name: /Enable black and white/ })).toBeInTheDocument()
        const redMixer = screen.getAllByText('red').find((node) => node.tagName === 'SUMMARY')
        await user.click(redMixer)
        expect(within(redMixer.parentElement).getByRole('spinbutton', { name: 'hue value' })).toBeInTheDocument()
    })

    it('accepts changes from every editor slider', async () => {
        const user = userEvent.setup()
        const { container } = render(<Editor />)
        await user.upload(container.querySelector('input[type="file"]'), new File(['jpeg'], 'controls.jpg', { type: 'image/jpeg' }))
        await screen.findByText('controls')
        const sliders = [...container.querySelectorAll('.editor-sidebar input[type="range"]')]
        expect(sliders.length).toBeGreaterThan(60)
        for (const slider of sliders) {
            const min = Number(slider.min)
            const max = Number(slider.max)
            const next = min + (max - min) * 0.6
            fireEvent.change(slider, { target: { value: String(next) } })
        }
        await waitFor(() => expect(mocks.drawGeometryAtSize).toHaveBeenCalled())
        expect(screen.queryByText(/could not|failed/i)).not.toBeInTheDocument()
    })

    it('uses a smaller live preview while dragging and settles at full working quality', async () => {
        const largePhoto = { ...decodedPhoto, width: 2400, height: 1600 }
        mocks.decodeStandardFile.mockResolvedValueOnce(largePhoto)
        const { container } = render(<Editor />)
        await userEvent.upload(container.querySelector('input[type="file"]'), new File(['jpeg'], 'responsive.jpg', { type: 'image/jpeg' }))
        await screen.findByText('responsive')
        await waitFor(() => expect(mocks.workerMessages.some((message) => message.width === 1200)).toBe(true))

        mocks.workerMessages.length = 0
        const exposure = screen.getByRole('slider', { name: 'Exposure' })
        fireEvent.pointerDown(exposure, { pointerId: 11 })
        fireEvent.change(exposure, { target: { value: '1' } })
        await waitFor(() => expect(mocks.workerMessages.some((message) => message.width === 560)).toBe(true))
        fireEvent.pointerUp(exposure, { pointerId: 11 })
        await waitFor(() => expect(mocks.workerMessages.some((message) => message.width === 1200)).toBe(true))

        mocks.workerMessages.length = 0
        await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Preview quality' }), 'high')
        await waitFor(() => expect(mocks.workerMessages.some((message) => message.width === 1800)).toBe(true))
        expect(localStorage.getItem('ian-photo-editor-preview-quality-v1')).toBe('high')
    })

    it('shows discrete controls and presets through the GPU before the exact preview settles', async () => {
        mocks.gpuEnabled = true
        const { container } = render(<Editor />)
        await userEvent.upload(container.querySelector('input[type="file"]'), new File(['jpeg'], 'instant.jpg', { type: 'image/jpeg' }))
        await screen.findByText('instant')
        await waitFor(() => expect(mocks.gpuRender).toHaveBeenCalled())
        expect(screen.getByRole('region', { name: 'Photo editor workspace' })).toHaveAttribute('data-preview-engine', 'gpu')

        mocks.gpuRender.mockClear()
        mocks.workerMessages.length = 0
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Exposure value' }), { target: { value: '0.8' } })
        await waitFor(() => expect(mocks.gpuRender).toHaveBeenCalledWith(
            expect.anything(), expect.objectContaining({ exposure: 0.8 }), false,
        ))
        expect(screen.queryByText('Processing...')).not.toBeInTheDocument()

        mocks.gpuRender.mockClear()
        await userEvent.click(screen.getByRole('button', { name: 'Kodak Portra 400' }))
        await waitFor(() => expect(mocks.gpuRender).toHaveBeenCalledWith(
            expect.anything(), expect.objectContaining({ temperature: 7, grain: 12 }), false,
        ))
        await waitFor(() => expect(mocks.workerMessages.some((message) => (
            message.width === 2 && message.includeHistogram === true && message.adjustments?.temperature === 7
        ))).toBe(true), { timeout: 1000 })
        expect(screen.queryByText('Processing...')).not.toBeInTheDocument()
    })

    it('prewarms preview blur data and avoids redrawing unchanged before geometry', async () => {
        const { container } = render(<Editor />)
        await userEvent.upload(container.querySelector('input[type="file"]'), new File(['jpeg'], 'cached.jpg', { type: 'image/jpeg' }))
        await screen.findByText('cached')
        await waitFor(() => expect(mocks.workerMessages.some((message) => message.operation === 'prewarm')).toBe(true), { timeout: 1500 })

        mocks.drawGeometryAtSize.mockClear()
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Exposure value' }), { target: { value: '0.5' } })
        await waitFor(() => expect(mocks.drawGeometryAtSize).toHaveBeenCalled())
        expect(mocks.drawGeometryAtSize).toHaveBeenCalledTimes(1)
    })

    it('terminates an obsolete exact render when a newer edit arrives', async () => {
        mocks.gpuEnabled = true
        mocks.holdWorkerResponses = true
        const { container } = render(<Editor />)
        await userEvent.upload(container.querySelector('input[type="file"]'), new File(['jpeg'], 'latest-only.jpg', { type: 'image/jpeg' }))
        await screen.findByText('latest-only')
        await waitFor(() => expect(mocks.workerMessages.some((message) => message.includeHistogram === true)).toBe(true), { timeout: 1000 })
        const beforeEdit = mocks.workerTerminations

        await userEvent.click(screen.getByRole('button', { name: 'Kodak Gold 200' }))
        await waitFor(() => expect(mocks.workerTerminations).toBeGreaterThan(beforeEdit))
        await waitFor(() => expect(mocks.gpuRender.mock.calls.some(([, settings]) => settings.temperature === 14)).toBe(true))
        mocks.holdWorkerResponses = false
    })

    it('adapts the interactive preview edge to a smaller visible viewport', async () => {
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(220)
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(180)
        const largePhoto = { ...decodedPhoto, width: 2400, height: 1600 }
        mocks.decodeStandardFile.mockResolvedValueOnce(largePhoto)
        const { container } = render(<Editor />)
        await userEvent.upload(container.querySelector('input[type="file"]'), new File(['jpeg'], 'viewport.jpg', { type: 'image/jpeg' }))
        await screen.findByText('viewport')
        const exposure = screen.getByRole('slider', { name: 'Exposure' })
        fireEvent.pointerDown(exposure, { pointerId: 19 })
        fireEvent.change(exposure, { target: { value: '0.5' } })
        await waitFor(() => expect(mocks.workerMessages.some((message) => message.width === 360)).toBe(true))
        fireEvent.pointerUp(exposure, { pointerId: 19 })
    })

    it('recovers from a preview worker crash without leaving Processing stuck', async () => {
        mocks.workerFailures = 1
        const { container } = render(<Editor />)
        await userEvent.upload(container.querySelector('input[type="file"]'), new File(['jpeg'], 'recovery.jpg', { type: 'image/jpeg' }))
        await screen.findByText('recovery')
        await waitFor(() => expect(mocks.drawGeometryAtSize).toHaveBeenCalled(), { timeout: 1500 })
        await waitFor(() => expect(screen.queryByText('Processing...')).not.toBeInTheDocument())
        expect(mocks.workerInstances).toBeGreaterThanOrEqual(3)
        expect(screen.queryByText(/simulated worker crash/i)).not.toBeInTheDocument()
    })

    it('restores the local source and editor state, then explicitly clears it', async () => {
        const recoveredFile = new File(['jpeg'], 'recovered.jpg', { type: 'image/jpeg' })
        mocks.loadEditorSession.mockResolvedValueOnce({
            file: recoveredFile,
            state: {
                adjustments: { exposure: 1.35, temperature: 14 },
                geometry: { quarterTurns: 1, flipX: true },
                history: [{ adjustments: { exposure: 0.5 }, geometry: {} }],
                future: [{ adjustments: { exposure: 2 }, geometry: {} }],
                compare: true,
                comparePosition: 36,
                showClipping: true,
                zoom: 125,
                pan: { x: 18, y: -9 },
                exportOptions: { format: 'webp', quality: 88, resizeMode: 'longEdge', size: 1600, suffix: '-proof' },
            },
        })

        const user = userEvent.setup()
        render(<Editor />)

        expect(await screen.findByText('recovered')).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue(1.35)
        expect(screen.getByRole('spinbutton', { name: 'Temperature value' })).toHaveValue(14)
        expect(screen.getByRole('slider', { name: 'Comparison split' })).toHaveValue('36')
        expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
        expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled()
        expect(screen.getByRole('combobox', { name: 'Format' })).toHaveValue('webp')
        expect(screen.getByRole('combobox', { name: 'Dimensions' })).toHaveValue('longEdge')
        expect(screen.getByRole('spinbutton', { name: 'Pixels' })).toHaveValue(1600)
        expect(screen.getByText('Recovered locally')).toBeInTheDocument()
        expect(mocks.saveEditorSource).not.toHaveBeenCalled()

        await user.click(screen.getByRole('button', { name: 'Close photo' }))
        await waitFor(() => expect(mocks.clearEditorSession).toHaveBeenCalledTimes(1))
        expect(screen.getByText('No photo open')).toBeInTheDocument()
        expect(screen.getByText('No saved session')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Drop a photo or RAW file here/ })).toBeInTheDocument()
    })
})
