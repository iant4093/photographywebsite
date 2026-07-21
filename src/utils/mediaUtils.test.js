import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('blurhash', () => ({ encode: vi.fn(() => 'LEHV6nWB2yk8pyo0adR*.7kCMdnj') }))

import { encode } from 'blurhash'
import { extractFrameFromVideoElement, processImage, processVideo } from './mediaUtils'

function installCanvas({ context = true, blob = new Blob(['jpeg'], { type: 'image/jpeg' }), imageDataError } = {}) {
  const drawImage = vi.fn()
  const getImageData = imageDataError
    ? vi.fn(() => { throw imageDataError })
    : vi.fn((_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }))
  const ctx = context ? { drawImage, getImageData } : null
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(blob))
  return { drawImage, getImageData }
}

describe('client media processing', () => {
  let createdUrl

  beforeEach(() => {
    createdUrl = 'blob:test-media'
    URL.createObjectURL = vi.fn(() => createdUrl)
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => vi.restoreAllMocks())

  it('scales a large image, generates JPEG and blurhash, and always revokes the object URL', async () => {
    const { drawImage } = installCanvas()
    class ImageStub {
      set src(value) {
        this.width = 1600
        this.height = 1200
        expect(value).toBe(createdUrl)
        queueMicrotask(() => this.onload())
      }
    }
    vi.stubGlobal('Image', ImageStub)
    const result = await processImage(new File(['raw'], 'photo.jpg', { type: 'image/jpeg' }))
    expect(result).toMatchObject({ width: 1600, height: 1200, blurhash: expect.any(String) })
    expect(result.thumbnail).toBeInstanceOf(Blob)
    expect(drawImage).toHaveBeenCalledWith(expect.any(ImageStub), 0, 0, 800, 600)
    expect(encode).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(createdUrl)
  })

  it('rejects image decode, invalid dimensions, missing canvas, and failed JPEG encoding', async () => {
    class BadImage {
      set src(_value) { queueMicrotask(() => this.onerror()) }
    }
    vi.stubGlobal('Image', BadImage)
    await expect(processImage(new Blob())).rejects.toThrow('Failed to load image')

    installCanvas()
    class EmptyImage {
      set src(_value) { this.width = 0; this.height = 10; queueMicrotask(() => this.onload()) }
    }
    vi.stubGlobal('Image', EmptyImage)
    await expect(processImage(new Blob())).rejects.toThrow('no usable dimensions')

    vi.restoreAllMocks()
    installCanvas({ context: false })
    class ValidImage {
      set src(_value) { this.width = 10; this.height = 10; queueMicrotask(() => this.onload()) }
    }
    vi.stubGlobal('Image', ValidImage)
    await expect(processImage(new Blob())).rejects.toThrow('Canvas rendering is unavailable')

    vi.restoreAllMocks()
    installCanvas({ blob: null })
    vi.stubGlobal('Image', ValidImage)
    await expect(processImage(new Blob())).rejects.toThrow('Thumbnail encoding failed')

    vi.restoreAllMocks()
    installCanvas({ imageDataError: new DOMException('tainted', 'SecurityError') })
    vi.stubGlobal('Image', ValidImage)
    await expect(processImage(new Blob())).rejects.toThrow('tainted')
  })

  it('captures a selected video frame once and cleans up the hidden element', async () => {
    vi.useFakeTimers()
    installCanvas()
    const originalCreate = document.createElement.bind(document)
    let video
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag !== 'video') return originalCreate(tag)
      video = originalCreate('video')
      Object.defineProperty(video, 'videoWidth', { value: 1920 })
      Object.defineProperty(video, 'videoHeight', { value: 1080 })
      Object.defineProperty(video, 'src', {
        configurable: true,
        set: () => { queueMicrotask(() => video.oncanplay()) },
      })
      return video
    })
    const promise = processVideo(new File(['video'], 'clip.mp4'), -5)
    await Promise.resolve()
    expect(video.currentTime).toBe(0.1)
    video.oncanplay()
    video.onseeked()
    await vi.advanceTimersByTimeAsync(300)
    await expect(promise).resolves.toMatchObject({ width: 1920, height: 1080 })
    expect(document.body.contains(video)).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(createdUrl)
    vi.useRealTimers()
  })

  it('rejects video decode and frame processing failures without double settling', async () => {
    const originalCreate = document.createElement.bind(document)
    let video
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag !== 'video') return originalCreate(tag)
      video = originalCreate('video')
      Object.defineProperty(video, 'src', { configurable: true, set: () => {} })
      return video
    })
    const failed = processVideo(new Blob(), 2)
    const expectation = expect(failed).rejects.toThrow('Failed to load video')
    const failHandler = video.onerror
    const seekHandler = video.onseeked
    const canPlayHandler = video.oncanplay
    canPlayHandler()
    canPlayHandler()
    failHandler()
    failHandler()
    vi.useFakeTimers()
    seekHandler()
    await vi.advanceTimersByTimeAsync(300)
    vi.useRealTimers()
    await expectation

    vi.restoreAllMocks()
    installCanvas()
    vi.useFakeTimers()
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag !== 'video') return originalCreate(tag)
      video = originalCreate('video')
      Object.defineProperty(video, 'videoWidth', { value: 0 })
      Object.defineProperty(video, 'videoHeight', { value: 0 })
      Object.defineProperty(video, 'src', { configurable: true, set: () => {} })
      return video
    })
    const invalid = processVideo(new Blob(), '3')
    const invalidExpectation = expect(invalid).rejects.toThrow('no usable dimensions')
    video.oncanplay()
    expect(video.currentTime).toBe(3)
    video.onseeked()
    await vi.advanceTimersByTimeAsync(300)
    await invalidExpectation
    vi.useRealTimers()
  })

  it('tolerates blurhash extraction failure for an existing video element', async () => {
    installCanvas({ imageDataError: new DOMException('tainted', 'SecurityError') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const video = { videoWidth: 640, videoHeight: 360 }
    await expect(extractFrameFromVideoElement(video)).resolves.toMatchObject({ blurhash: null })
    expect(console.warn).toHaveBeenCalled()
  })
})
