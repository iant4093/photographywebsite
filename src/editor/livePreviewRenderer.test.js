import { afterEach, describe, expect, it, vi } from 'vitest'
import { freshAdjustments } from './adjustments'
import { createLivePreviewRenderer, LivePreviewRenderer } from './livePreviewRenderer'

function fakeWebGl({ shaderCompiles = true, programLinks = true, contextLost = false, shaderMessage = 'shader error', programMessage = '' } = {}) {
    const gl = {
        VERTEX_SHADER: 1,
        FRAGMENT_SHADER: 2,
        COMPILE_STATUS: 3,
        LINK_STATUS: 4,
        ARRAY_BUFFER: 5,
        STATIC_DRAW: 6,
        FLOAT: 7,
        TEXTURE_2D: 8,
        TEXTURE_MIN_FILTER: 9,
        TEXTURE_MAG_FILTER: 10,
        TEXTURE_WRAP_S: 11,
        TEXTURE_WRAP_T: 12,
        LINEAR: 13,
        NEAREST: 14,
        CLAMP_TO_EDGE: 15,
        RGBA8: 16,
        RGBA: 17,
        UNSIGNED_BYTE: 18,
        FRAMEBUFFER: 19,
        COLOR_ATTACHMENT0: 20,
        TEXTURE0: 30,
        TEXTURE3: 33,
        TRIANGLES: 40,
        UNPACK_ALIGNMENT: 41,
        R8: 42,
        RED: 43,
        createShader: vi.fn(() => ({})),
        shaderSource: vi.fn(),
        compileShader: vi.fn(),
        getShaderParameter: vi.fn(() => shaderCompiles),
        getShaderInfoLog: vi.fn(() => shaderMessage),
        deleteShader: vi.fn(),
        createProgram: vi.fn(() => ({})),
        attachShader: vi.fn(),
        linkProgram: vi.fn(),
        getProgramParameter: vi.fn(() => programLinks),
        getProgramInfoLog: vi.fn(() => programMessage),
        deleteProgram: vi.fn(),
        createVertexArray: vi.fn(() => ({})),
        bindVertexArray: vi.fn(),
        deleteVertexArray: vi.fn(),
        createBuffer: vi.fn(() => ({})),
        bindBuffer: vi.fn(),
        bufferData: vi.fn(),
        deleteBuffer: vi.fn(),
        enableVertexAttribArray: vi.fn(),
        vertexAttribPointer: vi.fn(),
        createTexture: vi.fn(() => ({})),
        bindTexture: vi.fn(),
        texParameteri: vi.fn(),
        texImage2D: vi.fn(),
        deleteTexture: vi.fn(),
        createFramebuffer: vi.fn(() => ({})),
        bindFramebuffer: vi.fn(),
        framebufferTexture2D: vi.fn(),
        deleteFramebuffer: vi.fn(),
        viewport: vi.fn(),
        useProgram: vi.fn(),
        activeTexture: vi.fn(),
        getUniformLocation: vi.fn(() => ({})),
        uniform1i: vi.fn(),
        uniform1fv: vi.fn(),
        uniform2f: vi.fn(),
        uniform2fv: vi.fn(),
        uniform3f: vi.fn(),
        uniform3fv: vi.fn(),
        uniform4f: vi.fn(),
        pixelStorei: vi.fn(),
        drawArrays: vi.fn(),
        readPixels: vi.fn((_x, _y, width, height, _format, _type, output) => {
            const rowLength = width * 4
            for (let row = 0; row < height; row += 1) {
                output.fill(row + 1, row * rowLength, (row + 1) * rowLength)
            }
        }),
        isContextLost: vi.fn(() => contextLost),
    }
    return gl
}

const source = {
    width: 3,
    height: 2,
    pixels: new Uint8ClampedArray(3 * 2 * 4).fill(128),
}

