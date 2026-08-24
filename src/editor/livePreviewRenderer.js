import { COLOR_CHANNELS, curveLookup, sanitizeAdjustments } from './adjustments'

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
}`

const BLUR_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform bool u_horizontal;
uniform int u_radius;
in vec2 v_texCoord;
out vec4 outColor;
void main() {
    vec4 sum = vec4(0.0);
    float count = 0.0;
    for (int offset = -5; offset <= 5; offset++) {
        if (abs(offset) > u_radius) continue;
        vec2 direction = u_horizontal ? vec2(float(offset) * u_texel.x, 0.0) : vec2(0.0, float(offset) * u_texel.y);
        sum += texture(u_source, v_texCoord + direction);
        count += 1.0;
    }
    outColor = sum / count;
}`

const ADJUST_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform sampler2D u_fineBlur;
uniform sampler2D u_broadBlur;
uniform sampler2D u_curve;
uniform vec4 u_lightA;
uniform vec4 u_lightB;
uniform vec4 u_color;
uniform vec4 u_detail;
uniform vec4 u_noise;
uniform vec3 u_misc;
uniform vec3 u_hsl[8];
uniform float u_bw[8];
uniform vec2 u_grading[4];
uniform bool u_useFine;
uniform bool u_useBroad;
uniform bool u_useHue;
uniform bool u_useGrading;
uniform bool u_blackAndWhite;
uniform bool u_clipping;
uniform vec2 u_dimensions;
in vec2 v_texCoord;
out vec4 outColor;

float clampByte(float value) { return clamp(value, 0.0, 255.0); }

vec3 rgbToHsl(vec3 color) {
    vec3 c = color / 255.0;
    float maximum = max(c.r, max(c.g, c.b));
    float minimum = min(c.r, min(c.g, c.b));
    float lightness = (maximum + minimum) * 0.5;
    float delta = maximum - minimum;
    if (delta < 0.00001) return vec3(0.0, 0.0, lightness);
    float saturation = lightness > 0.5 ? delta / (2.0 - maximum - minimum) : delta / (maximum + minimum);
    float hue;
    if (maximum == c.r) hue = (c.g - c.b) / delta + (c.g < c.b ? 6.0 : 0.0);
    else if (maximum == c.g) hue = (c.b - c.r) / delta + 2.0;
    else hue = (c.r - c.g) / delta + 4.0;
    return vec3(hue / 6.0, saturation, lightness);
}

float hueChannel(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 0.5) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
}

vec3 hslToRgb(vec3 hsl) {
    float hue = fract(hsl.x);
    if (hsl.y <= 0.00001) return vec3(hsl.z * 255.0);
    float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
    float p = 2.0 * hsl.z - q;
    return vec3(
        hueChannel(p, q, hue + 1.0 / 3.0),
        hueChannel(p, q, hue),
        hueChannel(p, q, hue - 1.0 / 3.0)
    ) * 255.0;
}

int channelIndex(float normalizedHue) {
    float hue = mod(normalizedHue * 360.0 + 360.0, 360.0);
    if (hue < 15.0 || hue >= 345.0) return 0;
    if (hue < 45.0) return 1;
    if (hue < 75.0) return 2;
    if (hue < 165.0) return 3;
    if (hue < 195.0) return 4;
    if (hue < 255.0) return 5;
    if (hue < 285.0) return 6;
    return 7;
}

vec3 gradingColor(float hue) {
    return hslToRgb(vec3(fract(hue / 360.0), 0.8, 0.5));
}

