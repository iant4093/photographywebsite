import { ShaderChunk } from 'three'

// The base and detail materials on one frame follow the same wave as their
// textures crossfade. The frame and glazing retain their own geometry.
const progressByPainting = new WeakMap()

export function paintingRipple(painting) {
    if (!progressByPainting.has(painting)) progressByPainting.set(painting, { value: -1 })
    return progressByPainting.get(painting)
}

export function applyPaintingRipple(shader, painting, aspect = 2.66 / 1.76) {
    shader.uniforms.museumRipple = paintingRipple(painting)
    shader.uniforms.museumRippleAspect = { value: aspect }
    shader.fragmentShader = 'uniform float museumRippleAspect;\nuniform float museumRipple;\n' + shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
        vec2 museumPrintUV = vMapUv;
        float crest = 0.0;
        if (museumRipple >= 0.0) {
            vec2 aspect = vec2(museumRippleAspect, 1.0);
            vec2 p = (vMapUv - 0.5) * aspect;
            float d = length(p);
            float wave = d - museumRipple * (length(aspect) * 0.5 + 0.22);
            float envelope = exp(-8.5 * abs(wave)) * smoothstep(0.0, 0.08, museumRipple);
            float bend = sin(wave * 58.0) * envelope;
            museumPrintUV = clamp(vMapUv + (p / max(d, 0.001)) / aspect * bend * 0.044, 0.0, 1.0);
            crest = bend * 0.39;
        }
        ${ShaderChunk.map_fragment.replaceAll('vMapUv', 'museumPrintUV')}
        diffuseColor.rgb = diffuseColor.rgb * (1.0 + crest) + vec3(0.22, 0.15, 0.08) * max(0.0, crest);
        #endif`
    ).replace('texture2D(museumPreviousMap, vMapUv)', 'texture2D(museumPreviousMap, museumPrintUV)')
}