describe('GPU live preview renderer', () => {
    afterEach(() => vi.restoreAllMocks())

    it('renders every adjustment family and reuses GPU blur targets', () => {
        const gl = fakeWebGl()
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((type) => type === 'webgl2' ? gl : null)
        const renderer = new LivePreviewRenderer()
        const uniformLookups = gl.getUniformLocation.mock.calls.length
        expect(renderer.render(source, freshAdjustments())).toBe(renderer.canvas)
        expect(gl.drawArrays).toHaveBeenCalledOnce()
        const settings = freshAdjustments()
        settings.exposure = 0.5
        settings.contrast = 12
        settings.temperature = 8
        settings.tint = -4
        settings.saturation = 10
        settings.vibrance = 15
        settings.texture = 20
        settings.clarity = 25
        settings.dehaze = 8
        settings.sharpening = 30
        settings.sharpeningRadius = 2
        settings.noiseLuminance = 10
        settings.noiseColor = 5
        settings.vignette = -12
        settings.grain = 8
        settings.hsl.blue.hue = 6
        settings.grading.shadows.saturation = 12

        expect(renderer.render(source, settings, true)).toBe(renderer.canvas)
        const firstDrawCount = gl.drawArrays.mock.calls.length
        expect(firstDrawCount).toBe(6)
        expect(gl.uniform3fv).toHaveBeenCalled()
        expect(gl.uniform2fv).toHaveBeenCalled()

        renderer.render(source, { ...settings, clarity: 40 }, false)
        expect(gl.drawArrays.mock.calls.length - firstDrawCount).toBe(1)
        expect(gl.getUniformLocation).toHaveBeenCalledTimes(uniformLookups)

        renderer.prepare(source)
        expect(renderer.blurTargets.has(1)).toBe(true)
        expect(renderer.blurTargets.has(5)).toBe(true)

        renderer.render({ ...source, pixels: new Uint8ClampedArray(source.pixels) }, { ...settings, blackAndWhite: true })
        expect(gl.deleteFramebuffer).toHaveBeenCalled()
        renderer.dispose()
        expect(gl.deleteProgram).toHaveBeenCalledTimes(2)
        expect(gl.deleteVertexArray).toHaveBeenCalledOnce()
    })

    it('falls back cleanly when WebGL is unavailable or shader setup fails', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
        expect(createLivePreviewRenderer()).toBeNull()
        vi.restoreAllMocks()

        const gl = fakeWebGl({ shaderCompiles: false })
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl)
        expect(createLivePreviewRenderer()).toBeNull()
        expect(gl.deleteShader).toHaveBeenCalled()

        vi.restoreAllMocks()
        const linkFailure = fakeWebGl({ programLinks: false, programMessage: 'link error' })
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(linkFailure)
        expect(createLivePreviewRenderer()).toBeNull()
        expect(linkFailure.deleteProgram).toHaveBeenCalled()

        vi.restoreAllMocks()
        const fallbackMessages = fakeWebGl({ shaderCompiles: false, shaderMessage: '' })
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fallbackMessages)
        expect(createLivePreviewRenderer()).toBeNull()
    })

    it('returns a stable top-down pixel copy for the settled preview', () => {
        const gl = fakeWebGl()
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((type) => type === 'webgl2' ? gl : null)
        const renderer = new LivePreviewRenderer()

        const result = renderer.renderPixels(source, { ...freshAdjustments(), exposure: 1 })

        expect(gl.readPixels).toHaveBeenCalledWith(0, 0, 3, 2, gl.RGBA, gl.UNSIGNED_BYTE, expect.any(Uint8Array))
        expect(result).toEqual({
            width: 3,
            height: 2,
            pixels: new Uint8ClampedArray([
                ...new Array(12).fill(2),
                ...new Array(12).fill(1),
            ]),
        })
        renderer.dispose()
    })

    it('rejects rendering after the graphics context is lost', () => {
        const gl = fakeWebGl({ contextLost: true })
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl)
        const renderer = new LivePreviewRenderer()
        expect(() => renderer.render(source, freshAdjustments())).toThrow('graphics preview context was lost')
        renderer.dispose()
    })
})