void main() {
    vec3 source = texture(u_source, v_texCoord).rgb * 255.0;
    vec3 color = source;
    if (u_useFine) {
        vec3 blurred = texture(u_fineBlur, v_texCoord).rgb * 255.0;
        float detailStrength = (u_detail.x * 0.55 + u_detail.z * (u_detail.w / 50.0)) / 100.0;
        float noiseMix = u_noise.y / 130.0;
        color = color * (1.0 - noiseMix) + blurred * noiseMix + (color - blurred) * detailStrength;
        float colorMix = u_noise.z / 120.0;
        if (colorMix != 0.0) {
            float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
            color = mix(color, vec3(luma), colorMix);
        }
    }
    if (u_useBroad) {
        vec3 blurred = texture(u_broadBlur, v_texCoord).rgb * 255.0;
        color += (color - blurred) * (u_detail.y / 115.0);
    }

    float exposure = exp2(u_lightA.x);
    float temperature = u_lightB.w / 100.0;
    float tint = u_color.x / 100.0;
    color.r *= exposure * (1.0 + temperature * 0.14) * (1.0 - tint * 0.05);
    color.g *= exposure * (1.0 + tint * 0.08);
    color.b *= exposure * (1.0 - temperature * 0.14) * (1.0 - tint * 0.05);

    float originalLuma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float normalizedLuma = originalLuma / 255.0;
    float tonalLift = u_lightA.w * pow(1.0 - normalizedLuma, 2.0) * 1.25
        + u_lightB.y * (1.0 - normalizedLuma) * 0.65
        + u_lightA.z * pow(normalizedLuma, 2.0) * 1.25
        + u_lightB.x * normalizedLuma * 0.65;
    color += tonalLift;

    float contrast = (1.0 + u_lightA.y / 100.0) * (1.0 + u_color.w / 180.0);
    color = (color - 127.5) * contrast + 127.5;
    color = 255.0 * pow(clamp(color, 0.0, 255.0) / 255.0, vec3(1.0 / max(0.01, u_lightB.z)));
    color.r = texture(u_curve, vec2((clampByte(color.r) + 0.5) / 256.0, 0.5)).r * 255.0;
    color.g = texture(u_curve, vec2((clampByte(color.g) + 0.5) / 256.0, 0.5)).r * 255.0;
    color.b = texture(u_curve, vec2((clampByte(color.b) + 0.5) / 256.0, 0.5)).r * 255.0;

    int channel = 0;
    if (u_useHue || u_blackAndWhite) {
        vec3 hsl = rgbToHsl(color);
        channel = channelIndex(hsl.x);
        if (u_useHue) {
            vec3 channelSettings = u_hsl[channel];
            hsl.x = fract(hsl.x + channelSettings.x * 0.45 / 360.0 + 1.0);
            float vibranceBoost = (u_color.y / 100.0) * (1.0 - hsl.y) * 0.7;
            hsl.y = clamp(hsl.y * (1.0 + u_color.z / 100.0) + vibranceBoost + channelSettings.y / 100.0, 0.0, 1.0);
            hsl.z = clamp(hsl.z + channelSettings.z / 250.0, 0.0, 1.0);
            color = hslToRgb(hsl);
        }
    }

    float luma = clamp(dot(color, vec3(0.2126, 0.7152, 0.0722)), 0.0, 255.0);
    if (u_useGrading && !u_blackAndWhite) {
        for (int rangeIndex = 0; rangeIndex < 4; rangeIndex++) {
            float weight = 1.0;
            if (rangeIndex == 0) weight = pow(1.0 - luma / 255.0, 2.0);
            else if (rangeIndex == 1) weight = 1.0 - abs(luma / 127.5 - 1.0);
            else if (rangeIndex == 2) weight = pow(luma / 255.0, 2.0);
            float strength = rangeIndex == 3 ? 0.35 : 0.22;
            float amount = (u_grading[rangeIndex].y / 100.0) * weight * strength;
            color = mix(color, gradingColor(u_grading[rangeIndex].x), amount);
        }
    }
    if (u_blackAndWhite) color = vec3(clamp(luma * (1.0 + u_bw[channel] / 100.0 * 0.6), 0.0, 255.0));

    if (u_noise.w != 0.0) {
        vec2 position = gl_FragCoord.xy / max(vec2(1.0), u_dimensions - vec2(1.0)) * 2.0 - 1.0;
        float distanceFromCenter = min(1.0, length(position) / 1.35);
        color *= 1.0 + (u_noise.w / 100.0) * distanceFromCenter * distanceFromCenter * 0.7;
    }
    if (u_misc.x != 0.0) {
        float randomValue = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 2.0 - 1.0;
        color += randomValue * u_misc.x * 0.38;
    }
    if (u_clipping && any(greaterThanEqual(color, vec3(254.0)))) color = vec3(255.0, 45.0, 35.0);
    else if (u_clipping && all(lessThanEqual(color, vec3(1.0)))) color = vec3(25.0, 100.0, 255.0);
    outColor = vec4(clamp(color / 255.0, 0.0, 1.0), 1.0);
}`

function compileShader(gl, type, source) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'WebGL shader compilation failed.'
        gl.deleteShader(shader)
        throw new Error(message)
    }
    return shader
}

function createProgram(gl, fragmentSource) {
    const program = gl.createProgram()
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const message = gl.getProgramInfoLog(program) || 'WebGL program linking failed.'
        gl.deleteProgram(program)
        throw new Error(message)
    }
    return program
}

function configureTexture(gl, texture, width, height, pixels = null) {
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
}

function uniformLocations(gl, program, names) {
    return Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]))
}

function setSampler(gl, location, unit, texture) {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1i(location, unit)
}

function gradingArray(settings) {
    return ['shadows', 'midtones', 'highlights', 'global'].flatMap((key) => [settings.grading[key].hue, settings.grading[key].saturation])
}

export class LivePreviewRenderer {
    constructor() {
        this.canvas = document.createElement('canvas')
        this.gl = this.canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: false,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
        })
        if (!this.gl) throw new Error('WebGL 2 is unavailable.')
        const gl = this.gl
        this.adjustProgram = createProgram(gl, ADJUST_SHADER)
        this.blurProgram = createProgram(gl, BLUR_SHADER)
        this.adjustUniforms = uniformLocations(gl, this.adjustProgram, [
            'u_source', 'u_fineBlur', 'u_broadBlur', 'u_curve', 'u_lightA', 'u_lightB', 'u_color',
            'u_detail', 'u_noise', 'u_misc', 'u_hsl[0]', 'u_bw[0]', 'u_grading[0]', 'u_useFine',
            'u_useBroad', 'u_useHue', 'u_useGrading', 'u_blackAndWhite', 'u_clipping', 'u_dimensions',
        ])
        this.blurUniforms = uniformLocations(gl, this.blurProgram, ['u_source', 'u_texel', 'u_horizontal', 'u_radius'])
        this.vertexArray = gl.createVertexArray()
        gl.bindVertexArray(this.vertexArray)
        this.vertexBuffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0,
            -1, 1, 0, 0, 1, -1, 1, 1, 1, 1, 1, 0,
        ]), gl.STATIC_DRAW)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0)
        gl.enableVertexAttribArray(1)
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8)
        this.sourceTexture = gl.createTexture()
        this.curveTexture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, this.curveTexture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        this.blurTargets = new Map()
        this.source = null
        this.temporaryTarget = null
        this.curveKey = ''
    }

    makeTarget() {
        const gl = this.gl
        const texture = gl.createTexture()
        configureTexture(gl, texture, this.canvas.width, this.canvas.height)
        const framebuffer = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
        return { texture, framebuffer }
    }

    clearTargets() {
        const gl = this.gl
        for (const target of [...this.blurTargets.values(), this.temporaryTarget].filter(Boolean)) {
            gl.deleteFramebuffer(target.framebuffer)
            gl.deleteTexture(target.texture)
        }
        this.blurTargets.clear()
        this.temporaryTarget = null
    }

    setSource(source) {
        if (this.source === source) return
        const gl = this.gl
        this.canvas.width = source.width
        this.canvas.height = source.height
        gl.viewport(0, 0, source.width, source.height)
        configureTexture(gl, this.sourceTexture, source.width, source.height, source.pixels)
        this.clearTargets()
        this.source = source
    }

    blur(radius) {
        const existing = this.blurTargets.get(radius)
        if (existing) return existing.texture
        const gl = this.gl
        if (!this.temporaryTarget) this.temporaryTarget = this.makeTarget()
        const output = this.makeTarget()
        gl.useProgram(this.blurProgram)
        gl.bindVertexArray(this.vertexArray)
        setSampler(gl, this.blurUniforms.u_source, 0, this.sourceTexture)
        gl.uniform2f(this.blurUniforms.u_texel, 1 / this.canvas.width, 1 / this.canvas.height)
        gl.uniform1i(this.blurUniforms.u_radius, radius)
        gl.uniform1i(this.blurUniforms.u_horizontal, 1)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.temporaryTarget.framebuffer)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        setSampler(gl, this.blurUniforms.u_source, 0, this.temporaryTarget.texture)
        gl.uniform1i(this.blurUniforms.u_horizontal, 0)
        gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        this.blurTargets.set(radius, output)
        return output.texture
    }

    prepare(source, radii = [1, 5]) {
        this.setSource(source)
        for (const candidate of radii) this.blur(Math.max(1, Math.min(5, Math.round(Number(candidate) || 1))))
    }

    render(source, candidate, clipping = false) {
        const settings = sanitizeAdjustments(candidate)
        this.setSource(source)
        const gl = this.gl
        if (gl.isContextLost()) throw new Error('The graphics preview context was lost.')
        const useFine = Boolean(settings.texture || settings.sharpening || settings.noiseLuminance || settings.noiseColor)
        const useBroad = Boolean(settings.clarity)
        const fineTexture = useFine ? this.blur(Math.max(1, Math.round(settings.sharpeningRadius))) : this.sourceTexture
        const broadTexture = useBroad ? this.blur(5) : this.sourceTexture
        const lookup = curveLookup(settings.curve)
        const curveKey = settings.curve.map(({ x, y }) => `${x}:${y}`).join('|')
        if (curveKey !== this.curveKey) {
            gl.activeTexture(gl.TEXTURE3)
            gl.bindTexture(gl.TEXTURE_2D, this.curveTexture)
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, lookup)
            this.curveKey = curveKey
        }

        const program = this.adjustProgram
        const uniforms = this.adjustUniforms
        gl.useProgram(program)
        gl.bindVertexArray(this.vertexArray)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, this.canvas.width, this.canvas.height)
        setSampler(gl, uniforms.u_source, 0, this.sourceTexture)
        setSampler(gl, uniforms.u_fineBlur, 1, fineTexture)
        setSampler(gl, uniforms.u_broadBlur, 2, broadTexture)
        setSampler(gl, uniforms.u_curve, 3, this.curveTexture)

        gl.uniform4f(uniforms.u_lightA, settings.exposure, settings.contrast, settings.highlights, settings.shadows)
        gl.uniform4f(uniforms.u_lightB, settings.whites, settings.blacks, settings.gamma, settings.temperature)
        gl.uniform4f(uniforms.u_color, settings.tint, settings.vibrance, settings.saturation, settings.dehaze)
        gl.uniform4f(uniforms.u_detail, settings.texture, settings.clarity, settings.sharpening, settings.sharpeningDetail)
        gl.uniform4f(uniforms.u_noise, settings.sharpeningRadius, settings.noiseLuminance, settings.noiseColor, settings.vignette)
        gl.uniform3f(uniforms.u_misc, settings.grain, settings.blackAndWhite ? 1 : 0, clipping ? 1 : 0)
        gl.uniform3fv(uniforms['u_hsl[0]'], COLOR_CHANNELS.flatMap((key) => [settings.hsl[key].hue, settings.hsl[key].saturation, settings.hsl[key].luminance]))
        gl.uniform1fv(uniforms['u_bw[0]'], COLOR_CHANNELS.map((key) => settings.bwMixer[key]))
        gl.uniform2fv(uniforms['u_grading[0]'], gradingArray(settings))
        gl.uniform1i(uniforms.u_useFine, useFine ? 1 : 0)
        gl.uniform1i(uniforms.u_useBroad, useBroad ? 1 : 0)
        gl.uniform1i(uniforms.u_useHue, settings.vibrance || settings.saturation || COLOR_CHANNELS.some((key) => Object.values(settings.hsl[key]).some(Boolean)) ? 1 : 0)
        gl.uniform1i(uniforms.u_useGrading, Object.values(settings.grading).some((grade) => grade.saturation) ? 1 : 0)
        gl.uniform1i(uniforms.u_blackAndWhite, settings.blackAndWhite ? 1 : 0)
        gl.uniform1i(uniforms.u_clipping, clipping ? 1 : 0)
        gl.uniform2f(uniforms.u_dimensions, this.canvas.width, this.canvas.height)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        return this.canvas
    }

    dispose() {
        this.clearTargets()
        this.gl.deleteTexture(this.sourceTexture)
        this.gl.deleteTexture(this.curveTexture)
        this.gl.deleteBuffer(this.vertexBuffer)
        this.gl.deleteVertexArray(this.vertexArray)
        this.gl.deleteProgram(this.adjustProgram)
        this.gl.deleteProgram(this.blurProgram)
        this.source = null
    }
}

export function createLivePreviewRenderer() {
    try {
        return new LivePreviewRenderer()
    } catch {
        return null
    }
}
