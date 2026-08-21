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
}))

vi.mock('../editor/standardDecoder', () => ({
    decodeStandardFile: mocks.decodeStandardFile,
    makePreviewSource: (source) => ({ ...source, pixels: new Uint8ClampedArray(source.pixels) }),
}))

vi.mock('../editor/rawDecoder', () => ({ decodeRawFile: mocks.decodeRawFile, isRawFile: mocks.isRawFile }))

vi.mock('../editor/canvas', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        drawGeometry: mocks.drawGeometry,
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
        this.listeners = []
    }
    addEventListener(type, listener) {
        if (type === 'message') this.listeners.push(listener)
    }
    removeEventListener(type, listener) {
        if (type === 'message') this.listeners = this.listeners.filter((item) => item !== listener)
    }
    postMessage(message) {
        const result = {
            id: message.id,
            pixels: message.pixels,
            histogram: { red: [1], green: [1], blue: [1], luma: [1] },
        }
        queueMicrotask(() => this.listeners.forEach((listener) => listener({ data: result })))
    }
    terminate() {}
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
        vi.stubGlobal('Worker', WorkerStub)
        vi.stubGlobal('ImageData', ImageDataStub)
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
        expect(screen.getByText(/Nothing is uploaded or stored/)).toBeInTheDocument()
        const file = new File(['jpeg'], 'mountain.jpg', { type: 'image/jpeg' })
        await user.upload(container.querySelector('input[type="file"]'), file)

        expect(await screen.findByText('mountain')).toBeInTheDocument()
        expect(mocks.decodeStandardFile).toHaveBeenCalledWith(file)
        expect((await screen.findAllByText(/working preview/)).length).toBeGreaterThan(0)
        expect(screen.getByText(/Canon EOS R7/)).toBeInTheDocument()

        fireEvent.change(screen.getByRole('spinbutton', { name: 'Exposure value' }), { target: { value: '1.2' } })
        expect(screen.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue(1.2)
        expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
        await user.click(screen.getByRole('button', { name: 'Undo' }))
        expect(screen.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue(0)
        await user.click(screen.getByRole('button', { name: 'Redo' }))
        expect(screen.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue(1.2)

        await user.click(screen.getByRole('button', { name: 'Before / after' }))
        expect(screen.getByRole('slider', { name: 'Comparison split' })).toHaveValue('50')
        await user.click(screen.getByRole('button', { name: 'Clipping' }))
        await user.click(screen.getByRole('button', { name: 'Warm Portrait' }))
        expect(screen.getByRole('spinbutton', { name: 'Temperature value' })).toHaveValue(18)

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
        expect(screen.getByRole('spinbutton', { name: 'Midtones value' })).toBeInTheDocument()
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
        await waitFor(() => expect(mocks.drawGeometry).toHaveBeenCalled())
        expect(screen.queryByText(/could not|failed/i)).not.toBeInTheDocument()
    })
})
